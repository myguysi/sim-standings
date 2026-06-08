/**
 * iRacing Data API integration.
 *
 * Fetches league race results via the iracing-data-client SDK and writes them to
 * assets/events/ in the same shape build.js consumes (camelCase, no {type,data}
 * envelope — exactly what results.get() returns).
 */

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

module.exports = { syncSeason };
