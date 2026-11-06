#!/usr/bin/env node
// Builds the static card database used by the site from the free TCGdex API
// (https://tcgdex.dev). Run with:  node scripts/build-data.mjs [--lang=ja] [setId ...]
//   Languages: en (default), ja, zh-tw, th, id. Non-English catalogues go to data/<lang>/ and their
//   set/card ids are prefixed with "<lang>/" so they never clash with English ids.
//
// Output:
//   data/sets.json        – index of every set (grouped by series/era)
//   data/sets/<id>.json   – master-set card list for one set (all variants,
//                           stamps, foils, jumbos) with current prices

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fillGaps } from './fill-gaps.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LANG = (process.argv.find((a) => a.startsWith('--lang=')) || '--lang=en').slice(7);
const OUT = LANG === 'en' ? path.join(ROOT, 'data') : path.join(ROOT, 'data', LANG);
const API = `https://api.tcgdex.net/v2/${LANG}`;
const PREFIX = LANG === 'en' ? '' : `${LANG}/`;
// English names for TCGdex's non-English series ids
const SERIES_EN = {
  PMCG: 'Original era', neo: 'Neo', VS: 'VS', web: 'Web', e: 'e-Card', E: 'e-Card', ADV: 'ADV (EX era)', PCG: 'PCG (EX era)',
  DP: 'Diamond & Pearl', DPt: 'Platinum', L: 'LEGEND (HGSS)', BW: 'Black & White', XY: 'XY', XYb: 'XY BREAK',
  SM: 'Sun & Moon', S: 'Sword & Shield', SV: 'Scarlet & Violet', M: 'Mega Evolution', CS: 'Chinese exclusive',
};
let SPECIES = {}; // Pokédex number -> English name, so non-English cards can be searched in English
async function loadSpecies() {
  try {
    const r = await (await fetch('https://pokeapi.co/api/v2/pokemon-species?limit=2000')).json();
    r.results.forEach((x, i) => {
      SPECIES[i + 1] = x.name.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')
        .replace(/^Nidoran F$/, 'Nidoran♀').replace(/^Nidoran M$/, 'Nidoran♂').replace(/^Mr Mime$/, 'Mr. Mime').replace(/^Mime Jr$/, 'Mime Jr.').replace(/^Mr Rime$/, 'Mr. Rime');
    });
  } catch (e) {
    console.warn('Could not load English Pokémon names:', e.message);
  }
}
const CONCURRENCY = Number(process.env.CONCURRENCY || 12);
// Pokémon TCG Pocket is a digital game – not physical cards, so skip it.
const SKIP_SERIES = new Set(['tcgp']);
// Must match EUR_TO_USD in js/app.js.
const EUR_TO_USD = 1.1;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, tries = 7) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      last = e;
      await sleep(500 * 2 ** i);
    }
  }
  throw new Error(`Failed ${url}: ${last}`);
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return out;
}

const round = (n) => (typeof n === 'number' && n > 0 ? Math.round(n * 100) / 100 : null);

// ---- pricing -------------------------------------------------------------
function tcgplayerPrice(tp, v) {
  if (!tp) return null;
  const keys = Object.keys(tp).filter((k) => tp[k] && typeof tp[k] === 'object');
  if (!keys.length) return null;
  const first = (v.stamp || []).includes('1st-edition');
  const prefs = [];
  if (first) prefs.push(v.type === 'normal' ? '1st-edition-normal' : '1st-edition-holofoil', '1st-edition');
  if (v.type === 'reverse') prefs.push('reverse-holofoil');
  else if (v.type === 'normal') prefs.push('normal', 'unlimited');
  else prefs.push('holofoil', 'unlimited-holofoil', 'normal', 'unlimited');
  for (const k of prefs) {
    const p = tp[k];
    if (p) return round(p.marketPrice ?? p.midPrice ?? p.lowPrice);
  }
  // Only fall back to "any price" if the card has a single priced printing.
  if (keys.length === 1) {
    const p = tp[keys[0]];
    return round(p.marketPrice ?? p.midPrice ?? p.lowPrice);
  }
  return null;
}

function cardmarketPrice(cm, v) {
  if (!cm) return null;
  if (v.type === 'reverse') return round(cm['trend-holo'] || cm['avg30-holo'] || cm['avg-holo']);
  return round(cm.trend || cm.avg30 || cm.avg);
}

function isPlain(v) {
  return (
    !(v.stamp && v.stamp.length) &&
    !v.foil &&
    (v.size || 'standard') === 'standard' &&
    (!v.subtype || v.subtype === 'unlimited')
  );
}

// ---- variants ------------------------------------------------------------
const TYPE_RANK = { normal: 0, holo: 1, reverse: 2 };
function variantRank(v) {
  const stamps = v.stamp || [];
  const first = stamps.includes('1st-edition') ? 0 : 1;
  const sub = !v.subtype ? 1 : v.subtype === 'shadowless' ? 0 : v.subtype === 'unlimited' ? 1 : 2;
  const otherStamps = stamps.filter((s) => s !== '1st-edition').length ? 1 : 0;
  return [
    (v.size || 'standard') === 'standard' ? 0 : 1,
    otherStamps,
    first,
    sub,
    TYPE_RANK[v.type] ?? 3,
    v.foil ? 1 : 0,
    (v.foil || '') + stamps.join(','),
  ];
}
function cmpRank(a, b) {
  const ra = variantRank(a);
  const rb = variantRank(b);
  for (let i = 0; i < ra.length; i++) {
    if (ra[i] < rb[i]) return -1;
    if (ra[i] > rb[i]) return 1;
  }
  return 0;
}

function variantKey(v) {
  let k = v.type;
  if (v.subtype) k += '~' + v.subtype;
  if (v.foil) k += ':' + v.foil;
  if (v.stamp && v.stamp.length) k += '#' + v.stamp.join('+');
  if (v.size && v.size !== 'standard') k += '@' + v.size;
  return k;
}

function variantsFor(card) {
  let list = Array.isArray(card.variants_detailed) && card.variants_detailed.length ? card.variants_detailed : null;
  if (!list) {
    const f = card.variants || {};
    list = [];
    if (f.firstEdition) list.push({ type: f.holo ? 'holo' : 'normal', stamp: ['1st-edition'] });
    if (f.normal) list.push({ type: 'normal' });
    if (f.holo) list.push({ type: 'holo' });
    if (f.reverse) list.push({ type: 'reverse' });
    if (f.wPromo) list.push({ type: 'holo', stamp: ['w-promo'] });
    if (!list.length) list.push({ type: 'normal' });
  }
  const seen = new Set();
  const out = [];
  for (const v of [...list].sort(cmpRank)) {
    const k = variantKey(v);
    if (seen.has(k)) continue;
    seen.add(k);
    const own = v.pricing || null;
    const fallback = isPlain(v) ? card.pricing || null : null;
    const usd = tcgplayerPrice(own?.tcgplayer, v) ?? tcgplayerPrice(fallback?.tcgplayer, v);
    const eur = cardmarketPrice(own?.cardmarket, v) ?? cardmarketPrice(fallback?.cardmarket, v);
    const o = { k, t: v.type };
    if (v.subtype) o.sub = v.subtype;
    if (v.foil) o.f = v.foil;
    if (v.stamp && v.stamp.length) o.s = v.stamp;
    if (v.size && v.size !== 'standard') o.z = v.size;
    if (usd != null) o.u = usd;
    if (eur != null) o.e = eur;
    out.push(o);
  }
  return out;
}

// ---- main ----------------------------------------------------------------
async function buildSet(brief, seriesOrder) {
  const set = await get(`${API}/sets/${encodeURIComponent(brief.id)}`);
  if (!set) return null;
  const serie = set.serie || { id: 'misc', name: 'Miscellaneous' };
  if (SKIP_SERIES.has(serie.id)) return null;
  const briefs = set.cards || [];
  const cards = await pool(briefs, CONCURRENCY, async (b) => {
    const c = (await get(`${API}/cards/${encodeURIComponent(b.id)}`)) || b;
    const o = { id: PREFIX + (c.id || b.id), n: c.localId ?? b.localId, name: c.name ?? b.name };
    if (PREFIX && Array.isArray(c.dexId) && c.dexId.length) {
      const en = c.dexId.map((d) => SPECIES[d]).filter(Boolean);
      if (en.length) o.en = en.join(' & ');
    }
    if (c.image || b.image) o.img = c.image || b.image;
    if (c.rarity) o.r = c.rarity;
    if (c.category) o.cat = c.category;
    if (c.illustrator) o.ill = c.illustrator;
    if (c.types) o.ty = c.types;
    o.v = variantsFor(c);
    return o;
  });
  // When a printing has no price in one market, fall back to the other one
  // (converted), so set totals don't silently count it as zero.
  const sum = (key) =>
    Math.round(
      cards.reduce(
        (a, c) => a + c.v.reduce((b, v) => b + (v[key] ?? (key === 'u' ? (v.e ?? 0) * EUR_TO_USD : (v.u ?? 0) / EUR_TO_USD)), 0),
        0,
      ) * 100,
    ) / 100;
  const data = {
    id: PREFIX + set.id,
    name: set.name,
    lang: LANG,
    series: PREFIX + serie.id,
    seriesName: PREFIX ? SERIES_EN[serie.id] || serie.name : serie.name,
    releaseDate: set.releaseDate || null,
    logo: set.logo || null,
    symbol: set.symbol || null,
    code: set.abbreviation?.official || set.tcgOnline || null,
    official: set.cardCount?.official ?? cards.length,
    total: cards.length,
    variants: cards.reduce((a, c) => a + c.v.length, 0),
    valueUSD: sum('u'),
    valueEUR: sum('e'),
    updated: new Date().toISOString(),
    cards,
  };
  if (!cards.length) return null; // some non-English sets are listed without their cards
  await writeFile(path.join(OUT, 'sets', `${set.id}.json`), JSON.stringify(data));
  const { cards: _c, ...index } = data;
  index.seriesOrder = seriesOrder[PREFIX + serie.id] ?? 99;
  return index;
}

async function main() {
  await mkdir(path.join(OUT, 'sets'), { recursive: true });
  const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (PREFIX) await loadSpecies();
  const [sets, series] = await Promise.all([get(`${API}/sets`), get(`${API}/series`)]);
  const seriesOrder = Object.fromEntries(series.map((s, i) => [PREFIX + s.id, i]));
  const todo = only.length ? sets.filter((s) => only.includes(s.id)) : sets;

  // Keep previously built sets when doing a partial rebuild.
  const indexPath = path.join(OUT, 'sets.json');
  const prev = existsSync(indexPath) ? JSON.parse(await readFile(indexPath, 'utf8')).sets : [];
  const byId = new Map(prev.map((s) => [s.id, s]));

  let done = 0;
  for (const brief of todo) {
    try {
      const idx = await buildSet(brief, seriesOrder);
      done++;
      if (idx) {
        byId.set(idx.id, idx);
        console.log(`[${done}/${todo.length}] ${idx.id} ${idx.name}: ${idx.total} cards, ${idx.variants} master-set slots`);
      } else {
        byId.delete(PREFIX + brief.id);
        console.log(`[${done}/${todo.length}] ${brief.id} skipped`);
      }
    } catch (e) {
      done++;
      console.error(`[${done}/${todo.length}] ${brief.id} FAILED: ${e.message}`);
    }
  }

  const order = new Map(sets.map((s, i) => [PREFIX + s.id, i]));
  const all = [...byId.values()].sort(
    (a, b) => (a.releaseDate || '9999').localeCompare(b.releaseDate || '9999') || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
  );
  await writeFile(
    indexPath,
    JSON.stringify({ updated: new Date().toISOString(), lang: LANG, source: 'TCGdex (tcgdex.dev)', sets: all }, null, 0),
  );
  console.log(`Wrote ${all.length} sets`);
  // add cards TCGdex is missing from pokemontcg.io (failure here keeps the TCGdex data)
  try {
    if (LANG === 'en') await fillGaps();
  } catch (e) {
    console.error('Filling gaps from pokemontcg.io failed:', e.message);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
