/* ============================================================================
 * Mount Morris — file-system-driven listings server
 * ----------------------------------------------------------------------------
 * The client manages everything by moving lot folders between four directories
 * and editing plain .txt files. This server scans those folders on every
 * request, parses the text files into clean JSON, maps the images, and serves
 * three arrays: emptyLots, homesForRent, homesForSale.
 *
 * Design goals:
 *   - NEVER crash on bad human input. A malformed/missing file or image is
 *     logged and skipped; the rest of the site keeps working.
 *   - Folder 4 (occupied homes) is never read and never reachable via URL.
 * ========================================================================== */

const express = require('express');
const path = require('path');
const fs = require('fs/promises');

const app = express();
const PORT = process.env.PORT || 3000;

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'mount-morris-management');

/* Public categories. The `slug` is what appears in image URLs — folder 4 has
 * no slug, so its images are simply not addressable from the web. */
const CATEGORIES = [
  { key: 'emptyLots',    dir: '1_EMPTY_LOTS',     slug: 'empty', dataCat: 'lot',  needsHome: false },
  { key: 'homesForRent', dir: '2_HOMES_FOR_RENT', slug: 'rent',  dataCat: 'rent', needsHome: true  },
  { key: 'homesForSale', dir: '3_HOMES_FOR_SALE', slug: 'sale',  dataCat: 'sale', needsHome: true  },
];
const SLUG_TO_DIR = Object.fromEntries(CATEGORIES.map(c => [c.slug, c.dir]));

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const MAIN_BASENAME = 'main'; // we look for main.jpg / main.png / main.* (any image ext)

/* ------------------------------------------------------------------ helpers */

/** Read a directory's entries, returning [] instead of throwing if it's
 *  missing or unreadable (e.g. the client hasn't created it yet). */
async function safeReadDir(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[scan] could not read ${dir}: ${err.message}`);
    return [];
  }
}

/**
 * Parse a key:value text file into an ordered list of { label, value } pairs
 * plus a lookup map keyed by a normalized version of the label.
 *
 * Robust against: missing file, BOM, CRLF, blank lines, comment lines (#),
 * lines without a colon, values that themselves contain colons (only the
 * FIRST colon splits), and stray surrounding whitespace.
 */
async function parseKeyValueFile(filePath) {
  let text;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[parse] could not read ${filePath}: ${err.message}`);
    return { ordered: [], map: {} };
  }

  const ordered = [];
  const map = {};

  for (let rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^﻿/, '').trim(); // strip BOM + whitespace
    if (!line || line.startsWith('#')) continue;        // skip blanks + comments

    const idx = line.indexOf(':');
    if (idx === -1) continue;                            // not a key:value line

    const label = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();

    // Treat a lone "$" (from the blank template) or a dash as "no value given".
    if (value === '$' || value === '-' || value === '—') value = '';
    if (!label) continue;

    ordered.push({ label, value });
    map[normalizeKey(label)] = value;
  }

  return { ordered, map };
}

/** "Base Lot Rent ($)" -> "baselotrent" so lookups survive punctuation drift. */
function normalizeKey(label) {
  return label.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** First non-empty value among the given normalized-key aliases. */
function pick(map, ...aliases) {
  for (const a of aliases) {
    const v = map[a];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

/** Collect image files from a lot folder and pick the main thumbnail.
 *  main.* wins; otherwise the first image alphabetically; otherwise null. */
async function mapImages(lotPath, slug, folder) {
  const entries = await safeReadDir(lotPath);
  const images = entries
    .filter(e => e.isFile() && IMAGE_EXTS.has(path.extname(e.name).toLowerCase()))
    .map(e => e.name)
    .sort((a, b) => a.localeCompare(b));

  if (images.length === 0) {
    return { mainImage: null, gallery: [] }; // frontend draws a placeholder
  }

  const mainName =
    images.find(n => path.parse(n).name.toLowerCase() === MAIN_BASENAME) || images[0];

  // main image first, then the rest, as web-addressable URLs
  const ordered = [mainName, ...images.filter(n => n !== mainName)];
  const toUrl = (name) =>
    `/listings/${slug}/${encodeURIComponent(folder)}/${encodeURIComponent(name)}`;

  return { mainImage: toUrl(mainName), gallery: ordered.map(toUrl) };
}

/* --------------------------------------------------------- listing shaping */

/** Format a price string defensively. Adds a leading "$" for plain numbers. */
function formatPrice(raw) {
  let v = (raw || '').trim();
  if (!v) return 'Contact us';
  const hadDollar = v.startsWith('$');
  if (hadDollar) v = v.slice(1).trim();
  // Plain number (commas optional in the file) -> grouped with "$".
  if (/^\d[\d,]*(\.\d+)?$/.test(v)) {
    const [whole, frac] = v.replace(/,/g, '').split('.');
    const grouped = Number(whole).toLocaleString('en-US');
    return '$' + grouped + (frac ? '.' + frac : '');
  }
  return hadDollar ? '$' + v : v; // already-formatted or non-numeric, leave as typed
}

/** Add thousands separators to a plain number (e.g. "1180" -> "1,180").
 *  Leaves anything non-numeric untouched. */
function groupNumber(value) {
  const s = String(value).trim();
  if (!/^\d[\d,]*(\.\d+)?$/.test(s)) return s;
  const [whole, frac] = s.replace(/,/g, '').split('.');
  return Number(whole).toLocaleString('en-US') + (frac ? '.' + frac : '');
}

/** Build the card "specs" row (max 3 chips) for a home. */
function homeSpecs(home) {
  const out = [];
  const beds = pick(home, 'bedrooms', 'beds');
  const baths = pick(home, 'bathrooms', 'baths');
  const sqft = pick(home, 'squarefeet', 'sqft', 'squarefootage');
  if (beds) out.push(`${beds} Bed`);
  if (baths) out.push(`${baths} Bath`);
  if (sqft) out.push(`${groupNumber(sqft)} sq ft`);
  return out;
}

/** Build the card "specs" row for a bare lot. */
function lotSpecs(site) {
  const out = [];
  const area = pick(site, 'totallotareasqft', 'totallotarea', 'lotarea');
  const width = pick(site, 'maxhomewidth');
  const foundation = pick(site, 'foundationpadtype', 'foundation');
  if (area) out.push(`${groupNumber(area)} sq ft lot`);
  if (width) out.push(`Up to ${width} wide`);
  if (foundation) out.push(foundation);
  return out.slice(0, 3);
}

/** Turn one lot folder into a clean listing object for the frontend. */
async function buildListing(category, folder) {
  const lotPath = path.join(DATA_DIR, category.dir, folder);

  const site = await parseKeyValueFile(path.join(lotPath, 'site_info.txt'));
  const home = category.needsHome
    ? await parseKeyValueFile(path.join(lotPath, 'home_details.txt'))
    : { ordered: [], map: {} };

  const { mainImage, gallery } = await mapImages(lotPath, category.slug, folder);

  // Lot number falls back to the folder name so a card is never anonymous.
  const lotNumber =
    pick(site.map, 'lotnumber', 'lot') || folder.replace(/[_-]+/g, ' ').trim();

  // Badge + headline copy depend on the category (and, for sales, Deal Type).
  let badgeText, badgeClass, title, price, priceSmall, specs;

  if (!category.needsHome) {
    badgeText = 'Open Lot';
    badgeClass = 'b-lot';
    title = `Open Homesite · Lot ${lotNumber}`;
    const rent = pick(site.map, 'baselotrent', 'lotrent');
    price = rent ? formatPrice(rent) : 'Bring your home';
    priceSmall = rent ? ' / mo lot rent' : '';
    specs = lotSpecs(site.map);
  } else {
    const dealType = pick(home.map, 'dealtype').toLowerCase();
    const model = pick(home.map, 'homemodel', 'model');
    const maker = pick(home.map, 'homemanufacturer', 'manufacturer');
    const name = [maker, model].filter(Boolean).join(' ') || `Home`;
    title = `${name} · Lot ${lotNumber}`;
    specs = homeSpecs(home.map);
    price = formatPrice(pick(home.map, 'price'));

    if (category.slug === 'rent') {
      badgeText = 'For Rent';
      badgeClass = 'b-rent';
      priceSmall = ' / month';
    } else {
      const isNew = /\bnew\b/.test(dealType);
      badgeText = isNew ? 'Brand New' : 'Pre-Owned';
      badgeClass = isNew ? 'b-new' : 'b-used';
      priceSmall = '';
    }
  }

  // Ordered details for the modal: everything the client typed, blanks dropped.
  const details = [...site.ordered, ...home.ordered].filter(d => d.value !== '');

  return {
    id: `${category.slug}-${folder}`,
    category: category.key,
    dataCat: category.dataCat,
    lotNumber,
    title,
    badgeText,
    badgeClass,
    price,
    priceSmall,
    specs,
    mainImage,
    gallery,
    details,
  };
}

/** Scan one category directory into an array of listings. */
async function scanCategory(category) {
  const entries = await safeReadDir(path.join(DATA_DIR, category.dir));
  const folders = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'));

  const listings = await Promise.all(
    folders.map(async (f) => {
      try {
        return await buildListing(category, f.name);
      } catch (err) {
        // One bad folder must never take down the whole feed.
        console.warn(`[build] skipping ${category.dir}/${f.name}: ${err.message}`);
        return null;
      }
    })
  );

  return listings
    .filter(Boolean)
    .sort((a, b) => String(a.lotNumber).localeCompare(String(b.lotNumber), undefined, { numeric: true }));
}

/* ------------------------------------------------------------------ routes */

// Consolidated data endpoint — one fetch gives the frontend everything.
app.get('/api/listings', async (req, res) => {
  try {
    const [emptyLots, homesForRent, homesForSale] = await Promise.all(
      CATEGORIES.map(scanCategory)
    );
    res.set('Cache-Control', 'no-store'); // always reflect the live folders
    res.json({
      generatedAt: new Date().toISOString(),
      counts: {
        emptyLots: emptyLots.length,
        homesForRent: homesForRent.length,
        homesForSale: homesForSale.length,
      },
      emptyLots,
      homesForRent,
      homesForSale,
    });
  } catch (err) {
    console.error('[api] /api/listings failed:', err);
    // Even on total failure, hand back empty arrays so the UI degrades nicely.
    res.status(200).json({
      generatedAt: new Date().toISOString(),
      error: 'Could not read listings right now.',
      emptyLots: [], homesForRent: [], homesForSale: [],
    });
  }
});

// Image server — only the three public categories are reachable, and folder
// names are sanitized so "../" can't escape the data directory.
app.get('/listings/:slug/:folder/:file', async (req, res) => {
  const { slug, folder, file } = req.params;
  const dir = SLUG_TO_DIR[slug];
  if (!dir) return res.status(404).end();

  if (path.extname(file).toLowerCase() && !IMAGE_EXTS.has(path.extname(file).toLowerCase())) {
    return res.status(404).end();
  }

  const target = path.normalize(path.join(DATA_DIR, dir, folder, file));
  const base = path.normalize(path.join(DATA_DIR, dir));
  if (!target.startsWith(base + path.sep)) return res.status(403).end(); // traversal guard

  res.sendFile(target, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

// Serve the homepage. We deliberately do NOT expose the whole project root as
// static (that would leak the management folder); index.html is served on its own.
app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));

app.listen(PORT, () => {
  console.log(`\n  Mount Morris site running:  http://localhost:${PORT}\n`);
  console.log(`  Listings API:               http://localhost:${PORT}/api/listings`);
  console.log(`  Editing data here:          ${DATA_DIR}\n`);
});

