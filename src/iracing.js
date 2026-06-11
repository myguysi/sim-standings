/**
 * iRacing Data API integration (OAuth2 Authorization Code flow).
 *
 * The registered client (489822-league) uses the Authorization Code flow, so a
 * user must authorise in the browser before we can call the API:
 *
 *   1. GET /auth/iracing          -> getAuthorizationUrl(), redirect to iRacing
 *   2. iRacing redirects back to  -> handleCallback({ code, state }) exchanges the
 *      the registered redirect URI    code for tokens
 *   3. POST /sync                 -> syncSeason() uses the stored tokens
 *
 * Tokens are persisted to a gitignored file (single-user local backend) so a server
 * restart doesn't require re-authorising. onTokenRefresh keeps both the in-memory
 * copy and the file current.
 */

const fs = require('fs');
const {
    IRacingDataClient,
    buildAuthorizationUrl,
    exchangeAuthorizationCode,
} = require('iracing-data-client');

// Where synced event results are written. Runtime data (not committed) — defaults to
// data/events, overridable with EVENTS_DIR. build.js reads from the same location.
const EVENTS_DIR = process.env.EVENTS_DIR || 'data/events';

// Base URL for the iRacing data API. /data/doc is an unauthenticated endpoint we
// can cheaply probe to tell whether the data API is reachable (see checkDataApiStatus).
const DATA_API_BASE_URL = 'https://members-ng.iracing.com';

// How long to wait on the status probe before treating the API as unreachable.
const STATUS_PROBE_TIMEOUT_MS = 5000;

// 'iracing.auth' is the scope iRacing requires for data-server access (it's the
// SDK's own IRACING_AUTH_SCOPE constant). 'openid' is rejected as a disallowed
// scope. Override via IRACING_SCOPE only if iRacing's /authorize docs change.
const SCOPE = process.env.IRACING_SCOPE || 'iracing.auth';

function redirectUri() {
    // Must exactly match a redirect URI registered with the client.
    return process.env.IRACING_REDIRECT_URI || 'http://127.0.0.1:3000/auth/iracing/callback';
}

// Where to persist tokens between restarts. Holds access + refresh tokens, so it's
// gitignored like .env. Override the path with IRACING_TOKENS_FILE if needed.
const TOKENS_FILE = process.env.IRACING_TOKENS_FILE || '.iracing-tokens.json';

// Restore any persisted tokens on startup; pendingAuth is transient (in-memory only).
let tokens = loadTokens(); // { accessToken, refreshToken, expiresAt } | null
let pendingAuth = null; // { state, verifier } between redirect and callback

function isAuthenticated() {
    return Boolean(tokens && tokens.accessToken);
}

// Read persisted tokens from disk. Returns null if absent/unreadable, so the app
// simply starts unauthenticated rather than crashing.
function loadTokens() {
    try {
        const parsed = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));
        return parsed && parsed.accessToken ? parsed : null;
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.warn(`Could not read ${TOKENS_FILE}: ${err.message}`);
        }
        return null;
    }
}

// Write the current tokens to disk so they survive a restart.
function persistTokens() {
    try {
        fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
    } catch (err) {
        console.error(`Failed to persist tokens to ${TOKENS_FILE}: ${err.message}`);
    }
}

// Normalise an SDK TokenResponse (snake_case) into the client's token shape and
// persist it. Preserve the existing refresh token if a rotation response omits it.
function storeTokens(token) {
    tokens = {
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? tokens?.refreshToken,
        expiresAt: Math.floor(Date.now() / 1000) + token.expires_in,
    };
    persistTokens();
}

/** Build the iRacing authorization URL and remember the PKCE verifier + state. */
async function getAuthorizationUrl() {
    const { url, state, pkce } = await buildAuthorizationUrl({
        clientId: process.env.IRACING_CLIENT_ID,
        redirectUri: redirectUri(),
        scope: SCOPE,
    });
    pendingAuth = { state, verifier: pkce?.verifier };
    return url;
}

/** Exchange the authorization code (from the callback) for tokens. */
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
        // Skip the SDK's Zod response validation. Its bundled schemas are stricter
        // than the real API: league results carry null for allowedLicenses,
        // seriesLogo, and per-row divisionName, which the schemas reject. The
        // camelCase transform happens in the HTTP layer (before validation), so we
        // still get camelCased, envelope-stripped data — just unvalidated.
        validateParams: false,
    });
}

/**
 * Fetch every result for a league season and write one file per session.
 * Returns a summary: { leagueId, seasonId, sessionCount, written, subsessionIds }.
 */
async function syncSeason({ leagueId, seasonId }) {
    const iracing = createClient();

    // season_sessions returns { success, subscribed, leagueId, seasonId, sessions: [] }.
    // resultsOnly:true filters out scheduled/cancelled sessions that have no result.
    const { sessions } = await iracing.league.seasonSessions({
        leagueId,
        seasonId,
        resultsOnly: true,
    });

    // Each session is loosely typed; keep only those that actually carry a subsession id.
    // Sort by launch time so files land in chronological round order.
    const runSessions = (sessions ?? [])
        .filter((s) => s && s.subsessionId)
        .sort((a, b) => new Date(a.launchAt ?? 0) - new Date(b.launchAt ?? 0));

    if (!fs.existsSync(EVENTS_DIR)) {
        fs.mkdirSync(EVENTS_DIR, { recursive: true });
    }

    const subsessionIds = [];

    // Sequential to stay friendly with iRacing rate limits (the SDK also surfaces
    // a typed error if a limit is hit).
    for (const session of runSessions) {
        const subsessionId = session.subsessionId;
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
        sessionCount: runSessions.length,
        written: subsessionIds.length,
        subsessionIds,
    };
}

/**
 * Probe the iRacing data API to determine whether it's available right now.
 * Unauthenticated: /data/doc lists the API and is reachable without tokens, so a
 * 200 (or 401 "needs auth") means the backend is alive; a 503 is the CloudFront/ELB
 * "Service Temporarily Unavailable" we see during iRacing maintenance/outages.
 *
 * Returns { status: 'up' | 'down' | 'unreachable', httpStatus, checkedAt }.
 */
async function checkDataApiStatus() {
    const checkedAt = new Date().toISOString();
    try {
        const res = await fetch(`${DATA_API_BASE_URL}/data/doc`, {
            method: 'GET',
            signal: AbortSignal.timeout(STATUS_PROBE_TIMEOUT_MS),
        });
        // 200 = up; 401 = backend alive but unauthenticated (still "up" for our purposes).
        // 503 (and any other non-2xx/401) means the data API isn't serving requests.
        const status = res.ok || res.status === 401 ? 'up' : 'down';
        return { status, httpStatus: res.status, checkedAt };
    } catch (err) {
        // Network error, DNS failure, or the probe timed out.
        return { status: 'unreachable', httpStatus: null, checkedAt, error: err.message };
    }
}

module.exports = {
    syncSeason,
    getAuthorizationUrl,
    handleCallback,
    isAuthenticated,
    checkDataApiStatus,
};
