// sidepanel.js
// Reads the latest page scan from chrome.storage.local and renders it in
// Chrome's native side panel.

const status = document.getElementById("fbh-panel-status");
const content = document.getElementById("fbh-panel-content");

chrome.storage.local.get("fbhLatestScan", ({ fbhLatestScan }) => {
  renderScan(fbhLatestScan);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.fbhLatestScan) {
    renderScan(changes.fbhLatestScan.newValue);
  }
});

function renderScan(scan) {
  content.textContent = "";

  if (!scan) {
    status.textContent = "Open a supported fantasy baseball page.";
    const empty = document.createElement("p");
    empty.className = "fbh-empty";
    empty.textContent = "No scan results yet.";
    content.appendChild(empty);
    return;
  }

  const matchedPlayers = scan.matchedPlayers || [];
  const untrackedPlayerNames = scan.untrackedPlayerNames || [];
  const updated = scan.updatedAt ? new Date(scan.updatedAt).toLocaleTimeString() : "unknown";
  const dataSource = getDataSourceLabel(scan.dataSource);

  status.textContent = `Last scan: ${updated} - ${dataSource} data`;

  const summary = document.createElement("p");
  summary.className = "fbh-panel-summary";
  summary.textContent = `${matchedPlayers.length} recommendations, ${untrackedPlayerNames.length} untracked players.`;
  content.appendChild(summary);

  if (matchedPlayers.length > 0) {
    const groups = groupPlayersByAction(matchedPlayers);
    Object.keys(groups).forEach((groupName) => {
      const group = document.createElement("section");
      group.className = "fbh-match-group";

      const heading = document.createElement("h2");
      heading.textContent = groupName;
      group.appendChild(heading);

      groups[groupName].forEach((player) => {
        group.appendChild(createPlayerCard(player));
      });

      content.appendChild(group);
    });
  }

  if (untrackedPlayerNames.length > 0) {
    content.appendChild(createUntrackedPlayersSection(untrackedPlayerNames));
  }

  if (matchedPlayers.length === 0 && untrackedPlayerNames.length === 0) {
    const empty = document.createElement("p");
    empty.className = "fbh-empty";
    empty.textContent = "No player names found on the current page.";
    content.appendChild(empty);
  }
}

function getDataSourceLabel(dataSource) {
  const label = dataSource?.label || "unknown";
  if (label === "remote") {
    return "remote";
  }
  if (label === "bundled") {
    return "bundled";
  }
  if (label === "mixed") {
    return "mixed";
  }
  return "unknown";
}

function groupPlayersByAction(players) {
  return players.reduce((groups, player) => {
    const groupName = getAction(player) || "Watch";
    if (!groups[groupName]) {
      groups[groupName] = [];
    }
    groups[groupName].push(player);
    return groups;
  }, {});
}

function createPlayerCard(player) {
  const playerCard = document.createElement("article");
  playerCard.className = "fbh-player-card";

  const name = document.createElement("h3");
  name.textContent = player.name;

  const meta = document.createElement("p");
  meta.className = "fbh-meta";
  meta.textContent = [
    player.team,
    Array.isArray(player.positions) ? player.positions.join("/") : ""
  ]
    .filter(Boolean)
    .join(" - ");

  const tag = document.createElement("p");
  tag.className = "fbh-tag";
  tag.textContent = getTag(player);

  const score = document.createElement("p");
  score.className = "fbh-score";
  score.textContent = `Score: ${getScore(player)}`;

  const projection = document.createElement("p");
  projection.className = "fbh-projection";
  projection.textContent = getProjectionLine(player);

  const stats = document.createElement("p");
  stats.className = "fbh-stats";
  stats.textContent = getStatsLine(player);

  const reason = document.createElement("p");
  reason.className = "fbh-reason";
  reason.textContent = getReason(player);

  const source = document.createElement("p");
  source.className = "fbh-source";
  source.textContent = getSourceLine(player);

  playerCard.append(name, meta, tag, score, projection, stats, reason, source);
  return playerCard;
}

function createUntrackedPlayersSection(playerNames) {
  const group = document.createElement("section");
  group.className = "fbh-match-group";

  const heading = document.createElement("h2");
  heading.textContent = "Untracked Players";

  const list = document.createElement("ul");
  list.className = "fbh-untracked-list";

  playerNames.forEach((playerName) => {
    const item = document.createElement("li");
    item.textContent = playerName;
    list.appendChild(item);
  });

  group.append(heading, list);
  return group;
}

function getRecommendation(player) {
  return player.recommendation || player;
}

function getAction(player) {
  return getRecommendation(player).startSit;
}

function getTag(player) {
  return getRecommendation(player).tag || "Local Recommendation";
}

function getScore(player) {
  const score = getRecommendation(player).score;
  return Number.isFinite(Number(score)) ? score : "N/A";
}

function getReason(player) {
  return getRecommendation(player).reason || "No local reason provided.";
}

function getStatsLine(player) {
  const stats = player.stats;

  if (!stats) {
    return "Stats: not imported yet.";
  }

  if (stats.group === "pitching") {
    return `Stats: ${getPitchingLineParts(player, stats, false).join(", ")}.`;
  }

  return `Stats: ${stats.ops} OPS, ${stats.homeRuns} HR, ${stats.stolenBases} SB.`;
}

function getProjectionLine(player) {
  const projection = player.projection;

  if (!projection) {
    return "Projection: not imported yet.";
  }

  if (projection.group === "pitching") {
    return `Projection: ${getPitchingLineParts(player, projection, true).join(", ")}.`;
  }

  return `Projection: ${projection.runs} R, ${projection.homeRuns} HR, ${projection.rbi} RBI, ${projection.stolenBases} SB, ${formatAverage(projection.avg)} AVG.`;
}

function getPitchingLineParts(player, data, shouldRound) {
  const visibility = getPitchingStatVisibility(player);
  const countValue = (value) => {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return 0;
    }
    return shouldRound ? Math.round(number) : value;
  };
  const parts = [
    `${data.era || ".---"} ERA`,
    `${data.whip || ".---"} WHIP`,
    `${countValue(data.strikeOuts)} K`,
    `${countValue(data.baseOnBalls)} BB`
  ];

  if (visibility.showQualityStarts) {
    parts.push(`${countValue(data.qualityStarts)} QS`);
  }

  if (visibility.showSaves) {
    parts.push(`${countValue(data.saves)} SV`);
  }

  return parts;
}

function getPitchingStatVisibility(player) {
  const positions = getPlayerPositions(player);
  return {
    showQualityStarts: !positions.includes("RP"),
    showSaves: !positions.includes("SP")
  };
}

function getPlayerPositions(player) {
  const positions = [
    ...(Array.isArray(player.positions) ? player.positions : []),
    ...(Array.isArray(player.projection?.positions) ? player.projection.positions : [])
  ];
  return positions.map((position) => String(position).trim().toUpperCase()).filter(Boolean);
}

function getSourceLine(player) {
  if (player.source) {
    return `Source: ${player.source.projection || player.source.stats || "local"} + ${
      player.source.recommendation || "scoring"
    }, updated ${player.source.updatedAt || "unknown"}`;
  }

  return "Source: local";
}

function formatAverage(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return ".---";
  }

  return number.toFixed(3).replace(/^0/, "");
}
