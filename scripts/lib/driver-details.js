/**
 * Per-driver details read from the published Google Sheet's "<CLASS> Drivers"
 * tabs, used by scripts/generate-drivers.js:
 *
 *   country  - ISO 3166-1 alpha-2 code, lowercase (e.g. "nl"). The UK home
 *              nations, which have no alpha-2 code of their own, use their
 *              ISO 3166-2 subdivision code (e.g. "gb-sct").
 *              Flags are looked up from flagcdn: https://flagcdn.com/<country>.svg
 *   number   - car number.
 *   carBrand - manufacturer (e.g. "Ferrari"), derived from the car model
 *              (e.g. "Ferrari 296 GT3").
 */

const { normalizeName, fetchTabCsv } = require('./sheets');

// Columns without a header (hidden in the sheet's own view) holding the
// country slug used to pick the flag image and the car model.
const COUNTRY_COL = 10; // K
const CAR_COL = 12; // M

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

// Read a class tab into [{ name, country, number, carBrand }], one per driver
// row in sheet order. The header row is the one containing "Driver".
async function readClassTab(base, gid) {
    const rows = await fetchTabCsv(base, gid);
    const headerIdx = rows.findIndex((r) => r.some((c) => c.trim() === 'Driver'));
    if (headerIdx === -1) throw new Error('Driver tab has no "Driver" header column');
    const header = rows[headerIdx].map((c) => c.trim());
    const nameCol = header.indexOf('Driver');
    const numberCol = header.indexOf('Number');

    const entries = [];
    for (const row of rows.slice(headerIdx + 1)) {
        const cell = (i) => (i === -1 ? '' : (row[i] || '').trim());
        const name = cell(nameCol);
        if (!name) continue;
        const car = cell(CAR_COL);
        const model = car && !NO_CAR.test(car) ? car : null;
        entries.push({
            name,
            country: countryCode(cell(COUNTRY_COL)),
            number: cell(numberCol) || null,
            carBrand: model ? carBrand(model) : null,
        });
    }
    return entries;
}

module.exports = { readClassTab };
