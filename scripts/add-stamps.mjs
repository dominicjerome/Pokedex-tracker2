#!/usr/bin/env node
// Adds stamped and exclusive versions of regular set cards to each English master set,
// using TCGplayer's catalogue via tcgcsv.com (a free daily export of TCGplayer data).
//
// TCGplayer files these outside the main sets – League & Championship stamps, Professor
// Program, Prerelease kits, deck / blister exclusives (Cosmos, Cracked Ice), calendars,
// Trick or Trade, Battle Academy, stamped reprints in the promo groups… Each product that
// carries a regular set number (e.g. "17/147") is matched to the card with that number and
// name and added as an extra printing with its own photo and TCGplayer price.
//
// It also completes each set's regular printings from its main TCGplayer group: reverse holos
// and 1st Editions the card database is missing, holo rares it lists as non-holo, and photos of
// the Poké Ball / Master Ball / Energy Symbol reverse patterns.
//
// Runs after build-data.mjs (which calls it), or alone:  node scripts/add-stamps.mjs
// The last good result is kept in data/stamp-variants.json, so an outage never drops cards.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const API = 'https://tcgcsv.com/tcgplayer/3';
const EUR_TO_USD = 1.1;

// TCGplayer groups that hold stamped / exclusive reprints, and the label used when a product has no tag
// Play! Pokémon Prize Pack cards use TCGdex's name for the same stamp, so the two merge
const PRIZE_PACK = 'player-rewards-program';
const GROUPS = [
  [/^Prize Pack Series Cards$/i, PRIZE_PACK],
  [/^Deck Exclusives$/i, 'Deck Exclusive'],
  [/^Blister Exclusives$/i, 'Blister Exclusive'],
  [/^League & Championship Cards$/i, 'League'],
  [/^Professor Program Promos$/i, 'Professor Program'],
  [/^Alternate Art Promos$/i, 'Alternate Art'],
  [/^Countdown Calendar Promos$/i, 'Countdown Calendar'],
  [/^Trick or Trade BOOster Bundle/i, 'Trick or Trade'],
  [/^Battle Academy/i, 'Battle Academy'],
  [/^Pikachu World Collection/i, 'Pikachu World Collection'],
  [/^Kids WB Promos$/i, 'Kids WB'],
  [/^Best of Promos$/i, 'Best of Game'],
  [/Promo Cards$|^SM Promos$|^XY Promos$|^Black and White Promos$|^HGSS Promos$|^Diamond and Pearl Promos$|^Nintendo Promos$|^WoTC Promo$|^ME: Mega Evolution Promo$/i, 'Promo'],
];
const FOILS = [
  [/^cosmos? holo(foil)?$/i, 'cosmos'],
  [/^cracked ice( holo)?$/i, 'cracked-ice'],
  [/^wave foil$/i, 'wave'],
];
const TYPE_TAGS = [
  [/^reverse holo(foil)?$/i, 'reverse'],
  [/^non-?holo$/i, 'normal'],
  [/^holo(foil)?$/i, 'holo'],
];
const SUBTYPE = { Normal: 'normal', Holofoil: 'holo', 'Reverse Holofoil': 'reverse', '1st Edition': 'normal', '1st Edition Holofoil': 'holo', Unlimited: 'normal', 'Unlimited Holofoil': 'holo' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, tries = 5) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'PokeVault card tracker (github.com/dominicjerome/Pokedex-tracker2)', Accept: 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      last = e;
      await sleep(800 * 2 ** i);
    }
  }
  throw new Error(`${url}: ${last.message}`);
}
const norm = (s) => String(s).toLowerCase().replace(/[’']/g, '').replace(/é/g, 'e').replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
const slug = (s) => String(s).toLowerCase().replace(/é/g, 'e').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const numOf = (n) => String(n).replace(/^0+(?=\d)/, '').toLowerCase();
const ERA = /^(ex|dp|pl|hgss|hs|bw|xy|sm|swsh|sv|me|base|neo|e-card)\s+/i;

const UNMATCHED = [];
// main-set TCGplayer group names that don't follow the usual naming
const MAIN_GROUP = {
  base1: 'Base Set', base2: 'Jungle', base3: 'Fossil', base4: 'Base Set 2', base5: 'Team Rocket', gym1: 'Gym Heroes', gym2: 'Gym Challenge',
  lc: 'Legendary Collection', ecard1: 'Expedition', hgss1: 'HeartGold SoulSilver', ru1: 'Rumble', xy0: 'Kalos Starter Set', xy1: 'XY Base Set',
  g1: 'Generations', dv1: 'Dragon Vault', dc1: 'Double Crisis', sm1: 'SM Base Set', 'sm3.5': 'Shining Legends', 'sm7.5': 'Dragon Majesty',
  sm115: 'Hidden Fates', sma: 'Hidden Fates: Shiny Vault', swsh1: 'SWSH01: Sword & Shield Base Set', 'swsh3.5': "Champion's Path",
  'swsh4.5': 'Shining Fates', 'swsh4.5sv': 'Shining Fates: Shiny Vault', cel25: 'Celebrations', swsh9tg: 'Brilliant Stars Trainer Gallery',
  swsh10tg: 'Astral Radiance Trainer Gallery', swsh11tg: 'Lost Origin Trainer Gallery', swsh12tg: 'Silver Tempest Trainer Gallery',
  'swsh10.5': 'Pokemon GO', 'swsh12.5': 'Crown Zenith', 'swsh12.5gg': 'Crown Zenith: Galarian Gallery', sv01: 'SV01: Scarlet & Violet Base Set',
  'sv03.5': 'SV: Scarlet & Violet 151', 'sv04.5': 'SV: Paldean Fates', 'sv06.5': 'SV: Shrouded Fable', 'sv08.5': 'SV: Prismatic Evolutions',
  'sv10.5b': 'SV: Black Bolt', 'sv10.5w': 'SV: White Flare', 'me02.5': 'ME: Ascended Heroes', '30th': 'ME: 30th Celebration',
};
const PATTERNS = [
  [/master ball/i, 'masterball'], [/poke ?ball/i, 'pokeball'], [/energy symbol/i, 'energy'],
  [/dusk ball/i, 'duskball'], [/love ball/i, 'loveball'], [/friend ball/i, 'friendball'], [/quick ball/i, 'quickball'],
];
const numKey = (n) => String(n).split('/')[0].trim().toLowerCase().replace(/^([a-z]*)0+(?=\d)/, '$1');
const round2 = (n) => (n > 0 ? Math.round(n * 100) / 100 : null);
// EX-era reverse holos carry the set logo – that's the regular reverse, not a special stamp
const isRegularStamp = (v) => !(v.s || []).length || (v.t === 'reverse' && v.s.length === 1 && v.s[0] === 'set-logo');
const isPlainV = (v) => !(v.s || []).some((x) => x !== '1st-edition') && !v.f && !v.z;
/** put a regular printing after the other regular ones (before patterns, stamps and jumbos) */
function insertRegular(c, v) {
  let at = -1;
  c.v.forEach((x, i) => { if (isPlainV(x)) at = i; });
  c.v.splice(at + 1, 0, v);
}

/** what TCGplayer's main set groups say each card should have; returns card id -> [ops] */
async function completionOps(groups, sets) {
  const ops = {};
  const gBy = new Map();
  for (const g of groups)
    for (const n of [g.name, g.name.replace(/^[A-Za-z0-9.]+:\s*/, ''), g.name.replace(/^(XY|SM) - /, '').replace(/^EX /, '')])
      if (!gBy.has(norm(n))) gBy.set(norm(n), g);
  for (const { set } of sets) {
    if (/promo|trainer kit|mcdonald|energy|futsal|my first battle/i.test(set.name)) continue;
    const g = gBy.get(norm(MAIN_GROUP[set.id] || '')) || gBy.get(norm(set.name));
    if (!g) continue;
    const [products, prices] = await Promise.all([get(`${API}/${g.groupId}/products`), get(`${API}/${g.groupId}/prices`)]);
    const subsBy = new Map();
    for (const x of prices.results) {
      if (!subsBy.has(x.productId)) subsBy.set(x.productId, []);
      subsBy.get(x.productId).push(x);
    }
    const byNum = new Map(set.cards.map((c) => [numKey(c.n), c]));
    // only sets whose patterns TCGplayer lists separately (Prismatic Evolutions…) have a plain reverse besides them;
    // elsewhere the card database's patterned reverse (e.g. EX-era "energy" reverses) *is* the reverse holo
    const patternsListed = products.results.some((p) => [...p.name.matchAll(/\(([^)]*)\)/g)].some((t) => PATTERNS.some(([re]) => re.test(t[1]))));
    for (const p of products.results) {
      const number = (p.extendedData || []).find((e) => e.name === 'Number')?.value;
      const c = number && byNum.get(numKey(number));
      if (!c) continue;
      const base = norm(p.name.split(' - ')[0].replace(/\s*[([].*$/, ''));
      const cn = norm(c.name);
      if (!(base.slice(0, 4) === cn.slice(0, 4) || base.includes(cn) || cn.includes(base))) continue; // numbering mismatch – don't guess
      const subs = subsBy.get(p.productId) || [];
      const price = (name) => round2(subs.find((x) => x.subTypeName === name)?.marketPrice ?? subs.find((x) => x.subTypeName === name)?.midPrice);
      const tags = [...p.name.matchAll(/\(([^)]*)\)/g)].map((x) => x[1]);
      const list = (ops[c.id] ||= []);
      if (tags.length) {
        const pat = tags.map((t) => PATTERNS.find(([re]) => re.test(t))?.[1]).find(Boolean);
        if (pat && p.imageUrl) list.push({ op: 'photo', f: pat, im: p.imageUrl, u: price('Reverse Holofoil') ?? price('Holofoil') ?? price('Normal') });
        continue; // other tagged listings are alternate arts, stamps… handled elsewhere
      }
      const names = new Set(subs.map((x) => x.subTypeName));
      for (const x of subs) {
        const u = price(x.subTypeName);
        if (x.subTypeName === 'Reverse Holofoil') list.push({ op: 'add', k: 'reverse', t: 'reverse', u, anyFoil: !patternsListed });
        else if (x.subTypeName === 'Holofoil' && !names.has('Normal')) list.push({ op: 'holo', u });
        else if (/^1st Edition( Normal)?$/.test(x.subTypeName)) list.push({ op: 'add', k: 'normal#1st-edition', t: 'normal', s: ['1st-edition'], u });
        else if (x.subTypeName === '1st Edition Holofoil') list.push({ op: 'add', k: 'holo#1st-edition', t: 'holo', s: ['1st-edition'], u });
        else if (x.subTypeName === 'Normal') list.push({ op: 'price', t: 'normal', u });
      }
    }
    await sleep(100);
  }
  return ops;
}

/** apply completion ops to one card; returns the number of printings added */
function applyOps(c, list) {
  let added = 0;
  for (const o of list) {
    if (o.op === 'add') {
      const first = (o.s || []).includes('1st-edition');
      const have = first
        ? c.v.find((x) => x.t === o.t && (x.s || []).includes('1st-edition') && !x.z)
        : c.v.find((x) => x.t === o.t && !x.z && (o.anyFoil || !x.f) && isRegularStamp(x));
      if (have) { if (have.u == null && o.u != null) have.u = o.u; continue; }
      if (c.v.some((x) => x.k === o.k)) continue;
      const v = { k: o.k, t: o.t, src: 'tcgp' };
      if (o.s) v.s = o.s;
      if (o.u != null) v.u = o.u;
      insertRegular(c, v);
      added++;
    } else if (o.op === 'holo') {
      // a holo rare listed as non-holo: fix its type but keep its key, so owned cards stay owned
      const plainNormals = c.v.filter((x) => x.t === 'normal' && isPlainV(x) && !(x.s || []).length && (!x.sub || x.sub === 'unlimited'));
      const plainHolo = c.v.some((x) => x.t === 'holo' && isPlainV(x) && !(x.s || []).length);
      if (!plainHolo && plainNormals.length === 1) plainNormals[0].t = 'holo';
      // TCGplayer only sells it as holo, yet a plain non-holo is listed too: a duplicate listing – keep it out of the standard master set
      else if (plainHolo) for (const n of plainNormals) n.dup = 1;
      const h = c.v.find((x) => x.t === 'holo' && isPlainV(x) && !(x.s || []).length);
      if (h && h.u == null && o.u != null) h.u = o.u;
    } else if (o.op === 'photo') {
      const v = c.v.find((x) => x.f === o.f && x.t === 'reverse');
      if (v) { if (!v.im) v.im = o.im; if (v.u == null && o.u != null) v.u = o.u; }
    } else if (o.op === 'price') {
      const v = c.v.find((x) => x.t === 'normal' && isPlainV(x) && !(x.s || []).length);
      if (v && v.u == null && o.u != null) v.u = o.u;
    }
  }
  return added;
}
export async function addStamps({ log = console.log } = {}) {
  const indexPath = path.join(DATA, 'sets.json');
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  const cachePath = path.join(DATA, 'stamp-variants.json');
  const cache = existsSync(cachePath) ? JSON.parse(await readFile(cachePath, 'utf8')) : {};

  // load every English set
  const sets = [];
  for (const meta of index.sets) {
    const file = path.join(DATA, 'sets', `${meta.id}.json`);
    if (existsSync(file)) sets.push({ meta, file, set: JSON.parse(await readFile(file, 'utf8')) });
  }
  const setNames = new Map();
  for (const s of sets) {
    setNames.set(norm(s.set.name), s);
    setNames.set(norm(s.set.name.replace(ERA, '')), s);
  }
  // look-up: "number|name" -> candidate cards, with their set's printed totals
  const byNumName = new Map();
  for (const s of sets)
    for (const c of s.set.cards) {
      const k = `${numOf(c.n)}|${norm(c.name)}`;
      if (!byNumName.has(k)) byNumName.set(k, []);
      byNumName.get(k).push({ s, c });
    }

  let found = {}; // card id -> [variant]
  let ops = {}; // card id -> [completion op]
  try {
    const groups = (await get(`${API}/groups`)).results;
    const wanted = groups
      .map((g) => ({ g, label: GROUPS.find(([re]) => re.test(g.name))?.[1] }))
      .filter((x) => x.label);
    log(`Stamps: checking ${wanted.length} TCGplayer groups`);
    for (const { g, label } of wanted) {
      const [products, prices] = await Promise.all([get(`${API}/${g.groupId}/products`), get(`${API}/${g.groupId}/prices`)]);
      const priceBy = new Map();
      for (const p of prices.results) {
        if (!priceBy.has(p.productId)) priceBy.set(p.productId, []);
        priceBy.get(p.productId).push(p);
      }
      for (const p of products.results) {
        const number = (p.extendedData || []).find((e) => e.name === 'Number')?.value;
        const prize = label === PRIZE_PACK;
        let m = number && String(number).match(/^0*(\d+[a-z]?)\s*\/\s*0*(\d+)$/i);
        // Prize Pack also reprints promos ("SWSH149"); other promo-numbered cards are already in the promo sets
        const promoNum = prize && !m && number && /^([A-Z]{2,5})?\d+$/i.test(number) ? number : null;
        if (!m && !promoNum) continue;
        const [, n, total] = m || [null, promoNum, null];
        const base = p.name.split(' - ')[0].replace(/\s*[([].*$/, '').trim();
        const tags = [...p.name.matchAll(/\(([^)]*)\)|\[([^\]]*)\]/g)].map((x) => (x[1] || x[2]).trim()).filter((t) => t && !/^\d+[a-z]?\/\d+$/i.test(t) && t !== number);
        // which set? a tag naming the set wins, else the printed total must match
        const hinted = tags.map((t) => setNames.get(norm(t)) || setNames.get(norm(t.replace(ERA, '')))).find(Boolean);
        let cands = byNumName.get(`${numOf(n)}|${norm(base)}`) || byNumName.get(`${numOf(n)}|${norm(base.replace(/^basic\s+/i, ''))}`) || [];
        // basic energies: "MEE" marks Mega Evolution energies, unmarked ones are Scarlet & Violet's
        if (cands.some((x) => x.s.set.id === 'mee')) cands = cands.filter((x) => (x.s.set.id === 'mee') === /\bMEE\b/.test(p.name));
        if (!cands.length) cands = [...byNumName.entries()].filter(([k]) => k.startsWith(numOf(n) + '|') && (k.endsWith('|' + norm(base)) || k.split('|')[1].startsWith(norm(base)))).flatMap(([, v]) => v);
        if (hinted) cands = cands.filter((x) => x.s === hinted);
        else if (promoNum) cands = cands.filter((x) => /promo|energy/i.test(x.s.set.name));
        else cands = cands.filter((x) => Number(total) === x.s.set.official || Number(total) === x.s.set.total);
        // promo sets list their own cards (and TCGdex already has their stamped versions)
        if (!promoNum) cands = cands.filter((x) => !/promo/i.test(x.s.set.name));
        else if (cands.length > 1) cands = cands.filter((x) => x.s.set.releaseDate >= '2019'); // Prize Packs began with Sword & Shield
        if (cands.length !== 1 && prize) UNMATCHED.push(`${p.name} [${number}]`);
        if (cands.length !== 1) continue;
        const { c } = cands[0];
        // describe the printing
        let foil = null, type = null;
        const stamps = [];
        for (const t of tags) {
          if (hinted && (setNames.get(norm(t)) === hinted || setNames.get(norm(t.replace(ERA, ''))) === hinted)) continue;
          const f = FOILS.find(([re]) => re.test(t));
          if (f) { foil = f[1]; continue; }
          const ty = TYPE_TAGS.find(([re]) => re.test(t));
          if (ty) { type = ty[1]; continue; }
          if (/^\d+$/.test(t)) continue; // stray numbers
          if (prize && /^(prize pack )?series \d+$/i.test(t)) { stamps.push(slug('prize-pack-' + t.replace(/^prize pack /i, ''))); continue; }
          stamps.push(slug(t));
        }
        if (prize) stamps.unshift(PRIZE_PACK); // every Prize Pack card carries the Play! Pokémon stamp
        else if (!stamps.length) stamps.push(slug(label)); // e.g. a cosmos blister card is still a blister exclusive
        const subs = priceBy.get(p.productId) || [{ subTypeName: type === 'reverse' ? 'Reverse Holofoil' : type === 'normal' ? 'Normal' : 'Holofoil' }];
        for (const sp of subs) {
          const t = type || SUBTYPE[sp.subTypeName] || 'holo';
          const st = /1st Edition/.test(sp.subTypeName || '') ? ['1st-edition', ...stamps] : stamps;
          const v = { k: `${t}${foil ? ':' + foil : ''}#${st.join('+')}`, t, s: st, src: 'tcgp' };
          if (foil) v.f = foil;
          const u = sp.marketPrice ?? sp.midPrice ?? sp.lowPrice;
          if (u > 0) v.u = Math.round(u * 100) / 100;
          if (p.imageUrl) v.im = p.imageUrl;
          (found[c.id] ||= []).push(v);
        }
      }
      await sleep(150);
    }
    ops = await completionOps(groups, sets);
  } catch (e) {
    log(`Stamps: TCGplayer catalogue unavailable (${e.message}) – using the saved stamped printings`);
    found = cache.stamps || cache;
    ops = cache.ops || {};
  }

  // apply to the set files (replacing what an earlier run added)
  let added = 0, completed = 0;
  for (const s of sets) {
    let changed = false;
    for (const c of s.set.cards) {
      const before = c.v.length;
      c.v = c.v.filter((v) => v.src !== 'tcgp');
      if (c.v.length !== before) changed = true;
      if (ops[c.id]) {
        completed += applyOps(c, ops[c.id]);
        changed = true;
      }
      const extra = found[c.id];
      if (!extra) continue;
      for (const v of extra) {
        // TCGdex already has this printing: keep it, but use TCGplayer's photo of the stamped card and its own price
        const same = c.v.find((x) => x.k === v.k || (x.t === v.t && (x.f || null) === (v.f || null) && (x.s || []).join() === v.s.join()));
        if (same) {
          if (v.im) same.im = v.im;
          if (v.u != null) {
            same.u = v.u;
            // the card database often copies the regular card's Cardmarket price onto stamped printings – drop that copy
            const regular = c.v.find((x) => x !== same && x.t === same.t && !(x.s || []).length && !x.f);
            if (same.e != null && regular && regular.e === same.e) delete same.e;
          }
          changed = true;
          continue;
        }
        if (c.v.some((x) => x.k === v.k)) continue;
        c.v.push(v);
        added++;
        changed = true;
      }
    }
    if (!changed) continue;
    const set = s.set;
    set.variants = set.cards.reduce((a, c) => a + c.v.length, 0);
    const vs = set.cards.flatMap((c) => c.v);
    set.valueUSD = Math.round(vs.reduce((a, v) => a + (v.u ?? (v.e ?? 0) * EUR_TO_USD), 0) * 100) / 100;
    set.valueEUR = Math.round(vs.reduce((a, v) => a + (v.e ?? (v.u ?? 0) / EUR_TO_USD), 0) * 100) / 100;
    await writeFile(s.file, JSON.stringify(set));
    Object.assign(s.meta, { variants: set.variants, valueUSD: set.valueUSD, valueEUR: set.valueEUR });
  }
  await writeFile(cachePath, JSON.stringify({ stamps: found, ops }));
  await writeFile(indexPath, JSON.stringify(index));
  log(`Stamps: added ${added} stamped/exclusive printings`);
  log(`Master sets: added ${completed} missing regular printings (reverse holos, 1st Editions)`);
  if (UNMATCHED.length) log(`Prize Pack cards with no matching card (${UNMATCHED.length}): ${UNMATCHED.slice(0, 40).join('; ')}`);
  return added;
}


/**
 * Japanese master sets: add Mirror (reverse) holos and Poké Ball / Master Ball / Energy / other pattern
 * reverses that TCGplayer's "Pokemon Japan" catalogue lists but the card database is missing.
 */
export async function completeJapanese({ log = console.log } = {}) {
  const dir = path.join(DATA, 'ja');
  const indexPath = path.join(dir, 'sets.json');
  if (!existsSync(indexPath)) return 0;
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  const cachePath = path.join(dir, 'printings-cache.json');
  const sets = [];
  for (const meta of index.sets) {
    const file = path.join(dir, 'sets', `${meta.id.split('/')[1]}.json`);
    if (existsSync(file)) sets.push({ meta, file, set: JSON.parse(await readFile(file, 'utf8')) });
  }
  let ops = {};
  try {
    const groups = (await get('https://tcgcsv.com/tcgplayer/85/groups')).results;
    const byCode = new Map(groups.filter((g) => g.abbreviation).map((g) => [g.abbreviation.toLowerCase(), g]));
    for (const { set } of sets) {
      const g = byCode.get(set.id.split('/')[1].toLowerCase());
      if (!g) continue;
      const [products, prices] = await Promise.all([get(`https://tcgcsv.com/tcgplayer/85/${g.groupId}/products`), get(`https://tcgcsv.com/tcgplayer/85/${g.groupId}/prices`)]);
      const priceOf = new Map(prices.results.map((x) => [x.productId, round2(x.marketPrice ?? x.midPrice)]));
      const byNum = new Map(set.cards.map((c) => [numKey(c.n), c]));
      for (const p of products.results) {
        const number = (p.extendedData || []).find((e) => e.name === 'Number')?.value;
        const c = number && byNum.get(numKey(number));
        if (!c) continue;
        if (c.en && !c.en.split(' & ').some((n) => norm(p.name).includes(norm(n)))) continue; // TCGplayer names Japanese cards in English
        for (const [, t] of p.name.matchAll(/\(([^)]*)\)/g)) {
          const pat = [...PATTERNS, [/team rocket/i, 'team-rocket']].find(([re]) => re.test(t))?.[1];
          if (pat) (ops[c.id] ||= []).push({ k: `reverse:${pat}`, t: 'reverse', f: pat, u: priceOf.get(p.productId), im: p.imageUrl });
          else if (/mirror/i.test(t)) (ops[c.id] ||= []).push({ k: 'reverse', t: 'reverse', u: priceOf.get(p.productId) });
        }
      }
      await sleep(100);
    }
  } catch (e) {
    log(`Japanese printings: TCGplayer unavailable (${e.message.slice(0, 80)}) – using saved results`);
    ops = existsSync(cachePath) ? JSON.parse(await readFile(cachePath, 'utf8')) : {};
  }
  let added = 0;
  for (const s of sets) {
    let changed = false;
    for (const c of s.set.cards) {
      const before = c.v.length;
      c.v = c.v.filter((v) => v.src !== 'tcgp');
      if (c.v.length !== before) changed = true;
      for (const o of ops[c.id] || []) {
        const have = o.f ? c.v.find((x) => x.f === o.f) : c.v.find((x) => x.t === 'reverse' && !x.f);
        if (have) {
          if (o.im && !have.im) have.im = o.im;
          if (have.u == null && o.u != null) have.u = o.u;
          changed = true;
          continue;
        }
        const v = { k: o.k, t: o.t, src: 'tcgp' };
        if (o.f) v.f = o.f;
        if (o.u != null) v.u = o.u;
        if (o.im && o.f) v.im = o.im;
        if (o.f) c.v.push(v);
        else insertRegular(c, v);
        added++;
        changed = true;
      }
    }
    if (!changed) continue;
    const set = s.set;
    set.variants = set.cards.reduce((a, c) => a + c.v.length, 0);
    const vs = set.cards.flatMap((c) => c.v);
    set.valueUSD = Math.round(vs.reduce((a, v) => a + (v.u ?? (v.e ?? 0) * EUR_TO_USD), 0) * 100) / 100;
    set.valueEUR = Math.round(vs.reduce((a, v) => a + (v.e ?? (v.u ?? 0) / EUR_TO_USD), 0) * 100) / 100;
    await writeFile(s.file, JSON.stringify(set));
    Object.assign(s.meta, { variants: set.variants, valueUSD: set.valueUSD, valueEUR: set.valueEUR });
  }
  await writeFile(cachePath, JSON.stringify(ops));
  await writeFile(indexPath, JSON.stringify(index));
  log(`Japanese master sets: added ${added} Mirror / pattern printings`);
  return added;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const run = process.argv.includes('--lang=ja') ? completeJapanese : addStamps;
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
