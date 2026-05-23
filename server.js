/**
 * PokéProfit API Server  (v3 — cloud-ready)
 * ─────────────────────────────────────────────────────────────────────────────
 * Deployment: push this folder to GitHub, then connect to Render.com.
 *   render.yaml in this folder handles all configuration automatically.
 *   Your live API URL will be: https://pokeprofit-server.onrender.com
 *
 * Local dev: double-click start.bat  (or: npm install && npm start)
 *
 * Data source: TCGCSV.com — public TCGPlayer price CSVs, no API key needed.
 *
 * Why a server instead of fetching from the browser?
 *   Browsers enforce CORS — they block requests to external domains unless
 *   that domain explicitly allows it. TCGCSV does not, so any browser-direct
 *   fetch gets a 403. A server has no such restriction: it fetches TCGCSV
 *   privately on its own network, then returns clean JSON to the browser.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express      = require('express');
const cors         = require('cors');
const axios        = require('axios');
const { parse }    = require('csv-parse/sync');
const rateLimit    = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── CORS ──────────────────────────────────────────────────────────────────────
// In production set ALLOWED_ORIGINS to your actual domain(s).
// In development or with ALLOWED_ORIGINS=* all origins are accepted.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
app.use(cors({
  origin: allowedOrigins.includes('*') ? '*' : (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) cb(null, true);
    else cb(new Error(`Origin ${origin} not allowed`));
  },
}));

app.use(express.json());

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Prevents abuse without affecting normal usage.
// /api/ev is rate-limited more strictly since it triggers external fetches.
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max: 120,              // 120 requests/min globally
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests — please wait a moment.' },
});

const evLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,               // 20 EV fetches/min per IP (each fetch hits TCGCSV)
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'EV fetch rate limit reached — please wait 60 seconds.' },
});

app.use(globalLimiter);

// ── TCGCSV base URL ───────────────────────────────────────────────────────────
const TCGCSV = 'https://tcgcsv.com/tcgplayer/3';

// ── In-memory cache ───────────────────────────────────────────────────────────
// Because each TCGCSV fetch can be slow (~1–2 seconds), we cache aggressively.
// Prices are cached for 6 hours — accurate enough for investment decisions.
let groupsCache    = null;
let groupsCachedAt = 0;
const GROUP_TTL    = 60 * 60 * 1000;       // 1 hour
const SET_TTL      = 6 * 60 * 60 * 1000;   // 6 hours
const setCache     = {};

// ── CSV fetch + parse ─────────────────────────────────────────────────────────
async function fetchCSV(url) {
  const res = await axios.get(url, {
    headers: { 'User-Agent': 'PokéProfit-API/3.0' },
    timeout: 20000,
  });
  return parse(res.data, { columns: true, skip_empty_lines: true, trim: true });
}

async function getGroups() {
  if (groupsCache && Date.now() - groupsCachedAt < GROUP_TTL) return groupsCache;
  console.log('📥  Refreshing set list from TCGCSV…');
  groupsCache    = await fetchCSV(`${TCGCSV}/groups`);
  groupsCachedAt = Date.now();
  console.log(`✅  ${groupsCache.length} sets loaded.`);
  return groupsCache;
}

async function getSetData(groupId) {
  const entry = setCache[groupId];
  if (entry && Date.now() - entry.cachedAt < SET_TTL) return entry;
  console.log(`📥  Fetching card data for group ${groupId}…`);
  const [products, prices] = await Promise.all([
    fetchCSV(`${TCGCSV}/${groupId}/products`),
    fetchCSV(`${TCGCSV}/${groupId}/prices`),
  ]);
  const data = { products, prices, cachedAt: Date.now() };
  setCache[groupId] = data;
  console.log(`✅  ${products.length} products, ${prices.length} price rows.`);
  return data;
}

// ── Known set aliases ─────────────────────────────────────────────────────────
const SET_ALIASES = {
  prismatic: 'Prismatic Evolutions',
  surging:   'Surging Sparks',
  stellar:   'Stellar Crown',
  twilight:  'Twilight Masquerade',
  paldea:    'Paldea Evolved',
};

// ── Pull rates by rarity ──────────────────────────────────────────────────────
// Total expected cards of each rarity per pack across the whole set.
// Per-card probability = PULL_RATES[rarity] / count_of_that_rarity_in_set
const PULL_RATES = {
  'Common':                       4.50,
  'Uncommon':                     3.00,
  'Rare':                         0.60,
  'Rare Holo':                    0.35,
  'Rare Holo ex':                 0.20,
  'Rare Holo V':                  0.20,
  'Rare Holo VMAX':               0.12,
  'Rare Holo VSTAR':              0.12,
  'Double Rare':                  0.20,
  'Rare Ultra':                   0.10,
  'Ultra Rare':                   0.10,
  'Trainer Gallery Rare Holo':    0.08,
  'Illustration Rare':            0.075,
  'Rare Rainbow':                 0.06,
  'Special Illustration Rare':    0.033,
  'Rare Secret':                  0.033,
  'Hyper Rare':                   0.015,
  'Rare Shining':                 0.015,
  'ACE SPEC Rare':                0.056,
  'Promo':                        0.00,
};
const DEFAULT_PULL_RATE = 0.05;

function getRarity(row) {
  if (row['Rarity'])   return row['Rarity'];
  if (row['rarity'])   return row['rarity'];
  const raw = row['extendedData'] || row['ExtendedData'] || '';
  if (raw) {
    try {
      const arr   = JSON.parse(raw);
      const entry = arr.find(e => e.name === 'Rarity' || e.Name === 'Rarity');
      if (entry) return (entry.value || entry.Value || '').trim();
    } catch { /* not JSON */ }
    const m = raw.match(/Rarity[:\s]+([^|,\n"]+)/i);
    if (m) return m[1].trim();
  }
  return null;
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({
    status:    'ok',
    message:   'PokéProfit API is running ✅',
    version:   '3.0',
    cacheInfo: {
      groupsCached:    !!groupsCache,
      setCacheEntries: Object.keys(setCache).length,
    },
  });
});

app.get('/api/sets', async (_req, res) => {
  try {
    const groups = await getGroups();
    const sets = groups
      .map(g => ({ id: g.groupId, name: g.name, publishedOn: g.publishedOn }))
      .sort((a, b) => new Date(b.publishedOn || 0) - new Date(a.publishedOn || 0));
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ success: true, sets });
  } catch (err) {
    console.error('Error fetching sets:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/ev?set=prismatic  OR  ?name=Surging+Sparks
app.get('/api/ev', evLimiter, async (req, res) => {
  const setKey  = req.query.set;
  const setName = SET_ALIASES[setKey] || req.query.name;

  if (!setName) {
    return res.status(400).json({
      success: false,
      error: 'Provide ?set=<key> or ?name=<set name>. Use /api/sets to browse.',
    });
  }

  try {
    console.log(`\n🔍  EV request for: "${setName}" (from ${req.ip})`);
    const groups = await getGroups();
    const group  =
      groups.find(g => g.name?.toLowerCase() === setName.toLowerCase()) ||
      groups.find(g => g.name?.toLowerCase().includes(setName.toLowerCase())) ||
      groups.find(g => setName.toLowerCase().includes((g.name || '').toLowerCase()));

    if (!group) {
      return res.status(404).json({
        success: false,
        error: `Set "${setName}" not found. Use /api/sets to browse available sets.`,
      });
    }

    const { products, prices } = await getSetData(group.groupId);

    // Price map: productId → best market price
    const priceMap = {};
    for (const row of prices) {
      const id = row.productId;
      const mp = parseFloat(row.marketPrice) || parseFloat(row.midPrice) || 0;
      if (!priceMap[id] || mp > priceMap[id]) priceMap[id] = mp;
    }

    // Count priced cards per rarity
    const rarityCount = {};
    for (const card of products) {
      if (!(priceMap[card.productId] > 0)) continue;
      const r = getRarity(card) || '__unknown__';
      rarityCount[r] = (rarityCount[r] || 0) + 1;
    }

    // EV = Σ (tierRate / countOfRarity) × price
    let ev = 0, included = 0, skipped = 0;
    const breakdown = {};

    for (const card of products) {
      const price = priceMap[card.productId] || 0;
      if (!price) { skipped++; continue; }
      const rarity      = getRarity(card) || '__unknown__';
      const tierRate    = PULL_RATES[rarity] ?? DEFAULT_PULL_RATE;
      const cardProb    = tierRate / (rarityCount[rarity] || 1);
      const contribution = cardProb * price;
      ev += contribution;
      included++;
      if (!breakdown[rarity]) {
        breakdown[rarity] = { count: 0, tierRate, cardProbability: +cardProb.toFixed(5), totalContribution: 0 };
      }
      breakdown[rarity].count++;
      breakdown[rarity].totalContribution += contribution;
    }

    ev = Math.round(ev * 100) / 100;
    console.log(`✅  EV = $${ev}/pack (${included} cards)\n`);

    // Cache response at the CDN/browser level for 6 hours
    res.set('Cache-Control', 'public, max-age=21600');
    res.json({
      success:   true,
      setName:   group.name,
      groupId:   group.groupId,
      ev,
      cardCount: included,
      skipped,
      breakdown,
      fetchedAt: new Date().toISOString(),
      source:    'TCGCSV / TCGPlayer market prices',
    });

  } catch (err) {
    const msg = err.response
      ? `TCGCSV returned ${err.response.status} — ${err.response.statusText}`
      : err.message;
    console.error('Error:', msg);
    res.status(502).json({ success: false, error: msg });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🟡  PokéProfit API running at http://localhost:${PORT}`);
  if (process.env.NODE_ENV === 'production') {
    console.log(`    Running in production mode`);
    console.log(`    Allowed origins: ${allowedOrigins.join(', ')}`);
  }
  console.log();
});

module.exports = app;
