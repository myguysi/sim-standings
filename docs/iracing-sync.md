# Implementation Guide: `/sync` Endpoint (iRacing Data API)

This guide describes how to add a `/sync` endpoint that fetches league race results
directly from the iRacing Data API (via [`iracing-data-client`](https://allymurray.github.io/iracing-data-client/))
and writes them to the local filesystem, replacing the manual `assets/events/*.json` files.

---

## 1. Goal

Today, race results live in `assets/events/eventresult-<subsessionId>.json` and are
dropped in by hand. They are the **raw iRacing API envelope** in `snake_case`:

```jsonc
{
  "type": "...",
  "data": {
    "subsession_id": 84770853,
    "session_results": [ { "simsession_name": "RACE", "results": [ { "cust_id": 1088529, ... } ] } ],
    ...
  }
}
```

After this feature, a single call to `POST /sync` will:

1. Read the target `leagueId` + `seasonId` from `assets/config.json`.
2. Ask the iRacing API for every session in that league season that has results.
3. Fetch the full result for each session.
4. Write one file per session into `assets/events/`, ready for `build.js`.

> **Decision (agreed):** We store the SDK's **camelCase** output directly and adapt
> `build.js` to read camelCase — rather than transforming back to the raw snake_case
> envelope. See [§5](#5-adapt-buildjs-to-camelcase) for the exact field mapping.

---

## 2. The library

- Package: **`iracing-data-client`** (v0.2.2 at time of writing)
- Dual CommonJS/ESM — `require()` works, so it fits this project's `"type": "commonjs"` setup with no changes.
- Auto-transforms API responses from `snake_case` → **`camelCase`** and **strips the
  `{ type, data }` envelope** (`results.get()` returns the data object directly).
- Handles OAuth2 token acquisition + refresh, rate-limit and maintenance-mode errors internally.

Install:

```bash
npm install iracing-data-client dotenv
```

(`dotenv` is used to load credentials from a `.env` file; see below.)

---

## 3. Prerequisites: credentials & `.env`

You already have iRacing OAuth credentials (Client ID + Secret). The client uses the
**password-limited** OAuth flow, which needs four values. Put them in a `.env` file at
the project root:

```dotenv
# .env  — DO NOT COMMIT
IRACING_CLIENT_ID=your-client-id
IRACING_CLIENT_SECRET=your-client-secret
IRACING_USERNAME=your-iracing-email
IRACING_PASSWORD=your-iracing-password
```

Add `.env` to `.gitignore` (current `.gitignore` ignores `.DS_Store`, `node_modules`,
`public` — append `.env`):

```gitignore
.DS_Store
node_modules
public
.env
```

Load it once at process start (top of `src/server.js`, before anything reads
`process.env`):

```js
require('dotenv').config();
```

---

## 4. New module: `src/iracing.js`

Encapsulate all API interaction in one module so the endpoint stays thin and the
client is easy to mock in tests.

```js
// src/iracing.js
const fs = require('fs');
const { IRacingDataClient } = require('iracing-data-client');

const EVENTS_DIR = 'assets/events';

function createClient() {
    return new IRacingDataClient({
        auth: {
            type: 'password-limited',
            clientId: process.env.IRACING_CLIENT_ID,
            clientSecret: process.env.IRACING_CLIENT_SECRET,
            username: process.env.IRACING_USERNAME,
            password: process.env.IRACING_PASSWORD,
        },
    });
}

/**
 * Fetch every result for a league season and write one file per session.
 * Returns a summary: { seasonId, sessionCount, subsessionIds, written }.
 */
async function syncSeason({ leagueId, seasonId }) {
    const iracing = createClient();

    // 1. List sessions in this league season that have results.
    //    resultsOnly:true filters out scheduled/cancelled sessions with no result.
    const sessions = await iracing.league.seasonSessions({
        leagueId,
        seasonId,
        resultsOnly: true,
    });

    if (!fs.existsSync(EVENTS_DIR)) {
        fs.mkdirSync(EVENTS_DIR, { recursive: true });
    }

    const subsessionIds = [];

    // 2. Fetch + save each subsession result. Sequential to stay friendly with
    //    iRacing rate limits (the SDK also surfaces RateLimitError if hit).
    for (const session of sessions) {
        const subsessionId = session.subsessionId;
        if (!subsessionId) continue;

        const result = await iracing.results.get({ subsessionId });

        fs.writeFileSync(
            `${EVENTS_DIR}/eventresult-${subsessionId}.json`,
            JSON.stringify(result, null, 2),
        );
        subsessionIds.push(subsessionId);
    }

    return {
        leagueId,
        seasonId,
        sessionCount: sessions.length,
        written: subsessionIds.length,
        subsessionIds,
    };
}

module.exports = { syncSeason };
```

### Notes & things to verify against the live API

- `league.seasonSessions(...)` returns an array of session objects. Confirm the
  subsession id field is `subsessionId` (camelCase of `subsession_id`) and adjust if
  the SDK names it differently. A league session can have **splits** (multiple
  subsessions); `resultsOnly` plus the per-session `subsessionId` should be the primary
  result for a league race, but inspect one response to be sure you aren't missing or
  duplicating splits.
- `results.get({ subsessionId })` returns the **camelCase result object directly** (no
  `{ type, data }` wrapper). That object is what we save — see the field mapping below.
- The file name (`eventresult-<subsessionId>.json`) and sort order matter: `build.js`'s
  `getEventResults()` reads `assets/events/*.json` **sorted by filename** and treats
  array order as round order (round 1, round 2, …). If subsession IDs do not sort into
  the chronological round order you want, sort sessions by their launch/start time and
  rename files with a zero-padded round prefix (e.g. `01-eventresult-<id>.json`).
  See [§7](#7-round-ordering).

---

## 5. Adapt `build.js` to camelCase

The SDK output is camelCase and has no `{ type, data }` envelope. Update the field
accesses in `src/build.js`. These are the **only** places that read raw iRacing fields:

### 5a. `splitIntoClasses()`

| Current (snake_case + envelope)            | New (camelCase, no envelope)       |
| ------------------------------------------ | ---------------------------------- |
| `eventResult.data.session_results`         | `eventResult.sessionResults`       |
| `sr.simsession_name === 'RACE'`            | `sr.simsessionName === 'RACE'`     |
| `result.cust_id`                           | `result.custId`                    |
| `result.display_name`                      | `result.displayName`               |

### 5b. `parseResults()`

`parseResults` receives the **race results array** for one event (`eventResult` here is
that array). Update:

| Current                          | New                          |
| -------------------------------- | ---------------------------- |
| `eventResult[0].laps_complete`   | `eventResult[0].lapsComplete`|
| `r.cust_id`                      | `r.custId`                   |
| `r.display_name`                 | `r.displayName`              |
| `r.finish_position`              | `r.finishPosition`           |
| `r.starting_position`            | `r.startingPosition`         |
| `r.best_lap_time`                | `r.bestLapTime`              |
| `r.reason_out`                   | `r.reasonOut`                |
| `r.laps_complete`                | `r.lapsComplete`             |

No other functions in `build.js` touch raw API fields (everything downstream uses the
already-normalised `ProcessedResult` shape produced by `parseResults`).

### 5c. Migration of existing files

The 8 existing `assets/events/*.json` files are in the **old snake_case envelope format**
and will no longer parse after this change. Options:

- **Recommended:** delete them and run `/sync` once to repopulate from the API in the
  new format.
- If you want to keep them as a fixture, write a one-off script to unwrap `.data` and
  camelCase the keys — but going forward `/sync` is the source of truth.

> Tip: keep a single fixture file of the **new** camelCase shape under `assets/` (or a
> `test/` dir) so you can run `build.js` offline without hitting the API.

---

## 6. config.json additions

Add the league/season identifiers to `assets/config.json` so `/sync` knows what to pull:

```jsonc
{
  "leagueName": "Example League",
  "leagueId": 1234,        // <-- add: iRacing league ID
  "seasonId": 5678,        // <-- add: iRacing league season ID
  "formats": [ ... ],
  "events": [ ... ],
  "classes": ["pro", "inter", "club"]
}
```

How to find the IDs:

- `leagueId` is in the iRacing league URL, and is also present on every existing event
  file under `data.league_id` / `data.league_season_id`.
- To discover season IDs programmatically, call
  `iracing.league.seasons({ leagueId })` and read `seasonId` / `seasonName` from the
  result. Consider exposing a small `GET /seasons` helper endpoint during development.

---

## 7. Round ordering

`build.js` assumes file (and therefore array) order == round order, and applies
round-specific rules based on index:

- `assignFinishPoints` multiplies points ×1.5 when `eventIndex >= 7` (final 3 rounds).
- `applyDropRounds` only drops from the first 7 rounds (`results.slice(0, 7)`).
- `config.events` is an ordered array of `{ format }` describing each round.

So the synced files **must** sort into the correct chronological round order. iRacing
`subsessionId`s are roughly chronological but **not guaranteed** to be monotonic across a
season. Make ordering explicit:

1. In `syncSeason`, sort `sessions` by their start/launch timestamp (e.g.
   `session.launchAt`) before writing.
2. Write files with a zero-padded round index prefix so `readdirSync(...).sort()` is
   stable, e.g. `01-eventresult-<id>.json`, `02-...`.
3. Update `getEventResults()`'s filter if you change the naming pattern.

This also keeps the synced rounds aligned with `config.events[i].format`.

---

## 8. The `/sync` endpoint

Wire it into `src/server.js`. Use `POST` because it has side effects (writes files).
The form is a plain `<form method="POST" action="/sync">` — no client-side JavaScript —
and `POST /sync` **content-negotiates** its response: an HTML results page for browser
form submissions, JSON for API/`curl`/programmatic callers. This "use the platform"
approach works with JS disabled and degrades gracefully.

```js
// src/server.js
require('dotenv').config();

const express = require('express');
const { syncSeason } = require('./iracing');
const config = require('../assets/config.json');

const app = express();
const port = 3001;

app.use(express.static('public/standings'));
// Parse urlencoded form bodies (the POST /sync form submission).
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
    res.send('OK');
});

// GET /sync — render the HTML form that POSTs to /sync.
app.get('/sync', (req, res) => {
    const { leagueName, leagueId, seasonId } = config;
    res.send(renderSyncForm({ leagueName, leagueId, seasonId }));
});

app.post('/sync', async (req, res) => {
    const { leagueId, seasonId } = config;

    // res.format dispatches on the Accept header: browsers send text/html,
    // API clients send application/json (or use curl -H "Accept: application/json").
    const respond = (status, payload) => {
        // json first so non-browser clients (curl/`*/*`) default to JSON; browsers
        // explicitly send text/html and still get the HTML result page.
        res.status(status).format({
            json: () => res.json(payload),
            html: () => res.send(renderSyncResult(payload)),
            default: () => res.json(payload),
        });
    };

    if (!leagueId || !seasonId) {
        return respond(400, {
            ok: false,
            error: 'leagueId and seasonId must be set in assets/config.json',
        });
    }

    try {
        const summary = await syncSeason({ leagueId, seasonId });
        respond(200, { ok: true, ...summary });
    } catch (err) {
        // The SDK throws typed errors (OAuthError, IRacingError with isUnauthorized,
        // RateLimitError, maintenance-mode). Surface a useful status + message.
        console.error('Sync failed:', err);
        respond(502, { ok: false, error: err.message });
    }
});

app.listen(port, () => {
    console.log(`App listening on port ${port}`);
});
```

### The GET form

`GET /sync` returns a minimal, self-contained HTML page (inline CSS, no build step, no
deps) with a native form that POSTs to `/sync`. Submitting navigates the browser to the
POST response, which renders as the results page below.

```js
// src/server.js (helpers, or move to a small renderer module)

// Escape interpolated values. config.json is yours today, but escaping keeps this safe
// if any field ever becomes user-supplied.
function escapeHtml(value) {
    return String(value ?? '—').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

function page(title, body) {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; }
    button { font-size: 1rem; padding: .6rem 1.2rem; cursor: pointer; }
    button[disabled] { cursor: not-allowed; opacity: .6; }
    pre { background: #f4f4f4; padding: 1rem; border-radius: .4rem; overflow: auto; white-space: pre-wrap; }
    .meta { color: #555; }
    .error { color: #b00; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

function renderSyncForm({ leagueName, leagueId, seasonId }) {
    const configured = leagueId && seasonId;
    return page('Sync Results', `
  <h1>Sync Results</h1>
  <p class="meta">
    League: <strong>${escapeHtml(leagueName)}</strong><br>
    leagueId: <strong>${escapeHtml(leagueId)}</strong> · seasonId: <strong>${escapeHtml(seasonId)}</strong>
  </p>
  ${configured
      ? ''
      : '<p class="error">Set <code>leagueId</code> and <code>seasonId</code> in <code>assets/config.json</code> first.</p>'}
  <form method="POST" action="/sync">
    <button type="submit" ${configured ? '' : 'disabled'}>Sync this season</button>
  </form>`);
}

// Rendered as the POST response for browser (Accept: text/html) submissions.
function renderSyncResult(payload) {
    const heading = payload.ok ? 'Sync complete' : 'Sync failed';
    return page(heading, `
  <h1>${heading}</h1>
  ${payload.ok ? '' : `<p class="error">${escapeHtml(payload.error)}</p>`}
  <pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre>
  <p><a href="/sync">&larr; Back</a></p>`);
}
```

Notes:

- **Content negotiation** via `res.format(...)` is the key bit: the same `POST /sync`
  serves the browser an HTML page and serves `curl`/API clients JSON, keyed off the
  `Accept` header. Test the JSON path with
  `curl -X POST -H "Accept: application/json" localhost:3001/sync`.
- `express.urlencoded({ extended: true })` is added so a form POST body parses. The form
  carries no fields today (league/season come from `config.json`), but the middleware is
  in place if you later add inputs (e.g. a season override) — see [§6](#6-configjson-additions).
- All interpolated values are passed through `escapeHtml()`.
- No client-side JavaScript is involved; the feature works with JS disabled.

### Optional: rebuild standings after sync

`/sync` only refreshes the raw event files — it does **not** regenerate standings. To
make sync end-to-end, either:

- Call the build pipeline after a successful sync. Refactor `build.js` to export its
  entry points (`processSeasonToDate`, `renderStandings`) instead of running on import,
  then invoke them from the endpoint; **or**
- Keep them separate and document that you run `npm run build` (or hit a future
  `/build` endpoint) after `/sync`.

> Note: `build.js` currently runs its pipeline as a side effect of `require()` (the last
> lines call `processSeasonToDate()` and `renderStandings`). If the endpoint needs to
> trigger a build, refactor those trailing lines into an exported `function main()` and
> guard the auto-run with `if (require.main === module) main();` so importing it from the
> server doesn't run a build immediately.

---

## 9. Error handling reference

The SDK exposes typed errors you can branch on for better responses:

```js
const { OAuthError, IRacingError } = require('iracing-data-client');

try {
    // ...
} catch (error) {
    if (error instanceof OAuthError) {
        // bad credentials / invalid_grant
    } else if (error instanceof IRacingError && error.isUnauthorized) {
        // authenticated but not permitted (e.g. not a league member)
    }
    // also: rate-limit and maintenance-mode error types — see SDK docs
}
```

Confirm the exact exported error class names against the installed package's typings
(`node_modules/iracing-data-client/lib/index.d.ts`).

---

## 10. Implementation checklist

- [x] `npm install iracing-data-client dotenv`
- [x] Create `.env` with the four `IRACING_*` vars; add `.env` to `.gitignore`
      *(placeholder values for now — pending the regenerated client secret)*
- [x] Add `leagueId` + `seasonId` to `assets/config.json` *(set to `0`; fill in real IDs)*
- [x] Create `src/iracing.js` (`syncSeason`) — sorts sessions by `launchAt`, reads
      `session.subsessionId`. **Still to verify against a live response:** split handling
      and that `subsessionId`/`launchAt` are the right field names (sessions are untyped).
- [x] Update the camelCase field accesses in `src/build.js`
      ([§5a](#5a-splitintoclasses) / [§5b](#5b-parseresults))
- [x] Convert the 8 legacy snake_case event files — `src/migrate-events.js` (deep
      camelCase + envelope unwrap), already run. Idempotent / safe to re-run.
- [x] Add `POST /sync` to `src/server.js` with `res.format()` content negotiation
      (JSON for API/`*/*`, HTML page for browsers); `dotenv` loaded at the top
- [x] Add `express.urlencoded({ extended: true })` middleware
- [x] Add `GET /sync` rendering the native HTML form (`renderSyncForm`, no client JS)
- [ ] (Optional) refactor `build.js` to export `main()` and trigger a rebuild after sync
- [x] Tested offline: build passes on migrated data; `/sync` form, validation guard, and
      JSON/HTML negotiation all verified
- [ ] **Pending credentials:** fill real `leagueId`/`seasonId` + client secret, then
      `POST /sync` against the live API and confirm files land in `assets/events/`

> **Note on chronological ordering ([§7](#7-round-ordering)):** `syncSeason` sorts
> sessions by `launchAt`, but files are written as `eventresult-<subsessionId>.json` and
> `build.js` orders rounds by *filename*. The existing 8 subsession IDs sort into correct
> round order, so this matches today's behaviour. If a future season's IDs aren't
> monotonic, switch to a zero-padded round prefix in the filename.

---

## 11. Quick API recap

| Call | Purpose | Key params |
| --- | --- | --- |
| `iracing.league.seasons({ leagueId })` | List a league's seasons | `leagueId`, `retired?` |
| `iracing.league.seasonSessions({ leagueId, seasonId, resultsOnly })` | List sessions (with results) in a season | `leagueId`, `seasonId`, `resultsOnly?` |
| `iracing.results.get({ subsessionId })` | Full result for one subsession (camelCase, no envelope) | `subsessionId`, `includeLicenses?` |

Client init (password-limited OAuth):

```js
const iracing = new IRacingDataClient({
    auth: {
        type: 'password-limited',
        clientId: process.env.IRACING_CLIENT_ID,
        clientSecret: process.env.IRACING_CLIENT_SECRET,
        username: process.env.IRACING_USERNAME,
        password: process.env.IRACING_PASSWORD,
    },
});
```
