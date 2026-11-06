#!/usr/bin/env node
// Fetches graded (PSA / CGC / BGS …) market prices from the Pokemon Price Tracker API
// (https://www.pokemonpricetracker.com, eBay sold listings) into data/graded.json.
//
// Needs a free API key in the PPT_API_KEY environment variable (a GitHub Actions secret).
// The free plan allows ~100 credits a day and each card with graded data costs 2, so each run
// refreshes ~45 cards: the most valuable cards that have no graded prices yet first, then the
// ones whose prices are oldest. Run daily and coverage grows over time.
//
//   PPT_API_KEY=... node scripts/fetch-graded.mjs [--cards=45]

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(DATA, 'graded.json');
const KEY = process.env.PPT_API_KEY;
const API = 'https://www.pokemonpricetracker.com/api/v2/cards';
const LIMIT = Number((process.argv.find((a) => a.startsWith('--cards=')) || '--cards=45').slice(8));
const REFRESH_DAYS = 21;
const MIN_VALUE = 3; // USD – cheaper cards are rarely graded

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GRADERS = 'psa|cgc|bgs|sgc|tag|ace';
const GRADE_KEY = new RegExp(`^(${GRADERS})[ _-]?(10|[1-9](?:[._]5)?)$`, 'i');
const PRICE_FIELDS = ['smartMarketPrice', 'marketPrice', 'market', 'medianPrice', 'median', 'averagePrice', 'avg', 'average', 'price'];

/** pull "PSA 10" -> price out of whatever shape the API returns */
function gradePrices(json) {
  const out = {};
  const pick = (v) => {
    if (typeof v === 'number') return v;
    if (v && typeof v === 'object') {
      for (const f of PRICE_FIELDS) if (typeof v[f] === 'number' && v[f] > 0) return v[f];
      for (const f of PRICE_FIELDS) if (v[f] && typeof v[f] === 'object') {
        const n = pick(v[f]);
        if (n) return n;
      }
    }
    return null;
  };
  const walk = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 8) return;
    for (const [k, v] of Object.entries(node)) {
      const m = k.match(GRADE_KEY);
      if (m) {
        const price = pick(v);
        const label = `${m[1].toUpperCase()} ${m[2].replace('_', '.')}`;
        if (price && price > 0 && !(label in out)) out[label] = Math.round(price * 100) / 100;
      } else walk(v, depth + 1);
    }
  };
  walk(json);
  return out;
}

async function main() {
  if (!KEY) {
    console.log('PPT_API_KEY is not set – skipping graded prices. See README for setup.');
    return;
  }
  const graded = existsSync(OUT) ? JSON.parse(await readFile(OUT, 'utf8')) : { cards: {} };
  graded.cards ||= {};

  // every English card with a TCGplayer id, valued by its most expensive printing
  const files = (await readdir(path.join(DATA, 'sets'))).filter((f) => f.endsWith('.json'));
  const cards = [];
  for (const f of files) {
    const set = JSON.parse(await readFile(path.join(DATA, 'sets', f), 'utf8'));
    for (const c of set.cards) {
      if (!c.tp) continue;
      const value = Math.max(0, ...c.v.map((v) => v.u ?? (v.e ?? 0) * 1.1));
      if (value >= MIN_VALUE) cards.push({ id: c.id, tp: c.tp, value, name: c.name, set: set.name });
    }
  }
  const now = Date.now();
  const stale = (c) => !graded.cards[c.id] || now - graded.cards[c.id].t > REFRESH_DAYS * 864e5;
  const todo = cards
    .filter(stale)
    .sort((a, b) => (graded.cards[a.id] ? 1 : 0) - (graded.cards[b.id] ? 1 : 0) || b.value - a.value)
    .slice(0, LIMIT);
  console.log(`${cards.length} cards worth grading, ${cards.filter(stale).length} need prices; fetching ${todo.length}`);

  let ok = 0, shown = false;
  for (const c of todo) {
    const res = await fetch(`${API}?tcgPlayerId=${c.tp}&includeEbay=true`, { headers: { Authorization: `Bearer ${KEY}` } });
    if (res.status === 429 || res.status === 402 || res.status === 403) {
      console.log(`Stopping: API said ${res.status} (daily credits used up or plan limit) – ${(await res.text()).slice(0, 200)}`);
      break;
    }
    if (!res.ok) {
      console.log(`  ${c.name} (${c.set}): HTTP ${res.status}`);
      continue;
    }
    const json = await res.json();
    if (!shown) {
      // log the response layout once, to help if the API changes shape
      const d = Array.isArray(json.data) ? json.data[0] : json.data || json;
      console.log('Response layout:', JSON.stringify(d, (k, v) => (Array.isArray(v) ? `[${v.length}]` : v)).slice(0, 1500));
      shown = true;
    }
    const prices = gradePrices(json.data ?? json);
    graded.cards[c.id] = { t: now, usd: prices };
    ok++;
    console.log(`  ${c.name} (${c.set}): ${Object.keys(prices).length ? Object.entries(prices).slice(0, 4).map(([g, p]) => `${g} $${p}`).join(', ') : 'no graded sales'}`);
    await sleep(1100); // stay well inside 60 calls/minute
  }
  graded.updated = new Date().toISOString();
  graded.source = 'Pokemon Price Tracker (eBay sold listings)';
  await writeFile(OUT, JSON.stringify(graded));
  const withPrices = Object.values(graded.cards).filter((x) => Object.keys(x.usd || {}).length).length;
  console.log(`Updated ${ok} cards. data/graded.json now has graded prices for ${withPrices} cards.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
