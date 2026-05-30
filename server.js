const express   = require('express');
const cors      = require('cors');
const axios     = require('axios');
const rateLimit = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 3001;

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
app.use(cors({
  origin: allowedOrigins.includes('*') ? '*' : (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) cb(null, true);
    else cb(new Error('Origin ' + origin + ' not allowed'));
  },
}));
app.use(express.json());

const globalLimiter = rateLimit({ windowMs: 60000, max: 120, standardHeaders: true, legacyHeaders: false });
const evLimiter     = rateLimit({ windowMs: 60000, max: 20,  standardHeaders: true, legacyHeaders: false });
app.use(globalLimiter);

const TCGCSV = 'https://tcgcsv.com/tcgplayer/3';

let groupsCache = null, groupsCachedAt = 0;
const GROUP_TTL = 3600000, SET_TTL = 21600000, setCache = {};

function parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim());
  return lines.slice(1).map(line => {
    const values = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') { inQ = !inQ; }
      else if (line[i] === ',' && !inQ) { values.push(cur.trim()); cur = ''; }
      else { cur += line[i]; }
    }
    values.push(cur.trim());
    const row = {};
    headers.forEach((h, i) => { row[h] = (values[i] || '').replace(/^"|"$/g, ''); });
    return row;
  });
}

async function fetchCSV(url) {
  const res = await axios.get(url, { headers: { 'User-Agent': 'PokéProfit-API/4.0' }, timeout: 20000 });
  return parseCSV(String(res.data));
}

async function getGroups() {
  if (groupsCache && Date.now() - groupsCachedAt < GROUP_TTL) return groupsCache;
  groupsCache = await fetchCSV(TCGCSV + '/groups');
  groupsCachedAt = Date.now();
  return groupsCache;
}

async function getSetData(groupId) {
  const entry = setCache[groupId];
  if (entry && Date.now() - entry.cachedAt < SET_TTL) return entry;
  const [products, prices] = await Promise.all([
    fetchCSV(TCGCSV + '/' + groupId + '/products'),
    fetchCSV(TCGCSV + '/' + groupId + '/prices'),
  ]);
  setCache[groupId] = { products, prices, cachedAt: Date.now() };
  return setCache[groupId];
}

const SET_ALIASES = {
  prismatic: 'Prismatic Evolutions',
  surging:   'Surging Sparks',
  stellar:   'Stellar Crown',
  twilight:  'Twilight Masquerade',
  paldea:    'Paldea Evolved',
};

const RARITY_TIER = {
  'Common': 'skip', 'Uncommon': 'skip', 'Promo': 'skip',
  'Rare': 'reverse',
  'Rare Holo': 'rare', 'Rare Holo ex': 'rare', 'Rare Holo V': 'rare',
  'Rare Holo VMAX': 'rare', 'Rare Holo VSTAR': 'rare',
  'Double Rare': 'rare', 'ACE SPEC Rare': 'rare',
  'Rare Ultra': 'secret', 'Ultra Rare': 'secret',
  'Illustration Rare': 'secret', 'Trainer Gallery Rare Holo': 'secret',
  'Rare Rainbow': 'secret', 'Special Illustration Rare': 'secret',
  'Rare Secret': 'secret', 'Hyper Rare': 'secret', 'Rare Shining': 'secret',
};

const EFFECTIVE_RATES = {
  'Rare Holo': 0.772,
  'Rare Holo ex': 0.125, 'Rare Holo V': 0.125,
  'Rare Holo VMAX': 0.125, 'Rare Holo VSTAR': 0.125,
  'Double Rare': 0.125, 'ACE SPEC Rare': 0.056,
  'Ultra Rare': 0.125, 'Rare Ultra': 0.125,
  'Illustration Rare': 0.056, 'Trainer Gallery Rare Holo': 0.056,
  'Special Illustration Rare': 0.033, 'Rare Secret': 0.033, 'Rare Rainbow': 0.033,
  'Hyper Rare': 0.014, 'Rare Shining': 0.014,
  'Rare': 0,
};

function getRarity(row) {
  if (row['Rarity']) return row['Rarity'];
  if (row['rarity']) return row['rarity'];
  const raw = row['extendedData'] || row['ExtendedData'] || '';
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      const e = arr.find(x => x.name === 'Rarity' || x.Name === 'Rarity');
      if (e) return (e.value || e.Value || '').trim();
    } catch (_) {}
    const m = raw.match(/Rarity[:\s]+([^|,\n"]+)/i);
    if (m) return m[1].trim();
  }
  return null;
}

function calculateEV(products, priceMap) {
  const rarityCount = {};
  for (const card of products) {
    const price = priceMap[card.productId] || 0;
    if (!price) continue;
    const rarity = getRarity(card);
    if (!rarity) continue;
    const tier = RARITY_TIER[rarity];
    if (tier === 'skip' || !tier) continue;
    const rate = EFFECTIVE_RATES[rarity];
    if (!rate) continue;
    rarityCount[rarity] = (rarityCount[rarity] || 0) + 1;
  }

  let ev = 0, includedCards = 0, skippedCards = 0;
  const breakdown = {};

  for (const card of products) {
    const price = priceMap[card.productId] || 0;
    const rarity = getRarity(card);
    if (!rarity || !price) { skippedCards++; continue; }
    const tier = RARITY_TIER[rarity];
    if (tier === 'skip' || !tier) { skippedCards++; continue; }
    const rate = EFFECTIVE_RATES[rarity];
    if (!rate) { skippedCards++; continue; }
    const count = rarityCount[rarity] || 1;
    const cardProb = rate / count;
    const contribution = cardProb * price;
    ev += contribution;
    includedCards++;
    if (!breakdown[rarity]) {
      breakdown[rarity] = { tier, count: 0, packRate: +rate.toFixed(4), avgCardProb: +(rate/count).toFixed(5), totalContribution: 0, priceSum: 0, avgPrice: 0 };
    }
    breakdown[rarity].count++;
    breakdown[rarity].totalContribution += contribution;
    breakdown[rarity].priceSum += price;
  }

  for (const r of Object.keys(breakdown)) {
    const b = breakdown[r];
    b.avgPrice = +(b.priceSum / b.count).toFixed(2);
    b.totalContribution = +b.totalContribution.toFixed(4);
    b.avgCardProb = +(b.packRate / b.count).toFixed(5);
    delete b.priceSum;
  }

  return { ev: Math.round(ev * 100) / 100, breakdown, includedCards, skippedCards };
}

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', message: 'PokéProfit API is running', version: '4.0' });
});

app.get('/api/sets', async (_req, res) => {
  try {
    const groups = await getGroups();
    const sets = groups.map(g => ({ id: g.groupId, name: g.name, publishedOn: g.publishedOn }))
      .sort((a, b) => new Date(b.publishedOn || 0) - new Date(a.publishedOn || 0));
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ success: true, sets });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/ev', evLimiter, async (req, res) => {
  const setKey  = req.query.set;
  const setName = SET_ALIASES[setKey] || req.query.name;
  if (!setName) return res.status(400).json({ success: false, error: 'Provide ?set=<key> or ?name=<set name>' });

  try {
    const groups = await getGroups();
    const group  =
      groups.find(g => g.name && g.name.toLowerCase() === setName.toLowerCase()) ||
      groups.find(g => g.name && g.name.toLowerCase().includes(setName.toLowerCase()));

    if (!group) return res.status(404).json({ success: false, error: 'Set "' + setName + '" not found.' });

    const { products, prices } = await getSetData(group.groupId);

    const priceMap = {};
    for (const row of prices) {
      const id = row.productId;
      const mp = parseFloat(row.marketPrice) || parseFloat(row.midPrice) || 0;
      if (!priceMap[id] || mp > priceMap[id]) priceMap[id] = mp;
    }

    const { ev, breakdown, includedCards, skippedCards } = calculateEV(products, priceMap);

    res.set('Cache-Control', 'public, max-age=21600');
    res.json({
      success: true, setName: group.name, groupId: group.groupId,
      ev, cardCount: includedCards, skipped: skippedCards,
      breakdown, model: 'slot-v4',
      fetchedAt: new Date().toISOString(), source: 'TCGCSV / TCGPlayer market prices',
    });
  } catch (err) {
    const msg = err.response ? 'TCGCSV returned ' + err.response.status : err.message;
    res.status(502).json({ success: false, error: msg });
  }
});



app.get('/api/debug', async (_req, res) => {
  try {
    const axios2 = require('axios');
    const raw = await axios2.get('https://tcgcsv.com/tcgplayer/3/groups', {
      headers: { 'User-Agent': 'PokéProfit-API/4.0' }, timeout: 20000
    });
    const text = String(raw.data);
    const lines = text.split('\n').slice(0, 5);
    res.json({ success: true, firstLines: lines });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/search', async (req, res) => {
  try {
    const groups = await getGroups();
    const q = (req.query.q || '').toLowerCase();
    const matches = q
      ? groups.filter(g => g.name && g.name.toLowerCase().includes(q))
      : groups.slice(0, 50);
    res.json({ success: true, count: matches.length, sets: matches.map(g => ({ id: g.groupId, name: g.name })) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log('PokéProfit API v4 running at http://localhost:' + PORT);
});

module.exports = app;
