/**
 * One-off migration: convert the legacy snake_case event files (raw iRacing
 * `{ type, data }` envelope) into the camelCase shape that results.get() returns,
 * which build.js now consumes.
 *
 * Each `assets/events/eventresult-*.json` is rewritten in place: the `{type,data}`
 * wrapper is dropped and every key is deep-camelCased.
 *
 * Run once: `node src/migrate-events.js`
 * Safe to re-run — already-migrated files (no `.data` envelope) are skipped.
 */

const fs = require('fs');

const EVENTS_DIR = 'assets/events';

const toCamel = (key) => key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

function deepCamel(value) {
    if (Array.isArray(value)) {
        return value.map(deepCamel);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([k, v]) => [toCamel(k), deepCamel(v)]),
        );
    }
    return value;
}

function migrate() {
    const files = fs.readdirSync(EVENTS_DIR).filter((f) => f.endsWith('.json'));
    let migrated = 0;

    for (const file of files) {
        const path = `${EVENTS_DIR}/${file}`;
        const parsed = JSON.parse(fs.readFileSync(path, 'utf-8'));

        // Legacy files are wrapped as { type, data }. Already-migrated files are the
        // bare camelCase result object (have sessionResults at the top level).
        if (!parsed.data || !parsed.data.session_results) {
            console.log(`skip  ${file} (already migrated)`);
            continue;
        }

        const converted = deepCamel(parsed.data);
        fs.writeFileSync(path, JSON.stringify(converted, null, 2));
        console.log(`ok    ${file}`);
        migrated += 1;
    }

    console.log(`\nMigrated ${migrated} of ${files.length} file(s).`);
}

migrate();
