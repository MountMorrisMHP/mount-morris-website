/* ============================================================================
 * Static-site build for GitHub Pages.
 * ----------------------------------------------------------------------------
 * GitHub Pages can't run server.js, so this script does the same scanning and
 * parsing at BUILD time and writes a static site into ./dist :
 *
 *   dist/index.html        — the homepage (copied as-is)
 *   dist/listings.json     — the data the page fetches (same shape as the API)
 *   dist/listings/<slug>/<folder>/<file>  — copied images (folders 1-3 only)
 *
 * IMPORTANT: only the three public categories are scanned. Nothing from
 * 4_OCCUPIED_HOMES or 0_TEMPLATES is ever parsed, copied, or published, so
 * occupied-resident data and blank templates never reach the public site.
 *
 * The parsing logic here mirrors server.js exactly (kept separate so server.js
 * stays untouched for local testing). Pure Node — no dependencies.
 * ========================================================================== */

const fs = require('fs/promises');
const path = require('path');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'mount-morris-management');
const OUT_DIR = path.join(ROOT, 'dist');

/* Only public categories. 0_TEMPLATES and 4_OCCUPIED_HOMES are intentionally
 * absent — that exclusion IS the privacy guarantee. */
const CATEGORIES = [
  { key: 'preorderHomes', dir: '1_PREORDER_HOMES', slug: 'preorder', dataCat: 'preorder', needsHome: false },
  { key: 'homesForRent', dir: '2_HOMES_FOR_RENT', slug: 'rent',  dataCat: 'rent', needsHome: true  },
  { key: 'homesForSale', dir: '3_HOMES_FOR_SALE', slug: 'sale',  dataCat: 'sale', needsHome: true  },
];

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg']);
const MAIN_BASENAME = 'main';

/* ------------------------------------------------------------------ helpers */

async function safeReadDir(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[scan] could not read ${dir}: ${err.message}`);
    return [];
  }
}

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
    const line = rawLine.replace(/^﻿/, '').trim();
    if (!line || line.startsWith('#')) continue;

    const idx = line.indexOf(':');
    if (idx === -1) continue;

    const label = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value === '$' || value === '-' || value === '—') value = '';
    if (!label) continue;

    ordered.push({ label, value });
    map[normalizeKey(label)] = value;
  }

  return { ordered, map };
}

function normalizeKey(label) {
  return label.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function pick(map, ...aliases) {
  for (const a of aliases) {
    const v = map[a];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

/** Collect a lot's images, COPY them into dist, and return relative URLs. */
/* tour-*.jpg files are legacy panorama images; keep them out of the flat gallery. */
const TOUR_RE = /^tour[-_. ]/i;

async function mapImages(lotPath, slug, folder) {
  const entries = await safeReadDir(lotPath);
  const images = entries
    .filter(e => e.isFile() && IMAGE_EXTS.has(path.extname(e.name).toLowerCase()) && !TOUR_RE.test(e.name))
    .map(e => e.name)
    .sort((a, b) => a.localeCompare(b));

  if (images.length === 0) return { mainImage: null, gallery: [] };

  const mainName =
    images.find(n => path.parse(n).name.toLowerCase() === MAIN_BASENAME) || images[0];
  const ordered = [mainName, ...images.filter(n => n !== mainName)];

  const destDir = path.join(OUT_DIR, 'listings', slug, folder);
  await fs.mkdir(destDir, { recursive: true });
  for (const name of ordered) {
    await fs.copyFile(path.join(lotPath, name), path.join(destDir, name));
  }

  // RELATIVE url (no leading slash) so it resolves under the /repo-name/ subpath.
  const toUrl = (name) =>
    `listings/${slug}/${encodeURIComponent(folder)}/${encodeURIComponent(name)}`;

  return { mainImage: toUrl(mainName), gallery: ordered.map(toUrl) };
}

/* --------------------------------------------------------- listing shaping */

/** Parse a money-ish value ("$1,250", "483.50") to a Number, or null if absent
 *  or not numeric. Used to total a rental's home rent + base lot rent. */
function moneyValue(raw) {
  const v = (raw || '').trim().replace(/^\$/, '').replace(/,/g, '');
  return /^\d+(\.\d+)?$/.test(v) ? Number(v) : null;
}

/** Format a Number as $X,XXX or $X,XXX.XX (cents only when they're non-zero). */
function formatMoney(n) {
  return '$' + n.toLocaleString('en-US', {
    minimumFractionDigits: n % 1 ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

function formatPrice(raw) {
  let v = (raw || '').trim();
  if (!v) return 'Contact us';
  const hadDollar = v.startsWith('$');
  if (hadDollar) v = v.slice(1).trim();
  if (/^\d[\d,]*(\.\d+)?$/.test(v)) {
    const [whole, frac] = v.replace(/,/g, '').split('.');
    return '$' + Number(whole).toLocaleString('en-US') + (frac ? '.' + frac : '');
  }
  return hadDollar ? '$' + v : v;
}

function groupNumber(value) {
  const s = String(value).trim();
  if (!/^\d[\d,]*(\.\d+)?$/.test(s)) return s;
  const [whole, frac] = s.replace(/,/g, '').split('.');
  return Number(whole).toLocaleString('en-US') + (frac ? '.' + frac : '');
}

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

async function buildListing(category, folder) {
  const lotPath = path.join(DATA_DIR, category.dir, folder);

  const site = await parseKeyValueFile(path.join(lotPath, 'site_info.txt'));
  const home = category.needsHome
    ? await parseKeyValueFile(path.join(lotPath, 'home_details.txt'))
    : { ordered: [], map: {} };

  const { mainImage, gallery } = await mapImages(lotPath, category.slug, folder);

  const lotNumber =
    pick(site.map, 'lotnumber', 'lot') || folder.replace(/[_-]+/g, ' ').trim();

  let badgeText, badgeClass, title, price, priceSmall, specs, priceNote = '';

  if (!category.needsHome) {
    badgeText = 'Pre-Order';
    badgeClass = 'b-preorder';
    title = `Pre-Order Your New Home · Lot ${lotNumber}`;
    const rent = pick(site.map, 'baselotrent', 'lotrent');
    price = rent ? formatPrice(rent) : 'Pre-order your new home';
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
      // The headline is the TOTAL monthly cost: home rent + base lot rent.
      // Fail safe: if either side is missing or non-numeric, show whatever
      // exists on its own rather than a misleading total or $0.
      const homeRent = moneyValue(pick(home.map, 'price'));
      const lotRent = moneyValue(pick(site.map, 'baselotrent', 'lotrent'));
      if (homeRent !== null && lotRent !== null) {
        price = formatMoney(homeRent + lotRent);
        priceNote = `${formatMoney(homeRent)} home + ${formatMoney(lotRent)} lot rent`;
      } else if (homeRent === null && lotRent !== null) {
        price = formatMoney(lotRent);
      }
      // else: keep the formatPrice(price) already computed above.
    } else {
      const isNew = /\bnew\b/.test(dealType);
      badgeText = isNew ? 'Brand New' : 'Pre-Owned';
      badgeClass = isNew ? 'b-new' : 'b-used';
      priceSmall = '';
    }
  }

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
    priceNote,   // rentals only: "$483.50 home + $550 lot rent" ('' when not applicable)
    specs,
    mainImage,
    gallery,
    details,
  };
}

async function scanCategory(category) {
  const entries = await safeReadDir(path.join(DATA_DIR, category.dir));
  const folders = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'));

  const listings = await Promise.all(
    folders.map(async (f) => {
      try {
        return await buildListing(category, f.name);
      } catch (err) {
        console.warn(`[build] skipping ${category.dir}/${f.name}: ${err.message}`);
        return null;
      }
    })
  );

  return listings
    .filter(Boolean)
    .sort((a, b) => String(a.lotNumber).localeCompare(String(b.lotNumber), undefined, { numeric: true }));
}

/* ---------------------------------------------------- community & amenities */

const COMMUNITY_DIR = path.join(DATA_DIR, 'community');
const AMENITIES_DIR = path.join(COMMUNITY_DIR, 'amenities');
const SCENERY_DIR   = path.join(COMMUNITY_DIR, 'general_scenery');
const FAQS_DIR      = path.join(COMMUNITY_DIR, 'faqs');

/** "pet_friendly" -> "Pet Friendly" (fallback display name from a folder). */
function titleCase(name) {
  return name.replace(/[_-]+/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase());
}

/** Copy images from a community subfolder into dist; return relative URLs (main first). */
async function copyCommunityImages(srcDir, destSubdir, urlPrefix) {
  const entries = await safeReadDir(srcDir);
  const images = entries
    .filter(e => e.isFile() && IMAGE_EXTS.has(path.extname(e.name).toLowerCase()))
    .map(e => e.name)
    .sort((a, b) => a.localeCompare(b));
  if (images.length === 0) return [];

  const mainName = images.find(n => path.parse(n).name.toLowerCase() === MAIN_BASENAME) || images[0];
  const ordered = [mainName, ...images.filter(n => n !== mainName)];

  const destDir = path.join(OUT_DIR, destSubdir);
  await fs.mkdir(destDir, { recursive: true });
  for (const name of ordered) await fs.copyFile(path.join(srcDir, name), path.join(destDir, name));

  return ordered.map(name => `${urlPrefix}/${encodeURIComponent(name)}`);
}

async function buildAmenity(folder) {
  const dir = path.join(AMENITIES_DIR, folder);

  let infoExists = false;
  try { await fs.access(path.join(dir, 'info.txt')); infoExists = true; } catch (_) {}
  const info = await parseKeyValueFile(path.join(dir, 'info.txt'));

  const gallery = await copyCommunityImages(
    dir,
    path.join('community', 'amenities', folder),
    `community/amenities/${encodeURIComponent(folder)}`
  );

  // Empty state: neither an info.txt nor any photos -> don't render this amenity.
  if (!infoExists && gallery.length === 0) return null;

  const orderRaw = pick(info.map, 'order');
  const order = /^-?\d+(\.\d+)?$/.test(orderRaw) ? parseFloat(orderRaw) : Number.POSITIVE_INFINITY;
  // "Coming Soon: yes" -> show the card but mark it not-yet-available.
  const comingSoon = /^(yes|true|1)$/i.test(pick(info.map, 'comingsoon').trim());
  // Display Name / Order / Coming Soon are control fields, not shown in the details list.
  const details = info.ordered.filter(
    d => d.value !== '' && !['displayname', 'name', 'order', 'comingsoon'].includes(normalizeKey(d.label))
  );

  return {
    id: folder,
    displayName: pick(info.map, 'displayname', 'name') || titleCase(folder),
    order,
    comingSoon,
    details,
    mainImage: gallery[0] || null,
    gallery,
  };
}

/** Find community/map.{jpg,jpeg,png,webp}; copy it into dist and return its URL, or null. */
async function copyCommunityMap() {
  for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
    const src = path.join(COMMUNITY_DIR, `map.${ext}`);
    try { await fs.access(src); } catch (_) { continue; }
    const destDir = path.join(OUT_DIR, 'community');
    await fs.mkdir(destDir, { recursive: true });
    await fs.copyFile(src, path.join(destDir, `map.${ext}`));
    return `community/map.${ext}`;
  }
  return null;
}

/** FAQs: one .txt file per Q&A in community/faqs/, each with Question / Answer /
 *  optional Order. Ordered by Order (numeric), then by file name. */
async function scanFaqs() {
  const entries = await safeReadDir(FAQS_DIR);
  const files = entries.filter(e => e.isFile() && e.name.toLowerCase().endsWith('.txt') && !e.name.startsWith('.'));

  const faqs = (await Promise.all(files.map(async f => {
    const info = await parseKeyValueFile(path.join(FAQS_DIR, f.name));
    const question = pick(info.map, 'question', 'q');
    const answer = pick(info.map, 'answer', 'a');
    // A FAQ needs both a question and an answer to render; skip anything incomplete.
    if (!question || !answer) return null;
    const orderRaw = pick(info.map, 'order');
    const order = /^-?\d+(\.\d+)?$/.test(orderRaw) ? parseFloat(orderRaw) : Number.POSITIVE_INFINITY;
    return { id: path.parse(f.name).name, question, answer, order, _file: f.name };
  }))).filter(Boolean);

  faqs.sort((a, b) => (a.order - b.order) || a._file.localeCompare(b._file));
  return faqs.map(({ _file, ...rest }) => rest);
}

async function scanCommunity() {
  const entries = await safeReadDir(AMENITIES_DIR);
  const folders = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'));

  let amenities = (await Promise.all(folders.map(async f => {
    try { return await buildAmenity(f.name); }
    catch (err) { console.warn(`[community] skipping amenity ${f.name}: ${err.message}`); return null; }
  }))).filter(Boolean);
  amenities.sort((a, b) => (a.order - b.order) || a.displayName.localeCompare(b.displayName));

  const scenery = await copyCommunityImages(SCENERY_DIR, path.join('community', 'scenery'), 'community/scenery');
  const mapImage = await copyCommunityMap();
  const faqs = await scanFaqs();

  let communityRules = '';
  try {
    const t = await fs.readFile(path.join(COMMUNITY_DIR, 'community_rules.txt'), 'utf8');
    if (t.trim()) communityRules = t.trim();
  } catch (_) {}

  return { amenities, scenery, mapImage, communityRules, faqs };
}

/* ------------------------------------------------------------------- build */

async function main() {
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUT_DIR, { recursive: true });

  const [preorderHomes, homesForRent, homesForSale] = await Promise.all(CATEGORIES.map(scanCategory));
  const community = await scanCommunity();

  // Production sets VERSION (e.g. v2026.06.11-1430); local builds default to "dev".
  const version = process.env.VERSION || 'dev';
  const builtAt = new Date().toISOString();

  const data = {
    version,
    generatedAt: builtAt,
    counts: {
      preorderHomes: preorderHomes.length,
      homesForRent: homesForRent.length,
      homesForSale: homesForSale.length,
      amenities: community.amenities.length,
      scenery: community.scenery.length,
      faqs: community.faqs.length,
    },
    preorderHomes,
    homesForRent,
    homesForSale,
    community,
  };

  await fs.writeFile(path.join(OUT_DIR, 'listings.json'), JSON.stringify(data, null, 2));
  // Standalone version stamp — handy for confirming what's actually live.
  await fs.writeFile(path.join(OUT_DIR, 'version.json'), JSON.stringify({ version, builtAt }, null, 2));
  await fs.copyFile(path.join(ROOT, 'index.html'), path.join(OUT_DIR, 'index.html'));
  await fs.writeFile(path.join(OUT_DIR, '.nojekyll'), ''); // don't let Pages run Jekyll

  console.log(
    `Built dist/ — version ${version} — ${data.counts.preorderHomes} pre-order, ${data.counts.homesForRent} rent, ${data.counts.homesForSale} sale`
  );
}

main().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
