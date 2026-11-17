#!/usr/bin/env node
/**
 * Enrich assets/drivers.json with per-driver details scraped from the published
 * Google Sheet's "<CLASS> Drivers" tabs:
 *
 *   country  - ISO 3166-1 alpha-2 code, lowercase (e.g. "nl"). From a hidden
 *              column. The UK home nations, which have no alpha-2 code of their
 *              own, use their ISO 3166-2 subdivision code (e.g. "gb-sct").
 *              Flags are looked up from flagcdn: https://flagcdn.com/<country>.svg
 *   number   - car number.
 *   carBrand - manufacturer (e.g. "Ferrari"), derived from the hidden car
 *              model column (e.g. "Ferrari 296 GT3").
 *   photo    - driver photo, saved under assets/images/drivers/.
 *   livery   - car livery, saved under assets/images/liveries/.
 *
 * Image paths are relative to assets/. Files are named by a hash of their
 * content, so the stock photo/livery the sheet uses for drivers without their
 * own is stored once and shared. Images are fetched at original resolution.
 *
 * Drivers are matched to drivers.json entries by name (diacritic/case
 * insensitive) within their class. Run scripts/generate-drivers.js first to
 * build the roster; this script only adds fields to existing entries.
 *
 * Usage:
 *   node scripts/scrape-driver-media.js [publishedSheetUrl] [--drivers path]
 *
 * No iRacing auth needed.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
    DEFAULT_SHEET_URL,
    normalizeName,
    workbookBase,
    discoverTabs,
    findClassTabs,
    fetchTabCsv,
    fetchTabHtml,
} = require('./lib/sheets');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const DEFAULT_DRIVERS = path.join(ASSETS_DIR, 'drivers.json');
const PHOTO_DIR = 'images/drivers';
const LIVERY_DIR = 'images/liveries';

// Hidden columns (absent from the HTML view, present in the CSV export) holding
// the country slug used to pick the flag image and the car model.
const CSV_COUNTRY_COL = 10; // K
const CSV_CAR_COL = 12; // M

// Visible image columns, as offsets from the "Driver" header column:
// Driver | photo | brand logo | livery
const PHOTO_OFFSET = 1;
const LIVERY_OFFSET = 3;

// The sheet's country slugs -> lowercase ISO 3166-1 alpha-2 codes (ISO 3166-2
// for the UK home nations), as used in flagcdn URLs.
const COUNTRY_CODES = {
    austria: 'at',
    australia: 'au',
    belgium: 'be',
    brazil: 'br',
    canada: 'ca',
    croatia: 'hr',
    'czech-republic': 'cz',
    denmark: 'dk',
    england: 'gb-eng',
    estonia: 'ee',
    finland: 'fi',
    france: 'fr',
    germany: 'de',
    greece: 'gr',
    hungary: 'hu',
    ireland: 'ie',
    italy: 'it',
    latvia: 'lv',
    lithuania: 'lt',
    luxembourg: 'lu',
    netherlands: 'nl',
    'new-zealand': 'nz',
    'northern-ireland': 'gb-nir',
    norway: 'no',
    poland: 'pl',
    portugal: 'pt',
    'puerto-rico': 'pr',
    romania: 'ro',
    scotland: 'gb-sct',
    serbia: 'rs',
    slovakia: 'sk',
    slovenia: 'si',
    'south-africa': 'za',
    spain: 'es',
    sweden: 'se',
    switzerland: 'ch',
    ukraine: 'ua',
    'united-kingdom': 'gb',
    'united-states': 'us',
    wales: 'gb-wls',
};

// Manufacturers, longest first so e.g. "Mercedes-AMG" wins over a shorter prefix.
const CAR_BRANDS = [
    'Aston Martin',
    'Mercedes-AMG',
    'Lamborghini',
    'Chevrolet',
    'McLaren',
    'Ferrari',
    'Porsche',
    'Ford',
    'Audi',
    'Acura',
    'Lexus',
    'BMW',
].sort((a, b) => b.length - a.length);

// The sheet writes "Blank" when a driver has no car yet.
const NO_CAR = /^blank$/i;

function countryCode(slug) {
    const s = slug.trim().toLowerCase();
    if (!s) return null;
    if (!(s in COUNTRY_CODES)) {
        console.warn(`  ! unknown country "${slug}" — add it to COUNTRY_CODES`);
        return null;
    }
    return COUNTRY_CODES[s];
}

function carBrand(car) {
    const brand = CAR_BRANDS.find((b) => car.toLowerCase().startsWith(b.toLowerCase()));
    if (!brand) console.warn(`  ! unknown car brand for "${car}" — add it to CAR_BRANDS`);
    return brand || null;
}

// --- HTML table parsing ---

const decodeEntities = (s) =>
    s
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');

// Parse the tab's HTML table into rows of { text, img } cells, expanding colspans
// so cell indexes line up with sheet columns. The leading row-number <th> is dropped.
function parseHtmlTable(html) {
    const rows = [];
    for (const [, tr] of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
        const cells = [];
        for (const [, attrs, body] of tr.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)) {
            const span = Number((attrs.match(/colspan="(\d+)"/) || [])[1] || 1);
            const img = body.match(/<img[^>]*src="([^"]+)"/);
            const cell = {
                text: decodeEntities(body.replace(/<[^>]+>/g, '')).trim(),
                img: img ? decodeEntities(img[1]) : null,
            };
            cells.push(cell);
            for (let i = 1; i < span; i++) cells.push({ text: '', img: null });
        }
        rows.push(cells);
    }
    return rows;
}

// Read a class tab into [{ name, number, photoUrl, liveryUrl, country, car }].
// Visible fields come from the HTML (which carries the images); hidden ones
// come from the CSV export, joined on driver name.
function readClassTab(htmlRows, csvRows) {
    const headerIdx = htmlRows.findIndex((r) => r.some((c) => c.text === 'Driver'));
    if (headerIdx === -1) throw new Error('Driver tab has no "Driver" header column');
    const header = htmlRows[headerIdx];
    const nameCol = header.findIndex((c) => c.text === 'Driver');
    const numberCol = header.findIndex((c) => c.text === 'Number');

    const csvHeaderIdx = csvRows.findIndex((r) => r.some((c) => c.trim() === 'Driver'));
    const csvNameCol = csvRows[csvHeaderIdx].findIndex((c) => c.trim() === 'Driver');
    const hidden = {};
    for (const row of csvRows.slice(csvHeaderIdx + 1)) {
        const name = (row[csvNameCol] || '').trim();
        if (!name) continue;
        hidden[normalizeName(name)] = {
            country: (row[CSV_COUNTRY_COL] || '').trim(),
            car: (row[CSV_CAR_COL] || '').trim(),
        };
    }

    const entries = [];
    for (const row of htmlRows.slice(headerIdx + 1)) {
        const name = row[nameCol]?.text;
        if (!name) continue;
        const extra = hidden[normalizeName(name)] || { country: '', car: '' };
        entries.push({
            name,
            number: row[numberCol]?.text || '',
            photoUrl: row[nameCol + PHOTO_OFFSET]?.img || null,
            liveryUrl: row[nameCol + LIVERY_OFFSET]?.img || null,
            ...extra,
        });
    }
    return entries;
}

// --- Image download ---

// Google's image proxy URLs end in "=<sizing options>"; "=s0" asks for the
// original upload rather than the thumbnail rendered in the sheet.
const originalUrl = (url) => url.replace(/=[^=/]*$/, '=s0');

const EXTENSIONS = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
};

// Download (memoised per URL) and store under assets/<dir>/<content hash>.<ext>.
// Returns the path relative to assets/.
const downloads = new Map();
function saveImage(url, dir) {
    if (!url) return Promise.resolve(null);
    const key = `${dir}|${url}`;
    if (!downloads.has(key)) {
        downloads.set(
            key,
            (async () => {
                const res = await fetch(originalUrl(url));
                if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
                const type = (res.headers.get('content-type') || '').split(';')[0];
                const ext = EXTENSIONS[type];
                if (!ext) throw new Error(`Unexpected image type "${type}" for ${url}`);
                const buf = Buffer.from(await res.arrayBuffer());
                const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
                const rel = `${dir}/${hash}${ext}`;
                fs.mkdirSync(path.join(ASSETS_DIR, dir), { recursive: true });
                fs.writeFileSync(path.join(ASSETS_DIR, rel), buf);
                return rel;
            })(),
        );
    }
    return downloads.get(key);
}

// --- Main ---

async function main() {
    const args = process.argv.slice(2);
    let driversPath = DEFAULT_DRIVERS;
    const positional = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--drivers') driversPath = args[++i];
        else positional.push(args[i]);
    }
    const base = workbookBase(positional[0] || DEFAULT_SHEET_URL);

    const drivers = JSON.parse(fs.readFileSync(driversPath, 'utf-8'));
    const byClassName = new Map(drivers.map((d) => [`${d.class}|${normalizeName(d.name)}`, d]));

    console.log(`Discovering tabs in ${base} ...`);
    const classTabs = findClassTabs(await discoverTabs(base));

    const matched = new Set();
    const unmatched = [];
    for (const tab of classTabs) {
        const [html, csv] = await Promise.all([
            fetchTabHtml(base, tab.gid),
            fetchTabCsv(base, tab.gid),
        ]);
        const entries = readClassTab(parseHtmlTable(html), csv);
        console.log(`  ${tab.name}: ${entries.length} drivers`);

        for (const e of entries) {
            const driver = byClassName.get(`${tab.classId}|${normalizeName(e.name)}`);
            if (!driver) {
                unmatched.push(`${e.name} (${tab.classId})`);
                continue;
            }
            const car = e.car && !NO_CAR.test(e.car) ? e.car : null;
            const [photo, livery] = await Promise.all([
                saveImage(e.photoUrl, PHOTO_DIR),
                saveImage(e.liveryUrl, LIVERY_DIR),
            ]);
            Object.assign(driver, {
                country: countryCode(e.country),
                number: e.number || null,
                carBrand: car ? carBrand(car) : null,
                photo,
                livery,
            });
            matched.add(driver);
        }
    }

    fs.writeFileSync(driversPath, JSON.stringify(drivers, null, 4) + '\n');
    console.log(`\nUpdated ${matched.size}/${drivers.length} drivers in ${driversPath}`);

    const images = new Set(await Promise.all(downloads.values()));
    console.log(`Stored ${images.size} unique images`);

    if (unmatched.length) {
        console.log(`${unmatched.length} sheet driver(s) not in drivers.json (skipped):`);
        for (const u of unmatched) console.log(`  - ${u}`);
    }
    const missing = drivers.filter((d) => !matched.has(d));
    if (missing.length) {
        console.log(`${missing.length} driver(s) in drivers.json not found in the sheet:`);
        for (const d of missing) console.log(`  - ${d.name} (${d.class})`);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
