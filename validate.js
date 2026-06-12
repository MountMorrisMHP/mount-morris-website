/* ============================================================================
 * Listing-data validator.
 * ----------------------------------------------------------------------------
 * Scans the same folders 1-3 as build.js and checks each .txt field against
 * simple rules, so malformed data can never reach production. It does NOT
 * change the .txt format and does NOT convert anything to JSON — it only reads.
 *
 * Philosophy: EMPTY values are always allowed (the site handles them). We only
 * flag values that are FILLED IN but clearly wrong (e.g. a price of "abc").
 *
 * Exit code 0 = all good (warnings are OK). Exit code 1 = at least one error.
 * Errors are written in plain English a non-technical person can act on.
 * ========================================================================== */

const fs = require('fs/promises');
const path = require('path');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'mount-morris-management');

// Same three public categories as build.js. 0_TEMPLATES and 4_OCCUPIED_HOMES
// are intentionally not scanned.
const CATEGORIES = [
  { dir: '1_EMPTY_LOTS',     needsHome: false, isSale: false },
  { dir: '2_HOMES_FOR_RENT', needsHome: true,  isSale: false },
  { dir: '3_HOMES_FOR_SALE', needsHome: true,  isSale: true  },
];

const errors = [];
const warnings = [];

function normalizeKey(label) {
  return label.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// --- value checkers -------------------------------------------------------
// Money: a plain number; a leading "$" and thousands commas are allowed.
function isMoney(v) {
  return /^\d+(\.\d+)?$/.test(v.replace(/\$/g, '').replace(/,/g, '').trim());
}
// Plain number; thousands commas allowed (e.g. 1,280). Decimals allowed (2.5).
function isNumber(v) {
  return /^\d+(\.\d+)?$/.test(v.replace(/,/g, '').trim());
}
// A measurement: a number, optionally followed by a unit like "ft".
function isDimension(v) {
  return /^\d+(\.\d+)?\s*(ft|feet|')?$/i.test(v.replace(/,/g, '').trim());
}

// Which fields get checked, keyed by the normalized label. Anything not listed
// here is treated as free text (no rules — type whatever you like).
const RULES = {
  baselotrent:      { check: isMoney,     name: 'lot rent',        example: '450' },
  price:            { check: isMoney,     name: 'price',           example: '1250' },
  bedrooms:         { check: isNumber,    name: 'bedrooms',        example: '3' },
  bathrooms:        { check: isNumber,    name: 'bathrooms',       example: '2 or 2.5' },
  squarefeet:       { check: isNumber,    name: 'square feet',     example: '1280' },
  totallotareasqft: { check: isNumber,    name: 'lot area',        example: '5400' },
  totallotarea:     { check: isNumber,    name: 'lot area',        example: '5400' },
  parkingspaces:    { check: isNumber,    name: 'parking spaces',  example: '2' },
  maxhomewidth:     { check: isDimension, name: 'max home width',  example: '16 (or 16 ft)' },
  maxhomelengthft:  { check: isDimension, name: 'max home length', example: '80' },
  maxhomelength:    { check: isDimension, name: 'max home length', example: '80' },
};

async function safeReadDir(dir) {
  try { return await fs.readdir(dir, { withFileTypes: true }); }
  catch (e) {
    if (e.code !== 'ENOENT') console.warn(`Could not read ${dir}: ${e.message}`);
    return [];
  }
}

/** Parse a .txt into [{label, value, lineNo, key}], or null if the file is missing. */
async function parseFields(filePath) {
  let text;
  try { text = await fs.readFile(filePath, 'utf8'); }
  catch (e) { return null; }

  const out = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/^﻿/, '').trim();
    if (!line || line.startsWith('#')) return;
    const idx = line.indexOf(':');
    if (idx === -1) return;
    const label = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value === '$' || value === '-' || value === '—') value = ''; // blank template leftovers
    if (!label) return;
    out.push({ label, value, lineNo: i + 1, key: normalizeKey(label) });
  });
  return out;
}

/** Check every filled-in field in one file against its rule. */
function checkFields(relPath, fields) {
  for (const f of fields) {
    if (f.value === '') continue;          // empty is always fine
    const rule = RULES[f.key];
    if (!rule) continue;                   // free-text field
    if (!rule.check(f.value)) {
      errors.push(
        `ERROR in ${relPath} (line ${f.lineNo}): "${f.label}: ${f.value}" — ` +
        `${rule.name} must be a number, like ${rule.example}.`
      );
    }
  }
}

async function main() {
  let lotCount = 0;

  for (const cat of CATEGORIES) {
    const entries = await safeReadDir(path.join(DATA_DIR, cat.dir));
    const folders = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'));

    for (const folder of folders) {
      lotCount++;
      const lotRel = `${cat.dir}/${folder.name}`;
      const lotPath = path.join(DATA_DIR, cat.dir, folder.name);

      // site_info.txt — and the Lot Number must be present.
      const site = await parseFields(path.join(lotPath, 'site_info.txt'));
      if (site === null) {
        errors.push(`ERROR in ${lotRel}: missing site_info.txt — every lot needs one (copy it from 0_TEMPLATES/copy-me).`);
      } else {
        checkFields(`${lotRel}/site_info.txt`, site);
        const lotNo = site.find(f => f.key === 'lotnumber');
        if (!lotNo || lotNo.value === '') {
          errors.push(`ERROR in ${lotRel}/site_info.txt: missing Lot Number — every lot needs a Lot Number, like 5.`);
        }
      }

      // home_details.txt — only for rent/sale, and only validated if present.
      if (cat.needsHome) {
        const home = await parseFields(path.join(lotPath, 'home_details.txt'));
        if (home !== null) {
          checkFields(`${lotRel}/home_details.txt`, home);
          if (cat.isSale) {
            const deal = home.find(f => f.key === 'dealtype');
            if (deal && deal.value && !/^(new|pre\s*-?\s*owned)$/i.test(deal.value)) {
              warnings.push(
                `WARNING in ${lotRel}/home_details.txt (line ${deal.lineNo}): "Deal Type: ${deal.value}" — ` +
                `this is usually "New" or "Pre-Owned" (it sets the badge shown on the site).`
              );
            }
          }
        }
      }
    }
  }

  // --- Community amenities: everything is free text, but "Order:" must be numeric if filled.
  const AMEN_DIR = path.join(DATA_DIR, 'community', 'amenities');
  const amenEntries = await safeReadDir(AMEN_DIR);
  let amenityCount = 0;
  for (const folder of amenEntries.filter(e => e.isDirectory() && !e.name.startsWith('.'))) {
    const info = await parseFields(path.join(AMEN_DIR, folder.name, 'info.txt'));
    if (info === null) continue;          // a photos-only amenity (no info.txt) is fine
    amenityCount++;
    const order = info.find(f => f.key === 'order');
    if (order && order.value && !/^-?\d+(\.\d+)?$/.test(order.value)) {
      errors.push(
        `ERROR in community/amenities/${folder.name}/info.txt (line ${order.lineNo}): "Order: ${order.value}" — ` +
        `Order must be a number, like 1, 2 or 3 (it sets where this amenity appears).`
      );
    }
  }

  if (warnings.length) {
    console.log('\nWarnings (these do NOT block publishing):');
    warnings.forEach(w => console.log('  ' + w));
  }

  if (errors.length) {
    console.error(`\nFound ${errors.length} problem(s) in the listing data:\n`);
    errors.forEach(e => console.error('  ' + e));
    console.error('\nPlease fix the file(s) above and commit again. Remember: blank values are fine — only filled-in values that look wrong are flagged.\n');
    process.exit(1);
  }

  console.log(`\nAll data looks good — checked ${lotCount} lot(s) and ${amenityCount} amenity file(s), no problems found.`);
}

main().catch((err) => {
  console.error('validate.js crashed:', err);
  process.exit(1);
});
