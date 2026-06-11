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
 * Tokens are held in memory only (single-user local backend): a server restart
 * requires re-authorising. onTokenRefresh keeps the in-memory copy current.
 */

const fs = require('fs');
const {
    IRacingDataClient,
    buildAuthorizationUrl,
    exchangeAuthorizationCode,
} = require('iracing-data-client');

const EVENTS_DIR = 'assets/events';

// 'iracing.auth' is the scope iRacing requires for data-server access (it's the
// SDK's own IRACING_AUTH_SCOPE constant). 'openid' is rejected as a disallowed
// scope. Override via IRACING_SCOPE only if iRacing's /authorize docs change.
const SCOPE = process.env.IRACING_SCOPE || 'iracing.auth';

function redirectUri() {
    // Must exactly match a redirect URI registered with the client.
    return process.env.IRACING_REDIRECT_URI || 'http://127.0.0.1:3000/auth/iracing/callback';
}

// In-memory state (not persisted).
let tokens = null; // { accessToken, refreshToken, expiresAt }
let pendingAuth = null; // { state, verifier } between redirect and callback

function isAuthenticated() {
    return Boolean(tokens && tokens.accessToken);
}

// Normalise an SDK TokenResponse (snake_case) into the client's token shape.
// Preserve the existing refresh token if a rotation response omits it.
function storeTokens(token) {
    tokens = {
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? tokens?.refreshToken,
        expiresAt: Math.floor(Date.now() / 1000) + token.expires_in,
    };
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

module.exports = { syncSeason, getAuthorizationUrl, handleCallback, isAuthenticated };
