#!/usr/bin/env node
// Fills in card images that TCGdex doesn't have.
//
//   English:   pokemontcg.io card scans, then TCGplayer product photos (via tcgcsv.com)
//   Japanese:  TCGplayer "Pokemon Japan" product photos, matched by set code + number
//   Chinese (Traditional) / Thai / Indonesian: these sets share set codes and numbering with the
//              Japanese releases, so a missing picture falls back to the Japanese print's picture
//              (marked on the site as "JP image").
//
// Found images are kept in data/image-fill.json, so a rebuild or an outage never loses them.
// Runs at the end of build-data.mjs, or on its own:  node scripts/fill-images.mjs [--lang=ja]

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const UA = { 'User-Agent': 'PokeVault card tracker (github.com/dominicjerome/Pokedex-tracker2)', Accept: 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, tries = 5) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: UA });
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
/** "006/165" -> "6", "SV001" -> "sv1", "TG05" -> "tg5", "060a" -> "60a" */
const numKey = (n) => String(n).split('/')[0].trim().toLowerCase().replace(/^([a-z]*)0+(?=\d)/, '$1');
const hasImage = (c) => !!(c.img || c.ims);
const big = (tcgUrl) => tcgUrl.replace('_200w', '_in_1000x1000');

// Candidate images are checked before use: TCGplayer lists some products whose photo was never uploaded.
let PENDING = [];
const propose = (s, c, img) => PENDING.push({ s, c, img });
async function urlWorks(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': UA['User-Agent'] } });
      if (r.ok) return true;
      if (r.status === 403 || r.status === 404) return false;
    } catch {}
    await sleep(500 * (i + 1));
  }
  return false;
}
async function commitPending(cache) {
  const list = PENDING;
  PENDING = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      while (i < list.length) {
        const { s, c, img } = list[i++];
        if (await urlWorks(img.s)) {
          cache[c.id] = img;
          Object.assign(c, { ims: img.s, iml: img.l });
          s.dirty = true;
        }
      }
    }),
  );
}

const dirOf = (lang) => (lang === 'en' ? DATA : path.join(DATA, lang));
const fileOf = (lang, setId) => path.join(dirOf(lang), 'sets', `${lang === 'en' ? setId : setId.slice(setId.indexOf('/') + 1)}.json`);

async function loadSets(lang) {
  const idxPath = path.join(dirOf(lang), 'sets.json');
  if (!existsSync(idxPath)) return [];
  const index = JSON.parse(await readFile(idxPath, 'utf8'));
  const out = [];
  for (const meta of index.sets) {
    const file = fileOf(lang, meta.id);
    if (existsSync(file)) out.push({ meta, file, set: JSON.parse(await readFile(file, 'utf8')), dirty: false });
  }
  return out;
}

/** a TCGplayer group's cards: list, and number -> [products] */
async function tcgProducts(category, groupId) {
  const r = await get(`https://tcgcsv.com/tcgplayer/${category}/${groupId}/products`);
  const list = r.results.filter((p) => p.imageUrl && !/booster|box|pack$|case|bundle|deck$|tin$/i.test(p.name));
  const byNum = new Map();
  for (const p of list) {
    const number = (p.extendedData || []).find((e) => e.name === 'Number')?.value;
    if (!number) continue;
    const k = numKey(number);
    if (!byNum.has(k)) byNum.set(k, []);
    byNum.get(k).push(p);
  }
  return { list, byNum };
}
const tcgName = (p) => norm(p.name.split(' - ')[0].replace(/\s*[([].*$/, ''));
const sameName = (a, b) => a && b && (a.startsWith(b.slice(0, 5)) || b.startsWith(a.slice(0, 5)));
/** pick the product for a card: by number (+ name check), else by a unique name */
function matchProduct(c, prods, wantName, hint = '') {
  const byNum = (prods.byNum.get(numKey(c.n)) || []).filter((p) => !wantName || sameName(tcgName(p), wantName));
  if (byNum.length === 1) return byNum[0];
  if (byNum.length > 1) return byNum.find((p) => hint && norm(p.name).includes(hint)) || byNum[0];
  if (!wantName || prods.byNum.size > prods.list.length / 2) return null; // numbered group – don't guess by name
  const byName = prods.list.filter((p) => tcgName(p) === wantName);
  return byName.length === 1 ? byName[0] : null;
}

async function fillEnglish(sets, cache, log) {
  const missing = () => sets.filter((s) => s.set.cards.some((c) => !hasImage(c)));
  // 1) pokemontcg.io scans
  try {
    const ptcg = (await get('https://api.pokemontcg.io/v2/sets?pageSize=250')).data;
    const byName = new Map(ptcg.map((p) => [norm(p.name), p]));
    const byId = new Map(ptcg.map((p) => [p.id, p]));
    for (const s of missing()) {
      const p = byName.get(norm(s.set.name)) || byId.get(s.set.id.replace(/\./g, 'pt')) || byId.get(s.set.id.replace(/\./g, ''));
      if (!p) continue;
      let cards;
      try {
        cards = (await get(`https://api.pokemontcg.io/v2/cards?q=set.id:${p.id}&pageSize=250&select=number,name,images`)).data;
      } catch {
        continue;
      }
      const byNum = new Map(cards.map((c) => [numKey(c.number), c]));
      for (const c of s.set.cards) {
        if (hasImage(c)) continue;
        const hit = byNum.get(numKey(c.n));
        if (hit?.images?.small && (norm(hit.name).startsWith(norm(c.name).slice(0, 5)) || norm(c.name).startsWith(norm(hit.name).slice(0, 5)))) {
          propose(s, c, { s: hit.images.small, l: hit.images.large || hit.images.small, src: 'pokemontcg.io' });
        }
      }
    }
  } catch (e) {
    log(`  pokemontcg.io unavailable (${e.message.slice(0, 80)})`);
  }
  await commitPending(cache);
  // 2) TCGplayer product photos
  try {
    const groups = (await get('https://tcgcsv.com/tcgplayer/3/groups')).results;
    const gByName = new Map();
    for (const g of groups) {
      gByName.set(norm(g.name), g);
      gByName.set(norm(g.name.replace(/^[A-Za-z0-9.]+:\s*/, '')), g); // "SV01: Scarlet & Violet Base Set"
    }
    const EN_ALIASES = {
      mep: 'ME: Mega Evolution Promo', svp: 'SV: Scarlet & Violet Promo Cards', swshp: 'SWSH: Sword & Shield Promo Cards',
      smp: 'SM Promos', xyp: 'XY Promos', bwp: 'Black and White Promos', hgssp: 'HGSS Promos', dpp: 'Diamond and Pearl Promos',
      np: 'Nintendo Promos', basep: 'WoTC Promo', '30th-c': 'ME: 30th Celebration Classic Collection', mfb: 'My First Battle',
    };
    for (const s of missing()) {
      const n = s.set.name;
      // trainer kits: TCGplayer has one group per pair, e.g. "XY Trainer Kit: Sylveon & Noivern"
      const kit = n.match(/trainer kit.*\((.+)\)/i);
      const g =
        gByName.get(norm(EN_ALIASES[s.set.id] || '')) ||
        gByName.get(norm(n)) ||
        gByName.get(norm(n.replace(/Black Star Promos/i, 'Promo Cards'))) ||
        (kit && groups.find((x) => /trainer kit/i.test(x.name) && norm(x.name).includes(norm(kit[1])) && norm(x.name).startsWith(norm(n.split(' ')[0]))));
      if (!g) continue;
      let products;
      try {
        products = await tcgProducts(3, g.groupId);
      } catch {
        continue;
      }
      const byNameOnly = s.set.id === '30th-c'; // reprints keep their original numbers there
      for (const c of s.set.cards) {
        if (hasImage(c)) continue;
        const p = byNameOnly
          ? (() => { const m = products.list.filter((x) => tcgName(x) === norm(c.name) || tcgName(x).startsWith(norm(c.name))); return m.length === 1 ? m[0] : null; })()
          : matchProduct(c, products, norm(c.name), kit ? norm(kit[1]) : '');
        if (p) {
          propose(s, c, { s: p.imageUrl, l: big(p.imageUrl), src: 'TCGplayer' });
        }
      }
      await sleep(100);
    }
  } catch (e) {
    log(`  TCGplayer catalogue unavailable (${e.message.slice(0, 80)})`);
  }
  await commitPending(cache);
}

async function fillJapanese(sets, cache, log) {
  try {
    const groups = (await get('https://tcgcsv.com/tcgplayer/85/groups')).results;
    const gByCode = new Map();
    for (const g of groups) if (g.abbreviation) gByCode.set(g.abbreviation.toLowerCase(), g);
    // older sets have no code on TCGplayer – map them by their English names
    const JA_GROUPS = {
      pmcg1: 'Expansion Pack', pmcg2: 'Pokemon Jungle', pmcg3: 'Mystery of the Fossils', pmcg4: 'Rocket Gang', pmcg5: "Leaders' Stadium",
      pmcg6: 'Challenge from the Darkness', neo1: 'Gold, Silver, to a New World...', neo2: 'Crossing the Ruins...', neo3: 'Awakening Legends',
      neo4: 'Darkness, and to Light...', vs1: 'Pokemon VS', web1: 'Pokemon Web', e1: 'Base Expansion Pack', e2: 'The Town on No Map',
      e3: 'Wind from the Sea', e4: 'Split Earth', e5: 'Mysterious Mountains', pcg1: 'Flight of Legends', pcg2: 'Clash of the Blue Sky',
      pcg3: 'Rocket Gang Strikes Back', pcg4: 'Golden Sky, Silvery Ocean', pcg5: 'Mirage Forest', pcg6: 'Holon Research Tower',
      pcg7: 'Holon Phantom', pcg8: 'Miracle Crystal', pcg9: 'Offense and Defense of the Furthest Ends', sm1p: 'SM1+: Sun & Moon',
      sm2p: 'SM2+: Facing a New Trial', sm3p: 'SM3+: Shining Legends', sm4p: 'SM4+: GX Battle Boost', sm5p: 'SM5+: Ultra Force',
      mc: 'Start Deck 100 Battle Collection',
    };
    for (const [code, name] of Object.entries(JA_GROUPS)) {
      const g = groups.find((x) => x.name === name);
      if (g && !gByCode.has(code)) gByCode.set(code, g);
    }
    // gym leaders and others whose cards carry an owner ("Brock's Zubat")
    const OWNERS = { タケシ: "Brock's", カスミ: "Misty's", マチス: "Lt. Surge's", エリカ: "Erika's", キョウ: "Koga's", ナツメ: "Sabrina's", カツラ: "Blaine's", サカキ: "Giovanni's", ロケット団: "Rocket's", わるい: 'Dark', ひかる: 'Shining' };
    const englishName = (c) => {
      if (!c.en) return null;
      for (const [jp, en] of Object.entries(OWNERS)) if (c.name.startsWith(jp)) return norm(`${en} ${c.en}`);
      return norm(c.en);
    };
    for (const s of sets) {
      if (!s.set.cards.some((c) => !hasImage(c))) continue;
      const code = s.set.id.split('/')[1].toLowerCase();
      const g = gByCode.get(code);
      if (!g) continue;
      let products;
      try {
        products = await tcgProducts(85, g.groupId);
      } catch {
        continue;
      }
      for (const c of s.set.cards) {
        if (hasImage(c)) continue;
        // TCGplayer names Japanese cards in English – check against the Pokémon's English name when we know it
        let p = (products.byNum.get(numKey(c.n)) || []).find((x) => !c.en || c.en.split(' & ').some((n) => tcgName(x).includes(norm(n))));
        if (!p && products.byNum.size < products.list.length / 2 && englishName(c)) {
          // unnumbered old set: only take a name that is unique on both sides
          const want = englishName(c);
          const mine = s.set.cards.filter((x) => englishName(x) === want).length;
          const theirs = products.list.filter((x) => tcgName(x) === want);
          if (mine === 1 && theirs.length === 1) p = theirs[0];
        }
        if (!p) continue;
        propose(s, c, { s: p.imageUrl, l: big(p.imageUrl), src: 'TCGplayer' });
      }
      await sleep(100);
    }
  } catch (e) {
    log(`  TCGplayer Japan catalogue unavailable (${e.message.slice(0, 80)})`);
  }
  await commitPending(cache);
}

/** Chinese / Thai / Indonesian: borrow the Japanese print's picture for the same set code and number */
async function fillFromJapanese(sets) {
  const jaSets = await loadSets('ja');
  const jaByCode = new Map(jaSets.map((s) => [s.set.id.split('/')[1].toLowerCase(), s.set]));
  for (const s of sets) {
    const ja = jaByCode.get(s.set.id.split('/')[1].toLowerCase());
    if (!ja) continue;
    const jaByNum = new Map(ja.cards.map((c) => [numKey(c.n), c]));
    for (const c of s.set.cards) {
      if (hasImage(c)) continue;
      const j = jaByNum.get(numKey(c.n));
      if (!j || !hasImage(j)) continue;
      if (c.en && j.en && c.en !== j.en) continue; // must be the same Pokémon
      const sm = j.img ? `${j.img}/low.webp` : j.ims;
      const lg = j.img ? `${j.img}/high.webp` : j.iml;
      Object.assign(c, { ims: sm, iml: lg, imlang: 'ja' });
      s.dirty = true;
    }
  }
}

export async function fillImages(lang = 'en', { log = console.log } = {}) {
  const cachePath = path.join(DATA, 'image-fill.json');
  const cache = existsSync(cachePath) ? JSON.parse(await readFile(cachePath, 'utf8')) : {};
  const sets = await loadSets(lang);
  const before = sets.reduce((a, s) => a + s.set.cards.filter((c) => !hasImage(c)).length, 0);
  // re-apply images found on earlier runs
  for (const s of sets)
    for (const c of s.set.cards)
      if (!hasImage(c) && cache[c.id]) {
        Object.assign(c, { ims: cache[c.id].s, iml: cache[c.id].l });
        s.dirty = true;
      }
  if (lang === 'en') await fillEnglish(sets, cache, log);
  else if (lang === 'ja') await fillJapanese(sets, cache, log);
  else await fillFromJapanese(sets);
  for (const s of sets) if (s.dirty) await writeFile(s.file, JSON.stringify(s.set));
  await writeFile(cachePath, JSON.stringify(cache));
  const after = sets.reduce((a, s) => a + s.set.cards.filter((c) => !hasImage(c)).length, 0);
  log(`Images (${lang}): ${before - after} filled, ${after} still missing`);
  return before - after;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const lang = (process.argv.find((a) => a.startsWith('--lang=')) || '--lang=en').slice(7);
  fillImages(lang).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
