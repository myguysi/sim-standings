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
4. Write one file per session into the runtime data dir (`data/events/`, see
   [§4a](#4a-runtime-data-directory--startup-sync)), ready for `build.js`.

> **Decision (agreed):** We store the SDK's **camelCase** output directly and adapt
> `build.js` to read camelCase — rather than transforming back to the raw snake_case
> envelope. See [§5](#5-adapt-buildjs-to-camelcase) for the exact field mapping.

---

## 2. The library

- Package: **`iracing-data-client`** (v0.2.2 at time of writing)
- Dual CommonJS/ESM — `require()` works, so it fits this project's `"type": "commonjs"` setup with no changes.
- Auto-transforms API responses from `snake_case` → **`camelCase`** and **strips the
  `{ type, data }` envelope** (`results.get()` returns the data object directly).
- Handles OAuth2 token refresh, rate-limit and maintenance-mode errors internally.

Install:

```bash
npm install iracing-data-client dotenv
```

(`dotenv` is used to load credentials from a `.env` file; see below.)

---

## 3. Prerequisites: credentials & `.env`

> **Auth flow:** the registered client (`489822-league`) uses the **Authorization Code**
> flow — *not* password-limited. It acts on behalf of a user, so a one-time browser
> login is required before the API can be called (see [§4](#4-new-module-srciracingjs)
> and [§8](#8-the-sync-endpoint)). Password-limited would skip the browser step but is a
> different client type.

Put the client credentials and OAuth settings in a `.env` file at the project root:

```dotenv
# .env  — DO NOT COMMIT
IRACING_CLIENT_ID=489822-league
IRACING_CLIENT_SECRET=your-client-secret

# Must exactly match a redirect URI registered with the client.
# Production: https://ileague.io/auth/iracing/callback
IRACING_REDIRECT_URI=http://127.0.0.1:3000/auth/iracing/callback

# Server port. 3000 matches the registered local redirect URI above.
PORT=3000
```

The **redirect URI must exactly match** one registered with iRacing. The local URI is
`http://127.0.0.1:3000/auth/iracing/callback` (note `127.0.0.1`, not `localhost`, and
port `3000`), which is why the server defaults to port 3000.

Add `.env` to `.gitignore` (current `.gitignore` ignores `.DS_Store`, `node_modules`,
`public` — append `.env`). Also ignore `.iracing-tokens.json`, where OAuth tokens are
persisted between restarts ([§4](#4-new-module-srciracingjs)) — it holds access + refresh
tokens, so it's as sensitive as `.env`:

```gitignore
.DS_Store
node_modules
public
.env
.iracing-tokens.json
```

Load it once at process start (top of `src/server.js`, before anything reads
`process.env`):

```js
require('dotenv').config();
```

---

## 4. New module: `src/iracing.js`

All API interaction lives in one module. Because this is the Authorization Code flow,
the module exposes both the **OAuth helpers** (to obtain tokens) and `syncSeason` (to
use them):

- `getAuthorizationUrl()` — builds the iRacing authorize URL via
  `buildAuthorizationUrl({ clientId, redirectUri, scope })`, and remembers the returned
  `state` + PKCE `verifier` in memory for the callback.
- `handleCallback({ code, state })` — validates `state`, then calls
  `exchangeAuthorizationCode({ clientId, clientSecret, code, redirectUri, codeVerifier })`
  and stores the resulting tokens.
- `isAuthenticated()` — whether we currently hold tokens.
- `syncSeason({ leagueId, seasonId })` — builds an `authorization-code` client from the
  stored tokens (throws if unauthenticated) and fetches/saves the season.

**Token storage is persisted to a gitignored file** (single-user local backend) so a
server restart doesn't require re-authorising. `loadTokens()` restores them on startup
(starting unauthenticated if the file is absent/corrupt); `storeTokens()` writes to disk
on the initial exchange and on every `onTokenRefresh`, keeping the in-memory copy and the
file in lock-step. The path defaults to `.iracing-tokens.json`, overridable with
`IRACING_TOKENS_FILE`. The file holds access + refresh tokens, so it's gitignored like
`.env`.

```js
// src/iracing.js (abridged — see the file for the full version)
const {
    IRacingDataClient,
    buildAuthorizationUrl,
    exchangeAuthorizationCode,
} = require('iracing-data-client');

const SCOPE = process.env.IRACING_SCOPE || 'iracing.auth';
const redirectUri = () =>
    process.env.IRACING_REDIRECT_URI || 'http://127.0.0.1:3000/auth/iracing/callback';

let tokens = null;       // { accessToken, refreshToken, expiresAt }
let pendingAuth = null;  // { state, verifier } between redirect and callback

const isAuthenticated = () => Boolean(tokens && tokens.accessToken);

function storeTokens(token) {
    tokens = {
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? tokens?.refreshToken,
        expiresAt: Math.floor(Date.now() / 1000) + token.expires_in,
    };
}

async function getAuthorizationUrl() {
    const { url, state, pkce } = await buildAuthorizationUrl({
        clientId: process.env.IRACING_CLIENT_ID,
        redirectUri: redirectUri(),
        scope: SCOPE,
    });
    pendingAuth = { state, verifier: pkce?.verifier };
    return url;
}

async function handleCallback({ code, state }) {
    if (!pendingAuth || state !== pendingAuth.state) {
        throw new Error('Invalid or expired OAuth state — start again at /auth/iracing');
    }
    const token = await exchangeAuthorizationCode({
        clientId: process.env.IRACING_CLIENT_ID,
        clientSecret: process.env.IRACING_CLIENT_SECRET,
        code,
        redirectUri: redirectUri(),
        codeVerifier: pendingAuth.verifier,
    });
    storeTokens(token);
    pendingAuth = null;
}

function createClient() {
    if (!isAuthenticated()) {
        throw new Error('Not authenticated with iRacing — visit /auth/iracing first');
    }
    return new IRacingDataClient({
        auth: {
            type: 'authorization-code',
            clientId: process.env.IRACING_CLIENT_ID,
            clientSecret: process.env.IRACING_CLIENT_SECRET,
            tokens,
            onTokenRefresh: (token) => storeTokens(token),
        },
        validateParams: false, // see note below
    });
}
```

> **`validateParams: false`.** The SDK validates every response against bundled Zod
> schemas that are stricter than the real API: live league results carry `null` for
> `allowedLicenses`, `seriesLogo`, and per-row `divisionName`, which the schemas reject
> (throwing a large `ZodError` before returning the data). This flag skips that response
> `.parse()`. The camelCase transform and `{ type, data }` envelope strip happen in the
> HTTP layer *before* validation, so we still get clean camelCased data — just unvalidated.

`syncSeason` itself is flow-agnostic — it just uses `createClient()`:

```js
async function syncSeason({ leagueId, seasonId }) {
    const iracing = createClient();

    // season_sessions returns { success, subscribed, leagueId, seasonId, sessions: [] }.
    const { sessions } = await iracing.league.seasonSessions({
        leagueId,
        seasonId,
        resultsOnly: true, // skip scheduled/cancelled sessions with no result
    });

    // Keep only sessions with a subsession id; order by launch time (round order).
    const runSessions = (sessions ?? [])
        .filter((s) => s && s.subsessionId)
        .sort((a, b) => new Date(a.launchAt ?? 0) - new Date(b.launchAt ?? 0));

    // ... fetch results.get({ subsessionId }) for each and write
    //     data/events/eventresult-<subsessionId>.json ...
}
```

### Notes & things to verify against the live API

- `league.seasonSessions(...)` returns an **object** `{ ..., sessions: [] }` (the docs
  example showing a bare array is misleading) — destructure `.sessions`.
- `sessions` items are **untyped** in the SDK. We read `session.subsessionId` and
  `session.launchAt`; confirm those names against a real response, and check how league
  **splits** (multiple subsessions per race) appear so you don't miss/duplicate them.
- `results.get({ subsessionId })` returns the **camelCase result object directly** (no
  `{ type, data }` wrapper). That object is what we save — see the field mapping below.
- The file name (`eventresult-<subsessionId>.json`) and sort order matter: `build.js`'s
  `getEventResults()` reads `data/events/*.json` **sorted by filename** and treats
  array order as round order. The existing subsession IDs sort into correct round order;
  if a future season's IDs aren't monotonic, switch to a zero-padded round prefix in the
  filename (e.g. `01-eventresult-<id>.json`). See [§7](#7-round-ordering).

### 4a. Runtime data directory & startup sync

Event results are **fetched at runtime, not committed**. They live in `data/events/`
(separate from `assets/`, which holds static inputs like `config.json`, `drivers.json`,
`template.html`). The path is `EVENTS_DIR`, env-overridable, and **shared by `iracing.js`
(writer) and `build.js` (reader)** — keep the two in sync.

- **Gitignored:** the whole `data/` directory — event results *and* the events-include
  config (`data/events-config.json`, see [§4b](#4b-excluding-events-from-the-standings)).
  It's all runtime state, so nothing under it is tracked; the directories self-create on
  first run (below).
- **Directories self-create** (safe for a fresh VPS deploy): `syncSeason()` does
  `mkdirSync(EVENTS_DIR, { recursive: true })` before writing; `getEventResults()`
  creates `EVENTS_DIR` and returns `[]` if it's missing; `build.js` creates
  `public/standings/<class>/` recursively. Nothing assumes a pre-existing tree.
- **Initial sync on startup:** after `app.listen`, `runInitialSync()` does one
  `syncSeason()` + `build()` so the app self-populates on boot. It's guarded — skips
  cleanly (just logs) when not authenticated or when `leagueId`/`seasonId` aren't set,
  and swallows errors (e.g. iRacing API down) so a failed sync never blocks startup. With
  token persistence ([§4](#4-new-module-srciracingjs)), a restart re-syncs automatically
  without a fresh browser login.

> **Deploy note:** on the VPS you need `.env` (credentials, `PORT`, optionally
> `EVENTS_DIR`) and a one-time browser auth to mint `.iracing-tokens.json` (or copy an
> existing one across). After that, restarts re-sync on their own. `data/events/` and
> `public/standings/` are created automatically.

### 4b. Excluding events from the standings

Not every synced session should count — e.g. a pre-season **media day** appears as a
result but isn't a points round. Rather than hard-coding subsession IDs, the `/events`
page lets you deselect events:

- **`GET /events`** renders a checkbox per synced event (track + date), checked when the
  event currently counts. **`POST /events`** writes the choices and rebuilds the standings.
  Both are wired into `src/server.js` next to the `/sync` routes; `POST` is
  content-negotiated like `/sync` (HTML page for browsers, JSON otherwise).
- Choices persist to **`data/events-config.json`** — a `{ "<subsessionId>": boolean }` map,
  written by `saveEventsConfig()` and read by `loadEventsConfig()` in `build.js`.
- **Include by default:** only an explicit `false` excludes an event, so sessions synced
  *after* the form was last saved still flow into the standings until someone deselects
  them. A missing config file means "nothing excluded", so the build works before the
  form is ever used.
- `getEventResults()` drops the disabled events **before** the pipeline assigns round
  indices, so the remaining events re-index as rounds 1..N. The round-dependent scoring
  rules (1.5× for the final 3 rounds, drop-lowest from the first 7 — see
  [§7](#7-round-ordering)) therefore count from the *included* events only.

---

## 5. Adapt `build.js` to camelCase

The SDK output is camelCase and has no `{ type, data }` envelope. Update the field
accesses in `src/build.js`. These are the **only** places that read raw iRacing fields:

### 5a. `splitIntoClasses()`

| Current (snake_case + envelope)            | New (camelCase, no envelope)       |
| ------------------------------------------ | ---------------------------------- |
| `eventResult.data.session_results`         | `eventResult.sessionResults`       |
| `sr.simsession_name === 'RACE'`            | `sr.simsessionType === 6` †        |
| `result.cust_id`                           | `result.custId`                    |
| `result.display_name`                      | `result.displayName`               |

† **Match the race by `simsessionType` (6), not `simsessionName`.** Leagues can rename
the race session — one round in the live data was named `"FEATURE"` rather than `"RACE"`,
which made a `simsessionName === 'RACE'` lookup return `undefined` and crash on `.results`.
`simsessionType === 6` is iRacing's canonical race type and matched every round. The code
also throws a clear error if no race session is found, instead of a cryptic undefined read.

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

Wire it into `src/server.js`, alongside the two OAuth routes the Authorization Code flow
needs. `POST /sync` has side effects (writes files) and is **content-negotiated**: an
HTML results page for browser form submissions, JSON for API/`curl`/programmatic callers.
The form is a plain `<form method="POST" action="/sync">` — no client-side JavaScript —
so it works with JS disabled.

Routes:

| Route | Purpose |
| --- | --- |
| `GET /auth/iracing` | Redirect to iRacing to start the OAuth flow |
| `GET /auth/iracing/callback` | Exchange the `?code` for tokens, then redirect to `/sync` |
| `GET /sync` | Render the form (shows connection status; links to auth if not connected) |
| `POST /sync` | Sync the season (401 if not authenticated) |
| `GET /events` | Render the events form — a checkbox per synced event, checked = counts ([§4b](#4b-excluding-events-from-the-standings)) |
| `POST /events` | Save include/exclude choices to `data/events-config.json`, then rebuild |

```js
// src/server.js
require('dotenv').config();

const express = require('express');
const {
    syncSeason,
    getAuthorizationUrl,
    handleCallback,
    isAuthenticated,
} = require('./iracing');
const config = require('../assets/config.json');

const app = express();
// Env-driven so the port can change in production. Defaults to 3000 to match the
// registered local redirect URI (http://127.0.0.1:3000/auth/iracing/callback).
const port = process.env.PORT || 3000;

app.use(express.static('public/standings'));
// Parse urlencoded form bodies (the POST /sync form submission).
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
    res.send('OK');
});

// GET /auth/iracing — start the OAuth Authorization Code flow.
app.get('/auth/iracing', async (req, res) => {
    res.redirect(await getAuthorizationUrl());
});

// GET /auth/iracing/callback — iRacing redirects here with ?code&state (or ?error).
app.get('/auth/iracing/callback', async (req, res) => {
    const { code, state, error, error_description: errorDescription } = req.query;
    if (error) {
        return res
            .status(400)
            .send(renderSyncResult({ ok: false, error: `${error}: ${errorDescription ?? ''}` }));
    }
    try {
        await handleCallback({ code, state });
        res.redirect('/sync');
    } catch (err) {
        res.status(400).send(renderSyncResult({ ok: false, error: err.message }));
    }
});

// GET /sync — render the HTML form that POSTs to /sync.
app.get('/sync', (req, res) => {
    const { leagueName, leagueId, seasonId } = config;
    res.send(renderSyncForm({ leagueName, leagueId, seasonId, authed: isAuthenticated() }));
});

app.post('/sync', async (req, res) => {
    const { leagueId, seasonId } = config;

    // res.format dispatches on the Accept header (json first so curl/`*/*` get JSON;
    // browsers send text/html and get the result page).
    const respond = (status, payload) => {
        res.status(status).format({
            json: () => res.json(payload),
            html: () => res.send(renderSyncResult(payload)),
            default: () => res.json(payload),
        });
    };

    if (!isAuthenticated()) {
        return respond(401, {
            ok: false,
            error: 'Not authenticated with iRacing — visit /auth/iracing first',
        });
    }

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

function renderSyncForm({ leagueName, leagueId, seasonId, authed }) {
    const configured = leagueId && seasonId;
    const ready = configured && authed;
    return page('Sync Results', `
  <h1>Sync Results</h1>
  <p class="meta">
    League: <strong>${escapeHtml(leagueName)}</strong><br>
    leagueId: <strong>${escapeHtml(leagueId)}</strong> · seasonId: <strong>${escapeHtml(seasonId)}</strong><br>
    iRacing: <strong>${authed ? 'connected' : 'not connected'}</strong>
  </p>
  ${configured
      ? ''
      : '<p class="error">Set <code>leagueId</code> and <code>seasonId</code> in <code>assets/config.json</code> first.</p>'}
  ${authed
      ? ''
      : '<p><a href="/auth/iracing">Connect iRacing account</a> to enable syncing.</p>'}
  <form method="POST" action="/sync">
    <button type="submit" ${ready ? '' : 'disabled'}>Sync this season</button>
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
  `curl -X POST -H "Accept: application/json" 127.0.0.1:3000/sync`.
- `express.urlencoded({ extended: true })` is added so a form POST body parses. The form
  carries no fields today (league/season come from `config.json`), but the middleware is
  in place if you later add inputs (e.g. a season override) — see [§6](#6-configjson-additions).
- All interpolated values are passed through `escapeHtml()`.
- No client-side JavaScript is involved; the feature works with JS disabled.

### Rebuild standings after sync

`/sync` regenerates standings end-to-end: after writing the raw event files it calls
`build()` to recompute and re-render each class's page, so the published standings
reflect the new data immediately. The success response includes `rebuilt: true`.

To make this possible, `build.js` exports a `build()` function and only auto-runs when
invoked directly:

```js
// src/build.js (tail)
function build() {
    const classStandings = processSeasonToDate();
    classStandings.forEach(renderStandings);
    return classStandings;
}

// Auto-run for `node src/build.js` / `npm run build`, but not when imported.
if (require.main === module) {
    build();
    console.log('Build complete!');
}

module.exports = { build };
```

```js
// src/server.js (inside POST /sync, after a successful sync)
const summary = await syncSeason({ leagueId, seasonId });
build(); // regenerate standings from the freshly synced event files
respond(200, { ok: true, rebuilt: true, ...summary });
```

`build()` is synchronous (it uses `fs` sync calls); if it throws, the existing `/sync`
catch reports the error. The standalone `npm run build` step still works unchanged.

---

## 9. Service status monitoring

iRacing's data API goes down for maintenance and the occasional unplanned outage. When
it does, every `/data/*` endpoint returns a CloudFront/ELB **503** (a raw HTML page, not
iRacing's `{"error":"Site Maintenance"}` JSON), so a sync fails. To surface this *before*
a user attempts an action, a background poller tracks availability.

**Probe — `checkDataApiStatus()` in `src/iracing.js`:** an unauthenticated
`GET https://members-ng.iracing.com/data/doc` (with a 5s timeout). `/data/doc` lists the
API and needs no tokens, so:

- `200` → `up`
- `401` (needs auth, backend alive) → `up`
- `503` / other non-2xx → `down`
- network error / timeout → `unreachable`

Returns `{ status, httpStatus, checkedAt }`.

**Poller — `src/status.js`:** probes once on startup, then every `IRACING_STATUS_POLL_MS`
(default `120000` = 2 min), caching the latest result in memory. `getStatus()` returns it
with no latency. `startPolling()` uses `setInterval(...).unref()` so the timer never holds
the process open. `onStatusChange(previous, next)` is the single chokepoint for transitions
— wire alerting (email/webhook) in there later without touching the rest of the app.

**Surfaced in `src/server.js`:**

- `GET /status` — content-negotiated JSON/HTML of the cached status (safe for monitoring).
- `GET /sync` — a status badge; when `down`/`unreachable`, a warning banner linking to
  status.iracing.com. The Sync button stays enabled (warn-but-attempt: the cached status
  can be up to one poll interval stale).
- `POST /sync` — on a `503` from the SDK, returns a friendly message (distinguishing
  `isMaintenanceMode`) pointing at the status page rather than the bare "Service unavailable".

```js
const { startPolling, getStatus } = require('./status');
app.listen(port, () => { startPolling(); });        // begin background polling
app.get('/status', (req, res) => res.json(getStatus()));
```

---

## 10. Error handling reference

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

## 11. Implementation checklist

- [x] `npm install iracing-data-client dotenv`
- [x] Create `.env` (`IRACING_CLIENT_ID`, `IRACING_CLIENT_SECRET`, `IRACING_REDIRECT_URI`,
      `PORT`); add `.env` to `.gitignore` *(client secret is a placeholder — pending the
      regenerated value)*
- [x] Set `leagueId` + `seasonId` in `assets/config.json` *(11991 / 131761)*
- [x] Create `src/iracing.js` — Authorization Code helpers (`getAuthorizationUrl`,
      `handleCallback`, `isAuthenticated`) + `syncSeason`. Tokens persisted to a gitignored
      `.iracing-tokens.json` (`IRACING_TOKENS_FILE`); `onTokenRefresh` keeps memory + file
      current. `validateParams: false` to bypass the SDK's over-strict response schemas.
      Verified against live data: `subsessionId`/`launchAt` field names and split handling.
- [x] Update the camelCase field accesses in `src/build.js`
      ([§5a](#5a-splitintoclasses) / [§5b](#5b-parseresults)); match the race session by
      `simsessionType === 6`, not `simsessionName` (a live round was named `"FEATURE"`)
- [x] Convert the 8 legacy snake_case event files — `src/migrate-events.js` (deep
      camelCase + envelope unwrap), already run. Idempotent / safe to re-run.
- [x] Add OAuth routes `GET /auth/iracing` + `GET /auth/iracing/callback` to `src/server.js`
- [x] Add `POST /sync` with `res.format()` content negotiation (JSON for API/`*/*`, HTML
      page for browsers) + 401 when unauthenticated; `dotenv` loaded at the top
- [x] Env-driven `PORT` (defaults to 3000 to match the registered redirect URI)
- [x] Add `express.urlencoded({ extended: true })` middleware
- [x] Add `GET /sync` rendering the native HTML form (`renderSyncForm`, no client JS;
      shows iRacing connection status + auth link)
- [x] Refactor `build.js` to export `build()` (auto-run guarded by `require.main`) and
      trigger a rebuild from `/sync` after a successful sync (`rebuilt: true` in response)
- [x] Tested offline: build passes on migrated data; `/sync` form + 401 guard + JSON/HTML
      negotiation verified; `GET /auth/iracing` redirects to iRacing with the correct
      `client_id`, redirect URI, `state`, and PKCE challenge
- [x] Service status monitoring ([§9](#9-service-status-monitoring)): `checkDataApiStatus()`
      probe, `src/status.js` background poller (2 min, `IRACING_STATUS_POLL_MS`), `GET /status`,
      sync-page badge + warning, friendly `503` handling. Verified: `401 → up` live; mapping
      and syntax checked
- [x] **Live `POST /sync` verified end-to-end:** browser login at `/auth/iracing` →
      `POST /sync` fetched all 11 subsessions, wrote `data/events/eventresult-*.json`,
      and rebuilt standings (3 classes, 11 rounds, `rebuilt: true`)
- [x] Move event results out of `assets/` to a gitignored runtime dir `data/events/`
      (`EVENTS_DIR`, [§4a](#4a-runtime-data-directory--startup-sync)); run an initial
      sync on startup (`runInitialSync`, guarded + non-fatal); dirs self-create for deploy

> **Note on chronological ordering ([§7](#7-round-ordering)):** `syncSeason` sorts
> sessions by `launchAt`, but files are written as `eventresult-<subsessionId>.json` and
> `build.js` orders rounds by *filename*. The live season's 11 subsession IDs sort into
> correct round order, so filename ordering matches chronological order today. If a future
> season's IDs aren't monotonic, switch to a zero-padded round prefix in the filename.

---

## 12. Quick API recap

| Call | Purpose | Key params |
| --- | --- | --- |
| `buildAuthorizationUrl({ clientId, redirectUri, scope })` | Build the authorize URL (+ `state`, PKCE) | returns `{ url, state, pkce }` |
| `exchangeAuthorizationCode({ clientId, clientSecret, code, redirectUri, codeVerifier })` | Swap the callback code for tokens | returns `TokenResponse` |
| `iracing.league.seasons({ leagueId })` | List a league's seasons | `leagueId`, `retired?` |
| `iracing.league.seasonSessions({ leagueId, seasonId, resultsOnly })` | List sessions; returns `{ ..., sessions: [] }` | `leagueId`, `seasonId`, `resultsOnly?` |
| `iracing.results.get({ subsessionId })` | Full result for one subsession (camelCase, no envelope) | `subsessionId`, `includeLicenses?` |

Client init (Authorization Code OAuth — tokens obtained via the flow above):

```js
const iracing = new IRacingDataClient({
    auth: {
        type: 'authorization-code',
        clientId: process.env.IRACING_CLIENT_ID,
        clientSecret: process.env.IRACING_CLIENT_SECRET,
        tokens: { accessToken, refreshToken, expiresAt },
        onTokenRefresh: (token) => persist(token), // here: update in-memory copy
    },
});
```
