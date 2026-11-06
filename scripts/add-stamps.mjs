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
const GROUPS = [
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
        const m = number && String(number).match(/^0*(\d+[a-z]?)\s*\/\s*0*(\d+)$/i);
        if (!m) continue; // promo-numbered cards are already in the promo sets
        const [, n, total] = m;
        const base = p.name.split(' - ')[0].replace(/\s*[([].*$/, '').trim();
        const tags = [...p.name.matchAll(/\(([^)]*)\)|\[([^\]]*)\]/g)].map((x) => (x[1] || x[2]).trim()).filter((t) => t && !/^\d+[a-z]?\/\d+$/i.test(t) && t !== number);
        // which set? a tag naming the set wins, else the printed total must match
        const hinted = tags.map((t) => setNames.get(norm(t)) || setNames.get(norm(t.replace(ERA, '')))).find(Boolean);
        let cands = byNumName.get(`${numOf(n)}|${norm(base)}`) || [];
        if (!cands.length) cands = [...byNumName.entries()].filter(([k]) => k.startsWith(numOf(n) + '|') && (k.endsWith('|' + norm(base)) || k.split('|')[1].startsWith(norm(base)))).flatMap(([, v]) => v);
        if (hinted) cands = cands.filter((x) => x.s === hinted);
        else cands = cands.filter((x) => Number(total) === x.s.set.official || Number(total) === x.s.set.total);
        // promo sets list their own cards (and TCGdex already has their stamped versions)
        cands = cands.filter((x) => !/promo/i.test(x.s.set.name));
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
          stamps.push(slug(t));
        }
        if (!stamps.length && !foil) stamps.push(slug(label));
        if (!stamps.length) stamps.push(slug(label)); // a cosmos blister card is still a blister exclusive
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
  } catch (e) {
    log(`Stamps: TCGplayer catalogue unavailable (${e.message}) – using the saved stamped printings`);
    found = cache;
  }

  // apply to the set files (replacing what an earlier run added)
  let added = 0;
  for (const s of sets) {
    let changed = false;
    for (const c of s.set.cards) {
      const before = c.v.length;
      c.v = c.v.filter((v) => v.src !== 'tcgp');
      if (c.v.length !== before) changed = true;
      const extra = found[c.id];
      if (!extra) continue;
      for (const v of extra) {
        // skip printings TCGdex already has (same type, foil and stamps)
        if (c.v.some((x) => x.k === v.k || (x.t === v.t && (x.f || null) === (v.f || null) && (x.s || []).join() === v.s.join()))) continue;
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
  await writeFile(cachePath, JSON.stringify(found));
  await writeFile(indexPath, JSON.stringify(index));
  log(`Stamps: added ${added} stamped/exclusive printings`);
  return added;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  addStamps().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
