// scripts/validate-generated-data.js
// Validates generated extension data after every local or automated refresh.

const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const EXPECTED_DATE = getCliOption("--date");
const MAX_PITCHER_SCORE_ONE_RATIO = 0.25;
const MIN_DISTINCT_PITCHER_PROJECTION_SCORES = 20;

function main() {
  const players = readJson("players.json");
  const playerValues = readJson("data/generated/player-values.json");
  const playerIndex = readJson("mlb-players.json");
  const history = readJson("data/generated/rating-history.json");

  assert(Array.isArray(players) && players.length > 0, "players.json must contain players.");
  assert(
    Array.isArray(playerValues) && playerValues.length === players.length,
    "player-values.json must contain the same number of players as players.json."
  );
  assert(
    playerIndex && Array.isArray(playerIndex.players) && playerIndex.players.length > 0,
    "mlb-players.json must contain a player index."
  );
  assert(
    history && Array.isArray(history.entries) && history.entries.length > 0,
    "rating-history.json must contain history entries."
  );
  assert(
    JSON.stringify(players) === JSON.stringify(playerValues),
    "player-values.json must exactly match players.json."
  );

  validatePlayerIdentityAndModelConsistency(players);
  validateRefreshDates(players, playerIndex, history);
  const historyDates = validateWeeklyHistoryContinuity(history.entries);
  const pitcherSummary = validatePitcherProjectionScores(players);

  console.log(
    `Validated ${players.length} players, ${historyDates.length} consecutive weekly history dates, ` +
      `and ${pitcherSummary.count} pitcher projections (${pitcherSummary.scoreOnePercent}% scored 1).`
  );
}

function validatePlayerIdentityAndModelConsistency(players) {
  const seenKeys = new Set();
  const modelVersions = new Set();

  players.forEach((player) => {
    const group = player?.projection?.group || "unknown";
    const identity = player?.mlbId
      ? `mlb:${player.mlbId}`
      : `name:${String(player?.name || "").trim().toLowerCase()}`;
    const key = `${group}:${identity}`;

    assert(!seenKeys.has(key), `Duplicate player record detected for ${key}.`);
    seenKeys.add(key);

    if (player?.rating?.modelVersion) {
      modelVersions.add(player.rating.modelVersion);
    }
  });

  assert(
    modelVersions.size === 1,
    `Generated players must use one rating model version; found ${
      Array.from(modelVersions).join(", ") || "none"
    }.`
  );
}

function validateRefreshDates(players, playerIndex, history) {
  if (!EXPECTED_DATE) {
    return;
  }

  const playerDates = Array.from(
    new Set(players.map((player) => player?.source?.updatedAt).filter(Boolean))
  );
  assert(
    playerDates.length === 1 && playerDates[0] === EXPECTED_DATE,
    `players.json must be updated for ${EXPECTED_DATE}; found ${playerDates.join(", ") || "none"}.`
  );
  assert(
    playerIndex.updatedAt === EXPECTED_DATE,
    `mlb-players.json must be updated for ${EXPECTED_DATE}; found ${playerIndex.updatedAt || "none"}.`
  );
  assert(
    history.updatedAt === EXPECTED_DATE,
    `rating-history.json must be updated for ${EXPECTED_DATE}; found ${history.updatedAt || "none"}.`
  );
}

function validateWeeklyHistoryContinuity(entries) {
  const dates = Array.from(new Set(entries.map((entry) => entry?.date).filter(Boolean))).sort();
  assert(dates.length > 0, "rating-history.json has no dated entries.");

  dates.forEach((date) => {
    assert(isMondayDate(date), `Rating history date ${date} is not a Monday.`);
  });

  for (let index = 1; index < dates.length; index += 1) {
    const expectedDate = getDateDaysAfter(dates[index - 1], 7);
    assert(
      dates[index] === expectedDate,
      `Rating history gap detected: expected ${expectedDate} after ${dates[index - 1]}, found ${dates[index]}.`
    );
  }

  return dates;
}

function validatePitcherProjectionScores(players) {
  const pitchers = players.filter((player) => {
    return (
      player?.projection?.group === "pitching" &&
      Number(player?.projection?.inningsPitched) > 0 &&
      Number.isFinite(Number(player?.rating?.components?.projection))
    );
  });
  assert(pitchers.length > 0, "No pitcher projection scores were generated.");

  const scores = pitchers.map((player) => Number(player.rating.components.projection));
  const scoreOneCount = scores.filter((score) => score === 1).length;
  const scoreOneRatio = scoreOneCount / pitchers.length;
  const distinctScores = new Set(scores).size;
  const poolMinimums = Array.from(
    new Set(
      pitchers
        .map((player) => Number(player.projection.projectionPoolMinimumInningsPitched))
        .filter(Number.isFinite)
    )
  );

  assert(
    scoreOneRatio <= MAX_PITCHER_SCORE_ONE_RATIO,
    `Pitcher projection scores collapsed: ${scoreOneCount}/${pitchers.length} ` +
      `(${(scoreOneRatio * 100).toFixed(1)}%) are scored 1.`
  );
  assert(
    distinctScores >= MIN_DISTINCT_PITCHER_PROJECTION_SCORES,
    `Pitcher projection scores have only ${distinctScores} distinct values.`
  );
  assert(
    poolMinimums.length === 1 && poolMinimums[0] >= 5 && poolMinimums[0] <= 40,
    "Pitcher projections must use one dynamic pool minimum between 5 and 40 innings."
  );

  return {
    count: pitchers.length,
    scoreOnePercent: (scoreOneRatio * 100).toFixed(1)
  };
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

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, relativePath), "utf8"));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function getCliOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index === process.argv.length - 1) {
    return "";
  }
  return process.argv[index + 1];
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
}
