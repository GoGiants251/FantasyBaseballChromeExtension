// content.js
// This file runs on the fantasy baseball pages listed in manifest.json.
// It loads local player recommendations, watches the page for player names,
// stores scan results for the Chrome side panel, and marks matched rows.

const HITTER_RECENT_PERFORMANCE_DEFAULT_GAMES = 7;
const PITCHER_RECENT_PERFORMANCE_DEFAULT_GAMES = 5;
const RECENT_PERFORMANCE_EXPANDED_GAMES = 15;
const PLAYER_NOTES_STORAGE_KEY = "fbhPlayerNotes";
const REMOTE_DATA_BASE_URL =
  "https://raw.githubusercontent.com/GoGiants251/FantasyBaseballChromeExtension/main";
const DATA_FETCH_TIMEOUT_MS = 6000;
const RATING_TREND_SERIES = [
  { key: "overall", label: "Overall", color: "#047857", defaultVisible: true },
  { key: "projection", label: "Projection", color: "#2563eb" },
  { key: "currentForm", label: "Current Form", color: "#d97706" },
  { key: "seasonStats", label: "Season Stats", color: "#7c3aed" },
  { key: "recentTrend", label: "Recent Trend", color: "#dc2626" },
  { key: "savantSkills", label: "Savant Skills", color: "#0891b2" }
];
const SVG_NS = "http://www.w3.org/2000/svg";

(async function startFantasyBaseballHelper() {
  const INDICATOR_ID = "fantasy-baseball-helper-indicator";
  const BADGE_CLASS = "fbh-inline-badge";
  const HIGHLIGHT_CLASS = "fbh-highlighted-row";

  // Avoid adding the helper more than once if Chrome injects this file again.
  if (document.getElementById(INDICATOR_ID)) {
    return;
  }

  const indicator = createPageIndicator(INDICATOR_ID);
  document.body.appendChild(indicator);

  const status = indicator.querySelector(".fbh-indicator-status");
  let rescanTimer;
  let observer;

  try {
    const [playersResult, mlbPlayerIndexResult, ratingHistoryResult] = await Promise.all([
      loadJsonWithFallback("players.json", isPlayerList),
      loadMlbPlayerIndex(),
      loadRatingHistory()
    ]);
    const players = playersResult.data;
    const mlbPlayerIndex = mlbPlayerIndexResult.data;
    const ratingHistory = ratingHistoryResult.data;
    const dataSource = buildDataSourceSummary(
      playersResult,
      mlbPlayerIndexResult,
      ratingHistoryResult
    );
    const playersWithHistory = attachRatingHistory(players, ratingHistory);
    const playersByName = groupPlayersByNormalizedName(playersWithHistory);

    function observePageChanges() {
      if (!observer) {
        return;
      }

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
      });
    }

    const scanPageForPlayers = () => {
      if (observer) {
        observer.disconnect();
      }

      removeOldPageMarkers(BADGE_CLASS, HIGHLIGHT_CLASS);

      const visiblePlayerNames = findVisiblePlayerNamesFromIndex(
        indicator,
        mlbPlayerIndex
      );
      const matchedPlayers = visiblePlayerNames
        .map((name) => {
          return chooseBestPagePlayerMatch(
            name,
            playersByName.get(normalizeText(name)) || [],
            indicator
          );
        })
        .filter(Boolean);
      const untrackedPlayerNames = findUntrackedPlayerNames(
        visiblePlayerNames,
        playersWithHistory
      );

      markMatchedRows(matchedPlayers, indicator, BADGE_CLASS, HIGHLIGHT_CLASS);
      updatePageIndicator(status, matchedPlayers, untrackedPlayerNames);
      publishScanResults(matchedPlayers, untrackedPlayerNames, dataSource);
      observePageChanges();
    };

    const scheduleScan = () => {
      window.clearTimeout(rescanTimer);
      rescanTimer = window.setTimeout(scanPageForPlayers, 250);
    };

    // Fantasy sites often render the roster table after the first page load.
    // This observer rescans when ESPN/Yahoo/CBS/Fantrax update the page.
    observer = new MutationObserver((mutations) => {
      const onlyHelperChanged = mutations.every((mutation) => {
        return mutationOnlyTouchesHelper(mutation, indicator);
      });

      if (!onlyHelperChanged) {
        scheduleScan();
      }
    });

    scanPageForPlayers();

    // Backup scans help with slower single-page app rendering.
    window.setTimeout(scanPageForPlayers, 1000);
    window.setTimeout(scanPageForPlayers, 3000);
    window.setTimeout(scanPageForPlayers, 6000);
  } catch (error) {
    status.textContent = "FBH data error";
    console.error("Fantasy Baseball Helper error:", error);
  }
})();

async function loadMlbPlayerIndex() {
  try {
    const playerIndex = await loadJsonWithFallback("mlb-players.json", isMlbPlayerIndex);
    return {
      ...playerIndex,
      data: Array.isArray(playerIndex.data.players) ? playerIndex.data.players : []
    };
  } catch (error) {
    console.warn("Fantasy Baseball Helper could not load MLB player index:", error);
    return { data: [], source: "unavailable", path: "mlb-players.json" };
  }
}

async function loadRatingHistory() {
  try {
    const history = await loadJsonWithFallback(
      "data/generated/rating-history.json",
      isRatingHistory
    );
    return {
      ...history,
      data: Array.isArray(history.data.entries) ? history.data.entries : []
    };
  } catch (error) {
    console.warn("Fantasy Baseball Helper could not load rating history:", error);
    return {
      data: [],
      source: "unavailable",
      path: "data/generated/rating-history.json"
    };
  }
}

async function loadJsonWithFallback(path, validator) {
  try {
    const remoteUrl = `${REMOTE_DATA_BASE_URL}/${path}`;
    const data = await fetchJsonWithTimeout(remoteUrl, DATA_FETCH_TIMEOUT_MS);
    validateLoadedJson(path, data, validator);
    const bundledResult = await loadBundledJsonForStaleCheck(path, validator);

    if (bundledResult && isRemoteDataStale(data, bundledResult.data)) {
      console.warn(
        `Fantasy Baseball Helper remote ${path} is older than bundled data; using bundled data.`
      );
      return bundledResult;
    }

    console.info(`Fantasy Baseball Helper loaded remote ${path}.`);
    return { data, source: "remote", path, url: remoteUrl };
  } catch (remoteError) {
    console.warn(
      `Fantasy Baseball Helper could not load remote ${path}; falling back to bundled data:`,
      remoteError
    );
  }

  return loadBundledJsonResult(path, validator);
}

async function loadBundledJsonForStaleCheck(path, validator) {
  try {
    return await loadBundledJsonResult(path, validator, false);
  } catch (error) {
    console.warn(
      `Fantasy Baseball Helper could not check bundled freshness for ${path}; using remote data if available:`,
      error
    );
    return null;
  }
}

async function loadBundledJsonResult(path, validator, shouldLog = true) {
  const bundledUrl = chrome.runtime.getURL(path);
  const data = await fetchBundledJson(path);
  validateLoadedJson(path, data, validator);
  if (shouldLog) {
    console.info(`Fantasy Baseball Helper loaded bundled ${path}.`);
  }
  return { data, source: "bundled", path, url: bundledUrl };
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      cache: "default",
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Request failed ${response.status}: ${url}`);
    }

    return await response.json();
  } finally {
    window.clearTimeout(timeout);
  }
}

async function fetchBundledJson(path) {
  const url = chrome.runtime.getURL(path);
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Could not load bundled ${path}: ${response.status}`);
  }

  return response.json();
}

function validateLoadedJson(path, data, validator) {
  if (!validator(data)) {
    throw new Error(`Invalid ${path} shape.`);
  }
}

function isPlayerList(data) {
  return Array.isArray(data);
}

function isMlbPlayerIndex(data) {
  return Boolean(data && Array.isArray(data.players));
}

function isRatingHistory(data) {
  return Boolean(data && Array.isArray(data.entries));
}

function isRemoteDataStale(remoteData, bundledData) {
  const remoteDate = getGeneratedDataDate(remoteData);
  const bundledDate = getGeneratedDataDate(bundledData);
  return Boolean(remoteDate && bundledDate && remoteDate < bundledDate);
}

function getGeneratedDataDate(data) {
  if (data?.updatedAt) {
    return data.updatedAt;
  }

  if (Array.isArray(data)) {
    return data.find((item) => item?.source?.updatedAt)?.source?.updatedAt || "";
  }

  return "";
}

function buildDataSourceSummary(playersResult, mlbPlayerIndex, ratingHistory) {
  const sources = [playersResult, mlbPlayerIndex, ratingHistory]
    .map((result) => result.source)
    .filter(Boolean);
  const uniqueSources = Array.from(new Set(sources));
  const label =
    uniqueSources.length === 1
      ? uniqueSources[0]
      : uniqueSources.length > 1
        ? "mixed"
        : "unknown";

  return {
    label,
    files: {
      players: playersResult.source,
      mlbPlayerIndex: mlbPlayerIndex.source,
      ratingHistory: ratingHistory.source
    }
  };
}

function attachRatingHistory(players, ratingHistory) {
  const historyByPlayerKey = new Map();

  ratingHistory.forEach((entry) => {
    getRatingHistoryKeys(entry).forEach((key) => {
      if (!historyByPlayerKey.has(key)) {
        historyByPlayerKey.set(key, []);
      }
      historyByPlayerKey.get(key).push(entry);
    });
  });

  return players.map((player) => {
    const entries = getRatingHistoryKeys(player)
      .flatMap((key) => historyByPlayerKey.get(key) || []);
    const uniqueByDate = new Map();

    entries.forEach((entry) => {
      if (entry?.date) {
        uniqueByDate.set(entry.date, entry);
      }
    });

    return {
      ...player,
      ratingHistory: Array.from(uniqueByDate.values()).sort((a, b) => {
        return String(a.date).localeCompare(String(b.date));
      })
    };
  });
}

function getRatingHistoryKeys(playerOrEntry) {
  const keys = [];
  if (playerOrEntry?.mlbId) {
    return [`mlb:${playerOrEntry.mlbId}`];
  }
  if (playerOrEntry?.name) {
    keys.push(`name:${normalizeText(playerOrEntry.name)}`);
  }
  return keys;
}

function groupPlayersByNormalizedName(players) {
  return players.reduce((playersByName, player) => {
    const key = normalizeText(player.name);
    if (!playersByName.has(key)) {
      playersByName.set(key, []);
    }
    playersByName.get(key).push(player);
    return playersByName;
  }, new Map());
}

function chooseBestPagePlayerMatch(playerName, candidates, helperElement) {
  if (candidates.length <= 1) {
    return candidates[0] || null;
  }

  const context = getPageContextForPlayerName(playerName, helperElement);
  const scoredCandidates = candidates.map((candidate) => {
    return {
      candidate,
      score: getContextMatchScore(candidate, context)
    };
  });

  scoredCandidates.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return Number(getScore(b.candidate)) - Number(getScore(a.candidate));
  });

  return scoredCandidates[0].candidate;
}

function getPageContextForPlayerName(playerName, helperElement) {
  const nameElement = findPlayerNameElement(playerName, helperElement);
  const row = nameElement ? findRowContainer(nameElement) : null;
  const rowText = normalizeText(row?.textContent || "");

  return {
    rowText,
    teams: extractTeamAbbreviations(rowText),
    positions: extractFantasyPositions(rowText)
  };
}

function getContextMatchScore(player, context) {
  const playerTeam = normalizeText(player.team);
  const playerPositions = new Set(
    (Array.isArray(player.positions) ? player.positions : [])
      .map((position) => normalizeText(position).toUpperCase())
  );
  const playerGroup = player.projection?.group || player.stats?.group;
  const pageLooksLikePitcher = context.positions.some((position) => {
    return ["P", "SP", "RP"].includes(position);
  });

  let score = 0;

  if (playerTeam && context.teams.includes(playerTeam.toUpperCase())) {
    score += 5;
  }

  context.positions.forEach((position) => {
    if (playerPositions.has(position)) {
      score += 4;
    }
  });

  if (playerGroup === "pitching" && pageLooksLikePitcher) {
    score += 3;
  }

  if (playerGroup === "hitting" && context.positions.length > 0 && !pageLooksLikePitcher) {
    score += 3;
  }

  return score;
}

function extractTeamAbbreviations(text) {
  const teamCodes = [
    "ARI",
    "ATH",
    "ATL",
    "BAL",
    "BOS",
    "CHC",
    "CIN",
    "CLE",
    "COL",
    "CWS",
    "DET",
    "HOU",
    "KC",
    "LAA",
    "LAD",
    "MIA",
    "MIL",
    "MIN",
    "NYM",
    "NYY",
    "PHI",
    "PIT",
    "SD",
    "SEA",
    "SF",
    "STL",
    "TB",
    "TEX",
    "TOR",
    "WSH"
  ];
  const upperText = text.toUpperCase();
  return teamCodes.filter((teamCode) => {
    return new RegExp(`\\b${teamCode}\\b`).test(upperText);
  });
}

function extractFantasyPositions(text) {
  const matches = text.toUpperCase().match(/\b(C|1B|2B|3B|SS|IF|OF|DH|SP|RP|P)\b/g);
  return matches ? Array.from(new Set(matches)) : [];
}

function createPageIndicator(indicatorId) {
  const indicator = document.createElement("div");
  indicator.id = indicatorId;
  indicator.innerHTML = `
    <span class="fbh-indicator-status">FBH scanning...</span>
    <button class="fbh-indicator-close" type="button" aria-label="Hide Fantasy Baseball Helper status">x</button>
  `;

  indicator.querySelector(".fbh-indicator-close").addEventListener("click", () => {
    indicator.remove();
  });

  return indicator;
}

function updatePageIndicator(status, matchedPlayers, untrackedPlayerNames) {
  status.textContent = `FBH: ${matchedPlayers.length} matched, ${untrackedPlayerNames.length} untracked`;
}

function publishScanResults(matchedPlayers, untrackedPlayerNames, dataSource) {
  chrome.storage.local.set({
    fbhLatestScan: {
      url: window.location.href,
      title: document.title,
      updatedAt: new Date().toISOString(),
      dataSource,
      matchedPlayers,
      untrackedPlayerNames
    }
  });
}

function getPageTextWithoutSidebar(helperElement) {
  // Remove helper text so anything displayed by this extension does not count
  // as a page match on future rescans.
  let pageText = document.body.innerText.replace(helperElement.innerText, "");
  document.querySelectorAll(".fbh-player-modal-backdrop").forEach((modal) => {
    pageText = pageText.replace(modal.innerText, "");
  });
  return normalizeText(pageText);
}

function mutationOnlyTouchesHelper(mutation, helperElement) {
  const target = getElementFromNode(mutation.target);

  if (target && isInsideHelperUi(target, helperElement)) {
    return true;
  }

  const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes]
    .map(getElementFromNode)
    .filter(Boolean);

  return (
    changedNodes.length > 0 &&
    changedNodes.every((node) => isInsideHelperUi(node, helperElement))
  );
}

function getElementFromNode(node) {
  if (!node) {
    return null;
  }

  return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
}

function isInsideHelperUi(element, helperElement) {
  return (
    helperElement.contains(element) ||
    element.matches?.(".fbh-player-modal-backdrop") ||
    Boolean(element.closest?.(".fbh-player-modal-backdrop"))
  );
}

function normalizeText(text) {
  return String(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function removeOldPageMarkers(badgeClass, highlightClass) {
  document.querySelectorAll(`.${badgeClass}`).forEach((badge) => {
    badge.remove();
  });

  document.querySelectorAll(".fbh-inline-badge-host").forEach((host) => {
    host.remove();
  });

  document.querySelectorAll(".fbh-player-name-mark").forEach((element) => {
    element.classList.remove("fbh-player-name-mark");
  });

  document.querySelectorAll(".fbh-player-cell-badge-target").forEach((element) => {
    element.classList.remove("fbh-player-cell-badge-target");
  });

  document.querySelectorAll(`.${highlightClass}`).forEach((row) => {
    row.classList.remove(
      highlightClass,
      "fbh-start-row",
      "fbh-watch-row",
      "fbh-bench-row",
      "fbh-add-row"
    );
  });

}

function markMatchedRows(players, sidebar, badgeClass, highlightClass) {
  players.forEach((player) => {
    const nameElement = findPlayerNameElement(player.name, sidebar);

    if (!nameElement) {
      return;
    }

    const row = findRowContainer(nameElement);
    if (row) {
      row.classList.add(highlightClass, getRowClass(player));
    }
    const badgeHost = createBadgeHost(nameElement, player.name);

    if (!badgeHost) {
      return;
    }

    const badge = document.createElement("span");
    badge.className = `${badgeClass} ${getScoreBadgeClass(player)}`;
    badge.textContent = getScore(player);
    badge.tabIndex = 0;
    badge.setAttribute("role", "button");
    badge.setAttribute(
      "aria-label",
      `Open ${player.name} fantasy helper card. Score ${getScore(player)}.`
    );
    badge.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openPlayerCard(player);
    });
    badge.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      openPlayerCard(player);
    });
    badgeHost.appendChild(badge);
  });
}

function createBadgeHost(nameElement, playerName) {
  const playerCell = findSafePlayerCell(nameElement, playerName);

  if (playerCell) {
    playerCell.classList.add("fbh-player-cell-badge-target");
    const host = document.createElement("span");
    host.className = "fbh-inline-badge-host fbh-player-cell-badge-host";
    playerCell.appendChild(host);
    return host;
  }

  return createInlineNameBadgeHost(nameElement, playerName);
}

function findSafePlayerCell(nameElement, playerName) {
  const normalizedPlayerName = normalizeText(playerName);
  const row = findRowContainer(nameElement);
  let current = nameElement;

  for (let levels = 0; current && current !== row && levels < 5; levels += 1) {
    const text = normalizeText(current.textContent || "");

    if (isSafePlayerCellText(text, normalizedPlayerName)) {
      return current;
    }

    current = current.parentElement;
  }

  return null;
}

function isSafePlayerCellText(text, normalizedPlayerName) {
  if (!text || text.length > 90 || !text.includes(normalizedPlayerName)) {
    return false;
  }

  const unrelatedPattern =
    /\b(move|status|opp|april|season|batting|pitching|h\/ab|hr|rbi|bb|avg|era|whip)\b/;
  if (unrelatedPattern.test(text)) {
    return false;
  }

  const teamPositionPattern =
    /\b[a-z]{2,3}\s+(c|1b|2b|3b|ss|if|of|dh|sp|rp|p)\b/;
  return teamPositionPattern.test(text);
}

function createInlineNameBadgeHost(nameElement, playerName) {
  if (normalizeVisibleNameText(nameElement.textContent).length > 60) {
    return null;
  }

  const host = document.createElement("span");
  host.className = "fbh-inline-badge-host";
  nameElement.classList.add("fbh-player-name-mark");
  nameElement.appendChild(host);
  return host;
}

function findPlayerNameElement(playerName, sidebar) {
  const normalizedName = normalizeText(playerName);
  const candidates = Array.from(
    document.querySelectorAll("a, button, span, td, div")
  ).filter((element) => {
    if (isInsideHelperUi(element, sidebar)) {
      return false;
    }

    const text = normalizeText(element.textContent);
    return textContainsPlayerNameWithLineupSlot(text, normalizedName);
  });

  // Prefer the smallest element that contains the player name. On ESPN this is
  // usually the player link inside a larger table row.
  return candidates.sort((a, b) => {
    return a.textContent.length - b.textContent.length;
  })[0];
}

function textContainsPlayerNameWithLineupSlot(text, normalizedName) {
  if (text === normalizedName || text.startsWith(`${normalizedName} `)) {
    return true;
  }

  const withoutLineupSlot = text
    .replace(/^\d{1,2}\s+/, "")
    .replace(/\s+\d{1,2}$/, "")
    .trim();

  return (
    withoutLineupSlot === normalizedName ||
    withoutLineupSlot.startsWith(`${normalizedName} `)
  );
}

function findVisiblePlayerNames(sidebar) {
  const names = new Set();

  findLikelyRosterRows(sidebar).forEach((row) => {
    const name = extractPlayerName(row.textContent);
    if (name) {
      names.add(name);
    }
  });

  findLikelyPlayerElements(sidebar).forEach((element) => {
    const name = extractPlayerName(element.textContent);
    if (name) {
      names.add(name);
    }
  });

  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

function findVisiblePlayerNamesFromIndex(sidebar, mlbPlayerIndex) {
  const pageText = getPageTextWithoutSidebar(sidebar);

  return mlbPlayerIndex
    .filter((player) => {
      return player.name && pageText.includes(normalizeText(player.name));
    })
    .map((player) => player.name)
    .sort((a, b) => a.localeCompare(b));
}

function findLikelyRosterRows(sidebar) {
  const rowSelectors = [
    "tr",
    "[role='row']",
    "li",
    "[class*='Table__TR']",
    "[class*='Table2__tr']",
    "[class*='playerTableTable'] tr",
    "[class*='PlayerRow']",
    "[class*='player-row']"
  ];

  return Array.from(document.querySelectorAll(rowSelectors.join(","))).filter(
    (row) => {
      if (isInsideHelperUi(row, sidebar)) {
        return false;
      }

      const rowText = normalizeText(row.textContent || "");
      return hasRosterRowContext(rowText) && Boolean(extractPlayerName(row.textContent));
    }
  );
}

function findLikelyPlayerElements(sidebar) {
  return Array.from(document.querySelectorAll("a, span, div")).filter(
    (element) => {
      if (isInsideHelperUi(element, sidebar)) {
        return false;
      }

      const text = normalizeVisibleNameText(element.textContent);
      if (!looksLikePlayerName(text)) {
        return false;
      }

      const row = findRowContainer(element);
      const rowText = normalizeText(row?.textContent || "");

      // Keep this scoped to real fantasy roster rows. ESPN navigation links can
      // look like names, but they do not sit inside player-stat rows.
      return hasRosterRowContext(rowText) && rowText.length < 220;
    }
  );
}

function hasRosterRowContext(rowText) {
  if (!rowText || rowText.length > 500) {
    return false;
  }

  const positionPattern = /\b(c|1b|2b|3b|ss|if|of|dh|sp|rp|p)\b/;
  const lineupTablePattern = /\b(move|opp|status)\b/;
  const teamPositionPattern =
    /\b[a-z]{2,3}\s+(c|1b|2b|3b|ss|if|of|dh|sp|rp|p)(?:\b|,)/;

  return (
    positionPattern.test(rowText) &&
    (lineupTablePattern.test(rowText) || teamPositionPattern.test(rowText))
  );
}

function extractPlayerName(text) {
  const cleanedText = normalizeVisibleNameText(text);
  const match = cleanedText.match(
    /\b[A-Z][a-z.'-]+(?:\s+(?:[A-Z][a-z.'-]+|[A-Z]\.|Jr\.|Sr\.|II|III|IV)){1,3}\b/
  );

  if (!match) {
    return "";
  }

  const name = match[0].replace(/\s+/g, " ").trim();
  return looksLikePlayerName(name) ? name : "";
}

function normalizeVisibleNameText(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

function looksLikePlayerName(text) {
  if (!text || text.length < 5 || text.length > 40) {
    return false;
  }

  if (!/^[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+)+$/.test(text)) {
    return false;
  }

  const blockedWords = [
    "ADD PLAYER",
    "ADD PLAYERS",
    "BATTING",
    "BATTERS",
    "BENCH",
    "FANTASY CHAT",
    "INJURED",
    "LINEUP PROTECTION MOVES",
    "MATCHUP",
    "MOVE",
    "OPPOSING TEAMS",
    "PLAYER",
    "PLAYER NEWS",
    "PLAYER RATER",
    "PLAYERS",
    "PITCHERS",
    "SAN DIEGO STATE AZTECS",
    "SLOT",
    "STATE PRIVACY RIGHTS",
    "STATUS",
    "TEAM SETTINGS",
    "WATCH LIST",
    "WATCH"
  ];

  return !blockedWords.includes(text.toUpperCase());
}

function findUntrackedPlayerNames(visiblePlayerNames, players) {
  const trackedNames = new Set(players.map((player) => normalizeText(player.name)));

  return visiblePlayerNames.filter((name) => {
    return !trackedNames.has(normalizeText(name));
  });
}

function findRowContainer(element) {
  const row = element.closest("tr, [role='row'], li");
  if (row) {
    return row;
  }

  // Some fantasy pages use nested divs instead of real table rows.
  let current = element.parentElement;
  for (let levels = 0; current && levels < 5; levels += 1) {
    const text = normalizeText(current.textContent);
    if (text.length > 20) {
      return current;
    }
    current = current.parentElement;
  }

  return element.parentElement;
}

function getBadgeClass(player) {
  return `fbh-badge-${normalizeText(getAction(player) || getTag(player))
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
}

function getScoreBadgeClass(player) {
  const score = Number(getScore(player));

  if (!Number.isFinite(score)) {
    return "fbh-score-badge-unknown";
  }

  if (score >= 85) {
    return "fbh-score-badge-elite";
  }

  if (score >= 70) {
    return "fbh-score-badge-start";
  }

  if (score >= 45) {
    return "fbh-score-badge-watch";
  }

  return "fbh-score-badge-bench";
}

function getRowClass(player) {
  const action = normalizeText(getAction(player));

  if (action.includes("start")) {
    return "fbh-start-row";
  }

  if (action.includes("bench") || action.includes("sit")) {
    return "fbh-bench-row";
  }

  if (action.includes("add")) {
    return "fbh-add-row";
  }

  return "fbh-watch-row";
}

function openPlayerCard(player) {
  closePlayerCard();

  const backdrop = document.createElement("div");
  backdrop.className = "fbh-player-modal-backdrop";
  backdrop.setAttribute("role", "presentation");
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) {
      closePlayerCard();
    }
  });

  const card = document.createElement("section");
  card.className = "fbh-player-modal-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-label", `${player.name} fantasy helper card`);

  const closeButton = document.createElement("button");
  closeButton.className = "fbh-player-modal-close";
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", "Close player card");
  closeButton.textContent = "×";
  closeButton.addEventListener("click", closePlayerCard);

  card.append(
    closeButton,
    createPlayerCardHeader(player),
    createDecisionSection(player),
    createRatingTrendSection(player),
    createFantasySnapshotSection(player),
    createRecentGamesSection(player),
    createSavantSection(player),
    createPlayerNotesSection(player)
  );
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);

  document.addEventListener("keydown", closePlayerCardOnEscape);
  closeButton.focus();
}

function closePlayerCard() {
  document.querySelectorAll(".fbh-player-modal-backdrop").forEach((modal) => {
    modal.remove();
  });
  document.removeEventListener("keydown", closePlayerCardOnEscape);
}

function closePlayerCardOnEscape(event) {
  if (event.key === "Escape") {
    closePlayerCard();
  }
}

function createPlayerCardHeader(player) {
  const header = document.createElement("header");
  header.className = "fbh-player-modal-header";
  const teamMeta = getTeamMeta(player.team);
  header.style.setProperty("--fbh-team-primary", teamMeta.primary);
  header.style.setProperty("--fbh-team-secondary", teamMeta.secondary);

  const intro = document.createElement("div");
  intro.className = "fbh-player-modal-intro";

  const identity = document.createElement("div");
  identity.className = "fbh-player-modal-identity";

  const title = document.createElement("h2");
  title.textContent = player.name;

  const meta = document.createElement("p");
  meta.textContent = [
    player.team,
    Array.isArray(player.positions) ? player.positions.join("/") : "",
    player.status,
    getHandednessLine(player)
  ]
    .filter(Boolean)
    .join(" - ");

  identity.append(title, meta);
  intro.append(createPlayerMedia(player, teamMeta), identity);

  const summary = document.createElement("div");
  summary.className = "fbh-player-modal-summary";
  summary.append(createScorePanel(player));

  if (player.mlbId) {
    const savantLink = document.createElement("a");
    savantLink.className = "fbh-savant-link-button";
    savantLink.href = `https://baseballsavant.mlb.com/savant-player/${player.mlbId}`;
    savantLink.target = "_blank";
    savantLink.rel = "noopener noreferrer";
    savantLink.setAttribute("aria-label", `Open ${player.name} on Baseball Savant`);

    const savantLogo = document.createElement("img");
    savantLogo.src = chrome.runtime.getURL("image.png");
    savantLogo.alt = "Baseball Savant";
    savantLogo.loading = "lazy";
    savantLink.appendChild(savantLogo);

    summary.appendChild(savantLink);
  }

  header.append(createHeaderTeamLogo(player, teamMeta), intro, summary);
  return header;
}

function createPlayerMedia(player, teamMeta) {
  const media = document.createElement("div");
  media.className = "fbh-player-modal-media";

  if (player.mlbId) {
    const headshot = document.createElement("img");
    headshot.className = "fbh-player-modal-headshot";
    headshot.src = `https://img.mlbstatic.com/mlb-photos/image/upload/w_180,q_auto:best/v1/people/${player.mlbId}/headshot/67/current`;
    headshot.alt = `${player.name} headshot`;
    headshot.loading = "lazy";
    headshot.addEventListener("error", () => {
      headshot.replaceWith(createPlayerInitials(player.name));
    });
    media.appendChild(headshot);
  } else {
    media.appendChild(createPlayerInitials(player.name));
  }

  return media;
}

function createHeaderTeamLogo(player, teamMeta) {
  if (!teamMeta.logoId) {
    return document.createTextNode("");
  }

  const logo = document.createElement("img");
  logo.className = "fbh-player-modal-header-logo";
  logo.src = `https://www.mlbstatic.com/team-logos/${teamMeta.logoId}.svg`;
  logo.alt = `${player.team} logo`;
  logo.loading = "lazy";
  logo.addEventListener("error", () => {
    logo.remove();
  });
  return logo;
}

function getHandednessLine(player) {
  const handedness = [
    player.bats ? `Bats ${player.bats}` : "",
    player.throws ? `Throws ${player.throws}` : ""
  ].filter(Boolean);
  return handedness.join(" / ");
}

function createPlayerInitials(name) {
  const initials = document.createElement("div");
  initials.className = "fbh-player-modal-initials";
  initials.textContent = String(name || "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  return initials;
}

function createDecisionSection(player) {
  const section = createModalSection("Decision");
  const tag = document.createElement("p");
  tag.className = "fbh-player-modal-tag";
  tag.textContent = `Profile: ${getTag(player)}`;

  const reason = document.createElement("p");
  reason.className = "fbh-player-modal-reason";
  reason.textContent = getDecisionSummary(player) || getReason(player);

  const notes = document.createElement("p");
  notes.className = "fbh-player-modal-notes";
  notes.textContent = getRecommendation(player).scoringNotes || "";

  section.append(tag);
  if (hasDecision(player)) {
    section.appendChild(createDecisionBadges(player.decision));
  }
  section.append(reason);
  if (hasDecision(player)) {
    section.appendChild(createDecisionDetails(player.decision));
  }
  if (player.rating) {
    section.appendChild(createRatingBreakdown(player.rating));
  } else if (notes.textContent) {
    section.appendChild(notes);
  }
  return section;
}

function hasDecision(player) {
  return Boolean(player.decision?.summary);
}

function getDecisionSummary(player) {
  return String(player.decision?.summary || "").trim();
}

function createDecisionBadges(decision) {
  const wrapper = document.createElement("div");
  wrapper.className = "fbh-decision-badges";

  (decision.badges || []).forEach((badge) => {
    const badgeElement = document.createElement("span");
    badgeElement.className = `fbh-decision-badge fbh-decision-badge-${normalizeText(badge.tone || "neutral")}`;
    const label = String(badge.label || "Note").trim();
    const detail = String(badge.detail || "").trim();
    const description = String(badge.description || "").trim();
    const labelElement = document.createElement("span");
    labelElement.className = "fbh-decision-badge-label";
    labelElement.textContent = label;

    badgeElement.appendChild(labelElement);

    if (detail) {
      const detailElement = document.createElement("span");
      detailElement.className = "fbh-decision-badge-detail";
      detailElement.textContent = detail;
      badgeElement.appendChild(detailElement);
    }

    const accessibleText = description || [label, detail].filter(Boolean).join(": ");
    if (accessibleText) {
      badgeElement.title = accessibleText;
      badgeElement.setAttribute("aria-label", accessibleText);
    }

    wrapper.appendChild(badgeElement);
  });

  return wrapper;
}

function createDecisionDetails(decision) {
  const wrapper = document.createElement("div");
  wrapper.className = "fbh-decision-details";

  const keyPoints = (decision.keyPoints || [])
    .map((point) => String(point || "").trim())
    .filter(Boolean)
    .slice(0, 3);

  if (keyPoints.length) {
    const why = document.createElement("div");
    why.className = "fbh-decision-why";

    const heading = document.createElement("strong");
    heading.textContent = "Why";

    const list = document.createElement("ul");
    keyPoints.forEach((point) => {
      const item = document.createElement("li");
      item.textContent = point;
      list.appendChild(item);
    });

    why.append(heading, list);
    wrapper.appendChild(why);
  }

  const riskText = String(decision.risk || "").trim();
  if (riskText) {
    const risk = document.createElement("p");
    risk.className = "fbh-decision-risk";
    risk.textContent = riskText;
    wrapper.appendChild(risk);
  }

  return wrapper;
}

function createRatingBreakdown(rating) {
  const wrapper = document.createElement("div");
  wrapper.className = "fbh-rating-breakdown";

  const rows = [
    [
      "Projection",
      rating.components?.projection,
      "Rest-of-season fantasy category percentile against fantasy-relevant players. Hitters include a modest position scarcity adjustment."
    ],
    [
      "Current Form",
      rating.components?.currentForm,
      "Blend of Season Form, Recent Trend, and Savant Skills."
    ],
    [
      "Season Form",
      rating.components?.seasonStats,
      "Current-season fantasy production adjusted for sample size. The model blends current stats with projection until enough volume: hitters around 150 PA, SP around 40 IP, RP around 15 IP."
    ],
    [
      "Recent Trend",
      rating.components?.recentTrend,
      "Role-based recent MLB game logs converted to a peer percentile and regressed for small samples: hitters use last 7 games, SP use last 3 starts, RP use last 5 outings."
    ],
    [
      "Savant Skills",
      rating.components?.savantSkills,
      "Average percentile from key Baseball Savant skill metrics."
    ]
  ];

  rows.forEach(([label, value, tooltip], index) => {
    const item = document.createElement("div");
    item.className = index < 2
      ? "fbh-rating-breakdown-item fbh-rating-primary"
      : "fbh-rating-breakdown-item fbh-rating-subcomponent";

    const itemLabel = document.createElement("div");
    itemLabel.className = "fbh-rating-breakdown-label";

    const labelText = document.createElement("span");
    labelText.textContent = label;

    const info = document.createElement("span");
    info.className = "fbh-info-tooltip";
    info.tabIndex = 0;
    info.setAttribute("role", "img");
    info.setAttribute("aria-label", tooltip);
    info.dataset.tooltip = tooltip;
    info.textContent = "i";

    itemLabel.append(labelText, info);

    const itemValue = document.createElement("strong");
    itemValue.textContent = Number.isFinite(Number(value)) ? String(value) : "N/A";

    item.append(itemLabel, itemValue);
    wrapper.appendChild(item);
  });

  const note = document.createElement("p");
  note.className = "fbh-player-modal-notes";
  note.textContent =
    "Final score = 60% Rest of Season Projection + 40% Current Form.";
  wrapper.appendChild(note);

  return wrapper;
}

function createRatingTrendSection(player) {
  const section = createModalSection("Trend");
  const history = normalizeRatingHistory(player);

  if (history.length === 0) {
    const empty = document.createElement("p");
    empty.className = "fbh-player-modal-empty";
    empty.textContent = "No rating history has been captured yet.";
    section.appendChild(empty);
    return section;
  }

  const state = new Set(
    RATING_TREND_SERIES.filter((series) => series.defaultVisible).map((series) => series.key)
  );
  const controls = document.createElement("div");
  controls.className = "fbh-rating-trend-controls";
  const chart = document.createElement("div");
  chart.className = "fbh-rating-trend-chart";

  const render = () => {
    renderRatingTrendChart(chart, history, state);
  };

  RATING_TREND_SERIES.forEach((series) => {
    const label = document.createElement("label");
    label.className = "fbh-rating-trend-toggle";
    label.style.setProperty("--fbh-series-color", series.color);

    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = series.key;
    input.checked = state.has(series.key);
    input.addEventListener("change", () => {
      if (input.checked) {
        state.add(series.key);
      } else {
        state.delete(series.key);
      }
      render();
    });

    const text = document.createElement("span");
    text.textContent = series.label;

    label.append(input, text);
    controls.appendChild(label);
  });

  const meta = document.createElement("p");
  meta.className = "fbh-player-modal-notes";
  const currentDate = player.source?.updatedAt || player.decision?.generatedAt || "";
  const todayDate = getTodayDateString();
  const weeklyHistory = history.filter((entry) => entry.kind !== "current");
  const currentSuffix = currentDate
    ? ` The ${formatTrendDate(todayDate)} point is the current card value from the latest refresh through ${formatTrendDate(currentDate)}.`
    : "";
  meta.textContent =
    (weeklyHistory.length === 1
      ? `1 Monday AM snapshot: ${formatTrendDate(weeklyHistory[0].date)}.`
      : `${weeklyHistory.length} Monday AM snapshots from ${formatTrendDate(weeklyHistory[0]?.date)} to ${formatTrendDate(weeklyHistory[weeklyHistory.length - 1]?.date)}.`) +
    ` Weekly snapshots use stats through the previous Sunday.${currentSuffix}`;

  render();
  section.append(controls, chart, meta);
  return section;
}

function normalizeRatingHistory(player) {
  const history = Array.isArray(player.ratingHistory) ? player.ratingHistory : [];
  const currentDate = player.source?.updatedAt || player.decision?.generatedAt || "";
  const todayDate = getTodayDateString();
  const currentEntry =
    currentDate && todayDate && player.rating
      ? {
          date: todayDate,
          throughDate: currentDate,
          kind: "current",
          scores: {
            overall: toFiniteNumber(player.rating.score || player.recommendation?.score),
            projection: toFiniteNumber(player.rating.components?.projection),
            currentForm: toFiniteNumber(player.rating.components?.currentForm),
            seasonStats: toFiniteNumber(player.rating.components?.seasonStats),
            recentTrend: toFiniteNumber(player.rating.components?.recentTrend),
            savantSkills: toFiniteNumber(player.rating.components?.savantSkills)
          }
        }
      : null;
  const byDate = new Map();

  history.forEach((entry) => {
    const normalized = normalizeRatingHistoryEntry(entry);
    if (normalized && isMondayDate(normalized.date)) {
      byDate.set(normalized.date, normalized);
    }
  });

  if (currentEntry) {
    const normalizedCurrent = normalizeRatingHistoryEntry(currentEntry);
    if (normalizedCurrent) {
      byDate.set(normalizedCurrent.date, normalizedCurrent);
    }
  }

  return Array.from(byDate.values()).sort((a, b) => {
    return String(a.date).localeCompare(String(b.date));
  });
}

function normalizeRatingHistoryEntry(entry) {
  const date = String(entry?.date || "").trim();
  if (!date) {
    return null;
  }

  const scores = {};
  RATING_TREND_SERIES.forEach((series) => {
    const value = toFiniteNumber(entry.scores?.[series.key]);
    if (Number.isFinite(value)) {
      scores[series.key] = value;
    }
  });

  if (Object.keys(scores).length === 0) {
    return null;
  }

  return {
    date,
    throughDate: String(entry?.throughDate || getWeeklySnapshotThroughDate(date)).trim(),
    kind: String(entry?.kind || "weekly").trim(),
    scores
  };
}

function getTodayDateString() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isMondayDate(dateString) {
  const date = new Date(`${dateString}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.getUTCDay() === 1;
}

function getWeeklySnapshotThroughDate(dateString) {
  const date = new Date(`${dateString}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function renderRatingTrendChart(container, history, visibleSeries) {
  container.textContent = "";

  const selectedSeries = RATING_TREND_SERIES.filter((series) => visibleSeries.has(series.key));
  if (selectedSeries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "fbh-player-modal-empty";
    empty.textContent = "Select at least one score to show.";
    container.appendChild(empty);
    return;
  }

  const width = 720;
  const height = 280;
  const padding = { top: 18, right: 18, bottom: 58, left: 42 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Rating trend chart");

  [0, 25, 50, 75, 100].forEach((tick) => {
    const y = scoreToY(tick, padding, plotHeight);
    const line = createSvgElement("line", {
      x1: padding.left,
      y1: y,
      x2: width - padding.right,
      y2: y,
      class: "fbh-rating-trend-grid"
    });
    const label = createSvgElement("text", {
      x: padding.left - 10,
      y: y + 4,
      class: "fbh-rating-trend-axis-label",
      "text-anchor": "end"
    });
    label.textContent = String(tick);
    svg.append(line, label);
  });

  const axis = createSvgElement("path", {
    d: `M ${padding.left} ${padding.top} V ${height - padding.bottom} H ${width - padding.right}`,
    class: "fbh-rating-trend-axis"
  });
  svg.appendChild(axis);

  history.forEach((entry, index) => {
    const x = dateIndexToX(index, history.length, padding, plotWidth);
    const tick = createSvgElement("line", {
      x1: x,
      y1: height - padding.bottom,
      x2: x,
      y2: height - padding.bottom + 5,
      class: "fbh-rating-trend-date-tick"
    });
    const label = createSvgElement("text", {
      x,
      y: height - 20,
      class: "fbh-rating-trend-axis-label fbh-rating-trend-date-label",
      "text-anchor": "end",
      transform: `rotate(-35 ${x} ${height - 20})`
    });
    label.textContent = formatTrendDate(entry.date);
    svg.append(tick, label);
  });

  selectedSeries.forEach((series) => {
    const points = history
      .map((entry, index) => {
        const value = toFiniteNumber(entry.scores?.[series.key]);
        if (!Number.isFinite(value)) {
          return null;
        }
        return {
          date: entry.date,
          throughDate: entry.throughDate,
          value,
          x: dateIndexToX(index, history.length, padding, plotWidth),
          y: scoreToY(value, padding, plotHeight)
        };
      })
      .filter(Boolean);

    if (points.length === 0) {
      return;
    }

    if (points.length > 1) {
      svg.appendChild(
        createSvgElement("polyline", {
          points: points.map((point) => `${point.x},${point.y}`).join(" "),
          fill: "none",
          stroke: series.color,
          "stroke-width": 3,
          "stroke-linecap": "round",
          "stroke-linejoin": "round",
          class: "fbh-rating-trend-line"
        })
      );
    }

    points.forEach((point) => {
      const pointGroup = createSvgElement("g", {
        class: "fbh-rating-trend-point-group",
        tabindex: 0,
        "aria-label": `${series.label}: ${Math.round(point.value)} on ${formatTrendDate(point.date)}, through ${formatTrendDate(point.throughDate)}`
      });
      const labelPosition = getTrendPointLabelPosition(point, width, padding);
      const hitTarget = createSvgElement("circle", {
        cx: point.x,
        cy: point.y,
        r: 11,
        fill: "transparent",
        class: "fbh-rating-trend-hit-target",
        "pointer-events": "all"
      });
      const marker = createSvgElement("circle", {
        cx: point.x,
        cy: point.y,
        r: 4,
        fill: series.color,
        class: "fbh-rating-trend-point"
      });
      const valueLabel = createSvgElement("text", {
        x: labelPosition.x,
        y: labelPosition.y,
        fill: series.color,
        class: "fbh-rating-trend-point-label",
        "text-anchor": labelPosition.anchor,
        opacity: 0
      });
      valueLabel.textContent = String(Math.round(point.value));
      attachTrendPointInteractions(pointGroup, marker, valueLabel);
      pointGroup.append(hitTarget, marker, valueLabel);
      svg.appendChild(pointGroup);
    });
  });

  container.appendChild(svg);
}

function createSvgElement(tagName, attributes = {}) {
  const element = document.createElementNS(SVG_NS, tagName);
  Object.entries(attributes).forEach(([name, value]) => {
    element.setAttribute(name, String(value));
  });
  return element;
}

function dateIndexToX(index, count, padding, plotWidth) {
  if (count <= 1) {
    return padding.left + plotWidth / 2;
  }
  return padding.left + (index / (count - 1)) * plotWidth;
}

function scoreToY(score, padding, plotHeight) {
  return padding.top + (1 - clampNumber(toFiniteNumber(score) || 0, 0, 100) / 100) * plotHeight;
}

function getTrendPointLabelPosition(point, width, padding) {
  const isNearTop = point.y < padding.top + 24;
  const xOffset = point.x < padding.left + 22 ? 8 : point.x > width - padding.right - 22 ? -8 : 0;
  const anchor = xOffset > 0 ? "start" : xOffset < 0 ? "end" : "middle";

  return {
    x: point.x + xOffset,
    y: point.y + (isNearTop ? 22 : -10),
    anchor
  };
}

function attachTrendPointInteractions(pointGroup, marker, valueLabel) {
  const showLabel = () => {
    valueLabel.setAttribute("opacity", "1");
    marker.setAttribute("r", "5.5");
  };
  const hideLabel = () => {
    valueLabel.setAttribute("opacity", "0");
    marker.setAttribute("r", "4");
  };

  pointGroup.addEventListener("mouseenter", showLabel);
  pointGroup.addEventListener("mouseleave", hideLabel);
  pointGroup.addEventListener("focus", showLabel);
  pointGroup.addEventListener("blur", hideLabel);
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatTrendDate(value) {
  const parts = String(value || "").split("-");
  if (parts.length !== 3) {
    return String(value || "");
  }
  return `${Number(parts[1])}/${Number(parts[2])}`;
}

function createFantasySnapshotSection(player) {
  const section = createModalSection("Stats");
  section.appendChild(createFantasyStatsTable(player));
  return section;
}

function createFantasyStatsTable(player) {
  const table = document.createElement("table");
  table.className = "fbh-stats-table";

  const headers =
    player.projection?.group === "pitching"
      ? ["", ...getPitchingStatColumns(player).map((column) => column.header)]
      : ["", "H/AB", "R", "HR", "RBI", "SB", "AVG", "OPS"];
  const bodyRows = [
    getFantasyStatsTableRow("Current Season", player, "stats"),
    getFantasyStatsTableRow("Projection", player, "projection")
  ];

  table.append(createTableHead(headers), createTableBody(bodyRows));
  return table;
}

function getFantasyStatsTableRow(label, player, sourceKey) {
  const data = player[sourceKey] || {};
  const shouldRound = sourceKey === "projection";

  if ((player.projection?.group || data.group) === "pitching") {
    return [
      label,
      ...getPitchingStatColumns(player).map((column) => column.getValue(data, shouldRound))
    ];
  }

  return [
    label,
    `${roundDisplay(data.hits)}/${roundDisplay(data.atBats)}`,
    shouldRound ? roundDisplay(data.runs) : data.runs || 0,
    shouldRound ? roundDisplay(data.homeRuns) : data.homeRuns || 0,
    shouldRound ? roundDisplay(data.rbi) : data.rbi || 0,
    shouldRound ? roundDisplay(data.stolenBases) : data.stolenBases || 0,
    formatAverage(data.avg),
    formatAverage(data.ops)
  ];
}

function createRecentGamesSection(player) {
  const section = createModalSection("Recent Performance");
  const games = player.recentGames?.games || [];

  if (games.length === 0) {
    const fallback = document.createElement("p");
    fallback.className = "fbh-player-modal-empty";
    fallback.textContent = "No recent game logs found for this player yet.";
    section.appendChild(fallback);
    return section;
  }

  const defaultGameCount = getRecentPerformanceDefaultGameCount(player);
  const defaultGames = games.slice(0, defaultGameCount);
  const expandedGames = games.slice(0, RECENT_PERFORMANCE_EXPANDED_GAMES);
  const tableContainer = document.createElement("div");
  tableContainer.className = "fbh-recent-performance-table";
  tableContainer.appendChild(createRecentGamesTable(player, defaultGames));
  section.appendChild(tableContainer);

  if (expandedGames.length > defaultGames.length) {
    const toggleButton = document.createElement("button");
    toggleButton.className = "fbh-recent-performance-toggle";
    toggleButton.type = "button";
    toggleButton.textContent = "Show More";
    toggleButton.setAttribute(
      "aria-label",
      `Show last ${expandedGames.length} games for recent performance`
    );
    toggleButton.setAttribute("aria-expanded", "false");

    toggleButton.addEventListener("click", () => {
      const isExpanded = toggleButton.getAttribute("aria-expanded") === "true";
      const visibleGames = isExpanded ? defaultGames : expandedGames;
      tableContainer.replaceChildren(createRecentGamesTable(player, visibleGames));
      toggleButton.setAttribute("aria-expanded", String(!isExpanded));
      toggleButton.textContent = isExpanded ? "Show More" : "Show Fewer";
      toggleButton.setAttribute(
        "aria-label",
        isExpanded
          ? `Show last ${expandedGames.length} games for recent performance`
          : `Show only last ${defaultGameCount} games for recent performance`
      );
    });

    section.appendChild(toggleButton);
  }

  return section;
}

function getRecentPerformanceDefaultGameCount(player) {
  return player.projection?.group === "pitching" || player.stats?.group === "pitching"
    ? PITCHER_RECENT_PERFORMANCE_DEFAULT_GAMES
    : HITTER_RECENT_PERFORMANCE_DEFAULT_GAMES;
}

function createRecentGamesTable(player, games) {
  const table = document.createElement("table");
  table.className = "fbh-stats-table fbh-game-log-table";

  const headers =
    player.projection?.group === "pitching"
      ? ["DATE", "OPP", ...getPitchingGameLogColumns(player).map((column) => column.header)]
      : ["DATE", "OPP", "H/AB", "R", "HR", "RBI", "SB", "AVG", "OPS", "K"];
  const rows = games.map((game) => {
    if (player.projection?.group === "pitching") {
      return [
        game.date,
        game.opponent,
        ...getPitchingGameLogColumns(player).map((column) => column.getValue(game))
      ];
    }

    return [
      game.date,
      game.opponent,
      `${game.hits}/${game.atBats}`,
      game.runs,
      game.homeRuns,
      game.rbi,
      game.stolenBases,
      game.avg,
      game.ops,
      game.strikeOuts
    ];
  });

  table.append(
    createTableHead(headers),
    createTableBody(rows),
    createTableFoot([getRecentGamesTotalsRow(player, games)])
  );
  return table;
}

function getRecentGamesTotalsRow(player, games) {
  if (player.projection?.group === "pitching") {
    const totals = games.reduce(
      (sum, game) => {
        const inningsPitched = inningsPitchedToNumber(game.inningsPitched);
        const era = Number(game.era);
        const whip = Number(game.whip);
        return {
          inningsPitched: sum.inningsPitched + inningsPitched,
          earnedRuns: sum.earnedRuns + Number(game.earnedRuns || 0),
          strikeOuts: sum.strikeOuts + Number(game.strikeOuts || 0),
          baseOnBalls: sum.baseOnBalls + Number(game.baseOnBalls || 0),
          qualityStarts: sum.qualityStarts + (game.qualityStart ? 1 : 0),
          wins: sum.wins + Number(game.wins || 0),
          saves: sum.saves + Number(game.saves || 0),
          baserunners: sum.baserunners + (Number.isFinite(whip) ? whip * inningsPitched : 0)
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
    const era = totals.inningsPitched
      ? ((totals.earnedRuns * 9) / totals.inningsPitched).toFixed(2)
      : ".---";
    const whip = totals.inningsPitched
      ? (totals.baserunners / totals.inningsPitched).toFixed(2)
      : ".---";

    return [
      "Total",
      "",
      ...getPitchingGameLogColumns(player).map((column) =>
        column.getTotalValue({ ...totals, era, whip })
      )
    ];
  }

  const totals = games.reduce(
    (sum, game) => {
      return {
        hits: sum.hits + Number(game.hits || 0),
        atBats: sum.atBats + Number(game.atBats || 0),
        runs: sum.runs + Number(game.runs || 0),
        homeRuns: sum.homeRuns + Number(game.homeRuns || 0),
        rbi: sum.rbi + Number(game.rbi || 0),
        stolenBases: sum.stolenBases + Number(game.stolenBases || 0),
        strikeOuts: sum.strikeOuts + Number(game.strikeOuts || 0)
      };
    },
    { hits: 0, atBats: 0, runs: 0, homeRuns: 0, rbi: 0, stolenBases: 0, strikeOuts: 0 }
  );
  const avg = totals.atBats ? formatAverage(totals.hits / totals.atBats) : ".---";

  return [
    "Total",
    "",
    `${totals.hits}/${totals.atBats}`,
    totals.runs,
    totals.homeRuns,
    totals.rbi,
    totals.stolenBases,
    avg,
    "--",
    totals.strikeOuts
  ];
}

function getPitchingStatColumns(player) {
  const visibility = getPitchingStatVisibility(player);
  const columns = [
    {
      header: "IP",
      getValue: (data, shouldRound) =>
        shouldRound ? roundDisplay(data.inningsPitched) : data.inningsPitched || "0.0"
    },
    {
      header: "ER",
      getValue: (data, shouldRound) =>
        shouldRound ? roundDisplay(data.earnedRuns) : data.earnedRuns || 0
    },
    {
      header: "K",
      getValue: (data, shouldRound) =>
        shouldRound ? roundDisplay(data.strikeOuts) : data.strikeOuts || 0
    },
    {
      header: "BB",
      getValue: (data, shouldRound) =>
        shouldRound ? roundDisplay(data.baseOnBalls) : data.baseOnBalls || 0
    }
  ];

  if (visibility.showQualityStarts) {
    columns.push({
      header: "QS",
      getValue: (data, shouldRound) =>
        shouldRound ? roundDisplay(data.qualityStarts) : data.qualityStarts || 0
    });
  }

  columns.push({
    header: "W",
    getValue: (data, shouldRound) => (shouldRound ? roundDisplay(data.wins) : data.wins || 0)
  });

  if (visibility.showSaves) {
    columns.push({
      header: "SV",
      getValue: (data, shouldRound) => (shouldRound ? roundDisplay(data.saves) : data.saves || 0)
    });
  }

  columns.push(
    { header: "ERA", getValue: (data) => data.era || ".---" },
    { header: "WHIP", getValue: (data) => data.whip || ".---" }
  );

  return columns;
}

function getPitchingGameLogColumns(player) {
  const visibility = getPitchingStatVisibility(player);
  const columns = [
    {
      header: "IP",
      getValue: (game) => game.inningsPitched,
      getTotalValue: (totals) => numberToInningsPitched(totals.inningsPitched)
    },
    {
      header: "ER",
      getValue: (game) => game.earnedRuns || 0,
      getTotalValue: (totals) => totals.earnedRuns
    },
    {
      header: "K",
      getValue: (game) => game.strikeOuts,
      getTotalValue: (totals) => totals.strikeOuts
    },
    {
      header: "BB",
      getValue: (game) => game.baseOnBalls || 0,
      getTotalValue: (totals) => totals.baseOnBalls
    }
  ];

  if (visibility.showQualityStarts) {
    columns.push({
      header: "QS",
      getValue: (game) => (game.qualityStart ? 1 : 0),
      getTotalValue: (totals) => totals.qualityStarts
    });
  }

  columns.push({
    header: "W",
    getValue: (game) => game.wins,
    getTotalValue: (totals) => totals.wins
  });

  if (visibility.showSaves) {
    columns.push({
      header: "SV",
      getValue: (game) => game.saves,
      getTotalValue: (totals) => totals.saves
    });
  }

  columns.push(
    {
      header: "ERA",
      getValue: (game) => game.era,
      getTotalValue: (totals) => totals.era
    },
    {
      header: "WHIP",
      getValue: (game) => game.whip,
      getTotalValue: (totals) => totals.whip
    }
  );

  return columns;
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

function createTableHead(headers) {
  const thead = document.createElement("thead");
  const row = document.createElement("tr");

  headers.forEach((headerText) => {
    const header = document.createElement("th");
    header.textContent = headerText;
    row.appendChild(header);
  });

  thead.appendChild(row);
  return thead;
}

function createTableBody(rows) {
  const tbody = document.createElement("tbody");

  rows.forEach((rowValues) => {
    const row = document.createElement("tr");
    rowValues.forEach((value) => {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.appendChild(cell);
    });
    tbody.appendChild(row);
  });

  return tbody;
}

function createTableFoot(rows) {
  const tfoot = document.createElement("tfoot");

  rows.forEach((rowValues) => {
    const row = document.createElement("tr");
    rowValues.forEach((value) => {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.appendChild(cell);
    });
    tfoot.appendChild(row);
  });

  return tfoot;
}

function createSavantSection(player) {
  const section = createModalSection("");
  const savant = player.savant;

  if (!savant || !Array.isArray(savant.metrics) || savant.metrics.length === 0) {
    const fallback = document.createElement("p");
    fallback.className = "fbh-player-modal-empty";
    fallback.textContent =
      "No Baseball Savant leaderboard row found for this player yet.";
    section.appendChild(fallback);
    return section;
  }

  const logo = document.createElement("img");
  logo.className = "fbh-savant-rankings-logo";
  logo.src = chrome.runtime.getURL("savant-rankings.png");
  logo.alt = "Savant rankings";

  const groupHeading = document.createElement("h4");
  groupHeading.className = "fbh-savant-group-heading";
  groupHeading.textContent = savant.role === "pitcher" ? "Pitching" : "Batting";

  const scale = document.createElement("div");
  scale.className = "fbh-savant-scale";
  scale.innerHTML = `
    <span>POOR</span>
    <span>AVERAGE</span>
    <span>GREAT</span>
  `;

  const metrics = document.createElement("div");
  metrics.className = "fbh-savant-metrics";
  savant.metrics.forEach((metric) => {
    metrics.appendChild(createSavantMetricRow(metric));
  });

  section.append(logo, groupHeading, scale, metrics);
  return section;
}

function createSavantMetricRow(metric) {
  const row = document.createElement("div");
  row.className = "fbh-savant-metric";

  const label = document.createElement("div");
  label.className = "fbh-savant-metric-label";
  label.textContent = metric.label;

  const value = document.createElement("div");
  value.className = "fbh-savant-metric-value";
  value.textContent = metric.display || "N/A";

  const track = document.createElement("div");
  track.className = "fbh-savant-bar-track";

  const fill = document.createElement("div");
  const percentile = Number(metric.percentile);
  fill.className = `fbh-savant-bar-fill ${getPercentileClass(percentile)}`;
  fill.style.width = Number.isFinite(percentile) ? `${percentile}%` : "0%";

  const percentileText = document.createElement("div");
  percentileText.className = `fbh-savant-percentile ${getPercentileClass(percentile)}`;
  percentileText.textContent = Number.isFinite(percentile) ? `${percentile}` : "N/A";
  percentileText.style.left = Number.isFinite(percentile)
    ? `${clampNumber(percentile, 6, 94)}%`
    : "50%";

  track.append(fill, percentileText);

  row.append(label, track, value);
  return row;
}

function createPlayerNotesSection(player) {
  const section = createModalSection("Notes");
  const noteKey = getPlayerNoteKey(player);

  const feed = document.createElement("div");
  feed.className = "fbh-player-notes-feed";

  const empty = document.createElement("p");
  empty.className = "fbh-player-notes-empty";
  empty.textContent = "No notes yet.";

  const composer = document.createElement("form");
  composer.className = "fbh-player-notes-composer";

  const textarea = document.createElement("textarea");
  textarea.className = "fbh-player-notes-input";
  textarea.placeholder = "Add your own notes...";
  textarea.rows = 3;
  textarea.spellcheck = true;
  textarea.setAttribute("aria-label", `New note for ${player.name}`);

  const addButton = document.createElement("button");
  addButton.className = "fbh-player-notes-submit";
  addButton.type = "submit";
  addButton.textContent = "Add Note";

  composer.append(textarea, addButton);

  const renderNotes = (notes) => {
    feed.textContent = "";

    if (notes.length === 0) {
      feed.appendChild(empty);
      return;
    }

    notes.forEach((note) => {
      feed.appendChild(createPlayerNoteItem(note));
    });
  };

  chrome.storage.local.get(PLAYER_NOTES_STORAGE_KEY, (result) => {
    const storedNotes = result[PLAYER_NOTES_STORAGE_KEY] || {};
    renderNotes(normalizePlayerNotes(storedNotes[noteKey]));
  });

  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = textarea.value.trim();

    if (!text) {
      textarea.focus();
      return;
    }

    addPlayerNote(noteKey, text, (notes) => {
      textarea.value = "";
      renderNotes(notes);
    });
  });

  section.append(feed, composer);
  return section;
}

function createPlayerNoteItem(note) {
  const item = document.createElement("article");
  item.className = "fbh-player-note-item";

  const timestamp = document.createElement("time");
  timestamp.className = "fbh-player-note-time";
  timestamp.dateTime = note.createdAt;
  timestamp.textContent = formatPlayerNoteTimestamp(note.createdAt);

  const text = document.createElement("p");
  text.className = "fbh-player-note-text";
  text.textContent = note.text;

  item.append(timestamp, text);
  return item;
}

function addPlayerNote(noteKey, noteText, onSaved) {
  chrome.storage.local.get(PLAYER_NOTES_STORAGE_KEY, (result) => {
    const allNotes = { ...(result[PLAYER_NOTES_STORAGE_KEY] || {}) };
    const playerNotes = normalizePlayerNotes(allNotes[noteKey]);
    const nextNotes = [
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        text: noteText,
        createdAt: new Date().toISOString()
      },
      ...playerNotes
    ];

    allNotes[noteKey] = nextNotes;
    chrome.storage.local.set({ [PLAYER_NOTES_STORAGE_KEY]: allNotes }, () => {
      if (typeof onSaved === "function") {
        onSaved(nextNotes);
      }
    });
  });
}

function normalizePlayerNotes(value) {
  if (Array.isArray(value)) {
    return value
      .filter((note) => note && typeof note.text === "string" && note.text.trim())
      .map((note) => ({
        id: note.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        text: note.text,
        createdAt: note.createdAt || new Date().toISOString()
      }));
  }

  if (typeof value === "string" && value.trim()) {
    return [
      {
        id: "legacy-note",
        text: value,
        createdAt: new Date().toISOString()
      }
    ];
  }

  return [];
}

function formatPlayerNoteTimestamp(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Unknown date";
  }

  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function getPlayerNoteKey(player) {
  if (player.mlbId) {
    return `mlb:${player.mlbId}`;
  }

  return `name:${normalizeText(player.name)}`;
}

function createScorePanel(player) {
  const panel = document.createElement("div");
  panel.className = `fbh-player-modal-score-panel ${getScoreBadgeClass(player)}`;
  const score = getScore(player);
  panel.setAttribute("aria-label", `Score ${score}`);

  const value = document.createElement("strong");
  value.textContent = score;

  panel.appendChild(value);
  return panel;
}

function createLineCard(label, value) {
  const card = document.createElement("div");
  card.className = "fbh-player-modal-line-card";

  const heading = document.createElement("h4");
  heading.textContent = label;

  const text = document.createElement("p");
  text.textContent = value;

  card.append(heading, text);
  return card;
}

function createModalSection(titleText) {
  const section = document.createElement("section");
  section.className = "fbh-player-modal-section";

  const title = document.createElement("h3");
  title.textContent = titleText;
  section.appendChild(title);

  return section;
}

function getPercentileClass(percentile) {
  if (!Number.isFinite(percentile)) {
    return "fbh-savant-neutral";
  }

  if (percentile >= 70) {
    return "fbh-savant-good";
  }

  if (percentile <= 30) {
    return "fbh-savant-poor";
  }

  return "fbh-savant-neutral";
}

function getTeamMeta(teamCode) {
  const teams = {
    ARI: { logoId: 109, primary: "#a71930", secondary: "#e3d4ad" },
    ATH: { logoId: 133, primary: "#003831", secondary: "#efb21e" },
    ATL: { logoId: 144, primary: "#13274f", secondary: "#ce1141" },
    BAL: { logoId: 110, primary: "#df4601", secondary: "#000000" },
    BOS: { logoId: 111, primary: "#bd3039", secondary: "#0c2340" },
    CHC: { logoId: 112, primary: "#0e3386", secondary: "#cc3433" },
    CIN: { logoId: 113, primary: "#c6011f", secondary: "#000000" },
    CLE: { logoId: 114, primary: "#0c2340", secondary: "#e31937" },
    COL: { logoId: 115, primary: "#33006f", secondary: "#c4ced4" },
    CWS: { logoId: 145, primary: "#27251f", secondary: "#c4ced4" },
    DET: { logoId: 116, primary: "#0c2340", secondary: "#fa4616" },
    HOU: { logoId: 117, primary: "#002d62", secondary: "#eb6e1f" },
    KC: { logoId: 118, primary: "#004687", secondary: "#bd9b60" },
    LAA: { logoId: 108, primary: "#ba0021", secondary: "#003263" },
    LAD: { logoId: 119, primary: "#005a9c", secondary: "#ef3e42" },
    MIA: { logoId: 146, primary: "#00a3e0", secondary: "#ef3340" },
    MIL: { logoId: 158, primary: "#12284b", secondary: "#ffc52f" },
    MIN: { logoId: 142, primary: "#002b5c", secondary: "#d31145" },
    NYM: { logoId: 121, primary: "#002d72", secondary: "#ff5910" },
    NYY: { logoId: 147, primary: "#0c2340", secondary: "#c4ced4" },
    PHI: { logoId: 143, primary: "#e81828", secondary: "#002d72" },
    PIT: { logoId: 134, primary: "#27251f", secondary: "#fdb827" },
    SD: { logoId: 135, primary: "#2f241d", secondary: "#ffc425" },
    SEA: { logoId: 136, primary: "#0c2c56", secondary: "#005c5c" },
    SF: { logoId: 137, primary: "#fd5a1e", secondary: "#27251f" },
    STL: { logoId: 138, primary: "#c41e3a", secondary: "#0c2340" },
    TB: { logoId: 139, primary: "#092c5c", secondary: "#8fbce6" },
    TEX: { logoId: 140, primary: "#003278", secondary: "#c0111f" },
    TOR: { logoId: 141, primary: "#134a8e", secondary: "#e8291c" },
    WSH: { logoId: 120, primary: "#ab0003", secondary: "#14225a" }
  };

  return teams[String(teamCode || "").toUpperCase()] || {
    logoId: null,
    primary: "#0f5132",
    secondary: "#1f7a4d"
  };
}

function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function renderMatches(players, untrackedPlayerNames, status, container) {
  container.textContent = "";

  if (players.length === 0 && untrackedPlayerNames.length === 0) {
    status.textContent = "No player names found on this page yet.";
    return;
  }

  status.textContent = `${players.length} tracked recommendation${
    players.length === 1 ? "" : "s"
  } and ${untrackedPlayerNames.length} untracked player${
    untrackedPlayerNames.length === 1 ? "" : "s"
  } found.`;

  if (players.length > 0) {
    const groupedPlayers = groupPlayersByAction(players);
    Object.keys(groupedPlayers).forEach((groupName) => {
      const group = document.createElement("section");
      group.className = "fbh-match-group";

      const heading = document.createElement("h3");
      heading.textContent = groupName;
      group.appendChild(heading);

      groupedPlayers[groupName].forEach((player) => {
        group.appendChild(createPlayerCard(player));
      });

      container.appendChild(group);
    });
  }

  if (untrackedPlayerNames.length > 0) {
    container.appendChild(createUntrackedPlayersSection(untrackedPlayerNames));
  }
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

  // Use textContent for player data so the JSON cannot inject HTML.
  const name = document.createElement("h4");
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
  group.className = "fbh-match-group fbh-untracked-group";

  const heading = document.createElement("h3");
  heading.textContent = "Untracked Players";

  const note = document.createElement("p");
  note.className = "fbh-untracked-note";
  note.textContent =
    "These names are visible on the page but are not in helper-config.json yet.";

  const list = document.createElement("ul");
  list.className = "fbh-untracked-list";

  playerNames.forEach((playerName) => {
    const item = document.createElement("li");
    item.textContent = playerName;
    list.appendChild(item);
  });

  group.append(heading, note, list);
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

  return `Stats: ${roundDisplay(stats.hits)}/${roundDisplay(stats.atBats)} H/AB, ${stats.runs} R, ${stats.homeRuns} HR, ${stats.rbi} RBI, ${stats.stolenBases} SB, ${formatAverage(stats.avg)} AVG, ${formatAverage(stats.ops)} OPS.`;
}

function getProjectionLine(player) {
  const projection = player.projection;

  if (!projection) {
    return "Projection: not imported yet.";
  }

  if (projection.group === "pitching") {
    return `Projection: ${getPitchingLineParts(player, projection, true).join(", ")}.`;
  }

  return `Projection: ${roundDisplay(projection.hits)}/${roundDisplay(projection.atBats)} H/AB, ${roundDisplay(projection.runs)} R, ${roundDisplay(projection.homeRuns)} HR, ${roundDisplay(projection.rbi)} RBI, ${roundDisplay(projection.stolenBases)} SB, ${formatAverage(projection.avg)} AVG, ${formatAverage(projection.ops)} OPS.`;
}

function roundDisplay(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : 0;
}

function getPitchingLineParts(player, data, shouldRound) {
  const visibility = getPitchingStatVisibility(player);
  const countValue = (value) => (shouldRound ? roundDisplay(value) : value || 0);
  const parts = [
    `${shouldRound ? roundDisplay(data.inningsPitched) : data.inningsPitched || "0.0"} IP`,
    `${countValue(data.earnedRuns)} ER`,
    `${countValue(data.strikeOuts)} K`,
    `${countValue(data.baseOnBalls)} BB`
  ];

  if (visibility.showQualityStarts) {
    parts.push(`${countValue(data.qualityStarts)} QS`);
  }

  parts.push(`${countValue(data.wins)} W`);

  if (visibility.showSaves) {
    parts.push(`${countValue(data.saves)} SV`);
  }

  parts.push(`${data.era || ".---"} ERA`, `${data.whip || ".---"} WHIP`);
  return parts;
}

function inningsPitchedToNumber(value) {
  const [wholeInnings, outs] = String(value || "0.0")
    .split(".")
    .map((part) => Number(part));
  return (Number.isFinite(wholeInnings) ? wholeInnings : 0) +
    (Number.isFinite(outs) ? outs : 0) / 3;
}

function numberToInningsPitched(value) {
  const wholeInnings = Math.floor(value);
  const outs = Math.round((value - wholeInnings) * 3);

  if (outs >= 3) {
    return `${wholeInnings + 1}.0`;
  }

  return `${wholeInnings}.${outs}`;
}

function getSourceLine(player) {
  if (typeof player.source === "string") {
    return `Source: ${player.source}${
      player.sourceUpdatedAt ? `, updated ${player.sourceUpdatedAt}` : ""
    }`;
  }

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
