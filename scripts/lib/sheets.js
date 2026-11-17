/**
 * Shared helpers for reading the published Google Sheet workbook (the Sunday
 * GT3 Championship driver registry) and matching its driver names.
 */

// A pubhtml/pub URL from any tab of the default (Season 20) workbook. Only the
// `/e/<id>` segment matters; scripts discover each tab's gid for themselves.
const DEFAULT_SHEET_URL =
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vRYW73CM-iu2FlsRAiatZW7W60fDgf15rXiDfGiFozZlTxmKgMqsH99txmeR5ApzL5-B8OSF8-I-AGX/pubhtml';

// Spreadsheet class label (from the "<label> Drivers" tab name) -> the class id
// used throughout the app (see assets/config.json "classes").
const CLASS_IDS = { PRO: 'pro', INTER: 'inter', CLUB: 'club' };
const CLASS_ORDER = ['pro', 'inter', 'club'];

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

// The per-class "<CLASS> Drivers" tabs (e.g. "SUNGT3-PRO Drivers"), in class
// order: [{ classId, name, gid }].
function findClassTabs(tabs) {
    const classTabs = [];
    for (const [name, gid] of Object.entries(tabs)) {
        const m = name.match(/\b(PRO|INTER|CLUB)\b\s*Drivers/i);
        if (m) classTabs.push({ classId: CLASS_IDS[m[1].toUpperCase()], name, gid });
    }
    if (!classTabs.length) {
        throw new Error('No "<CLASS> Drivers" tabs found in the sheet');
    }
    return classTabs.sort(
        (a, b) => CLASS_ORDER.indexOf(a.classId) - CLASS_ORDER.indexOf(b.classId),
    );
}

function fetchTabCsv(base, gid) {
    return fetchText(`${base}/pub?gid=${gid}&single=true&output=csv`).then(parseCsv);
}

// The rendered HTML of a single tab. Unlike the CSV export this includes cell
// images (IMAGE() formulas / in-cell images), but omits hidden columns.
function fetchTabHtml(base, gid) {
    return fetchText(`${base}/pubhtml/sheet?headers=false&gid=${gid}`);
}

module.exports = {
    DEFAULT_SHEET_URL,
    CLASS_IDS,
    CLASS_ORDER,
    parseCsv,
    normalizeName,
    workbookBase,
    fetchText,
    discoverTabs,
    findClassTabs,
    fetchTabCsv,
    fetchTabHtml,
};
