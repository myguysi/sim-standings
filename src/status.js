/**
 * Background poller for iRacing data API availability.
 *
 * On startup we probe the data API once, then re-probe on an interval, caching the
 * latest result in memory. The rest of the app reads getStatus() with no latency,
 * so pages and actions know the API's health before hitting it.
 *
 * onStatusChange() is the single chokepoint for status transitions — wire alerting
 * (email, webhook, etc.) in here later without touching the rest of the app.
 */

const { checkDataApiStatus } = require('./iracing');

// Poll interval, env-overridable like PORT. Defaults to 2 minutes — frequent enough
// to catch outages quickly, light enough to stay polite to iRacing's edge.
const POLL_MS = Number(process.env.IRACING_STATUS_POLL_MS) || 120000;

// Latest known status. 'unknown' until the first probe completes.
let current = { status: 'unknown', httpStatus: null, checkedAt: null };
let timer = null;

/** Latest cached status: { status: 'unknown'|'up'|'down'|'unreachable', httpStatus, checkedAt }. */
function getStatus() {
    return current;
}

// Probe once and update the cache, firing onStatusChange on a real transition.
async function refresh() {
    const previous = current;
    current = await checkDataApiStatus();
    if (previous.status !== 'unknown' && previous.status !== current.status) {
        onStatusChange(previous, current);
    }
    return current;
}

// Single place where availability changes are observed. Logs for now; this is where
// future alerting (notify on up -> down) should hook in.
function onStatusChange(previous, next) {
    console.log(
        `iRacing data API status changed: ${previous.status} -> ${next.status} `
        + `(HTTP ${next.httpStatus ?? 'n/a'}) at ${next.checkedAt}`,
    );
}

// Probe immediately, then on the interval. unref() so the timer never keeps the
// process alive on its own.
function startPolling() {
    const tick = () => refresh().catch((err) => console.error('Status probe failed:', err.message));
    tick();
    timer = setInterval(tick, POLL_MS);
    timer.unref();
    return timer;
}

module.exports = { getStatus, refresh, startPolling, POLL_MS };
