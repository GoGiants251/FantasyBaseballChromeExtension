# Fantasy Baseball Helper

Personal-use Chrome Extension Manifest V3 project for highlighting local fantasy baseball recommendations on supported fantasy baseball pages.

## Load The Extension

1. Open Chrome.
2. Go to `chrome://extensions`.
3. Turn on Developer mode.
4. Click Load unpacked.
5. Select this project folder.
6. Refresh your fantasy baseball page.
7. Click the Fantasy Baseball Helper extension icon to open the Chrome side panel.

The extension keeps the full recommendation list in Chrome's side panel. On the fantasy page itself it adds a small status pill and inline score badges. Click one of those score badges to open a dismissible player card with the recommendation, decision notes, projection/current stats, recent games, and Baseball Savant metric percentiles.

## Refresh Player Data

V6 uses a local updater script. The Chrome extension does not call live APIs from the page.

1. Edit `helper-config.json` to change league settings, projection source URLs, or manual player overrides.
2. Run:

```sh
node scripts/update-players.js
```

To stamp the generated data with a specific through date and use that as the recent-game cutoff:

```sh
node scripts/update-players.js --date 2026-05-03
```

3. Go to `chrome://extensions`.
4. Reload Fantasy Baseball Helper.
5. Refresh the fantasy baseball page.
6. Click the extension icon to open the side panel.

The updater fetches MLB identity/current season stats and recent game logs from `statsapi.mlb.com`, imports Razzball/Steamer hitter and pitcher projection tables, imports Baseball Savant custom leaderboard CSV metrics, builds an explainable rest-of-season rating, generates deterministic decision notes, and rewrites `players.json`. Projection scores are ranked against fantasy-relevant players; hitter scores include a modest position scarcity adjustment. Final scores are weighted 60% rest-of-season projection and 40% current form.

It also writes `mlb-players.json`, a local MLB name index that the extension uses to find visible untracked players on the fantasy page.

It also writes `data/generated/player-values.json` as a backup copy of the generated projection values.

It also appends the latest overall rating and five component scores to `data/generated/rating-history.json`. Player cards use that history to show selectable trend lines for Overall, Projection, Current Form, Season Stats, Recent Trend, and Savant Skills.

To backfill estimated weekly Monday trend points from MLB game logs:

```sh
node scripts/backfill-rating-history.js --season 2026 --through 2026-05-14
```

Backfilled weekly points use current projection scores plus reconstructed season and recent-game form through the prior Sunday. They intentionally leave Savant Skills empty; Savant trend points are only captured on normal data refreshes.

## Automated Data Refresh

The repo includes a GitHub Actions workflow at `.github/workflows/refresh-data.yml` that refreshes generated data every 3 days at 12:00 UTC. The workflow calculates the refresh date in `America/Los_Angeles`, runs the deterministic updater, backfills Monday rating history through the same date, validates the generated JSON, and commits only:

- `players.json`
- `mlb-players.json`
- `data/generated/player-values.json`
- `data/generated/rating-history.json`

The scheduled workflow intentionally does not update `manifest.json`. Data-only refresh commits should not bump the Chrome extension version; version bumps are reserved for behavior, UI, code, or manifest changes.

You can run the workflow manually from GitHub Actions with an optional `refresh_date` and `season` override. Use `YYYY-MM-DD` for the date.

The extension tries to load JSON from public GitHub raw URLs first, then falls back to the bundled JSON files if the remote request fails, times out, returns an unexpected shape, or is older than the bundled data. The current remote base URL is configured in `content.js`:

```js
https://raw.githubusercontent.com/GoGiants251/FantasyBaseballChromeExtension/main
```

If your GitHub repo owner or repo name differs, update `REMOTE_DATA_BASE_URL` in `content.js`, then bump `manifest.json` for that behavior/configuration change.

Before relying on automated remote data:

1. Push this project to the `main` branch of the GitHub repo used by `REMOTE_DATA_BASE_URL`.
2. In GitHub repository settings, allow GitHub Actions to read and write repository contents.
3. Confirm these public raw URLs load in a browser:

```text
https://raw.githubusercontent.com/GoGiants251/FantasyBaseballChromeExtension/main/players.json
https://raw.githubusercontent.com/GoGiants251/FantasyBaseballChromeExtension/main/mlb-players.json
https://raw.githubusercontent.com/GoGiants251/FantasyBaseballChromeExtension/main/data/generated/rating-history.json
```

Do not put private league IDs, cookies, paid API tokens, or private notes in committed generated JSON. A private repo is not enough for direct extension loading unless you introduce separate authenticated hosting or a proxy; do not embed GitHub tokens in extension code.

## Experimental Gemini Decision Notes

The normal Decision section is generated by the free local rule engine. The extension does not call Gemini from Chrome. If you want to experiment with AI-assisted Decision text and badges, run the local updater with a Gemini API key:

```sh
GEMINI_API_KEY=your_key node scripts/update-players.js --ai
```

This stores optional `decision` notes in `players.json`. The score still comes from the local rating model. If the key is missing, quota is exhausted, or Gemini returns invalid JSON, the updater keeps the normal deterministic recommendations.

The default Gemini settings are conservative for the free tier: up to 25 players per run and 5 requests per minute. You can tune those in `helper-config.json`.

To test one player only:

```sh
GEMINI_API_KEY=your_key node scripts/update-players.js --ai --ai-player "Rafael Devers"
```

## Data Sources

- MLB Stats API: identity, current season stats, and MLB name index.
- Razzball/Steamer projection tables: rest-of-season hitter and pitcher projections.
- Baseball Savant custom leaderboard CSV: expected stats, contact quality, discipline metrics, and local percentile ranks.
