require('dotenv').config();

const express = require('express');
const {
    syncSeason,
    getAuthorizationUrl,
    handleCallback,
    isAuthenticated,
} = require('./iracing');
const { getStatus, startPolling } = require('./status');
const { build, listEvents, saveEventsConfig } = require('./build');
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

// GET /auth/iracing — kick off the OAuth Authorization Code flow.
app.get('/auth/iracing', async (req, res) => {
    try {
        res.redirect(await getAuthorizationUrl());
    } catch (err) {
        console.error('Failed to build authorization URL:', err);
        res.status(500).send(renderSyncResult({ ok: false, error: err.message }));
    }
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
        console.error('OAuth callback failed:', err);
        res.status(400).send(renderSyncResult({ ok: false, error: err.message }));
    }
});

// GET /status — current iRacing data API availability (cached by the poller).
// Content-negotiated so monitoring can poll JSON while browsers get a small page.
app.get('/status', (req, res) => {
    const status = getStatus();
    res.format({
        json: () => res.json(status),
        html: () => res.send(renderStatusPage(status)),
        default: () => res.json(status),
    });
});

// GET /sync — render the HTML form that POSTs to /sync.
app.get('/sync', (req, res) => {
    const { leagueName, leagueId, seasonId } = config;
    res.send(renderSyncForm({
        leagueName,
        leagueId,
        seasonId,
        authed: isAuthenticated(),
        status: getStatus(),
    }));
});

// POST /sync — fetch the season's results from iRacing and write them to disk.
// Content-negotiates: an HTML result page for browsers, JSON for API clients.
app.post('/sync', async (req, res) => {
    const { leagueId, seasonId } = config;

    const respond = (status, payload) => {
        // json first so non-browser clients (curl/`*/*`) default to JSON; browsers
        // explicitly send text/html and still get the HTML result page.
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
        // Regenerate standings from the freshly synced event files.
        build();
        respond(200, { ok: true, rebuilt: true, ...summary });
    } catch (err) {
        // The SDK throws typed errors (OAuthError, IRacingError with isUnauthorized,
        // rate-limit and maintenance-mode). Log the request URL + response body so a
        // 503/4xx can be traced to a specific iRacing endpoint.
        console.error('Sync failed:', {
            message: err.message,
            status: err.status,
            url: err.url,
            responseData: err.responseData,
        });
        // A 503 means iRacing's data API is unavailable (maintenance/outage), not a
        // bug in the request — point the user at the status page.
        if (err.status === 503) {
            const reason = err.isMaintenanceMode
                ? 'iRacing is in scheduled maintenance'
                : 'iRacing data API is temporarily unavailable';
            return respond(503, {
                ok: false,
                error: `${reason} (503). Check https://status.iracing.com and try again shortly.`,
            });
        }
        respond(502, { ok: false, error: err.message });
    }
});

// GET /events — render the form of synced events with a checkbox each, so the user
// can deselect events (e.g. a media day) that shouldn't count towards the standings.
app.get('/events', (req, res) => {
    res.send(renderEventsForm(listEvents()));
});

// POST /events — persist the include/exclude choices, then rebuild the standings.
// Unchecked checkboxes aren't submitted, so we re-list every synced event and record
// an explicit boolean for each based on whether its id is in the submitted set.
app.post('/events', (req, res) => {
    const respond = (status, payload) => {
        res.status(status).format({
            json: () => res.json(payload),
            html: () => res.send(renderEventsResult(payload)),
            default: () => res.json(payload),
        });
    };

    try {
        const raw = req.body.included;
        const includedIds = (Array.isArray(raw) ? raw : raw != null ? [raw] : []).map(String);

        const events = listEvents();
        const eventsConfig = {};
        events.forEach((e) => {
            eventsConfig[e.subsessionId] = includedIds.includes(String(e.subsessionId));
        });
        saveEventsConfig(eventsConfig);

        // Regenerate standings from the now-filtered set of events.
        build();
        respond(200, { ok: true, rebuilt: true, included: includedIds.length, total: events.length });
    } catch (err) {
        console.error('Saving events config failed:', err);
        respond(500, { ok: false, error: err.message });
    }
});

app.listen(port, () => {
    console.log(`App listening on port ${port}`);
    // Begin polling iRacing data API availability in the background.
    startPolling();
    // Fetch the latest results on startup (event data isn't committed). Fire-and-forget
    // so the server is responsive immediately; runInitialSync never throws.
    runInitialSync();
});

// Sync the season and rebuild standings once at startup. Skips cleanly when not yet
// authenticated or unconfigured, and swallows errors (e.g. iRacing API down) so a
// failed sync never takes the server down — the user can retry via POST /sync.
async function runInitialSync() {
    const { leagueId, seasonId } = config;
    if (!isAuthenticated()) {
        console.log('Initial sync skipped: not authenticated with iRacing — visit /auth/iracing.');
        return;
    }
    if (!leagueId || !seasonId) {
        console.log('Initial sync skipped: leagueId/seasonId not set in assets/config.json.');
        return;
    }
    try {
        console.log('Running initial sync from iRacing…');
        const summary = await syncSeason({ leagueId, seasonId });
        build();
        console.log(`Initial sync complete: ${summary.written} event(s) written, standings rebuilt.`);
    } catch (err) {
        console.error('Initial sync failed (will not block startup):', err.message);
    }
}


// --- HTML rendering ---------------------------------------------------------

// Escape interpolated values. config.json is ours today, but escaping keeps this
// safe if any field ever becomes user-supplied.
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
    .badge { display: inline-block; padding: .15rem .6rem; border-radius: 1rem; font-size: .85rem; font-weight: 600; }
    .badge--up { background: #e3f5e3; color: #137333; }
    .badge--down, .badge--unreachable { background: #fce8e6; color: #b00; }
    .badge--unknown { background: #eee; color: #555; }
    .warn { background: #fff4e5; border: 1px solid #ffcf8b; color: #8a5300; padding: .6rem 1rem; border-radius: .4rem; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

// Human-readable label + CSS modifier for each status value.
const STATUS_LABELS = {
    up: 'operational',
    down: 'unavailable',
    unreachable: 'unreachable',
    unknown: 'checking…',
};

function statusBadge(status) {
    const state = status?.status ?? 'unknown';
    const label = STATUS_LABELS[state] ?? state;
    return `<span class="badge badge--${escapeHtml(state)}">iRacing data API: ${escapeHtml(label)}</span>`;
}

function renderSyncForm({ leagueName, leagueId, seasonId, authed, status }) {
    const configured = leagueId && seasonId;
    // Per design: warn but still attempt. The button stays enabled regardless of
    // API status (the cached status can be up to one poll interval stale).
    const ready = configured && authed;
    const apiDown = status && (status.status === 'down' || status.status === 'unreachable');
    return page('Sync Results', `
  <h1>Sync Results</h1>
  <p>${statusBadge(status)}</p>
  ${apiDown
      ? '<p class="warn">The iRacing data API looks unavailable right now '
        + '(<a href="https://status.iracing.com">status.iracing.com</a>). '
        + 'You can still try, but the sync will likely fail until it recovers.</p>'
      : ''}
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
  </form>
  <p><a href="/events">Choose which events count towards the standings &rarr;</a></p>`);
}

// GET /events form: one checkbox per synced event (checked = counts towards standings).
function renderEventsForm(events) {
    if (!events.length) {
        return page('Select Events', `
  <h1>Select Events</h1>
  <p class="meta">No events have been synced yet.</p>
  <p><a href="/sync">&larr; Sync this season</a> first, then come back to choose which count.</p>`);
    }
    const rows = events.map((e) => {
        const date = e.startTime ? new Date(e.startTime).toLocaleString() : '—';
        return `
    <label style="display:block; margin:.5rem 0;">
      <input type="checkbox" name="included" value="${escapeHtml(e.subsessionId)}" ${e.included ? 'checked' : ''}>
      <strong>${escapeHtml(e.trackName ?? 'Unknown track')}</strong> — ${escapeHtml(date)}
      <span class="meta">(#${escapeHtml(e.subsessionId)})</span>
    </label>`;
    }).join('');
    return page('Select Events', `
  <h1>Select Events</h1>
  <p class="meta">Deselect any events that shouldn't count towards the standings (e.g. a media day), then save to rebuild.</p>
  <form method="POST" action="/events">
    ${rows}
    <p><button type="submit">Save &amp; rebuild standings</button></p>
  </form>
  <p><a href="/sync">&larr; Sync</a></p>`);
}

// POST /events response for browser submissions.
function renderEventsResult(payload) {
    const heading = payload.ok ? 'Standings rebuilt' : 'Could not save';
    return page(heading, `
  <h1>${heading}</h1>
  ${payload.ok
      ? `<p>${escapeHtml(payload.included)} of ${escapeHtml(payload.total)} event(s) included. Standings rebuilt.</p>`
      : `<p class="error">${escapeHtml(payload.error)}</p>`}
  <p><a href="/events">&larr; Back to events</a></p>`);
}

// Standalone status page (GET /status with Accept: text/html).
function renderStatusPage(status) {
    const checkedAt = status?.checkedAt ? new Date(status.checkedAt).toLocaleString() : 'not yet checked';
    return page('iRacing Status', `
  <h1>iRacing Status</h1>
  <p>${statusBadge(status)}</p>
  <p class="meta">
    HTTP: <strong>${escapeHtml(status?.httpStatus ?? '—')}</strong><br>
    Last checked: <strong>${escapeHtml(checkedAt)}</strong>
  </p>
  <p><a href="https://status.iracing.com">iRacing status page</a> · <a href="/sync">&larr; Sync</a></p>`);
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
