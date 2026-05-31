// scripts/backfill-rating-history.js
// Run with: node scripts/backfill-rating-history.js
// Optional: node scripts/backfill-rating-history.js --season 2026 --through 2026-05-14
//
// Builds estimated weekly Monday rating-history points from MLB game logs.
// Backfilled points intentionally omit Savant Skills; Savant history is only
// captured by normal refresh snapshots from scripts/update-players.js.

const fs = require("fs/promises");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const PLAYERS_PATH = path.join(ROOT_DIR, "players.json");
const GENERATED_DIR = path.join(ROOT_DIR, "data", "generated");
const RATING_HISTORY_PATH = path.join(GENERATED_DIR, "rating-history.json");
const MLB_API_BASE = "https://statsapi.mlb.com/api/v1";
const RATING_PROJECTION_WEIGHT = 0.6;
const RATING_CURRENT_FORM_WEIGHT = 0.4;
const HITTER_RECENT_TREND_GAME_COUNT = 7;
const STARTER_RECENT_TREND_GAME_COUNT = 3;
const RELIEVER_RECENT_TREND_GAME_COUNT = 5;
const HITTER_SEASON_FORM_FULL_TRUST_PA = 150;
const STARTER_SEASON_FORM_FULL_TRUST_IP = 40;
const RELIEVER_SEASON_FORM_FULL_TRUST_IP = 15;
const RATING_HISTORY_MAX_DAYS = 90;
const BACKFILL_SOURCE = "weekly-backfill-estimated-no-savant";

async function main() {
  const players = await readJson(PLAYERS_PATH);
  const season = Number(getCliOption("--season")) || getSeasonFromPlayers(players) || new Date().getFullYear();
  const throughDate = getCliOption("--through") || getThroughDateFromPlayers(players) || new Date().toISOString().slice(0, 10);
  const gameLogStartDate = `${season}-03-01`;
  const logsByKey = await fetchSeasonGameLogs(players, season, gameLogStartDate, throughDate);
  const mondays = getMondaySnapshotDates(logsByKey, throughDate);

  if (mondays.length === 0) {
    console.log("No Monday backfill points found.");
    return;
  }

  const backfillEntries = mondays.flatMap((snapshotDate) => {
    const cutoffDate = getDateDaysBefore(snapshotDate, 1);
    return buildSnapshotEntries(players, logsByKey, snapshotDate, cutoffDate);
  });
  const history = await mergeRatingHistory(backfillEntries, throughDate);

  await fs.mkdir(GENERATED_DIR, { recursive: true });
  await fs.writeFile(RATING_HISTORY_PATH, `${JSON.stringify(history, null, 2)}\n`);

  console.log(
    `Backfilled ${mondays.length} Monday snapshot${mondays.length === 1 ? "" : "s"} ` +
      `(${mondays[0]} through ${mondays[mondays.length - 1]})`
  );
  console.log(`Wrote ${history.entries.length} history entries to data/generated/rating-history.json`);
}

async function fetchSeasonGameLogs(players, season, startDate, endDate) {
  const logsByKey = new Map();
  const groups = [
    { projectionGroup: "hitting", statsGroup: "hitting" },
    { projectionGroup: "pitching", statsGroup: "pitching" }
  ];

  for (const group of groups) {
    const ids = Array.from(
      new Set(
        players
          .filter((player) => player.mlbId && player.projection?.group === group.projectionGroup)
          .map((player) => player.mlbId)
      )
    );
    const chunks = chunkArray(ids, 75);

    for (const chunk of chunks) {
      const people = await fetchPeopleGameLogChunk(chunk, group.statsGroup, season, startDate, endDate);
      people.forEach((person) => {
        const splits = person.stats?.[0]?.splits || [];
        logsByKey.set(getPlayerGameLogKey(person.id, group.projectionGroup), normalizeSplits(splits));
      });
    }
  }

  return logsByKey;
}

async function fetchPeopleGameLogChunk(ids, group, season, startDate, endDate) {
  if (ids.length === 0) {
    return [];
  }

  const hydrate = `stats(group=[${group}],type=[gameLog],season=${season},startDate=${startDate},endDate=${endDate})`;
  const url =
    `${MLB_API_BASE}/people?personIds=${ids.join(",")}` +
    `&hydrate=${encodeURIComponent(hydrate)}`;
  const data = await fetchJson(url);
  return data.people || [];
}

function normalizeSplits(splits) {
  return (splits || [])
    .filter((split) => split?.date)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function getMondaySnapshotDates(logsByKey, throughDate) {
  const allDates = Array.from(logsByKey.values())
    .flatMap((splits) => splits.map((split) => split.date))
    .sort();
  const firstGameDate = allDates[0];

  if (!firstGameDate) {
    return [];
  }

  const dates = [];
  let current = getNextMonday(getDateDaysAfter(firstGameDate, 1));
  const lastMonday = getPreviousOrSameMonday(throughDate);

  while (current <= lastMonday) {
    dates.push(current);
    current = getDateDaysAfter(current, 7);
  }

  return dates;
}

function buildSnapshotEntries(players, logsByKey, snapshotDate, cutoffDate) {
  const snapshotPlayers = players.map((player) => {
    const splits = logsByKey.get(getPlayerGameLogKey(player.mlbId, player.projection?.group)) || [];
    const throughSplits = splits.filter((split) => split.date <= cutoffDate);
    const stats = buildCurrentStatsFromSplits(throughSplits, player.projection?.group);
    const recentGames = {
      games: buildRecentGamesFromSplits(throughSplits, player.projection?.group)
    };

    return {
      ...player,
      stats,
      recentGames,
      savant: null
    };
  });
  const rawComponents = snapshotPlayers.map((player) => {
    return {
      key: getPlayerRatingKey(player),
      player,
      seasonRaw: getSeasonStatsRawValue(player),
      recentRaw: getRecentTrendRawValue(player)
    };
  });
  const componentScores = {
    seasonStats: buildComponentScoreLookup(rawComponents, "seasonRaw"),
    recentTrend: buildComponentScoreLookup(rawComponents, "recentRaw")
  };

  return snapshotPlayers
    .map((player) => {
      const key = getPlayerRatingKey(player);
      const projectionScore = Number(player.projection?.percentileScore) || Number(player.recommendation?.score) || 50;
      const seasonScore = regressComponentScore({
        componentScore: componentScores.seasonStats.get(key),
        projectionScore,
        reliability: getSeasonStatsReliability(player)
      });
      const recentScore = regressComponentScore({
        componentScore: componentScores.recentTrend.get(key),
        projectionScore,
        reliability: getRecentTrendReliability(player)
      });
      const currentFormScore = Math.round(seasonScore * 0.625 + recentScore * 0.375);
      const overall = clamp(
        Math.round(
          projectionScore * RATING_PROJECTION_WEIGHT +
            currentFormScore * RATING_CURRENT_FORM_WEIGHT
        ) + toNumber(player.manualRecommendation?.scoreAdjustment),
        1,
        100
      );

      return {
        date: snapshotDate,
        mlbId: player.mlbId || null,
        name: player.name,
        team: player.team || "",
        positions: Array.isArray(player.positions) ? player.positions : [],
        action:
          player.manualRecommendation?.forceStartSit ||
          player.manualRecommendation?.startSitOverride ||
          getActionFromScore(overall),
        tag: player.recommendation?.tag || "",
        source: BACKFILL_SOURCE,
        throughDate: cutoffDate,
        scores: {
          overall,
          projection: Math.round(projectionScore),
          currentForm: currentFormScore,
          seasonStats: seasonScore,
          recentTrend: recentScore,
          savantSkills: null
        }
      };
    })
    .filter((entry) => Number.isFinite(entry.scores.overall));
}

function buildCurrentStatsFromSplits(splits, group) {
  if (group === "pitching") {
    const totals = splits.reduce(
      (sum, split) => {
        const stat = split.stat || {};
        const innings = inningsPitchedToNumber(stat.inningsPitched);
        return {
          gamesPlayed: sum.gamesPlayed + toNumber(stat.gamesPlayed || 1),
          gamesStarted: sum.gamesStarted + toNumber(stat.gamesStarted),
          qualityStarts: sum.qualityStarts + (isQualityStart(stat) ? 1 : 0),
          wins: sum.wins + toNumber(stat.wins),
          losses: sum.losses + toNumber(stat.losses),
          saves: sum.saves + toNumber(stat.saves),
          holds: sum.holds + toNumber(stat.holds),
          innings: sum.innings + innings,
          strikeOuts: sum.strikeOuts + toNumber(stat.strikeOuts),
          earnedRuns: sum.earnedRuns + toNumber(stat.earnedRuns),
          baseOnBalls: sum.baseOnBalls + toNumber(stat.baseOnBalls),
          hits: sum.hits + toNumber(stat.hits)
        };
      },
      {
        gamesPlayed: 0,
        gamesStarted: 0,
        qualityStarts: 0,
        wins: 0,
        losses: 0,
        saves: 0,
        holds: 0,
        innings: 0,
        strikeOuts: 0,
        earnedRuns: 0,
        baseOnBalls: 0,
        hits: 0
      }
    );
    const era = totals.innings > 0 ? (totals.earnedRuns * 9) / totals.innings : null;
    const whip = totals.innings > 0 ? (totals.hits + totals.baseOnBalls) / totals.innings : null;

    return {
      group: "pitching",
      gamesPlayed: totals.gamesPlayed,
      gamesStarted: totals.gamesStarted,
      qualityStarts: totals.qualityStarts,
      wins: totals.wins,
      losses: totals.losses,
      saves: totals.saves,
      holds: totals.holds,
      inningsPitched: numberToInningsPitched(totals.innings),
      strikeOuts: totals.strikeOuts,
      earnedRuns: totals.earnedRuns,
      baseOnBalls: totals.baseOnBalls,
      era: era === null ? ".---" : era.toFixed(2),
      whip: whip === null ? ".---" : whip.toFixed(2)
    };
  }

  const totals = splits.reduce(
    (sum, split) => {
      const stat = split.stat || {};
      return {
        gamesPlayed: sum.gamesPlayed + toNumber(stat.gamesPlayed || 1),
        plateAppearances: sum.plateAppearances + toNumber(stat.plateAppearances),
        atBats: sum.atBats + toNumber(stat.atBats),
        hits: sum.hits + toNumber(stat.hits),
        doubles: sum.doubles + toNumber(stat.doubles),
        triples: sum.triples + toNumber(stat.triples),
        runs: sum.runs + toNumber(stat.runs),
        homeRuns: sum.homeRuns + toNumber(stat.homeRuns),
        rbi: sum.rbi + toNumber(stat.rbi),
        stolenBases: sum.stolenBases + toNumber(stat.stolenBases),
        strikeOuts: sum.strikeOuts + toNumber(stat.strikeOuts),
        baseOnBalls: sum.baseOnBalls + toNumber(stat.baseOnBalls),
        hitByPitch: sum.hitByPitch + toNumber(stat.hitByPitch),
        sacFlies: sum.sacFlies + toNumber(stat.sacFlies)
      };
    },
    {
      gamesPlayed: 0,
      plateAppearances: 0,
      atBats: 0,
      hits: 0,
      doubles: 0,
      triples: 0,
      runs: 0,
      homeRuns: 0,
      rbi: 0,
      stolenBases: 0,
      strikeOuts: 0,
      baseOnBalls: 0,
      hitByPitch: 0,
      sacFlies: 0
    }
  );
  const avg = totals.atBats > 0 ? totals.hits / totals.atBats : null;
  const obpDenominator = totals.atBats + totals.baseOnBalls + totals.hitByPitch + totals.sacFlies;
  const obp =
    obpDenominator > 0
      ? (totals.hits + totals.baseOnBalls + totals.hitByPitch) / obpDenominator
      : null;
  const singles = totals.hits - totals.doubles - totals.triples - totals.homeRuns;
  const totalBases = singles + totals.doubles * 2 + totals.triples * 3 + totals.homeRuns * 4;
  const slg = totals.atBats > 0 ? totalBases / totals.atBats : null;
  const ops = obp !== null && slg !== null ? obp + slg : null;

  return {
    group: "hitting",
    gamesPlayed: totals.gamesPlayed,
    plateAppearances: totals.plateAppearances,
    atBats: totals.atBats,
    hits: totals.hits,
    runs: totals.runs,
    homeRuns: totals.homeRuns,
    rbi: totals.rbi,
    stolenBases: totals.stolenBases,
    strikeOuts: totals.strikeOuts,
    baseOnBalls: totals.baseOnBalls,
    avg: avg === null ? ".---" : formatRate(avg),
    obp: obp === null ? ".---" : formatRate(obp),
    slg: slg === null ? ".---" : formatRate(slg),
    ops: ops === null ? ".---" : formatRate(ops)
  };
}

function buildRecentGamesFromSplits(splits, group) {
  return splits
    .slice()
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .map((split) => {
      const stat = split.stat || {};
      if (group === "pitching") {
        return {
          date: formatShortDate(split.date),
          inningsPitched: stat.inningsPitched || "0.0",
          strikeOuts: toNumber(stat.strikeOuts),
          baseOnBalls: toNumber(stat.baseOnBalls),
          qualityStart: isQualityStart(stat),
          wins: toNumber(stat.wins),
          saves: toNumber(stat.saves),
          earnedRuns: toNumber(stat.earnedRuns),
          era: getGameEra(stat),
          whip: getGameWhip(stat)
        };
      }

      return {
        date: formatShortDate(split.date),
        hits: toNumber(stat.hits),
        atBats: toNumber(stat.atBats),
        runs: toNumber(stat.runs),
        homeRuns: toNumber(stat.homeRuns),
        rbi: toNumber(stat.rbi),
        stolenBases: toNumber(stat.stolenBases),
        avg: getGameAverage(stat),
        ops: getGameOps(stat),
        strikeOuts: toNumber(stat.strikeOuts)
      };
    });
}

async function mergeRatingHistory(backfillEntries, updatedAt) {
  const existingHistory = await readOptionalRatingHistory();
  const backfillDates = new Set(backfillEntries.map((entry) => entry.date));
  const realSnapshotDates = new Set(
    (existingHistory.entries || [])
      .filter((entry) => isMondayDate(entry.date) && backfillDates.has(entry.date) && entry.source !== BACKFILL_SOURCE)
      .map((entry) => entry.date)
  );
  const preservedEntries = (existingHistory.entries || []).filter((entry) => {
    return isMondayDate(entry.date) && (!backfillDates.has(entry.date) || entry.source !== BACKFILL_SOURCE);
  });
  const usableBackfillEntries = backfillEntries.filter((entry) => {
    return !realSnapshotDates.has(entry.date);
  });
  const entriesByDate = new Map();

  [...preservedEntries, ...usableBackfillEntries].forEach((entry) => {
    if (!entry?.date) {
      return;
    }
    if (!entriesByDate.has(entry.date)) {
      entriesByDate.set(entry.date, []);
    }
    entriesByDate.get(entry.date).push(entry);
  });

  const keptDates = Array.from(entriesByDate.keys()).sort().slice(-RATING_HISTORY_MAX_DAYS);
  return {
    version: 1,
    updatedAt,
    maxDays: RATING_HISTORY_MAX_DAYS,
    entries: keptDates.flatMap((date) => {
      return entriesByDate.get(date).sort((a, b) => {
        return String(a.name || "").localeCompare(String(b.name || ""));
      });
    })
  };
}

async function readOptionalRatingHistory() {
  try {
    return await readJson(RATING_HISTORY_PATH);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { entries: [] };
    }
    throw error;
  }
}

function buildComponentScoreLookup(componentRows, rawKey) {
  const lookup = new Map();
  ["hitting", "pitching"].forEach((group) => {
    const rows = componentRows.filter((row) => {
      return row.player.projection?.group === group && Number.isFinite(row[rawKey]);
    });
    const sorted = rows.map((row) => row[rawKey]).sort((a, b) => a - b);

    rows.forEach((row) => {
      const rankIndex = sorted.findIndex((value) => value >= row[rawKey]);
      const percentile =
        sorted.length <= 1 ? 1 : rankIndex / Math.max(sorted.length - 1, 1);
      lookup.set(row.key, clamp(Math.round(percentile * 99) + 1, 1, 100));
    });
  });
  return lookup;
}

function regressComponentScore({ componentScore, projectionScore, reliability }) {
  if (!Number.isFinite(componentScore)) {
    return Math.round(projectionScore);
  }

  const trustedReliability = clamp(reliability, 0, 1);
  return Math.round(
    projectionScore * (1 - trustedReliability) + componentScore * trustedReliability
  );
}

function getSeasonStatsRawValue(player) {
  const stats = player.stats || {};

  if (stats.group === "pitching") {
    const inningsPitched = inningsPitchedToNumber(stats.inningsPitched);
    if (inningsPitched <= 0) {
      return null;
    }

    const era = toNullableNumber(stats.era);
    const whip = toNullableNumber(stats.whip);
    return (
      toNumber(stats.qualityStarts) +
      zFriendlyCount(stats.wins) +
      zFriendlyCount(stats.saves) +
      toNumber(stats.strikeOuts) / 8 +
      (3.9 - (era ?? 3.9)) * Math.sqrt(inningsPitched || 1) +
      (1.28 - (whip ?? 1.28)) * Math.sqrt(inningsPitched || 1)
    );
  }

  if (toNumber(stats.plateAppearances) <= 0) {
    return null;
  }

  const avg = toNullableNumber(stats.avg) ?? 0.245;
  return (
    toNumber(stats.runs) +
    toNumber(stats.homeRuns) * 2 +
    toNumber(stats.rbi) +
    toNumber(stats.stolenBases) * 2 +
    (avg - 0.245) * Math.sqrt(toNumber(stats.atBats) || 1) * 18
  );
}

function getRecentTrendRawValue(player) {
  const games = (player.recentGames?.games || []).slice(0, getRecentTrendGameCount(player));
  if (games.length === 0) {
    return null;
  }

  if (player.projection?.group === "pitching") {
    const totals = games.reduce(
      (sum, game) => {
        const inningsPitched = inningsPitchedToNumber(game.inningsPitched);
        const era = toNullableNumber(game.era) ?? 3.9;
        const whip = toNullableNumber(game.whip) ?? 1.28;
        return {
          inningsPitched: sum.inningsPitched + inningsPitched,
          strikeOuts: sum.strikeOuts + toNumber(game.strikeOuts),
          qualityStarts: sum.qualityStarts + (game.qualityStart ? 1 : 0),
          wins: sum.wins + toNumber(game.wins),
          saves: sum.saves + toNumber(game.saves),
          earnedRuns: sum.earnedRuns + (era * inningsPitched) / 9,
          baserunners: sum.baserunners + whip * inningsPitched
        };
      },
      {
        inningsPitched: 0,
        strikeOuts: 0,
        qualityStarts: 0,
        wins: 0,
        saves: 0,
        earnedRuns: 0,
        baserunners: 0
      }
    );

    if (totals.inningsPitched <= 0) {
      return null;
    }

    const era = (totals.earnedRuns * 9) / totals.inningsPitched;
    const whip = totals.baserunners / totals.inningsPitched;
    return (
      totals.qualityStarts * 4 +
      totals.wins * 3 +
      totals.saves * 3 +
      totals.strikeOuts / 2 +
      (3.9 - era) * Math.sqrt(totals.inningsPitched) +
      (1.28 - whip) * Math.sqrt(totals.inningsPitched)
    );
  }

  const totals = games.reduce(
    (sum, game) => {
      return {
        hits: sum.hits + toNumber(game.hits),
        atBats: sum.atBats + toNumber(game.atBats),
        runs: sum.runs + toNumber(game.runs),
        homeRuns: sum.homeRuns + toNumber(game.homeRuns),
        rbi: sum.rbi + toNumber(game.rbi),
        stolenBases: sum.stolenBases + toNumber(game.stolenBases)
      };
    },
    { hits: 0, atBats: 0, runs: 0, homeRuns: 0, rbi: 0, stolenBases: 0 }
  );

  if (totals.atBats <= 0) {
    return null;
  }

  const avg = totals.hits / totals.atBats;
  return (
    totals.runs +
    totals.homeRuns * 2 +
    totals.rbi +
    totals.stolenBases * 2 +
    (avg - 0.245) * Math.sqrt(totals.atBats) * 18
  );
}

function getSeasonStatsReliability(player) {
  if (player.projection?.group === "pitching") {
    const fullTrustInnings = isReliefPitcher(player)
      ? RELIEVER_SEASON_FORM_FULL_TRUST_IP
      : STARTER_SEASON_FORM_FULL_TRUST_IP;
    return clamp(inningsPitchedToNumber(player.stats?.inningsPitched) / fullTrustInnings, 0, 1);
  }

  return clamp(toNumber(player.stats?.plateAppearances) / HITTER_SEASON_FORM_FULL_TRUST_PA, 0, 1);
}

function getRecentTrendReliability(player) {
  const recentTrendGameCount = getRecentTrendGameCount(player);
  return clamp(
    (player.recentGames?.games || []).slice(0, recentTrendGameCount).length /
      recentTrendGameCount,
    0,
    1
  );
}

function getRecentTrendGameCount(player) {
  if (player.projection?.group === "pitching" || player.stats?.group === "pitching") {
    return isReliefPitcher(player)
      ? RELIEVER_RECENT_TREND_GAME_COUNT
      : STARTER_RECENT_TREND_GAME_COUNT;
  }

  return HITTER_RECENT_TREND_GAME_COUNT;
}

function isReliefPitcher(player) {
  const positions = [
    ...(Array.isArray(player.positions) ? player.positions : []),
    ...(Array.isArray(player.projection?.positions) ? player.projection.positions : [])
  ].map((position) => String(position).trim().toUpperCase());

  return positions.includes("RP") && !positions.includes("SP");
}

function getPlayerRatingKey(player) {
  return `${player.mlbId || player.name}:${player.projection?.group || player.stats?.group || "unknown"}`;
}

function getPlayerGameLogKey(mlbId, group) {
  return `${mlbId || "unknown"}:${group || "unknown"}`;
}

function zFriendlyCount(value) {
  return toNumber(value) * 2;
}

function getActionFromScore(score) {
  if (score >= 70) return "Start";
  if (score >= 45) return "Watch";
  return "Bench";
}

function getSeasonFromPlayers(players) {
  return Number(players.find((player) => player.source?.season)?.source?.season) || null;
}

function getThroughDateFromPlayers(players) {
  return players.find((player) => player.source?.updatedAt)?.source?.updatedAt || "";
}

async function readJson(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return JSON.parse(text);
}

async function fetchJson(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Request failed ${response.status}: ${url}`);
  }

  return response.json();
}

function toNumber(value) {
  const cleaned = String(value || "").replace(/[%,$]/g, "");
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : 0;
}

function toNullableNumber(value) {
  const cleaned = String(value || "").replace(/[%,$]/g, "").trim();
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

function chunkArray(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function getNextMonday(dateString) {
  const date = new Date(`${dateString}T00:00:00Z`);
  const day = date.getUTCDay();
  const daysUntilMonday = (8 - day) % 7;
  date.setUTCDate(date.getUTCDate() + daysUntilMonday);
  return date.toISOString().slice(0, 10);
}

function getPreviousOrSameMonday(dateString) {
  const date = new Date(`${dateString}T00:00:00Z`);
  const day = date.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return date.toISOString().slice(0, 10);
}

function isMondayDate(dateString) {
  const date = new Date(`${dateString}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.getUTCDay() === 1;
}

function getDateDaysAfter(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function getDateDaysBefore(dateString, days) {
  return getDateDaysAfter(dateString, -days);
}

function formatShortDate(dateString) {
  if (!dateString) {
    return "--";
  }

  const [year, month, day] = String(dateString).split("-");
  if (!year || !month || !day) {
    return dateString;
  }

  return `${Number(month)}/${Number(day)}`;
}

function getGameAverage(stat) {
  const atBats = toNumber(stat.atBats);
  if (atBats === 0) {
    return ".---";
  }

  return formatRate(toNumber(stat.hits) / atBats);
}

function getGameOps(stat) {
  const obp = getGameObp(stat);
  const slg = getGameSlg(stat);
  if (!Number.isFinite(obp) || !Number.isFinite(slg)) {
    return ".---";
  }

  return formatRate(obp + slg);
}

function getGameObp(stat) {
  const hits = toNumber(stat.hits);
  const walks = toNumber(stat.baseOnBalls);
  const hitByPitch = toNumber(stat.hitByPitch);
  const atBats = toNumber(stat.atBats);
  const sacFlies = toNumber(stat.sacFlies);
  const denominator = atBats + walks + hitByPitch + sacFlies;

  if (denominator === 0) {
    return null;
  }

  return (hits + walks + hitByPitch) / denominator;
}

function getGameSlg(stat) {
  const atBats = toNumber(stat.atBats);
  if (atBats === 0) {
    return null;
  }

  const singles =
    toNumber(stat.hits) -
    toNumber(stat.doubles) -
    toNumber(stat.triples) -
    toNumber(stat.homeRuns);
  const totalBases =
    singles +
    toNumber(stat.doubles) * 2 +
    toNumber(stat.triples) * 3 +
    toNumber(stat.homeRuns) * 4;
  return totalBases / atBats;
}

function getGameEra(stat) {
  const innings = inningsPitchedToNumber(stat.inningsPitched);
  if (!innings) {
    return "0.00";
  }

  return ((toNumber(stat.earnedRuns) * 9) / innings).toFixed(2);
}

function getGameWhip(stat) {
  const innings = inningsPitchedToNumber(stat.inningsPitched);
  if (!innings) {
    return "0.00";
  }

  return ((toNumber(stat.hits) + toNumber(stat.baseOnBalls)) / innings).toFixed(2);
}

function inningsPitchedToNumber(value) {
  const [wholeInnings, outs] = String(value || "0.0")
    .split(".")
    .map((part) => Number(part));
  return (Number.isFinite(wholeInnings) ? wholeInnings : 0) +
    (Number.isFinite(outs) ? outs : 0) / 3;
}

function numberToInningsPitched(value) {
  const outs = Math.round(value * 3);
  return `${Math.floor(outs / 3)}.${outs % 3}`;
}

function isQualityStart(stat) {
  return (
    toNumber(stat.gamesStarted) > 0 &&
    inningsPitchedToNumber(stat.inningsPitched) >= 6 &&
    toNumber(stat.earnedRuns) <= 3
  );
}

function formatRate(value) {
  if (!Number.isFinite(value)) {
    return ".---";
  }

  return value.toFixed(3).replace(/^0/, "");
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getCliOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index === process.argv.length - 1) {
    return "";
  }
  return process.argv[index + 1];
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
