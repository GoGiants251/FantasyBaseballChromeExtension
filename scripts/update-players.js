// scripts/update-players.js
// Run with: node scripts/update-players.js
// Optional: node scripts/update-players.js --date 2026-05-03
// This local-only updater builds the extension data from real baseball sources:
// MLB Stats API for identity/current stats and Razzball/Steamer projection
// tables for rest-of-season fantasy value.

const fs = require("fs/promises");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT_DIR, "helper-config.json");
const OUTPUT_PATH = path.join(ROOT_DIR, "players.json");
const PLAYER_INDEX_PATH = path.join(ROOT_DIR, "mlb-players.json");
const GENERATED_DIR = path.join(ROOT_DIR, "data", "generated");
const PLAYER_VALUES_PATH = path.join(GENERATED_DIR, "player-values.json");
const RATING_HISTORY_PATH = path.join(GENERATED_DIR, "rating-history.json");
const MLB_API_BASE = "https://statsapi.mlb.com/api/v1";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const RUN_AI_RECOMMENDATIONS = process.argv.includes("--ai");
const AI_PLAYER_FILTER = getCliOption("--ai-player") || process.env.GEMINI_AI_PLAYER || "";
const REQUESTED_UPDATE_DATE = getCliOption("--date") || process.env.FBH_UPDATE_DATE || "";
const DECISION_ENGINE_VERSION = "decision-engine-v1";
const RATING_PROJECTION_WEIGHT = 0.6;
const RATING_CURRENT_FORM_WEIGHT = 0.4;
const HITTER_RECENT_TREND_GAME_COUNT = 7;
const STARTER_RECENT_TREND_GAME_COUNT = 3;
const RELIEVER_RECENT_TREND_GAME_COUNT = 5;
const RECENT_GAMES_OUTPUT_COUNT = 15;
const HITTER_PROJECTION_POOL_PA_PERCENTILE = 0.6;
const HITTER_PROJECTION_POOL_MIN_PA = 75;
const HITTER_PROJECTION_POOL_MAX_PA = 250;
const HITTER_SEASON_FORM_FULL_TRUST_PA = 150;
const STARTER_SEASON_FORM_FULL_TRUST_IP = 40;
const RELIEVER_SEASON_FORM_FULL_TRUST_IP = 15;
const RATING_HISTORY_MAX_DAYS = 90;
const AI_BADGE_LABELS = new Set([
  "Projection Anchor",
  "Projection Edge",
  "Projection Carry",
  "Elite Projection",
  "Current Form",
  "Current Form Support",
  "Hot Last 7",
  "Hot Last 5",
  "Hot Last 3",
  "Cold Last 7",
  "Cold Last 5",
  "Cold Last 3",
  "Savant Support",
  "Savant Warning",
  "Power Upside",
  "Power Source",
  "Speed Upside",
  "Speed Source",
  "Average Help",
  "Contact Quality",
  "K Upside",
  "QS Volume",
  "Ratio Support",
  "Save Path",
  "Small Sample",
  "Strikeout Risk",
  "Weak Contact",
  "AVG Drag",
  "Ratio Risk",
  "Low Volume",
  "Walk Risk",
  "Contact Risk",
  "Role Risk"
]);
const AI_BADGE_TONES = new Set(["positive", "neutral", "caution", "risk"]);

async function main() {
  const config = await readJson(CONFIG_PATH);
  const season = config.season || new Date().getFullYear();
  const updatedAt = getUpdateDate();

  await fs.mkdir(GENERATED_DIR, { recursive: true });

  const playerIndex = await fetchMlbPlayerIndex(season, updatedAt);
  const mlbPlayersByName = mapMlbPlayersByName(playerIndex.players);
  const [currentHittingStats, currentPitchingStats, projections, savantById] =
    await Promise.all([
      fetchBulkSeasonStats("hitting", season),
      fetchBulkSeasonStats("pitching", season),
      fetchProjectionPool(config),
      fetchSavantMetricPool(season, updatedAt)
    ]);

  let players = await buildPlayerValues({
    config,
    playerIndex,
    mlbPlayersByName,
    currentHittingStats,
    currentPitchingStats,
    savantById,
    projections,
    season,
    updatedAt
  });
  const recentGamesByIdAndGroup = await fetchRecentGameLogs(players, season, updatedAt);
  players = players.map((player) => {
    const key = getRecentGamesMapKey(player.mlbId, player.projection?.group);
    const recentGames = recentGamesByIdAndGroup.get(key) || getEmptyRecentGames(updatedAt);
    const seasonQualityStarts = recentGames.seasonQualityStarts;
    const stats =
      player.projection?.group === "pitching" && Number.isFinite(Number(seasonQualityStarts))
        ? {
            ...player.stats,
            qualityStarts: seasonQualityStarts
          }
        : player.stats;
    const source =
      player.projection?.group === "pitching" && Number.isFinite(Number(seasonQualityStarts))
        ? {
            ...player.source,
            stats: "MLB Stats API bulk season stats + game-log quality starts"
          }
        : player.source;

    return {
      ...player,
      stats,
      source,
      recentGames
    };
  });
  players = applyDeterministicDecisions(applyRatings(players), config, updatedAt).sort((a, b) => {
    return b.recommendation.score - a.recommendation.score;
  });
  players = await maybeAddAiDecisions(players, config, updatedAt);
  const ratingHistory = await updateRatingHistory(players, updatedAt);

  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(players, null, 2)}\n`);
  await fs.writeFile(PLAYER_INDEX_PATH, `${JSON.stringify(playerIndex, null, 2)}\n`);
  await fs.writeFile(PLAYER_VALUES_PATH, `${JSON.stringify(players, null, 2)}\n`);
  await fs.writeFile(RATING_HISTORY_PATH, `${JSON.stringify(ratingHistory, null, 2)}\n`);

  console.log(`Wrote ${players.length} projection-scored players to players.json`);
  console.log(
    `Wrote ${playerIndex.players.length} MLB names to ${path.relative(
      ROOT_DIR,
      PLAYER_INDEX_PATH
    )}`
  );
  console.log(`Wrote values backup to ${path.relative(ROOT_DIR, PLAYER_VALUES_PATH)}`);
  console.log(`Wrote rating history to ${path.relative(ROOT_DIR, RATING_HISTORY_PATH)}`);
  printTopPlayers(players);
}

async function updateRatingHistory(players, updatedAt) {
  const previousHistory = await readOptionalRatingHistory();
  const previousEntries = Array.isArray(previousHistory.entries)
    ? previousHistory.entries.filter((entry) => isMondayDate(entry.date))
    : [];
  const nextEntriesForDate = isMondayDate(updatedAt)
    ? players
        .map((player) => buildRatingHistoryEntry(player, updatedAt))
        .filter(Boolean)
    : [];
  const entriesByDate = new Map();

  previousEntries.forEach((entry) => {
    if (!entry?.date || entry.date === updatedAt) {
      return;
    }

    if (!entriesByDate.has(entry.date)) {
      entriesByDate.set(entry.date, []);
    }
    entriesByDate.get(entry.date).push(entry);
  });

  if (nextEntriesForDate.length) {
    entriesByDate.set(updatedAt, nextEntriesForDate);
  }

  const keptDates = Array.from(entriesByDate.keys())
    .sort()
    .slice(-RATING_HISTORY_MAX_DAYS);
  const entries = keptDates.flatMap((date) => {
    return entriesByDate.get(date).sort((a, b) => {
      return String(a.name || "").localeCompare(String(b.name || ""));
    });
  });

  return {
    version: 1,
    updatedAt,
    maxDays: RATING_HISTORY_MAX_DAYS,
    entries
  };
}

function isMondayDate(dateString) {
  const date = new Date(`${dateString}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.getUTCDay() === 1;
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

function buildRatingHistoryEntry(player, date) {
  const rating = player.rating || {};
  const components = rating.components || {};
  const overall = toNumber(rating.score || player.recommendation?.score);

  if (!Number.isFinite(overall)) {
    return null;
  }

  return {
    date,
    mlbId: player.mlbId || null,
    name: player.name,
    team: player.team || "",
    positions: Array.isArray(player.positions) ? player.positions : [],
    action: rating.action || player.recommendation?.startSit || "",
    tag: player.recommendation?.tag || "",
    scores: {
      overall,
      projection: toNullableNumber(components.projection),
      currentForm: toNullableNumber(components.currentForm),
      seasonStats: toNullableNumber(components.seasonStats),
      recentTrend: toNullableNumber(components.recentTrend),
      savantSkills: toNullableNumber(components.savantSkills)
    }
  };
}

function getUpdateDate() {
  const fallbackDate = new Date().toISOString().slice(0, 10);
  const value = REQUESTED_UPDATE_DATE.trim();

  if (!value) {
    return fallbackDate;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid --date value "${value}". Use YYYY-MM-DD.`);
  }

  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid --date value "${value}". Use a real calendar date.`);
  }

  return value;
}

async function fetchProjectionPool(config) {
  const sources = config.projectionSources || {};
  const hitterUrl =
    sources.hittersUrl || "https://razzball.com/restofseason-hitterprojections";
  const pitcherUrl =
    sources.pitchersUrl || "https://razzball.com/restofseason-pitcherprojections";

  const [hitters, pitchers] = await Promise.all([
    fetchRazzballProjectionTable(hitterUrl, "hitting"),
    fetchRazzballProjectionTable(pitcherUrl, "pitching")
  ]);

  return {
    hitters,
    pitchers,
    source: "Razzball/Steamer rest-of-season projections",
    hitterUrl,
    pitcherUrl
  };
}

async function fetchSavantMetricPool(season, updatedAt) {
  const [batters, pitchers] = await Promise.all([
    fetchSavantLeaderboard("batter", season),
    fetchSavantLeaderboard("pitcher", season)
  ]);

  const batterMetrics = buildSavantMetrics(batters, "batter", season, updatedAt);
  const pitcherMetrics = buildSavantMetrics(pitchers, "pitcher", season, updatedAt);
  return new Map([...batterMetrics, ...pitcherMetrics]);
}

async function fetchSavantLeaderboard(type, season) {
  const sort = type === "pitcher" ? "xwoba" : "xwoba";
  const sortDir = type === "pitcher" ? "asc" : "desc";
  const url =
    `https://baseballsavant.mlb.com/leaderboard/custom?csv=true` +
    `&chart=false&chartType=beeswarm&min=0&r=no` +
    `&selections=pa%2Ck_percent%2Cbb_percent%2Cxwoba%2Cxba%2Cxslg%2Cbarrel_batted_rate%2Chard_hit_percent%2Cexit_velocity_avg%2Cwhiff_percent%2Cswing_percent` +
    `&sort=${sort}&sortDir=${sortDir}&type=${type}&year=${season}`;
  const csv = await fetchText(url);
  return parseCsv(csv);
}

function buildSavantMetrics(rows, role, season, updatedAt) {
  const definitions = getSavantMetricDefinitions(role);
  const rowsWithMetrics = rows
    .map((row) => {
      const playerId = Number(row.player_id);
      if (!Number.isInteger(playerId)) {
        return null;
      }

      return {
        playerId,
        role,
        raw: row,
        values: Object.fromEntries(
          definitions.map((definition) => [
            definition.key,
            toNullableNumber(row[definition.key])
          ])
        )
      };
    })
    .filter(Boolean);

  const percentilesByMetric = Object.fromEntries(
    definitions.map((definition) => [
      definition.key,
      buildPercentileLookup(rowsWithMetrics, definition)
    ])
  );

  return rowsWithMetrics.map((row) => {
    return [
      getSavantMapKey(row.playerId, role),
      {
        source: "Baseball Savant Custom Leaderboard CSV",
        season,
        updatedAt,
        role,
        metrics: definitions.map((definition) => {
          const value = row.values[definition.key];
          return {
            key: definition.key,
            label: definition.label,
            value,
            display: formatSavantMetricValue(value, definition),
            percentile: percentilesByMetric[definition.key].get(row.playerId) || null,
            higherIsBetter: definition.higherIsBetter
          };
        })
      }
    ];
  });
}

function getSavantMapKey(playerId, role) {
  return `${playerId}:${role}`;
}

function getSavantMetricDefinitions(role) {
  const shared = [
    { key: "xwoba", label: "xwOBA", decimals: 3 },
    { key: "xba", label: "xBA", decimals: 3 },
    { key: "xslg", label: "xSLG", decimals: 3 },
    { key: "barrel_batted_rate", label: "Barrel %", decimals: 1, suffix: "%" },
    { key: "hard_hit_percent", label: "Hard-Hit %", decimals: 1, suffix: "%" },
    { key: "exit_velocity_avg", label: "Avg EV", decimals: 1 },
    { key: "k_percent", label: "K %", decimals: 1, suffix: "%" },
    { key: "bb_percent", label: "BB %", decimals: 1, suffix: "%" },
    { key: "whiff_percent", label: "Whiff %", decimals: 1, suffix: "%" },
    { key: "swing_percent", label: "Swing %", decimals: 1, suffix: "%" }
  ];

  return shared.map((definition) => {
    const lowerIsBetterForHitters = ["k_percent", "whiff_percent", "swing_percent"];
    const higherIsBetterForPitchers = ["k_percent", "whiff_percent"];
    const higherIsBetter =
      role === "pitcher"
        ? higherIsBetterForPitchers.includes(definition.key)
        : !lowerIsBetterForHitters.includes(definition.key);

    return {
      ...definition,
      higherIsBetter
    };
  });
}

function buildPercentileLookup(rows, definition) {
  const values = rows
    .map((row) => row.values[definition.key])
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  const percentileByPlayerId = new Map();

  rows.forEach((row) => {
    const value = row.values[definition.key];
    if (!Number.isFinite(value) || values.length === 0) {
      return;
    }

    const lessOrEqual = values.filter((candidate) => candidate <= value).length;
    const greaterOrEqual = values.filter((candidate) => candidate >= value).length;
    const rawPercentile = definition.higherIsBetter
      ? lessOrEqual / values.length
      : greaterOrEqual / values.length;
    percentileByPlayerId.set(row.playerId, clamp(Math.round(rawPercentile * 100), 1, 100));
  });

  return percentileByPlayerId;
}

function formatSavantMetricValue(value, definition) {
  if (!Number.isFinite(value)) {
    return "N/A";
  }

  const formatted = value.toFixed(definition.decimals);
  const trimmed =
    definition.decimals === 3 ? formatted.replace(/^0/, "") : formatted;
  return `${trimmed}${definition.suffix || ""}`;
}

async function fetchRazzballProjectionTable(url, group) {
  const html = await fetchText(url);
  const tableMatch = html.match(
    /<table[^>]+id=["']neorazzstatstable["'][\s\S]*?<\/table>/i
  );

  if (!tableMatch) {
    throw new Error(`Could not find projection table at ${url}`);
  }

  const rows = parseHtmlTable(tableMatch[0]);
  if (rows.length < 2) {
    throw new Error(`Projection table had no rows at ${url}`);
  }

  const headers = rows[0];
  return rows
    .slice(1)
    .map((row) => rowToObject(headers, row))
    .filter((row) => row.Name)
    .map((row) => normalizeProjection(row, group));
}

function parseHtmlTable(tableHtml) {
  const rowMatches = tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  return rowMatches.map((rowHtml) => {
    const cellMatches = rowHtml.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || [];
    return cellMatches.map((cellHtml) => {
      return decodeHtml(stripTags(cellHtml)).replace(/\s+/g, " ").trim();
    });
  });
}

function rowToObject(headers, row) {
  return headers.reduce((object, header, index) => {
    object[header] = row[index] || "";
    return object;
  }, {});
}

function normalizeProjection(row, group) {
  if (group === "pitching") {
    return {
      group,
      name: row.Name,
      team: row.Team,
      positions: [row.POS || "P"].filter(Boolean),
      throws: row["R/L"] || "",
      projected: {
        games: toNumber(row.G),
        gamesStarted: toNumber(row.GS),
        qualityStarts: toNumber(row.QS),
        inningsPitched: toNumber(row.IP),
        wins: toNumber(row.W),
        saves: toNumber(row.SV),
        holds: toNumber(row.HLD),
        strikeOuts: toNumber(row.K),
        baseOnBalls: toNumber(row.BB),
        earnedRuns: getProjectedEarnedRuns(row.IP, row.ERA),
        era: toNumber(row.ERA),
        siera: toNumber(row.SIERA),
        whip: toNumber(row.WHIP)
      },
      sourceId: row.RazzID
    };
  }

  return {
    group,
    name: row.Name,
    team: row.Team,
    positions: parsePositions(row.ESPN || row.YAHOO),
    bats: row.Bats || "",
    projected: {
      games: toNumber(row.G),
      plateAppearances: toNumber(row.PA),
      atBats: toNumber(row.AB),
      runs: toNumber(row.R),
      homeRuns: toNumber(row.HR),
      rbi: toNumber(row.RBI),
      stolenBases: toNumber(row.SB),
      hits: toNumber(row.H),
      strikeOuts: toNumber(row.SO),
      baseOnBalls: toNumber(row.BB),
      avg: toNumber(row.AVG),
      obp: toNumber(row.OBP),
      slg: toNumber(row.SLG),
      ops: toNumber(row.OPS)
    },
    sourceId: row.RazzID
  };
}

async function buildPlayerValues({
  config,
  playerIndex,
  mlbPlayersByName,
  currentHittingStats,
  currentPitchingStats,
  savantById,
  projections,
  season,
  updatedAt
}) {
  const manualById = new Map((config.players || []).map((player) => [player.mlbId, player]));
  const hitterValues = scoreHitters(projections.hitters, config.leagueSettings);
  const pitcherValues = scorePitchers(projections.pitchers, config.leagueSettings);
  const projectionValues = [...hitterValues, ...pitcherValues];
  const sourcePersonCache = new Map();
  const seenIds = new Set();

  const playerRecords = await Promise.all(
    projectionValues.map(async (projectionValue) => {
      const mlbPerson = await chooseMlbPerson({
        projectionValue,
        mlbPlayersByName,
        currentHittingStats,
        currentPitchingStats,
        sourcePersonCache
      });
      const manual = mlbPerson ? manualById.get(mlbPerson.mlbId) : null;
      const mlbId = mlbPerson?.mlbId || null;
      const currentStats =
        projectionValue.group === "pitching"
          ? currentPitchingStats.get(mlbId)
          : currentHittingStats.get(mlbId);

      if (mlbId && seenIds.has(mlbId)) {
        return null;
      }
      if (mlbId) {
        seenIds.add(mlbId);
      }

      const savantRole = projectionValue.group === "pitching" ? "pitcher" : "batter";

      return buildPlayerRecord({
        projectionValue,
        mlbPerson,
        manual,
        currentStats,
        savant: mlbId ? savantById.get(getSavantMapKey(mlbId, savantRole)) : null,
        projections,
        season,
        updatedAt
      });
    })
  );

  return playerRecords.filter(Boolean).sort((a, b) => {
    return b.recommendation.score - a.recommendation.score;
  });
}

async function chooseMlbPerson({
  projectionValue,
  mlbPlayersByName,
  currentHittingStats,
  currentPitchingStats,
  sourcePersonCache
}) {
  const candidates = mlbPlayersByName.get(normalizeNameKey(projectionValue.name)) || [];
  const compatibleCandidates = candidates.filter((candidate) => {
    return isCompatibleWithProjectionGroup(candidate, projectionValue.group);
  });

  const statsMatchedCandidates = compatibleCandidates.filter((candidate) => {
    const statsMap =
      projectionValue.group === "pitching" ? currentPitchingStats : currentHittingStats;
    return statsMap.has(candidate.mlbId);
  });

  if (statsMatchedCandidates.length === 1) {
    return statsMatchedCandidates[0];
  }

  if (compatibleCandidates.length === 1) {
    return compatibleCandidates[0];
  }

  const sourcePerson = await fetchMlbPersonFromSourceId(
    projectionValue,
    sourcePersonCache
  );

  if (sourcePerson) {
    return sourcePerson;
  }

  return compatibleCandidates[0] || null;
}

async function fetchMlbPersonFromSourceId(projectionValue, sourcePersonCache) {
  const sourceId = Number(projectionValue.sourceId);

  if (!Number.isInteger(sourceId) || sourceId <= 0) {
    return null;
  }

  if (!sourcePersonCache.has(sourceId)) {
    sourcePersonCache.set(sourceId, fetchPersonById(sourceId).catch(() => null));
  }

  const person = await sourcePersonCache.get(sourceId);
  if (!person || normalizeNameKey(person.fullName) !== normalizeNameKey(projectionValue.name)) {
    return null;
  }

  const mlbPerson = {
    name: person.fullName,
    mlbId: person.id,
    team: person.currentTeam?.abbreviation || "",
    position: person.primaryPosition?.abbreviation || "",
    active: person.active !== false
  };

  return isCompatibleWithProjectionGroup(mlbPerson, projectionValue.group)
    ? mlbPerson
    : null;
}

async function fetchPersonById(mlbId) {
  const data = await fetchJson(`${MLB_API_BASE}/people/${mlbId}?hydrate=currentTeam,team`);
  return data.people?.[0] || null;
}

function isCompatibleWithProjectionGroup(player, group) {
  const position = String(player.position || "").toUpperCase();
  const isPitcher = ["P", "SP", "RP"].includes(position);
  return group === "pitching" ? isPitcher : !isPitcher;
}

function scoreHitters(hitters) {
  const projectionPoolMinimumPlateAppearances = getDynamicHitterProjectionPoolMinimumPa(hitters);
  const eligible = hitters.filter((player) => {
    return player.projected.plateAppearances >= projectionPoolMinimumPlateAppearances;
  });
  const metrics = {
    runs: getMeanAndStd(eligible.map((player) => player.projected.runs)),
    homeRuns: getMeanAndStd(eligible.map((player) => player.projected.homeRuns)),
    rbi: getMeanAndStd(eligible.map((player) => player.projected.rbi)),
    stolenBases: getMeanAndStd(eligible.map((player) => player.projected.stolenBases)),
    avgImpact: getMeanAndStd(
      eligible.map((player) => {
        return (player.projected.avg - 0.245) * Math.sqrt(player.projected.atBats || 1);
      })
    )
  };

  const scored = hitters.map((player) => {
    const projected = player.projected;
    const avgImpact = (projected.avg - 0.245) * Math.sqrt(projected.atBats || 1);
    const rawValue =
      z(projected.runs, metrics.runs) +
      z(projected.homeRuns, metrics.homeRuns) +
      z(projected.rbi, metrics.rbi) +
      z(projected.stolenBases, metrics.stolenBases) +
      z(avgImpact, metrics.avgImpact);
    const positionAdjustment = getHitterPositionScarcityAdjustment(player.positions);
    const adjustedValue = rawValue + positionAdjustment;

    return {
      ...player,
      fantasyValue: round(adjustedValue, 2),
      fantasyValueRaw: round(rawValue, 2),
      positionAdjustment: round(positionAdjustment, 2),
      projectionPoolMinimumPlateAppearances
    };
  });

  const percentilePool = scored.filter((player) => {
    return player.projected.plateAppearances >= projectionPoolMinimumPlateAppearances;
  });
  return addPercentileScores(scored, percentilePool);
}

function getDynamicHitterProjectionPoolMinimumPa(hitters) {
  const projectedPlateAppearances = hitters
    .map((player) => player.projected.plateAppearances)
    .filter((plateAppearances) => Number.isFinite(plateAppearances) && plateAppearances > 0)
    .sort((a, b) => a - b);

  if (projectedPlateAppearances.length === 0) {
    return HITTER_PROJECTION_POOL_MIN_PA;
  }

  const percentileIndex = Math.floor(
    (projectedPlateAppearances.length - 1) * HITTER_PROJECTION_POOL_PA_PERCENTILE
  );
  const percentilePlateAppearances = projectedPlateAppearances[percentileIndex];

  return clamp(
    Math.round(percentilePlateAppearances),
    HITTER_PROJECTION_POOL_MIN_PA,
    HITTER_PROJECTION_POOL_MAX_PA
  );
}

function getHitterPositionScarcityAdjustment(positions) {
  const adjustments = {
    C: 0.75,
    "2B": 0.35,
    SS: 0.25,
    "3B": 0.1,
    "1B": 0,
    OF: 0,
    DH: 0,
    UTIL: 0
  };
  const eligiblePositions = (positions || []).map((position) => String(position).toUpperCase());
  return eligiblePositions.reduce((best, position) => {
    return Math.max(best, adjustments[position] ?? 0);
  }, 0);
}

function scorePitchers(pitchers) {
  const eligible = pitchers.filter((player) => player.projected.inningsPitched >= 40);
  const metrics = {
    qualityStarts: getMeanAndStd(eligible.map((player) => player.projected.qualityStarts)),
    wins: getMeanAndStd(eligible.map((player) => player.projected.wins)),
    saves: getMeanAndStd(eligible.map((player) => player.projected.saves)),
    strikeOuts: getMeanAndStd(eligible.map((player) => player.projected.strikeOuts)),
    eraImpact: getMeanAndStd(
      eligible.map((player) => {
        return (3.9 - player.projected.era) * Math.sqrt(player.projected.inningsPitched || 1);
      })
    ),
    whipImpact: getMeanAndStd(
      eligible.map((player) => {
        return (1.28 - player.projected.whip) * Math.sqrt(player.projected.inningsPitched || 1);
      })
    )
  };

  const scored = pitchers.map((player) => {
    const projected = player.projected;
    const eraImpact = (3.9 - projected.era) * Math.sqrt(projected.inningsPitched || 1);
    const whipImpact = (1.28 - projected.whip) * Math.sqrt(projected.inningsPitched || 1);
    const rawValue =
      z(projected.qualityStarts, metrics.qualityStarts) +
      z(projected.wins, metrics.wins) +
      z(projected.saves, metrics.saves) +
      z(projected.strikeOuts, metrics.strikeOuts) +
      z(eraImpact, metrics.eraImpact) +
      z(whipImpact, metrics.whipImpact);

    return {
      ...player,
      fantasyValue: round(rawValue, 2)
    };
  });

  const percentilePool = scored.filter((player) => player.projected.inningsPitched >= 40);
  return addPercentileScores(scored, percentilePool);
}

function addPercentileScores(players, percentilePool = players) {
  const sortedValues = percentilePool
    .map((player) => player.fantasyValue)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);

  return players.map((player) => {
    const lowerCount = sortedValues.filter((value) => value <= player.fantasyValue).length;
    const percentile =
      sortedValues.length <= 1 ? 1 : (lowerCount - 1) / Math.max(sortedValues.length - 1, 1);
    const score = clamp(Math.round(percentile * 99) + 1, 1, 100);

    return {
      ...player,
      score
    };
  });
}

function applyRatings(players) {
  const rawComponents = players.map((player) => {
    return {
      key: getPlayerRatingKey(player),
      player,
      seasonRaw: getSeasonStatsRawValue(player),
      recentRaw: getRecentTrendRawValue(player),
      savantRaw: getSavantSkillRawValue(player)
    };
  });
  const componentScores = {
    seasonStats: buildComponentScoreLookup(rawComponents, "seasonRaw"),
    recentTrend: buildComponentScoreLookup(rawComponents, "recentRaw"),
    savantSkills: buildComponentScoreLookup(rawComponents, "savantRaw")
  };

  return players.map((player) => {
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
    const savantScore = regressComponentScore({
      componentScore: componentScores.savantSkills.get(key),
      projectionScore,
      reliability: player.savant?.metrics?.length ? 1 : 0
    });
    const currentFormScore = Math.round(
      seasonScore * 0.5 + recentScore * 0.3 + savantScore * 0.2
    );
    const finalScore = clamp(
      Math.round(
        projectionScore * RATING_PROJECTION_WEIGHT +
        currentFormScore * RATING_CURRENT_FORM_WEIGHT
      ),
      1,
      100
    );
    const adjustedScore = clamp(
      finalScore + toNumber(getManualRecommendation(player).scoreAdjustment),
      1,
      100
    );
    const action =
      getManualRecommendation(player).forceStartSit ||
      getManualRecommendation(player).startSitOverride ||
      getActionFromScore(adjustedScore);
    const confidence =
      getManualRecommendation(player).confidenceOverride ||
      getConfidenceFromScore(adjustedScore);
    const rating = {
      score: adjustedScore,
      action,
      confidence,
      components: {
        projection: Math.round(projectionScore),
        currentForm: currentFormScore,
        seasonStats: seasonScore,
        recentTrend: recentScore,
        savantSkills: savantScore
      },
      weights: {
        projection: RATING_PROJECTION_WEIGHT,
        currentForm: RATING_CURRENT_FORM_WEIGHT
      },
      notes: [
        "Rest-of-season projection weighted 60%; current form weighted 40%.",
        "Current form includes season form, recent games, and Savant skills."
      ],
      modelVersion: "rest-of-season-blend-v2"
    };

    return {
      ...player,
      rating,
      recommendation: {
        ...player.recommendation,
        score: rating.score,
        startSit: rating.action,
        confidence: rating.confidence,
        scoringNotes: getRatingScoringNotes(rating)
      },
      source: {
        ...player.source,
        recentGames: player.recentGames?.source || "MLB Stats API game logs",
        savant: player.savant?.source || "Baseball Savant Custom Leaderboard CSV",
        recommendation: "rest-of-season blended rating",
        ratingModel: rating.modelVersion
      }
    };
  });
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
      ((3.9 - (era ?? 3.9)) * Math.sqrt(inningsPitched || 1)) +
      ((1.28 - (whip ?? 1.28)) * Math.sqrt(inningsPitched || 1))
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
          baseOnBalls: sum.baseOnBalls + toNumber(game.baseOnBalls),
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
        baseOnBalls: 0,
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

function getSavantSkillRawValue(player) {
  const metrics = player.savant?.metrics || [];
  const scoredMetrics = metrics.filter((metric) => Number.isFinite(Number(metric.percentile)));
  if (scoredMetrics.length === 0) {
    return null;
  }

  return (
    scoredMetrics.reduce((total, metric) => total + Number(metric.percentile), 0) /
    scoredMetrics.length
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

function isReliefPitcher(player) {
  const positions = [
    ...(Array.isArray(player.positions) ? player.positions : []),
    ...(Array.isArray(player.projection?.positions) ? player.projection.positions : [])
  ].map((position) => String(position).trim().toUpperCase());

  return positions.includes("RP") && !positions.includes("SP");
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

function getPlayerRatingKey(player) {
  return `${player.mlbId || player.name}:${player.projection?.group || player.stats?.group || "unknown"}`;
}

function getManualRecommendation(player) {
  return player.manualRecommendation || {};
}

function zFriendlyCount(value) {
  return toNumber(value) * 2;
}

function getRatingScoringNotes(rating) {
  return `Projection ${rating.components.projection}; current form ${rating.components.currentForm}; final blended score ${rating.score}.`;
}

function applyDeterministicDecisions(players, config, updatedAt) {
  return players.map((player) => {
    return {
      ...player,
      decision: buildDeterministicDecision(player, config, updatedAt)
    };
  });
}

function buildDeterministicDecision(player, config, updatedAt) {
  const profile = getDecisionProfile(player, config);
  const badges = buildDecisionBadges(player, profile);

  return {
    source: "deterministic-rule-engine",
    modelVersion: DECISION_ENGINE_VERSION,
    generatedAt: updatedAt,
    summary: buildDecisionSummary(player, profile),
    badges,
    keyPoints: buildDecisionKeyPoints(player, profile, badges),
    risk: buildDecisionRisk(player, profile, badges)
  };
}

function getDecisionProfile(player, config) {
  const group = player.projection?.group || player.stats?.group || "hitting";
  const components = {
    projection: toNumber(player.rating?.components?.projection),
    currentForm: toNumber(player.rating?.components?.currentForm),
    seasonStats: toNumber(player.rating?.components?.seasonStats),
    recentTrend: toNumber(player.rating?.components?.recentTrend),
    savantSkills: toNumber(player.rating?.components?.savantSkills)
  };
  const stats = player.stats || {};
  const projection = player.projection || {};
  const recentGames = player.recentGames?.games || [];
  const recentTotals = getRecentDecisionTotals(player, group);
  const recentTrendGameCount = getRecentTrendGameCount(player);
  const plateAppearances = toNumber(stats.plateAppearances);
  const inningsPitched = inningsPitchedToNumber(stats.inningsPitched);

  return {
    group,
    action: player.rating?.action || player.recommendation?.startSit || getActionFromScore(player.rating?.score || 0),
    score: toNumber(player.rating?.score || player.recommendation?.score),
    components,
    categories: config.leagueSettings?.categories || [],
    stats,
    projection,
    recentGames,
    recentTotals,
    recentTrendGameCount,
    smallSample:
      group === "pitching"
        ? inningsPitched < 15 || recentGames.length < 3
        : plateAppearances < 60 || recentGames.length < 3,
    hitterKRate:
      plateAppearances > 0 ? toNumber(stats.strikeOuts) / plateAppearances : null,
    hitterBbRate:
      plateAppearances > 0 ? toNumber(stats.baseOnBalls) / plateAppearances : null
  };
}

function buildDecisionBadges(player, profile) {
  const badges = [];
  const { projection, currentForm, recentTrend, savantSkills } = profile.components;

  if (projection >= 85) {
    addDecisionBadge(
      badges,
      "Projection Anchor",
      "positive",
      `Proj ${projection}`,
      `Rest-of-season projection component is ${projection}, an anchor-level score.`
    );
  } else if (projection >= 70) {
    addDecisionBadge(
      badges,
      "Projection Edge",
      "positive",
      `Proj ${projection}`,
      `Rest-of-season projection component is ${projection}, above the 70-point edge threshold.`
    );
  }

  if (currentForm >= 70) {
    addDecisionBadge(
      badges,
      "Current Form Support",
      "positive",
      `Form ${currentForm}`,
      `Current Form component is ${currentForm}, so recent and season inputs support the projection.`
    );
  } else if (projection - currentForm >= 25) {
    addDecisionBadge(
      badges,
      "Projection Carry",
      "neutral",
      `${projection} vs ${currentForm}`,
      `Projection is carrying the score: projection ${projection}, current form ${currentForm}.`
    );
  }

  if (profile.group === "pitching") {
    addPitcherDecisionBadges(player, profile, badges);
  } else {
    addHitterDecisionBadges(player, profile, badges);
  }

  const recentTrendLabel = getRecentTrendBadgeLabel(recentTrend, profile.recentTrendGameCount);
  if (recentTrend >= 70) {
    addDecisionBadge(
      badges,
      recentTrendLabel,
      "positive",
      `Trend ${recentTrend}`,
      `Recent Trend component is ${recentTrend} over the last ${profile.recentTrendGameCount} games.`
    );
  } else if (recentTrend < 40) {
    addDecisionBadge(
      badges,
      recentTrendLabel,
      "caution",
      `Trend ${recentTrend}`,
      `Recent Trend component is ${recentTrend} over the last ${profile.recentTrendGameCount} games.`
    );
  }

  if (savantSkills >= 70) {
    addDecisionBadge(
      badges,
      "Savant Support",
      "positive",
      `Savant ${savantSkills}`,
      `Savant Skills component is ${savantSkills}, reinforcing the underlying profile.`
    );
  } else if (savantSkills > 0 && savantSkills < 40) {
    addDecisionBadge(
      badges,
      "Savant Warning",
      "caution",
      `Savant ${savantSkills}`,
      `Savant Skills component is ${savantSkills}, a caution flag beneath the projection.`
    );
  }

  if (profile.smallSample) {
    addDecisionBadge(
      badges,
      "Small Sample",
      "neutral",
      getSmallSampleBadgeDetail(profile),
      "Current-season or recent-game sample is still thin, so form inputs are less stable."
    );
  }

  return prioritizeDecisionBadges(badges).slice(0, 5);
}

function prioritizeDecisionBadges(badges) {
  const priority = [
    "Projection Anchor",
    "Projection Edge",
    "Current Form Support",
    "Projection Carry",
    "Power Source",
    "Speed Source",
    "K Upside",
    "Ratio Risk",
    "AVG Drag",
    "QS Volume",
    "Ratio Support",
    "Save Path",
    "Hot Last 7",
    "Hot Last 5",
    "Hot Last 3",
    "Cold Last 7",
    "Cold Last 5",
    "Cold Last 3",
    "Savant Warning",
    "Average Help",
    "Strikeout Risk",
    "Walk Risk",
    "Contact Risk",
    "Savant Support",
    "Small Sample",
    "Contact Quality"
  ];

  return badges.slice().sort((a, b) => {
    const aIndex = priority.includes(a.label) ? priority.indexOf(a.label) : priority.length;
    const bIndex = priority.includes(b.label) ? priority.indexOf(b.label) : priority.length;
    return aIndex - bIndex;
  });
}

function getRecentTrendBadgeLabel(recentTrend, gameCount) {
  const prefix = recentTrend >= 70 ? "Hot" : "Cold";
  return `${prefix} Last ${gameCount}`;
}

function addHitterDecisionBadges(player, profile, badges) {
  const projection = profile.projection;
  const stats = profile.stats;
  const projectedHr = toNumber(projection.homeRuns);
  const projectedSb = toNumber(projection.stolenBases);
  const projectedAvg = toNullableNumber(projection.avg);
  const currentAvg = toNullableNumber(stats.avg);
  const barrelPercentile = getSavantPercentile(player, "Barrel %");
  const hardHitPercentile = getSavantPercentile(player, "Hard-Hit %");
  const exitVelocityPercentile = getSavantPercentile(player, "Avg EV");
  const xbaPercentile = getSavantPercentile(player, "xBA");
  const xslgPercentile = getSavantPercentile(player, "xSLG");

  if (projectedHr >= 25) {
    addDecisionBadge(
      badges,
      "Power Source",
      "positive",
      `${Math.round(projectedHr)} HR`,
      `Projected for ${Math.round(projectedHr)} home runs, clearing the 25-HR power threshold.`
    );
  } else if (barrelPercentile >= 70) {
    addDecisionBadge(
      badges,
      "Power Source",
      "positive",
      `Barrel ${formatPercentileDetail(barrelPercentile)}`,
      `Barrel rate is in the ${formatPercentileDetail(barrelPercentile)} percentile.`
    );
  } else if (xslgPercentile >= 70) {
    addDecisionBadge(
      badges,
      "Power Source",
      "positive",
      `xSLG ${formatPercentileDetail(xslgPercentile)}`,
      `Expected slugging is in the ${formatPercentileDetail(xslgPercentile)} percentile.`
    );
  }

  if (projectedSb >= 15) {
    addDecisionBadge(
      badges,
      "Speed Source",
      "positive",
      `${Math.round(projectedSb)} SB`,
      `Projected for ${Math.round(projectedSb)} stolen bases, clearing the 15-SB speed threshold.`
    );
  } else if (toNumber(stats.stolenBases) >= 5) {
    addDecisionBadge(
      badges,
      "Speed Source",
      "positive",
      `${toNumber(stats.stolenBases)} SB`,
      `Current-season stolen base total is ${toNumber(stats.stolenBases)}.`
    );
  }

  if ((projectedAvg && projectedAvg >= 0.27) || (currentAvg && currentAvg >= 0.27 && xbaPercentile >= 55)) {
    const detail = projectedAvg && projectedAvg >= 0.27
      ? `${formatRateForBadge(projectedAvg)} AVG`
      : `${formatRateForBadge(currentAvg)} AVG`;
    addDecisionBadge(
      badges,
      "Average Help",
      "positive",
      detail,
      `Batting average profile is a strength: ${detail}.`
    );
  } else if ((projectedAvg && projectedAvg < 0.24) || (currentAvg && currentAvg < 0.23 && xbaPercentile < 45)) {
    const detail = projectedAvg && projectedAvg < 0.24
      ? `${formatRateForBadge(projectedAvg)} AVG`
      : `${formatRateForBadge(currentAvg)} AVG`;
    addDecisionBadge(
      badges,
      "AVG Drag",
      "caution",
      detail,
      `Batting average profile is a likely drag: ${detail}${
        xbaPercentile > 0 ? `, xBA ${formatPercentileDetail(xbaPercentile)} percentile.` : "."
      }`
    );
  }

  if (hardHitPercentile >= 70) {
    addDecisionBadge(
      badges,
      "Contact Quality",
      "positive",
      `HardHit ${formatPercentileDetail(hardHitPercentile)}`,
      `Hard-hit rate is in the ${formatPercentileDetail(hardHitPercentile)} percentile.`
    );
  } else if (exitVelocityPercentile >= 70) {
    addDecisionBadge(
      badges,
      "Contact Quality",
      "positive",
      `EV ${formatPercentileDetail(exitVelocityPercentile)}`,
      `Average exit velocity is in the ${formatPercentileDetail(exitVelocityPercentile)} percentile.`
    );
  }

  if (hasHitterStrikeoutRisk(player, profile)) {
    addDecisionBadge(
      badges,
      "Strikeout Risk",
      "risk",
      getHitterStrikeoutRiskDetail(player, profile),
      "Strikeout indicators add volatility to the short-term hitting profile."
    );
  }
}

function addPitcherDecisionBadges(player, profile, badges) {
  const projection = profile.projection;
  const stats = profile.stats;
  const projectedEra = toNullableNumber(projection.era);
  const projectedWhip = toNullableNumber(projection.whip);
  const currentEra = toNullableNumber(stats.era);
  const currentWhip = toNullableNumber(stats.whip);
  const xwobaPercentile = getSavantPercentile(player, "xwOBA");
  const xbaPercentile = getSavantPercentile(player, "xBA");
  const xslgPercentile = getSavantPercentile(player, "xSLG");
  const hardHitPercentile = getSavantPercentile(player, "Hard-Hit %");
  const exitVelocityPercentile = getSavantPercentile(player, "Avg EV");
  const kPercentile = getSavantPercentile(player, "K %");
  const bbPercentile = getSavantPercentile(player, "BB %");
  const whiffPercentile = getSavantPercentile(player, "Whiff %");

  if (toNumber(projection.strikeOuts) >= 170) {
    addDecisionBadge(
      badges,
      "K Upside",
      "positive",
      `${Math.round(toNumber(projection.strikeOuts))} K`,
      `Projected for ${Math.round(toNumber(projection.strikeOuts))} strikeouts.`
    );
  } else if (kPercentile >= 70) {
    addDecisionBadge(
      badges,
      "K Upside",
      "positive",
      `K ${formatPercentileDetail(kPercentile)}`,
      `Strikeout rate is in the ${formatPercentileDetail(kPercentile)} percentile.`
    );
  } else if (whiffPercentile >= 70) {
    addDecisionBadge(
      badges,
      "K Upside",
      "positive",
      `Whiff ${formatPercentileDetail(whiffPercentile)}`,
      `Whiff rate is in the ${formatPercentileDetail(whiffPercentile)} percentile.`
    );
  }

  if (toNumber(projection.qualityStarts) >= 15) {
    addDecisionBadge(
      badges,
      "QS Volume",
      "positive",
      `${Math.round(toNumber(projection.qualityStarts))} QS`,
      `Projected for ${Math.round(toNumber(projection.qualityStarts))} quality starts.`
    );
  } else if (toNumber(projection.inningsPitched) >= 160) {
    addDecisionBadge(
      badges,
      "QS Volume",
      "positive",
      `${Math.round(toNumber(projection.inningsPitched))} IP`,
      `Projected for ${Math.round(toNumber(projection.inningsPitched))} innings.`
    );
  }

  if (
    (projectedEra && projectedEra <= 3.5 && projectedWhip && projectedWhip <= 1.15) ||
    (currentEra && currentEra <= 3.5 && currentWhip && currentWhip <= 1.15)
  ) {
    const detail = projectedEra && projectedEra <= 3.5 && projectedWhip && projectedWhip <= 1.15
      ? `${formatDecisionRate(projectedEra)}/${formatDecisionRate(projectedWhip)}`
      : `${formatDecisionRate(currentEra)}/${formatDecisionRate(currentWhip)}`;
    addDecisionBadge(
      badges,
      "Ratio Support",
      "positive",
      detail,
      `ERA/WHIP profile supports fantasy ratios: ${detail}.`
    );
  }

  if (toNumber(projection.saves) >= 10) {
    addDecisionBadge(
      badges,
      "Save Path",
      "positive",
      `${Math.round(toNumber(projection.saves))} SV`,
      `Projected for ${Math.round(toNumber(projection.saves))} saves.`
    );
  } else if (toNumber(stats.saves) > 0) {
    addDecisionBadge(
      badges,
      "Save Path",
      "positive",
      `${toNumber(stats.saves)} SV`,
      `Current-season save total is ${toNumber(stats.saves)}.`
    );
  }

  if ((currentEra && currentEra >= 4.5) || (currentWhip && currentWhip >= 1.35)) {
    const detail = currentEra && currentEra >= 4.5
      ? `${formatDecisionRate(currentEra)} ERA`
      : `${formatDecisionRate(currentWhip)} WHIP`;
    addDecisionBadge(
      badges,
      "Ratio Risk",
      "risk",
      detail,
      `Current ratios are adding risk: ${detail}.`
    );
  }

  if (bbPercentile > 0 && bbPercentile < 40) {
    addDecisionBadge(
      badges,
      "Walk Risk",
      "caution",
      `BB ${formatPercentileDetail(bbPercentile)}`,
      `Walk rate is in the ${formatPercentileDetail(bbPercentile)} percentile.`
    );
  }

  if (
    (xwobaPercentile > 0 && xwobaPercentile < 40) ||
    (xbaPercentile > 0 && xbaPercentile < 40) ||
    (xslgPercentile > 0 && xslgPercentile < 40) ||
    (hardHitPercentile > 0 && hardHitPercentile < 40) ||
    (exitVelocityPercentile > 0 && exitVelocityPercentile < 40)
  ) {
    const contactRisk = getFirstSavantRiskDetail([
      ["xwOBA", xwobaPercentile],
      ["xBA", xbaPercentile],
      ["xSLG", xslgPercentile],
      ["HardHit", hardHitPercentile],
      ["EV", exitVelocityPercentile]
    ]);
    addDecisionBadge(
      badges,
      "Contact Risk",
      "caution",
      contactRisk.detail,
      contactRisk.description
    );
  }
}

function addDecisionBadge(badges, label, tone, detail = "", description = "") {
  if (!label || badges.some((badge) => badge.label === label)) {
    return;
  }

  const badge = { label, tone };
  const cleanDetail = String(detail || "").trim();
  const cleanDescription = String(description || "").trim();

  if (cleanDetail) {
    badge.detail = cleanDetail;
  }
  if (cleanDescription) {
    badge.description = cleanDescription;
  }

  badges.push(badge);
}

function buildDecisionSummary(player, profile) {
  const { projection, currentForm } = profile.components;

  if (profile.action === "Bench") {
    return profile.group === "pitching"
      ? "Bench unless you are chasing a specific pitching category."
      : "Bench unless you are chasing a specific category.";
  }

  if (profile.action === "Watch") {
    return "Watch closely; the profile has usable pieces, but the score is not strong enough for an automatic start.";
  }

  if (projection >= 70 && currentForm >= 70) {
    return "Start confidently because projection and current form are both supporting the profile.";
  }

  if (projection >= 70 && currentForm < 55) {
    return profile.group === "pitching"
      ? "Start for rest-of-season pitching value, but current form adds short-term risk."
      : "Start for rest-of-season value, but current form does not support chasing short-term upside.";
  }

  return profile.group === "pitching"
    ? "Start for projected pitching value with enough category support to keep him active."
    : "Start for projected category value with enough support to keep him in lineups.";
}

function buildDecisionKeyPoints(player, profile, badges) {
  const points = [];
  const { projection, currentForm, recentTrend, savantSkills } = profile.components;

  if (projection >= 70 && projection - currentForm >= 25) {
    points.push(`Projection ${projection} is carrying the final score while Current Form is ${currentForm}.`);
  } else if (projection >= 70 && currentForm >= 70) {
    points.push(`Projection ${projection} and Current Form ${currentForm} are both supporting the final score.`);
  } else if (currentForm >= 70) {
    points.push(`Current Form ${currentForm} is supporting the recommendation beyond the projection.`);
  } else {
    points.push(`Projection ${projection} is the primary input in the final score.`);
  }

  const categoryPoint =
    profile.group === "pitching"
      ? getPitcherDecisionCategoryPoint(player, profile, badges)
      : getHitterDecisionCategoryPoint(player, profile, badges);
  if (categoryPoint) {
    points.push(categoryPoint);
  }

  if (recentTrend >= 70) {
    points.push(`Recent Trend ${recentTrend} is helping the score over the last ${profile.recentTrendGameCount} games.`);
  } else if (recentTrend < 40) {
    points.push(`Recent Trend ${recentTrend} is below average over the last ${profile.recentTrendGameCount} games.`);
  } else if (savantSkills >= 70) {
    points.push(`Savant Skills ${savantSkills} are reinforcing the underlying profile.`);
  } else if (savantSkills > 0 && savantSkills < 40) {
    points.push(`Savant Skills ${savantSkills} are a caution flag beneath the projection.`);
  }

  return points.slice(0, 3);
}

function getHitterDecisionCategoryPoint(player, profile, badges) {
  const projection = profile.projection;
  const recentTotals = profile.recentTotals;

  if (hasDecisionBadge(badges, "Power Source")) {
    return `Projected ${Math.round(toNumber(projection.homeRuns))} HR keeps him relevant for power categories.`;
  }

  if (hasDecisionBadge(badges, "Speed Source")) {
    return `Projected ${Math.round(toNumber(projection.stolenBases))} SB gives him category-specific upside.`;
  }

  if (hasDecisionBadge(badges, "Average Help")) {
    return `Average profile is a strength against the current hitter pool.`;
  }

  if (hasDecisionBadge(badges, "AVG Drag")) {
    return `Batting average is a likely drag unless the contact profile improves.`;
  }

  if (hasDecisionBadge(badges, "Strikeout Risk")) {
    return `Strikeout indicators add volatility to the short-term hitting profile.`;
  }

  if (recentTotals.atBats > 0) {
    return `Last ${profile.recentTrendGameCount} games: ${recentTotals.hits}/${recentTotals.atBats}, ${recentTotals.homeRuns} HR, ${recentTotals.rbi} RBI, ${recentTotals.stolenBases} SB.`;
  }

  return "";
}

function getPitcherDecisionCategoryPoint(player, profile, badges) {
  const projection = profile.projection;
  const recentTotals = profile.recentTotals;

  if (hasDecisionBadge(badges, "K Upside")) {
    return `Projected ${Math.round(toNumber(projection.strikeOuts))} K gives him clear strikeout upside.`;
  }

  if (hasDecisionBadge(badges, "QS Volume")) {
    return `Projected ${Math.round(toNumber(projection.qualityStarts))} QS and ${Math.round(toNumber(projection.inningsPitched))} IP support volume.`;
  }

  if (hasDecisionBadge(badges, "Ratio Support")) {
    return `Projected ratios are useful: ${formatDecisionRate(projection.era)} ERA and ${formatDecisionRate(projection.whip)} WHIP.`;
  }

  if (hasDecisionBadge(badges, "Save Path")) {
    return `Projected ${Math.round(toNumber(projection.saves))} SV keeps him relevant for saves.`;
  }

  if (hasDecisionBadge(badges, "Ratio Risk")) {
    return `Current ratios are adding risk: ${profile.stats.era || "--"} ERA and ${profile.stats.whip || "--"} WHIP.`;
  }

  if (recentTotals.inningsPitched > 0) {
    return `Last ${profile.recentTrendGameCount} games: ${formatDecisionRate(recentTotals.inningsPitched)} IP, ${recentTotals.strikeOuts} K, ${recentTotals.qualityStarts} QS.`;
  }

  return "";
}

function buildDecisionRisk(player, profile, badges) {
  if (profile.smallSample) {
    return "Sample is still thin, so current form should be weighted carefully.";
  }

  if (hasDecisionBadge(badges, "Ratio Risk")) {
    return "Ratio risk can offset strikeout or volume value in weekly matchups.";
  }

  if (profile.group === "hitting" && hasHitterStrikeoutRisk(player, profile)) {
    return "Strikeout indicators add week-to-week volatility.";
  }

  if (hasDecisionBadge(badges, "Projection Carry")) {
    return "Use as a rest-of-season play, not a hot-hand call.";
  }

  if (hasDecisionBadge(badges, "Savant Warning")) {
    return "Underlying skill indicators are weaker than the fantasy projection.";
  }

  if (profile.action === "Bench") {
    return "Only use if you are chasing one specific category and can absorb the downside.";
  }

  return "";
}

function hasDecisionBadge(badges, label) {
  return badges.some((badge) => badge.label === label);
}

function hasHitterStrikeoutRisk(player, profile) {
  const kPercentile = getSavantPercentile(player, "K %");
  const whiffPercentile = getSavantPercentile(player, "Whiff %");
  return (
    (profile.hitterKRate && profile.hitterKRate >= 0.28) ||
    (kPercentile > 0 && kPercentile < 35) ||
    (whiffPercentile > 0 && whiffPercentile < 35)
  );
}

function getSavantPercentile(player, label) {
  const metric = (player.savant?.metrics || []).find((candidate) => candidate.label === label);
  return Number.isFinite(Number(metric?.percentile)) ? Number(metric.percentile) : 0;
}

function formatPercentileDetail(value) {
  const percentile = Math.round(toNumber(value));
  return `${percentile}th`;
}

function formatRateForBadge(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "--";
  }

  return number.toFixed(3).replace(/^0/, "");
}

function getSmallSampleBadgeDetail(profile) {
  if (profile.group === "pitching") {
    return `${formatDecisionRate(inningsPitchedToNumber(profile.stats?.inningsPitched))} IP`;
  }

  return `${toNumber(profile.stats?.plateAppearances)} PA`;
}

function getHitterStrikeoutRiskDetail(player, profile) {
  const kPercentile = getSavantPercentile(player, "K %");
  const whiffPercentile = getSavantPercentile(player, "Whiff %");

  if (profile.hitterKRate) {
    return `${Math.round(profile.hitterKRate * 100)}% K`;
  }

  if (kPercentile > 0 && kPercentile < 35) {
    return `K ${formatPercentileDetail(kPercentile)}`;
  }

  if (whiffPercentile > 0 && whiffPercentile < 35) {
    return `Whiff ${formatPercentileDetail(whiffPercentile)}`;
  }

  return "K risk";
}

function getFirstSavantRiskDetail(metrics) {
  const risk = metrics.find(([, percentile]) => percentile > 0 && percentile < 40);

  if (!risk) {
    return {
      detail: "Skills <40th",
      description: "One or more contact-management skill indicators are below the 40th percentile."
    };
  }

  const [label, percentile] = risk;
  return {
    detail: `${label} ${formatPercentileDetail(percentile)}`,
    description: `${label} is in the ${formatPercentileDetail(percentile)} percentile, adding contact risk.`
  };
}

function getRecentDecisionTotals(player, group) {
  const games = (player.recentGames?.games || []).slice(0, getRecentTrendGameCount(player));

  if (group === "pitching") {
    return games.reduce(
      (totals, game) => {
        return {
          inningsPitched: totals.inningsPitched + inningsPitchedToNumber(game.inningsPitched),
          strikeOuts: totals.strikeOuts + toNumber(game.strikeOuts),
          baseOnBalls: totals.baseOnBalls + toNumber(game.baseOnBalls),
          qualityStarts: totals.qualityStarts + (game.qualityStart ? 1 : 0),
          wins: totals.wins + toNumber(game.wins),
          saves: totals.saves + toNumber(game.saves)
        };
      },
      { inningsPitched: 0, strikeOuts: 0, baseOnBalls: 0, qualityStarts: 0, wins: 0, saves: 0 }
    );
  }

  return games.reduce(
    (totals, game) => {
      return {
        hits: totals.hits + toNumber(game.hits),
        atBats: totals.atBats + toNumber(game.atBats),
        runs: totals.runs + toNumber(game.runs),
        homeRuns: totals.homeRuns + toNumber(game.homeRuns),
        rbi: totals.rbi + toNumber(game.rbi),
        stolenBases: totals.stolenBases + toNumber(game.stolenBases),
        strikeOuts: totals.strikeOuts + toNumber(game.strikeOuts)
      };
    },
    { hits: 0, atBats: 0, runs: 0, homeRuns: 0, rbi: 0, stolenBases: 0, strikeOuts: 0 }
  );
}

function formatDecisionRate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "--";
  }

  return number.toFixed(2);
}

async function maybeAddAiDecisions(players, config, updatedAt) {
  if (!RUN_AI_RECOMMENDATIONS) {
    return players;
  }

  const aiConfig = getAiRecommendationConfig(config);
  if (aiConfig.provider !== "gemini") {
    console.log(`Skipping AI recommendations: unsupported provider "${aiConfig.provider}".`);
    return players;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.log("Skipping AI recommendations: GEMINI_API_KEY is not set.");
    return players;
  }

  const selectedKeys = selectAiDecisionPlayerKeys(players, config, aiConfig);
  console.log(
    `Generating Gemini decision notes for ${selectedKeys.size} player${selectedKeys.size === 1 ? "" : "s"} with ${aiConfig.model}.`
  );
  console.log(
    `Gemini throttle: ${aiConfig.requestsPerMinute} request${aiConfig.requestsPerMinute === 1 ? "" : "s"}/minute, ${Math.round(aiConfig.requestDelayMs / 1000)}s delay between players.`
  );

  const enrichedPlayers = [];
  let generated = 0;
  let failed = 0;

  for (const player of players) {
    if (!selectedKeys.has(getPlayerRatingKey(player))) {
      enrichedPlayers.push(player);
      continue;
    }

    try {
      const decision = await generateGeminiDecision(player, aiConfig, apiKey, updatedAt);
      enrichedPlayers.push({
        ...player,
        decision
      });
      generated += 1;
      await delay(aiConfig.requestDelayMs);
    } catch (error) {
      failed += 1;
      console.warn(`AI decision skipped for ${player.name}: ${error.message}`);
      enrichedPlayers.push(player);
    }
  }

  console.log(`Gemini decisions generated: ${generated}; skipped/failed: ${failed}.`);
  return enrichedPlayers;
}

function getAiRecommendationConfig(config) {
  const aiConfig = config.aiRecommendations || {};
  const requestsPerMinute = clamp(
    toNumber(process.env.GEMINI_REQUESTS_PER_MINUTE || aiConfig.requestsPerMinute) || 5,
    1,
    60
  );
  const defaultDelayMs = Math.ceil(60000 / requestsPerMinute) + 1000;

  return {
    provider: aiConfig.provider || "gemini",
    model: process.env.GEMINI_MODEL || aiConfig.model || "gemini-2.5-flash-lite",
    maxPlayers: Math.max(1, toNumber(aiConfig.maxPlayers) || 25),
    minimumScore: clamp(toNumber(aiConfig.minimumScore) || 45, 1, 100),
    requestsPerMinute,
    requestDelayMs: Math.max(0, toNumber(aiConfig.requestDelayMs) || defaultDelayMs),
    maxRetries: Math.max(0, toNumber(aiConfig.maxRetries) || 2)
  };
}

function selectAiDecisionPlayerKeys(players, config, aiConfig) {
  if (AI_PLAYER_FILTER) {
    const normalizedFilter = normalizeNameKey(AI_PLAYER_FILTER);
    const player = players.find((candidate) => {
      return (
        normalizeNameKey(candidate.name) === normalizedFilter ||
        String(candidate.mlbId) === String(AI_PLAYER_FILTER).trim()
      );
    });

    if (!player) {
      console.log(`No player matched --ai-player "${AI_PLAYER_FILTER}".`);
      return new Set();
    }

    console.log(`AI player filter matched ${player.name}.`);
    return new Set([getPlayerRatingKey(player)]);
  }

  const manualIds = new Set(
    (config.players || [])
      .map((player) => player.mlbId)
      .filter(Boolean)
      .map(String)
  );
  const selected = new Set();

  players.forEach((player) => {
    if (manualIds.has(String(player.mlbId))) {
      selected.add(getPlayerRatingKey(player));
    }
  });

  players.forEach((player) => {
    if (selected.size >= aiConfig.maxPlayers) {
      return;
    }

    if (toNumber(player.rating?.score || player.recommendation?.score) >= aiConfig.minimumScore) {
      selected.add(getPlayerRatingKey(player));
    }
  });

  return selected;
}

async function generateGeminiDecision(player, aiConfig, apiKey, updatedAt) {
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: buildGeminiDecisionPrompt(player)
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.25,
      topP: 0.8,
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          summary: { type: "STRING" },
          badges: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                label: { type: "STRING" },
                tone: { type: "STRING" },
                detail: { type: "STRING" },
                description: { type: "STRING" }
              },
              required: ["label", "tone"]
            }
          },
          keyPoints: {
            type: "ARRAY",
            items: { type: "STRING" }
          },
          risk: { type: "STRING" }
        },
        required: ["summary", "badges", "keyPoints", "risk"]
      }
    }
  };
  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(aiConfig.model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  let lastError;
  for (let attempt = 0; attempt <= aiConfig.maxRetries; attempt += 1) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (response.ok) {
      const data = await response.json();
      const text = extractGeminiText(data);
      return validateAiDecision(parseGeminiJson(text), player, aiConfig, updatedAt);
    }

    const errorText = await response.text();
    lastError = new Error(`Gemini request failed ${response.status}: ${errorText.slice(0, 180)}`);
    if (response.status !== 429 && response.status < 500) {
      break;
    }

    await delay((attempt + 1) * 1500);
  }

  throw lastError;
}

function buildGeminiDecisionPrompt(player) {
  const payload = {
    player: {
      name: player.name,
      team: player.team,
      positions: player.positions,
      status: player.status,
      bats: player.bats,
      throws: player.throws
    },
    recommendation: player.recommendation,
    rating: player.rating,
    projection: compactProjection(player.projection),
    currentStats: compactStats(player.stats),
    recentTrendGames: compactRecentGames(
      player.recentGames,
      player.projection?.group || player.stats?.group,
      getRecentTrendGameCount(player)
    ),
    savantMetrics: (player.savant?.metrics || []).map((metric) => ({
      label: metric.label,
      display: metric.display,
      percentile: metric.percentile
    })),
    allowedBadgeLabels: Array.from(AI_BADGE_LABELS),
    allowedBadgeTones: Array.from(AI_BADGE_TONES)
  };

  return [
    "You write concise fantasy baseball decision notes from structured data.",
    "Use only the data provided. Do not invent injuries, lineup role, trades, matchup context, roster status changes, or news.",
    "Do not change or question the supplied score, action, confidence, or rating components.",
    "Return strict JSON only with this shape:",
    "{\"summary\":\"one concise sentence\",\"badges\":[{\"label\":\"Projection Edge\",\"tone\":\"positive\",\"detail\":\"Proj 80\",\"description\":\"why this badge applies\"}],\"keyPoints\":[\"short point\",\"short point\"],\"risk\":\"short risk sentence or empty string\"}",
    "Use 2 to 4 badges from allowedBadgeLabels only. Use allowedBadgeTones only.",
    "Use short badge detail values when available. Keep badge descriptions under 18 words.",
    "Use 2 or 3 keyPoints. Keep every sentence under 24 words.",
    JSON.stringify(payload)
  ].join("\n\n");
}

function compactProjection(projection) {
  if (!projection) {
    return null;
  }

  if (projection.group === "pitching") {
    return {
      group: projection.group,
      inningsPitched: projection.inningsPitched,
      strikeOuts: projection.strikeOuts,
      qualityStarts: projection.qualityStarts,
      wins: projection.wins,
      saves: projection.saves,
      era: projection.era,
      earnedRuns: projection.earnedRuns,
      whip: projection.whip,
      fantasyValue: projection.fantasyValue,
      percentileScore: projection.percentileScore
    };
  }

  return {
    group: projection.group,
    plateAppearances: projection.plateAppearances,
    hits: projection.hits,
    atBats: projection.atBats,
    runs: projection.runs,
    homeRuns: projection.homeRuns,
    rbi: projection.rbi,
    stolenBases: projection.stolenBases,
    avg: projection.avg,
    ops: projection.ops,
    fantasyValue: projection.fantasyValue,
    percentileScore: projection.percentileScore
  };
}

function compactStats(stats) {
  if (!stats) {
    return null;
  }

  if (stats.group === "pitching") {
    return {
      group: stats.group,
      inningsPitched: stats.inningsPitched,
      strikeOuts: stats.strikeOuts,
      baseOnBalls: stats.baseOnBalls,
      qualityStarts: stats.qualityStarts,
      wins: stats.wins,
      saves: stats.saves,
      earnedRuns: stats.earnedRuns,
      era: stats.era,
      whip: stats.whip
    };
  }

  return {
    group: stats.group,
    plateAppearances: stats.plateAppearances,
    hits: stats.hits,
    atBats: stats.atBats,
    runs: stats.runs,
    homeRuns: stats.homeRuns,
    rbi: stats.rbi,
    stolenBases: stats.stolenBases,
    avg: stats.avg,
    ops: stats.ops
  };
}

function compactRecentGames(recentGames, group, gameCount = HITTER_RECENT_TREND_GAME_COUNT) {
  return {
    source: recentGames?.source,
    updatedAt: recentGames?.updatedAt,
    games: (recentGames?.games || []).slice(0, gameCount).map((game) => {
      const common = {
        date: game.date,
        opponent: game.opponent
      };

      if (group === "pitching") {
        return {
          ...common,
          inningsPitched: game.inningsPitched,
          strikeOuts: game.strikeOuts,
          baseOnBalls: game.baseOnBalls,
          qualityStart: game.qualityStart,
          wins: game.wins,
          saves: game.saves,
          earnedRuns: game.earnedRuns,
          era: game.era,
          whip: game.whip
        };
      }

      return {
        ...common,
        hits: game.hits,
        atBats: game.atBats,
        runs: game.runs,
        homeRuns: game.homeRuns,
        rbi: game.rbi,
        stolenBases: game.stolenBases,
        avg: game.avg,
        ops: game.ops
      };
    })
  };
}

function extractGeminiText(data) {
  const text = data?.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("")
    .trim();

  if (!text) {
    throw new Error("Gemini returned no text.");
  }

  return text;
}

function cleanJsonText(text) {
  return String(text)
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function parseGeminiJson(text) {
  const cleaned = cleanJsonText(text);
  const candidates = [
    cleaned,
    extractFirstJsonObject(cleaned)
  ].filter(Boolean);

  let lastError;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }

    const repaired = repairLooseJsonObject(candidate);
    if (repaired !== candidate) {
      try {
        return JSON.parse(repaired);
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw lastError || new Error("Unable to parse Gemini JSON.");
}

function extractFirstJsonObject(text) {
  const source = String(text || "");
  const start = source.indexOf("{");
  if (start < 0) {
    return "";
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
    }

    if (depth === 0) {
      return source.slice(start, index + 1);
    }
  }

  return "";
}

function repairLooseJsonObject(text) {
  return String(text || "")
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
    .replace(/,\s*([}\]])/g, "$1");
}

function validateAiDecision(rawDecision, player, aiConfig, updatedAt) {
  const summary = sanitizeSentence(rawDecision?.summary, 260);
  if (!summary) {
    throw new Error("AI decision missing summary.");
  }

  const badges = (Array.isArray(rawDecision.badges) ? rawDecision.badges : [])
    .map((badge) => {
      const cleanBadge = {
        label: sanitizeBadgeLabel(badge?.label),
        tone: sanitizeBadgeTone(badge?.tone)
      };
      const detail = sanitizeSentence(badge?.detail, 40);
      const description = sanitizeSentence(badge?.description, 140);

      if (detail) {
        cleanBadge.detail = detail;
      }
      if (description) {
        cleanBadge.description = description;
      }

      return cleanBadge;
    })
    .filter((badge) => badge.label)
    .slice(0, 4);

  const keyPoints = (Array.isArray(rawDecision.keyPoints) ? rawDecision.keyPoints : [])
    .map((point) => sanitizeSentence(point, 180))
    .filter(Boolean)
    .slice(0, 3);

  return {
    source: "Gemini",
    model: aiConfig.model,
    generatedAt: updatedAt,
    summary,
    badges: badges.length ? badges : getFallbackDecisionBadges(player),
    keyPoints: keyPoints.length ? keyPoints : getFallbackDecisionKeyPoints(player),
    risk: sanitizeSentence(rawDecision?.risk, 180)
  };
}

function sanitizeSentence(value, maxLength) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) {
    return "";
  }

  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trim()}...` : text;
}

function sanitizeBadgeLabel(value) {
  const label = sanitizeSentence(value, 40);
  return AI_BADGE_LABELS.has(label) ? label : "";
}

function sanitizeBadgeTone(value) {
  const tone = sanitizeSentence(value, 20).toLowerCase();
  return AI_BADGE_TONES.has(tone) ? tone : "neutral";
}

function getFallbackDecisionBadges(player) {
  const badges = [];
  const components = player.rating?.components || {};
  const projection = toNumber(components.projection);
  const recentTrend = toNumber(components.recentTrend);
  const savantSkills = toNumber(components.savantSkills);
  const recentTrendGameCount = getRecentTrendGameCount(player);

  if (projection >= 70) {
    badges.push({
      label: "Projection Edge",
      tone: "positive",
      detail: `Proj ${projection}`,
      description: `Rest-of-season projection component is ${projection}.`
    });
  }

  if (recentTrend >= 70) {
    badges.push({
      label: getRecentTrendBadgeLabel(recentTrend, recentTrendGameCount),
      tone: "positive",
      detail: `Trend ${recentTrend}`,
      description: `Recent Trend component is ${recentTrend} over the last ${recentTrendGameCount} games.`
    });
  } else if (recentTrend < 45) {
    badges.push({
      label: getRecentTrendBadgeLabel(recentTrend, recentTrendGameCount),
      tone: "caution",
      detail: `Trend ${recentTrend}`,
      description: `Recent Trend component is ${recentTrend} over the last ${recentTrendGameCount} games.`
    });
  }

  if (savantSkills >= 70) {
    badges.push({
      label: "Savant Support",
      tone: "positive",
      detail: `Savant ${savantSkills}`,
      description: `Savant Skills component is ${savantSkills}.`
    });
  }

  return badges.slice(0, 3);
}

function getFallbackDecisionKeyPoints(player) {
  const components = player.rating?.components || {};
  return [
    `Projection score ${Math.round(toNumber(components.projection) || 0)} remains the primary input.`,
    `Current form score ${Math.round(toNumber(components.currentForm) || 0)} blends season stats, recent games, and Savant skills.`
  ];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildPlayerRecord({
  projectionValue,
  mlbPerson,
  manual,
  currentStats,
  savant,
  projections,
  season,
  updatedAt
}) {
  const manualRecommendation = manual?.manualRecommendation || {};
  const score = clamp(
    projectionValue.score + toNumber(manualRecommendation.scoreAdjustment),
    1,
    100
  );
  const action =
    manualRecommendation.forceStartSit || manualRecommendation.startSitOverride || getActionFromScore(score);
  const projection = projectionValue.projected;

  return {
    name: mlbPerson?.name || projectionValue.name,
    mlbId: mlbPerson?.mlbId || null,
    team: projectionValue.team || mlbPerson?.team || "",
    positions: manual?.positions || projectionValue.positions || [mlbPerson?.position].filter(Boolean),
    status: mlbPerson?.active === false ? "Inactive" : "Active",
    bats: projectionValue.bats || "",
    throws: projectionValue.throws || "",
    manualRecommendation,
    stats: currentStats || getEmptyCurrentStats(projectionValue.group),
    savant: savant || null,
    projection: {
      group: projectionValue.group,
      ...projection,
      fantasyValue: projectionValue.fantasyValue,
      fantasyValueRaw: projectionValue.fantasyValueRaw,
      positionAdjustment: projectionValue.positionAdjustment,
      projectionPoolMinimumPlateAppearances:
        projectionValue.projectionPoolMinimumPlateAppearances,
      percentileScore: projectionValue.score
    },
    recommendation: {
      tag: manualRecommendation.tag || getProjectionTag(projectionValue.group, score),
      score,
      startSit: action,
      confidence: manualRecommendation.confidenceOverride || getConfidenceFromScore(score),
      reason: manualRecommendation.reason || getProjectionReason(projectionValue, action),
      scoringNotes: getProjectionScoringNotes(projectionValue)
    },
    source: {
      identity: mlbPerson ? "MLB Stats API" : projections.source,
      stats: "MLB Stats API bulk season stats",
      projection: projections.source,
      recommendation: "projection z-score model",
      season,
      updatedAt
    }
  };
}

async function fetchMlbPlayerIndex(season, updatedAt) {
  const data = await fetchJson(`${MLB_API_BASE}/sports/1/players?season=${season}`);
  const players = (data.people || [])
    .filter((person) => person.fullName && person.id)
    .map((person) => ({
      name: person.fullName,
      mlbId: person.id,
      team: person.currentTeam?.abbreviation || "",
      position: person.primaryPosition?.abbreviation || "",
      active: person.active !== false
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    source: "MLB Stats API",
    season,
    updatedAt,
    players
  };
}

async function fetchBulkSeasonStats(group, season) {
  const url = `${MLB_API_BASE}/stats?stats=season&group=${group}&playerPool=ALL&sportIds=1&season=${season}&limit=2000`;
  const data = await fetchJson(url);
  const splits = data.stats?.[0]?.splits || [];
  const statsById = new Map();

  splits.forEach((split) => {
    const mlbId = split.player?.id;
    if (!mlbId) {
      return;
    }
    statsById.set(mlbId, normalizeStats(split.stat || {}, group));
  });

  return statsById;
}

async function fetchRecentGameLogs(players, season, updatedAt) {
  const endDate = updatedAt;
  const groups = [
    { projectionGroup: "hitting", statsGroup: "hitting" },
    { projectionGroup: "pitching", statsGroup: "pitching" }
  ];
  const recentGamesByKey = new Map();

  for (const group of groups) {
    const ids = Array.from(
      new Set(
        players
          .filter((player) => {
            return player.mlbId && player.projection?.group === group.projectionGroup;
          })
          .map((player) => player.mlbId)
      )
    );
    const chunks = chunkArray(ids, 75);
    const gameLogStartDate = null;

    for (const chunk of chunks) {
      const people = await fetchPeopleGameLogChunk(
        chunk,
        group.statsGroup,
        season,
        gameLogStartDate,
        endDate
      );

      people.forEach((person) => {
        const splits = person.stats?.[0]?.splits || [];
        const games = normalizeRecentGames(splits, group.projectionGroup);
        recentGamesByKey.set(getRecentGamesMapKey(person.id, group.projectionGroup), {
          source: "MLB Stats API game logs",
          updatedAt,
          startDate: gameLogStartDate,
          endDate,
          games,
          ...(group.projectionGroup === "pitching"
            ? { seasonQualityStarts: countQualityStarts(splits) }
            : {})
        });
      });
    }
  }

  return recentGamesByKey;
}

async function fetchPeopleGameLogChunk(ids, group, season, startDate, endDate) {
  if (ids.length === 0) {
    return [];
  }

  const dateFilter = startDate ? `,startDate=${startDate},endDate=${endDate}` : "";
  const hydrate = `stats(group=[${group}],type=[gameLog],season=${season}${dateFilter})`;
  const url =
    `${MLB_API_BASE}/people?personIds=${ids.join(",")}` +
    `&hydrate=${encodeURIComponent(hydrate)}`;
  const data = await fetchJson(url);
  return data.people || [];
}

function countQualityStarts(splits) {
  return (splits || []).reduce((total, split) => {
    return total + (isQualityStart(split.stat || {}) ? 1 : 0);
  }, 0);
}

function normalizeRecentGames(splits, group) {
  return splits
    .slice()
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, RECENT_GAMES_OUTPUT_COUNT)
    .map((split) => {
      const stat = split.stat || {};
      const opponentCode = getTeamAbbreviation(split.opponent);
      const opponent = `${split.isHome ? "vs " : "@"}${opponentCode}`;

      if (group === "pitching") {
        return {
          date: formatShortDate(split.date),
          opponent,
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
        opponent,
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

function getEmptyRecentGames(updatedAt) {
  return {
    source: "MLB Stats API game logs",
    updatedAt,
    startDate: null,
    endDate: updatedAt,
    games: []
  };
}

function getRecentGamesMapKey(mlbId, group) {
  return `${mlbId || "unknown"}:${group || "unknown"}`;
}

function getTeamAbbreviation(team) {
  const teamName = String(team?.name || "");
  const teamAbbreviations = {
    "Arizona Diamondbacks": "ARI",
    "Athletics": "ATH",
    "Atlanta Braves": "ATL",
    "Baltimore Orioles": "BAL",
    "Boston Red Sox": "BOS",
    "Chicago Cubs": "CHC",
    "Chicago White Sox": "CWS",
    "Cincinnati Reds": "CIN",
    "Cleveland Guardians": "CLE",
    "Colorado Rockies": "COL",
    "Detroit Tigers": "DET",
    "Houston Astros": "HOU",
    "Kansas City Royals": "KC",
    "Los Angeles Angels": "LAA",
    "Los Angeles Dodgers": "LAD",
    "Miami Marlins": "MIA",
    "Milwaukee Brewers": "MIL",
    "Minnesota Twins": "MIN",
    "New York Mets": "NYM",
    "New York Yankees": "NYY",
    "Philadelphia Phillies": "PHI",
    "Pittsburgh Pirates": "PIT",
    "San Diego Padres": "SD",
    "San Francisco Giants": "SF",
    "Seattle Mariners": "SEA",
    "St. Louis Cardinals": "STL",
    "Tampa Bay Rays": "TB",
    "Texas Rangers": "TEX",
    "Toronto Blue Jays": "TOR",
    "Washington Nationals": "WSH"
  };

  return team?.abbreviation || teamAbbreviations[teamName] || teamName || "--";
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

async function fetchText(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Request failed ${response.status}: ${url}`);
  }

  return response.text();
}

function parseCsv(csv) {
  const rows = parseCsvRows(csv);
  const headers = rows.shift();

  if (!headers) {
    return [];
  }

  return rows
    .filter((row) => row.some((cell) => cell.trim() !== ""))
    .map((row) => {
      return headers.reduce((object, header, index) => {
        object[header] = row[index] || "";
        return object;
      }, {});
    });
}

function parseCsvRows(csv) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    const nextChar = csv[index + 1];

    if (char === '"' && inQuotes && nextChar === '"') {
      cell += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && nextChar === "\n") {
        index += 1;
      }

      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function mapMlbPlayersByName(players) {
  return players.reduce((playersByName, player) => {
    const key = normalizeNameKey(player.name);
    if (!playersByName.has(key)) {
      playersByName.set(key, []);
    }
    playersByName.get(key).push(player);
    return playersByName;
  }, new Map());
}

function normalizeStats(stats, group) {
  if (group === "pitching") {
    return {
      group,
      gamesPlayed: toNumber(stats.gamesPlayed),
      gamesStarted: toNumber(stats.gamesStarted),
      qualityStarts: toNumber(stats.qualityStarts),
      wins: toNumber(stats.wins),
      losses: toNumber(stats.losses),
      saves: toNumber(stats.saves),
      holds: toNumber(stats.holds),
      inningsPitched: stats.inningsPitched || "0.0",
      strikeOuts: toNumber(stats.strikeOuts),
      earnedRuns: toNumber(stats.earnedRuns),
      baseOnBalls: toNumber(stats.baseOnBalls),
      era: stats.era || ".---",
      whip: stats.whip || ".---"
    };
  }

  return {
    group,
    gamesPlayed: toNumber(stats.gamesPlayed),
    plateAppearances: toNumber(stats.plateAppearances),
    atBats: toNumber(stats.atBats),
    hits: toNumber(stats.hits),
    runs: toNumber(stats.runs),
    homeRuns: toNumber(stats.homeRuns),
    rbi: toNumber(stats.rbi),
    stolenBases: toNumber(stats.stolenBases),
    strikeOuts: toNumber(stats.strikeOuts),
    baseOnBalls: toNumber(stats.baseOnBalls),
    avg: stats.avg || ".---",
    obp: stats.obp || ".---",
    slg: stats.slg || ".---",
    ops: stats.ops || ".---"
  };
}

function getEmptyCurrentStats(group) {
  if (group === "pitching") {
    return {
      group,
      gamesPlayed: 0,
      gamesStarted: 0,
      qualityStarts: 0,
      wins: 0,
      losses: 0,
      saves: 0,
      holds: 0,
      inningsPitched: "0.0",
      strikeOuts: 0,
      baseOnBalls: 0,
      era: ".---",
      whip: ".---"
    };
  }

  return {
    group,
    gamesPlayed: 0,
    plateAppearances: 0,
    atBats: 0,
    hits: 0,
    runs: 0,
    homeRuns: 0,
    rbi: 0,
    stolenBases: 0,
    strikeOuts: 0,
    baseOnBalls: 0,
    avg: ".---",
    obp: ".---",
    slg: ".---",
    ops: ".---"
  };
}

function getProjectionTag(group, score) {
  if (score >= 90) {
    return group === "pitching" ? "Projected Ace" : "Projected Anchor";
  }
  if (score >= 70) {
    return "Strong Projection";
  }
  if (score >= 45) {
    return "Playable Depth";
  }
  return "Low Projection";
}

function getProjectionReason(player, action) {
  if (player.group === "pitching") {
    return `${action} based on projected fantasy value across strikeouts, quality starts, wins, saves, ERA, and WHIP.`;
  }

  return `${action} based on projected fantasy value across runs, home runs, RBI, stolen bases, and batting average.`;
}

function getProjectionScoringNotes(player) {
  return `Projection fantasy value ${formatSigned(player.fantasyValue)}; percentile score ${player.score}.`;
}

function getProjectedEarnedRuns(inningsPitched, era) {
  return round((toNumber(inningsPitched) * toNumber(era)) / 9, 1);
}

function getActionFromScore(score) {
  if (score >= 70) return "Start";
  if (score >= 45) return "Watch";
  return "Bench";
}

function getConfidenceFromScore(score) {
  if (score >= 85) return "High";
  if (score >= 55) return "Medium";
  return "Low";
}

function parsePositions(value) {
  return String(value || "")
    .split(/[,/ ]+/)
    .map((position) => position.trim())
    .filter(Boolean);
}

function getMeanAndStd(values) {
  const filtered = values.filter((value) => Number.isFinite(value));
  const mean =
    filtered.reduce((total, value) => total + value, 0) / Math.max(filtered.length, 1);
  const variance =
    filtered.reduce((total, value) => total + (value - mean) ** 2, 0) /
    Math.max(filtered.length, 1);

  return {
    mean,
    std: Math.sqrt(variance) || 1
  };
}

function z(value, metric) {
  return (value - metric.mean) / metric.std;
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

function getDateDaysBefore(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
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

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function formatSigned(value) {
  return value >= 0 ? `+${value}` : String(value);
}

function normalizeNameKey(name) {
  return String(name)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function stripTags(html) {
  return String(html).replace(/<[^>]*>/g, "");
}

function decodeHtml(value) {
  return String(value)
    .replace(/&nbsp;/g, " ")
    .replace(/&#8217;/g, "'")
    .replace(/&#038;/g, "&")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
}

function printTopPlayers(players) {
  console.log("Top generated values:");
  players.slice(0, 12).forEach((player) => {
    console.log(
      `${player.name}: ${player.recommendation.startSit} ${player.recommendation.score} (${player.recommendation.tag})`
    );
  });
}

function getCliOption(name) {
  const prefix = `${name}=`;
  const inlineValue = process.argv.find((argument) => argument.startsWith(prefix));
  if (inlineValue) {
    return inlineValue.slice(prefix.length);
  }

  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) {
    return process.argv[index + 1];
  }

  return "";
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
