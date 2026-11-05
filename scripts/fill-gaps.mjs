#!/usr/bin/env node
// Adds cards that TCGdex is missing, using the pokemontcg.io API as a second source.
// Examples: the "a" alternate prints in Sun & Moon sets (Tapu Lele-GX 60a) and
// lettered cards such as the Mew B / G / R cards in 30th Celebration.
//
// Run after scripts/build-data.mjs (it calls this automatically), or on its own:
//   node scripts/fill-gaps.mjs
// Cards added this way are marked with src: "ptcg" so the site doesn't ask TCGdex
// for live prices on them.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data');
const API = 'https://api.pokemontcg.io/v2';
const EUR_TO_USD = 1.1; // keep in step with build-data.mjs

// TCGdex set id -> pokemontcg.io set id, where names don't line up
const ALIASES = { '30th-c': 'me55c' };
// Sets whose extra pokemontcg.io cards live in a separate TCGdex set already
// (Unseen Forces' Unown A–Z are TCGdex's "exu" set).
const SKIP = new Set(['ex10']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, tries = 6) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      last = e;
      await sleep(1000 * 2 ** i);
    }
  }
  throw new Error(`Failed ${url}: ${last}`);
}

const norm = (s) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
const numKey = (n) => String(n).replace(/^0+(?=\d)/, '');
const round = (n) => (typeof n === 'number' && n > 0 ? Math.round(n * 100) / 100 : null);

/** split "SM30a" -> { pre: "SM", n: 30, post: "a" }; letters-only numbers have n = Infinity */
function parseNum(n) {
  const m = String(n).match(/^([A-Za-z]*?)(\d+)(.*)$/);
  return m ? { pre: m[1].toUpperCase(), n: Number(m[2]), post: m[3] } : { pre: '', n: Infinity, post: String(n) };
}

/** master-set variants for a pokemontcg.io card, keyed like build-data.mjs */
function variantsFor(card) {
  const tp = card.tcgplayer?.prices || {};
  const cm = card.cardmarket?.prices || {};
  const eurBase = round(cm.trendPrice || cm.averageSellPrice || cm.avg30);
  const eurRev = round(cm.reverseHoloTrend || cm.reverseHoloAvg30 || cm.reverseHoloSell);
  const map = [
    ['1stEditionNormal', { k: 'normal#1st-edition', t: 'normal', s: ['1st-edition'] }],
    ['1stEditionHolofoil', { k: 'holo#1st-edition', t: 'holo', s: ['1st-edition'] }],
    ['normal', { k: 'normal', t: 'normal' }],
    ['unlimited', { k: 'normal', t: 'normal' }],
    ['holofoil', { k: 'holo', t: 'holo' }],
    ['unlimitedHolofoil', { k: 'holo', t: 'holo' }],
    ['reverseHolofoil', { k: 'reverse', t: 'reverse' }],
  ];
  const out = new Map();
  for (const [key, v] of map) {
    if (!tp[key] || out.has(v.k)) continue;
    const o = { ...v };
    const u = round(tp[key].market ?? tp[key].mid ?? tp[key].low);
    const e = v.t === 'reverse' ? eurRev : v.s ? null : eurBase;
    if (u != null) o.u = u;
    if (e != null) o.e = e;
    out.set(v.k, o);
  }
  if (!out.size) {
    const holo = card.rarity && !/^(common|uncommon|promo)$/i.test(card.rarity);
    const o = { k: holo ? 'holo' : 'normal', t: holo ? 'holo' : 'normal' };
    if (eurBase != null) o.e = eurBase;
    out.set(o.k, o);
  }
  return [...out.values()];
}

/** insert a card next to its base number (60a after 60), letters-only at the end */
function insertCard(cards, card) {
  const a = parseNum(card.n);
  let at = cards.length;
  if (a.n !== Infinity) {
    let last = -1;
    cards.forEach((c, i) => {
      const b = parseNum(c.n);
      if (b.pre === a.pre && (b.n < a.n || (b.n === a.n && b.post <= a.post))) last = i;
    });
    if (last >= 0) at = last + 1;
  }
  cards.splice(at, 0, card);
}

export async function fillGaps({ log = console.log } = {}) {
  const indexPath = path.join(OUT, 'sets.json');
  if (!existsSync(indexPath)) throw new Error('Run build-data.mjs first');
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  const ptcgSets = (await get(`${API}/sets?pageSize=250`)).data;
  const byNameDate = new Map(ptcgSets.map((s) => [norm(s.name) + '|' + s.releaseDate.slice(0, 7).replace('/', '-'), s]));
  const byName = new Map();
  for (const s of ptcgSets) byName.set(norm(s.name), byName.has(norm(s.name)) ? null : s);
  const byId = new Map(ptcgSets.map((s) => [s.id, s]));

  let added = 0;
  for (const meta of index.sets) {
    if (SKIP.has(meta.id)) continue;
    const p =
      byId.get(ALIASES[meta.id]) ||
      byNameDate.get(norm(meta.name) + '|' + (meta.releaseDate || '').slice(0, 7)) ||
      byName.get(norm(meta.name)) ||
      byId.get(meta.id.replace(/\./g, ''));
    if (!p) continue;
    const file = path.join(OUT, 'sets', `${meta.id}.json`);
    const set = JSON.parse(await readFile(file, 'utf8'));
    // drop cards added by an earlier run so re-runs stay clean
    set.cards = set.cards.filter((c) => c.src !== 'ptcg');
    if (p.total <= set.cards.length) continue;
    const have = new Set(set.cards.map((c) => numKey(c.n).toLowerCase()));
    const cards = [];
    for (let page = 1; page <= 5; page++) {
      const r = await get(`${API}/cards?q=set.id:${p.id}&pageSize=250&page=${page}&select=id,number,name,rarity,supertype,types,artist,images,tcgplayer,cardmarket`);
      cards.push(...r.data);
      if (r.data.length < 250) break;
    }
    const missing = cards.filter((c) => !have.has(numKey(c.number).toLowerCase()));
    if (!missing.length) continue;
    for (const c of missing) {
      const card = { id: `${set.id}-${c.number}`, n: c.number, name: c.name, src: 'ptcg' };
      if (c.images?.small) (card.ims = c.images.small), (card.iml = c.images.large || c.images.small);
      if (c.rarity) card.r = c.rarity;
      if (c.supertype) card.cat = c.supertype === 'Pokémon' ? 'Pokemon' : c.supertype;
      if (c.artist) card.ill = c.artist;
      if (c.types) card.ty = c.types;
      card.v = variantsFor(c);
      insertCard(set.cards, card);
    }
    set.total = set.cards.length;
    set.variants = set.cards.reduce((a, c) => a + c.v.length, 0);
    const vs = set.cards.flatMap((c) => c.v);
    set.valueUSD = Math.round(vs.reduce((a, v) => a + (v.u ?? (v.e ?? 0) * EUR_TO_USD), 0) * 100) / 100;
    set.valueEUR = Math.round(vs.reduce((a, v) => a + (v.e ?? (v.u ?? 0) / EUR_TO_USD), 0) * 100) / 100;
    await writeFile(file, JSON.stringify(set));
    Object.assign(meta, { total: set.total, variants: set.variants, valueUSD: set.valueUSD, valueEUR: set.valueEUR });
    added += missing.length;
    log(`  ${meta.id} ${meta.name}: +${missing.length} from pokemontcg.io (${missing.map((c) => c.number).join(', ')})`);
  }
  index.source = 'TCGdex (tcgdex.dev) + pokemontcg.io';
  await writeFile(indexPath, JSON.stringify(index));
  log(`Filled ${added} missing cards`);
  return added;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  fillGaps().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
