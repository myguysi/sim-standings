require('dotenv').config();

const express = require('express');
const {
    syncSeason,
    getAuthorizationUrl,
    handleCallback,
    isAuthenticated,
} = require('./iracing');
const { build } = require('./build');
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

// GET /sync — render the HTML form that POSTs to /sync.
app.get('/sync', (req, res) => {
    const { leagueName, leagueId, seasonId } = config;
    res.send(renderSyncForm({ leagueName, leagueId, seasonId, authed: isAuthenticated() }));
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
        respond(502, { ok: false, error: err.message });
    }
});

app.listen(port, () => {
    console.log(`App listening on port ${port}`);
});


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
