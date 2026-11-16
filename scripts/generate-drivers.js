#!/usr/bin/env node
/**
 * Generate assets/drivers.json from a published Google Sheet.
 *
 * The published sheet (the Sunday GT3 Championship workbook) holds the driver
 * registry across several tabs, but it has no iRacing cust_ids — the field the
 * standings builder keys on. This script:
 *
 *   1. Discovers the workbook's tabs (name -> gid) from its pubhtml.
 *   2. Reads the per-class "<CLASS> Drivers" tabs for driver names + class.
 *   3. Reads the "TEAMS LineUp" tab to map each driver to their team
 *      (drivers absent from a team line up are treated as Privateer).
 *   4. Resolves each driver's cust_id via the iRacing lookup API
 *      (src/iracing.js), narrowed to the league in assets/config.json.
 *   5. Writes assets/drivers.json: [{ id, name, team, class }, ...].
 *
 * Usage:
 *   node scripts/generate-drivers.js [publishedSheetUrl] [--out path]
 *
 * Defaults to the Season 20 workbook and assets/drivers.json. Any pubhtml/pub
 * URL from the workbook works — only the workbook id is used; the gid/query is
 * ignored because the script discovers every tab itself.
 *
 * Requires iRacing OAuth tokens (run the app and authorise once, or `/login`).
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const { lookupDrivers, isAuthenticated } = require('../src/iracing');
const config = require('../assets/config.json');

// A pubhtml/pub URL from any tab of the default (Season 20) workbook. Only the
// `/e/<id>` segment matters; the script discovers each tab's gid for itself.
const DEFAULT_SHEET_URL =
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vRYW73CM-iu2FlsRAiatZW7W60fDgf15rXiDfGiFozZlTxmKgMqsH99txmeR5ApzL5-B8OSF8-I-AGX/pubhtml';

const DEFAULT_OUT = path.join(__dirname, '..', 'assets', 'drivers.json');

// Spreadsheet class label (from the "<label> Drivers" tab name) -> the class id
// used throughout the app (see assets/config.json "classes").
const CLASS_IDS = { PRO: 'pro', INTER: 'inter', CLUB: 'club' };

// Drivers not assigned to a team in the TEAMS LineUp tab race unattached.
const PRIVATEER = 'Privateer';

// --- CSV parsing (RFC 4180: handles quoted fields, embedded commas/newlines) ---

function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                field += c;
            }
        } else if (c === '"') {
            inQuotes = true;
        } else if (c === ',') {
            row.push(field);
            field = '';
        } else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
        } else {
            field += c;
        }
    }
    // Flush any trailing field/row that wasn't terminated by a newline.
    if (field !== '' || row.length) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}

// --- Name matching ---

// Diacritic- and case-insensitive key so sheet names (often typed without
// accents, e.g. "Timo Gartner") match iRacing's canonical display names
// (e.g. "Timo Gärtner").
// Letters that NFD does not decompose into base + combining mark (so the mark
// strip below can't reach them) still need folding, e.g. Danish ø in "Brøckner".
const LETTER_FOLDS = [
    [/[øòóôõö]/g, 'o'],
    [/æ/g, 'ae'],
    [/å/g, 'a'],
    [/ß/g, 'ss'],
    [/ł/g, 'l'],
    [/[đð]/g, 'd'],
    [/þ/g, 'th'],
];

function normalizeName(name) {
    let s = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    for (const [re, to] of LETTER_FOLDS) s = s.replace(re, to);
    return s.replace(/\s+/g, ' ').trim();
}

// --- Google Sheets fetching ---

// Strip any tab/query suffix so we can rebuild per-tab URLs from the workbook id.
function workbookBase(url) {
    const match = url.match(/^(https:\/\/docs\.google\.com\/spreadsheets\/d\/e\/[^/]+)/);
    if (!match) {
        throw new Error(`Not a published Google Sheet URL: ${url}`);
    }
    return match[1];
}

async function fetchText(url) {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
    }
    return res.text();
}

// Parse the workbook's pubhtml for its tab switcher: a list of
// { name: "<tab>", pageUrl: "...gid=<gid>..." } entries. Returns name -> gid.
async function discoverTabs(base) {
    const html = await fetchText(`${base}/pubhtml`);
    const tabs = {};
    const re = /\{name:\s*"((?:[^"\\]|\\.)*)",\s*pageUrl:[^}]*?gid=(\d+)/g;
    let m;
    while ((m = re.exec(html))) {
        tabs[m[1].replace(/\\(.)/g, '$1')] = m[2];
    }
    if (!Object.keys(tabs).length) {
        throw new Error('Could not find any tabs in the published sheet');
    }
    return tabs;
}

function fetchTabCsv(base, gid) {
    return fetchText(`${base}/pub?gid=${gid}&single=true&output=csv`).then(parseCsv);
}

// --- Tab readers ---

// A "<CLASS> Drivers" tab has a header row containing "Driver"; names live in
// that column for every subsequent non-empty row.
function readDriverNames(rows) {
    const headerIdx = rows.findIndex((r) => r.some((c) => c.trim() === 'Driver'));
    if (headerIdx === -1) {
        throw new Error('Driver tab has no "Driver" header column');
    }
    const col = rows[headerIdx].findIndex((c) => c.trim() === 'Driver');
    const names = [];
    for (const row of rows.slice(headerIdx + 1)) {
        const name = (row[col] || '').trim();
        if (name) names.push(name);
    }
    return names;
}

// The "TEAMS LineUp" tab lists one team per non-empty row: team name in column
// 1, its two drivers in columns 3 and 4. Returns normalizedName -> team.
function readTeamsByDriver(rows) {
    const byDriver = {};
    for (const row of rows) {
        const team = (row[1] || '').trim();
        if (!team) continue;
        for (const driver of [row[3], row[4]]) {
            const name = (driver || '').trim();
            if (name) byDriver[normalizeName(name)] = team;
        }
    }
    return byDriver;
}

// --- iRacing id resolution ---

// Resolve one sheet name to { id, name } using the iRacing lookup. Prefer an
// exact (diacritic-insensitive) match; fall back to the sole result when the
// search is unambiguous. Returns the canonical iRacing displayName so the output
// carries proper accents even when the sheet omits them.
async function resolveDriver(sheetName, leagueId) {
    const want = normalizeName(sheetName);
    const tokens = sheetName.trim().split(/\s+/);

    // iRacing's search matches its canonical (accented) display names, so a sheet
    // name typed without accents (e.g. "Timo Gartner") finds nothing by full name.
    // Try the full name first, then fall back to single tokens — iRacing returns
    // the accented name, which normalizeName() then matches. Each term is tried
    // within the league (disambiguates duplicate names) before widening globally.
    const terms = [sheetName, tokens[0], tokens[tokens.length - 1]].filter(
        (t, i, a) => t && a.indexOf(t) === i,
    );

    let results = [];
    let exact = null;
    for (const term of terms) {
        results = (await lookupDrivers({ searchTerm: term, leagueId })) || [];
        if (!results.length) results = (await lookupDrivers({ searchTerm: term })) || [];
        exact = results.find((r) => normalizeName(r.displayName) === want);
        if (exact) break;
    }

    const match = exact || (results.length === 1 ? results[0] : null);

    if (!match) {
        return {
            id: null,
            name: sheetName,
            note: results.length
                ? `ambiguous (${results.length} results, no exact match)`
                : 'no results',
        };
    }
    return { id: match.custId, name: match.displayName };
}

// --- Output ---

// Preserve any existing drivers.json before it's overwritten: rename it to a
// timestamped sibling (e.g. drivers.json.2026-11-16T09-30-00Z.bak) so a bad run
// can always be rolled back and successive runs don't clobber each other's
// backups. A missing file is fine — the write that follows creates it fresh.
function backupExisting(outPath) {
    if (!fs.existsSync(outPath)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${outPath}.${stamp}.bak`;
    fs.renameSync(outPath, backup);
    console.log(`Backed up existing ${path.basename(outPath)} -> ${path.basename(backup)}`);
}

// --- Main ---

async function main() {
    const args = process.argv.slice(2);
    let outPath = DEFAULT_OUT;
    const positional = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--out') {
            outPath = args[++i];
        } else {
            positional.push(args[i]);
        }
    }
    const sheetUrl = positional[0] || DEFAULT_SHEET_URL;

    if (!isAuthenticated()) {
        console.error(
            'Not authenticated with iRacing. Start the app and authorise (or run /login) first.',
        );
        process.exit(1);
    }

    const base = workbookBase(sheetUrl);
    const leagueId = config.leagueId;

    console.log(`Discovering tabs in ${base} ...`);
    const tabs = await discoverTabs(base);

    // Find the per-class driver tabs (e.g. "SUNGT3-PRO Drivers") and the team line up.
    const classTabs = [];
    for (const [name, gid] of Object.entries(tabs)) {
        const m = name.match(/\b(PRO|INTER|CLUB)\b\s*Drivers/i);
        if (m) classTabs.push({ classId: CLASS_IDS[m[1].toUpperCase()], name, gid });
    }
    if (!classTabs.length) {
        throw new Error('No "<CLASS> Drivers" tabs found in the sheet');
    }
    const teamsEntry = Object.entries(tabs).find(([n]) => /TEAMS\s*LineUp/i.test(n));

    const teamsByDriver = teamsEntry
        ? readTeamsByDriver(await fetchTabCsv(base, teamsEntry[1]))
        : {};
    if (!teamsEntry) {
        console.warn('No "TEAMS LineUp" tab found — every driver will be a Privateer.');
    }

    // Collect (sheetName, team, class) for every driver, preserving class order.
    const order = ['pro', 'inter', 'club'];
    classTabs.sort((a, b) => order.indexOf(a.classId) - order.indexOf(b.classId));

    const roster = [];
    for (const tab of classTabs) {
        const names = readDriverNames(await fetchTabCsv(base, tab.gid));
        console.log(`  ${tab.name}: ${names.length} drivers`);
        for (const name of names) {
            roster.push({
                sheetName: name,
                team: teamsByDriver[normalizeName(name)] || PRIVATEER,
                class: tab.classId,
            });
        }
    }

    console.log(`\nResolving ${roster.length} driver ids via iRacing (league ${leagueId}) ...`);
    const drivers = [];
    const unresolved = [];
    for (const entry of roster) {
        const { id, name, note } = await resolveDriver(entry.sheetName, leagueId);
        if (id == null) {
            unresolved.push({ name: entry.sheetName, note });
            console.warn(`  ! ${entry.sheetName} (${entry.class}): ${note}`);
        }
        // iRacing's canonical display name is the source of truth (resolveDriver
        // returns it, or the sheet name as a fallback when a driver is unresolved).
        drivers.push({ id, name, team: entry.team, class: entry.class });
    }

    backupExisting(outPath);
    fs.writeFileSync(outPath, JSON.stringify(drivers, null, 4) + '\n');
    console.log(`\nWrote ${drivers.length} drivers to ${outPath}`);
    if (unresolved.length) {
        console.log(
            `${unresolved.length} unresolved (id left null) — fix the name in the sheet or set the id by hand:`,
        );
        for (const u of unresolved) console.log(`  - ${u.name}: ${u.note}`);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
