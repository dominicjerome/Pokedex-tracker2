// PokéVault – Pokémon TCG master-set tracker
// Static single-page app. Card data lives in /data (built by scripts/build-data.mjs),
// the user's collection lives in localStorage.

const $ = (sel, el = document) => el.querySelector(sel);
const app = $('#app');
const modal = $('#modal');

const LS_COLLECTION = 'pokevault.collection.v1';
const LS_PREFS = 'pokevault.prefs.v1';
// Exchange rates per 1 EUR. Defaults are replaced by today's ECB rates (frankfurter.dev).
const LS_FX = 'pokevault.fx.v1';
let FX = { USD: 1.12, GBP: 0.84, date: null, t: 0 };

// --------------------------------------------------------------------------
// Storage
// --------------------------------------------------------------------------
function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    toast('Could not save – browser storage is full or blocked');
  }
}

/** collection: { "<cardId>|<variantKey>": { q: quantity, t: addedTimestamp } } */
let collection = load(LS_COLLECTION, {});
const prefs = Object.assign(
  { currency: 'GBP', mode: 'master', layout: 'grid', filter: 'all', sort: 'number', exSort: 'value-desc', exFilter: 'all', exSeries: 'all', setsSort: 'newest', tile: 160 },
  load(LS_PREFS, {}),
);
// one-off move to pounds as the default currency
if (!prefs.cv) {
  prefs.currency = 'GBP';
  prefs.cv = 1;
}
// "standard" = the cards + their regular printings (what checklists count); "true" = everything
if (!prefs.master) prefs.master = prefs.stamps === 'hide' ? 'standard' : 'true';
delete prefs.stamps;
const savePrefs = () => save(LS_PREFS, prefs);
FX = Object.assign(FX, load(LS_FX, {}));

/** Refresh exchange rates at most every 12 hours. Returns true if they changed. */
async function loadRates() {
  if (Date.now() - FX.t < 12 * 60 * 60 * 1000) return false;
  try {
    const r = await fetch('https://api.frankfurter.dev/v1/latest?base=EUR&symbols=GBP,USD');
    if (!r.ok) return false;
    const d = await r.json();
    if (!d.rates?.GBP || !d.rates?.USD) return false;
    const changed = Math.abs(d.rates.GBP - FX.GBP) > 0.001 || Math.abs(d.rates.USD - FX.USD) > 0.001;
    FX = { USD: d.rates.USD, GBP: d.rates.GBP, date: d.date, t: Date.now() };
    save(LS_FX, FX);
    return changed;
  } catch {
    return false;
  }
}
// Removed cards are remembered ("tombstones") so a removal syncs to other devices.
const LS_TOMBS = 'pokevault.deleted.v1';
let tombs = load(LS_TOMBS, {}); // { key: removedAt }
// Custom binders: { id: { id, name, cards: [cardKey], layout, created, m } }; deleted ones keep { id, del, m }
const LS_BINDERS = 'pokevault.binders.v1';
let binders = load(LS_BINDERS, {});
function saveCollection({ fromSync = false } = {}) {
  save(LS_COLLECTION, collection);
  save(LS_TOMBS, tombs);
  save(LS_BINDERS, binders);
  if (!fromSync) Sync.changed();
}
/** remove everything (keeps tombstones so other devices remove it too) */
function clearCollection() {
  const now = Date.now();
  for (const k of Object.keys(collection)) tombs[k] = now;
  collection = {};
}

// Jumbo printings now live in their own "Jumbo Cards" set: "sv01-001|holo@jumbo" -> "jumbo-sv01_001|holo@jumbo".
// Runs on load and after every sync, and leaves a tombstone so other devices drop the old key too.
function jumboKey(key) {
  const [cardId, vk] = key.split('|');
  if (!vk || !vk.includes('@jumbo') || /(^|\/)jumbo-/.test(cardId)) return null;
  const slash = cardId.indexOf('/') + 1; // language prefix, e.g. "ja/"
  const dash = cardId.lastIndexOf('-');
  return `${cardId.slice(0, slash)}jumbo-${cardId.slice(slash, dash)}_${cardId.slice(dash + 1)}|${vk}`;
}
function migrateJumbos() {
  let changed = false;
  const now = Date.now();
  for (const k of Object.keys(collection)) {
    const nk = jumboKey(k);
    if (!nk) continue;
    if (!collection[nk]) collection[nk] = { ...collection[k], m: now };
    delete collection[k];
    tombs[k] = now;
    delete tombs[nk];
    changed = true;
  }
  for (const b of Object.values(binders)) {
    if (!b.cards) continue;
    const cards = b.cards.map((k) => jumboKey(k) || k);
    if (cards.join() !== b.cards.join()) ((b.cards = cards), (b.m = now), (changed = true));
  }
  return changed;
}

const keyOf = (cardId, vk) => `${cardId}|${vk}`;
// An entry is { q: raw copies, g: [graded copies], t: added, m: modified }.
// Graded copy ("slab"): { id, co: grader, gr: grade, v: value|null, cur: currency of v, cert }
const entryOf = (cardId, vk) => collection[keyOf(cardId, vk)];
const rawOf = (cardId, vk) => entryOf(cardId, vk)?.q || 0;
const gradedOf = (cardId, vk) => entryOf(cardId, vk)?.g || [];
/** all copies, raw + graded (anything > 0 counts as owned) */
const qtyOf = (cardId, vk) => rawOf(cardId, vk) + gradedOf(cardId, vk).length;
const setIdOfCard = (cardId) => cardId.slice(0, cardId.lastIndexOf('-'));

function putEntry(k, q, g) {
  const now = Date.now();
  if (q > 0 || g.length) {
    collection[k] = { q: Math.max(0, q), t: collection[k]?.t || now, m: now };
    if (g.length) collection[k].g = g;
    delete tombs[k];
  } else if (collection[k]) {
    delete collection[k];
    tombs[k] = now;
  }
  saveCollection();
}
/** set the number of raw (ungraded) copies; graded copies are kept */
function setQty(cardId, vk, q) {
  putEntry(keyOf(cardId, vk), q, gradedOf(cardId, vk));
}
function addGraded(cardId, vk, slab) {
  const g = [...gradedOf(cardId, vk), { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ...slab }];
  putEntry(keyOf(cardId, vk), rawOf(cardId, vk), g);
}
function removeGraded(cardId, vk, id) {
  putEntry(keyOf(cardId, vk), rawOf(cardId, vk), gradedOf(cardId, vk).filter((x) => x.id !== id));
}

// --------------------------------------------------------------------------
// Sync across devices via a private GitHub Gist.
// Each "profile" is its own file in one gist, so two people can keep separate
// collections (own GitHub accounts, or one account with two profile names).
// Merging is per card: the most recent change (add, quantity or removal) wins.
// --------------------------------------------------------------------------
const Sync = (() => {
  const LS_SYNC = 'pokevault.sync.v1';
  const API = 'https://api.github.com';
  const DESC = 'PokéVault collection (synced by the PokéVault website)';
  const TOMB_KEEP = 180 * 24 * 60 * 60 * 1000;
  let cfg = load(LS_SYNC, null); // { token, profile, login, gistId, last }
  let state = cfg ? 'idle' : 'off';
  let message = '';
  let inflight = null;
  let again = false;
  let pushTimer = null;
  const listeners = new Set();

  const fileName = () => `pokevault-${(cfg?.profile || 'main').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`;
  const saveCfg = () => (cfg ? save(LS_SYNC, cfg) : localStorage.removeItem(LS_SYNC));
  const setState = (s, msg = '') => {
    state = s;
    message = msg;
    listeners.forEach((fn) => fn());
  };

  async function gh(path, opts = {}) {
    const res = await fetch(API + path, {
      ...opts,
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${cfg.token}`,
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    if (!res.ok) {
      const err = new Error(`GitHub ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }

  const payload = () => JSON.stringify({ app: 'pokevault', version: 2, updated: new Date().toISOString(), collection, deleted: tombs, binders });

  async function findOrCreateGist() {
    if (cfg.gistId) return cfg.gistId;
    for (let page = 1; page <= 5; page++) {
      const list = await gh(`/gists?per_page=100&page=${page}`);
      const hit = list.find((g) => g.description === DESC);
      if (hit) return (cfg.gistId = hit.id);
      if (list.length < 100) break;
    }
    const g = await gh('/gists', {
      method: 'POST',
      body: JSON.stringify({ description: DESC, public: false, files: { [fileName()]: { content: payload() } } }),
    });
    return (cfg.gistId = g.id);
  }

  async function readRemote() {
    const g = await gh(`/gists/${cfg.gistId}`);
    const f = g.files?.[fileName()];
    if (!f) return null;
    const text = f.truncated ? await (await fetch(f.raw_url, { cache: 'no-store' })).text() : f.content;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /** merge remote into local; returns { localChanged, remoteStale } */
  function merge(remote) {
    const R = remote?.collection || {};
    const RD = remote?.deleted || {};
    const stamp = (e) => e?.m || e?.t || 0;
    let localChanged = false;
    for (const [k, r] of Object.entries(R)) {
      const local = collection[k];
      const lm = local ? stamp(local) : tombs[k] || -1;
      if (stamp(r) > lm) {
        if (!local || local.q !== r.q || JSON.stringify(local.g) !== JSON.stringify(r.g)) localChanged = true;
        collection[k] = { q: r.q || 0, t: r.t || stamp(r), m: stamp(r) };
        if (r.g?.length) collection[k].g = r.g;
        delete tombs[k];
      }
    }
    for (const [k, dm] of Object.entries(RD)) {
      const local = collection[k];
      if (local && dm > stamp(local)) {
        delete collection[k];
        tombs[k] = dm;
        localChanged = true;
      } else if (!local && (tombs[k] || 0) < dm) tombs[k] = dm;
    }
    const cutoff = Date.now() - TOMB_KEEP;
    for (const [k, m] of Object.entries(tombs)) if (m < cutoff) delete tombs[k];
    // does the remote copy miss anything we have?
    let remoteStale = !remote;
    if (!remoteStale) {
      for (const [k, e] of Object.entries(collection))
        if (!R[k] || stamp(R[k]) !== stamp(e) || R[k].q !== e.q || JSON.stringify(R[k].g) !== JSON.stringify(e.g)) { remoteStale = true; break; }
      if (!remoteStale) for (const k of Object.keys(R)) if (!collection[k]) { remoteStale = true; break; }
      if (!remoteStale) for (const [k, m] of Object.entries(tombs)) if (RD[k] !== m) { remoteStale = true; break; }
    }
    // binders: whole binder, most recent change wins (deletions included)
    const RB = remote?.binders || {};
    for (const [id, rb] of Object.entries(RB)) {
      if (!binders[id] || (rb.m || 0) > (binders[id].m || 0)) {
        binders[id] = rb;
        localChanged = true;
      }
    }
    if (!remoteStale) for (const [id, b] of Object.entries(binders)) if (!RB[id] || RB[id].m !== b.m) { remoteStale = true; break; }
    return { localChanged, remoteStale };
  }

  async function runOnce() {
    setState('syncing');
    try {
      await findOrCreateGist();
      let remote;
      try {
        remote = await readRemote();
      } catch (e) {
        if (e.status !== 404) throw e;
        cfg.gistId = null; // gist was deleted – make a new one
        await findOrCreateGist();
        remote = await readRemote();
      }
      const merged = merge(remote);
      const migrated = migrateJumbos();
      const localChanged = merged.localChanged || migrated, remoteStale = merged.remoteStale || migrated;
      if (localChanged || remoteStale) saveCollection({ fromSync: true });
      if (remoteStale) {
        await gh(`/gists/${cfg.gistId}`, { method: 'PATCH', body: JSON.stringify({ files: { [fileName()]: { content: payload() } } }) });
      }
      cfg.last = Date.now();
      saveCfg();
      setState('idle');
      if (localChanged) onRemoteChange();
    } catch (e) {
      console.warn('Sync failed', e);
      if (e.status === 401) setState('error', 'GitHub rejected the token. Check it in Settings.');
      else if (e.status === 403 || e.status === 429) setState('error', 'GitHub is limiting requests. Will retry shortly.');
      else if (e.status === 404) setState('error', 'This token cannot access gists. Make sure the "gist" permission is ticked.');
      else setState('error', navigator.onLine === false ? 'You are offline. Changes will sync when you reconnect.' : 'Could not reach GitHub. Will retry shortly.');
    }
  }

  function sync() {
    if (!cfg) return Promise.resolve();
    if (inflight) {
      again = true;
      return inflight;
    }
    inflight = runOnce().finally(() => {
      inflight = null;
      if (again) {
        again = false;
        sync();
      }
    });
    return inflight;
  }

  let pendingRedraw = false;
  function onRemoteChange() {
    if (modal.open || selectMode) pendingRedraw = true;
    else route(true);
  }

  // auto-sync: on focus, when coming back online and every minute while visible
  window.addEventListener('focus', () => sync());
  window.addEventListener('online', () => sync());
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && sync());
  setInterval(() => document.visibilityState === 'visible' && sync(), 60 * 1000);

  return {
    get enabled() { return !!cfg; },
    get state() { return state; },
    get message() { return message; },
    get cfg() { return cfg; },
    fileName,
    subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    sync,
    flushRedraw() {
      if (pendingRedraw) {
        pendingRedraw = false;
        route(true);
      }
    },
    /** local edit: push a couple of seconds later (batches quick clicks) */
    changed() {
      if (!cfg) return;
      setState('pending');
      clearTimeout(pushTimer);
      pushTimer = setTimeout(sync, 2000);
    },
    async connect(token, profile) {
      const prev = cfg;
      cfg = { token: token.trim(), profile: (profile || 'main').trim() || 'main', gistId: null, last: 0 };
      try {
        const me = await gh('/user');
        cfg.login = me.login;
      } catch (e) {
        cfg = prev;
        throw new Error(e.status === 401 ? 'GitHub did not accept that token.' : 'Could not reach GitHub. Check your connection and try again.');
      }
      saveCfg();
      await sync();
      if (state === 'error') throw new Error(message);
    },
    disconnect() {
      cfg = null;
      saveCfg();
      setState('off');
    },
  };
})();

// --------------------------------------------------------------------------
// Data
// --------------------------------------------------------------------------
let INDEX = null; // { sets: [...] }
const setCache = new Map();

// Card catalogues. English lives in data/, the others in data/<lang>/ with "<lang>/" id prefixes.
const LANGS = [
  { id: 'en', name: 'English', short: 'EN' },
  { id: 'ja', name: '日本語 Japanese', short: 'JP' },
  { id: 'zh-tw', name: '繁體中文 Chinese', short: 'ZH' },
  { id: 'th', name: 'ไทย Thai', short: 'TH' },
  { id: 'id', name: 'Indonesian', short: 'ID' },
];
const langInfo = (id) => LANGS.find((l) => l.id === id) || LANGS[0];
const langOf = (setOrCardId) => (setOrCardId.includes('/') ? setOrCardId.split('/')[0] : 'en');
const rawId = (id) => (id.includes('/') ? id.slice(id.indexOf('/') + 1) : id);
const INDEXES = {};
const ALLMETA = new Map(); // set id -> index entry, across every loaded language

async function getIndex(lang = 'en') {
  if (INDEXES[lang]) return INDEXES[lang];
  const res = await fetch(lang === 'en' ? 'data/sets.json' : `data/${lang}/sets.json`, { cache: 'no-cache' });
  if (!res.ok) {
    if (lang === 'en') throw new Error('Could not load set list');
    INDEXES[lang] = { sets: [], byId: new Map(), missing: true };
    return INDEXES[lang];
  }
  const idx = await res.json();
  idx.byId = new Map(idx.sets.map((s) => [s.id, s]));
  idx.sets.forEach((s) => ALLMETA.set(s.id, s));
  INDEXES[lang] = idx;
  if (lang === 'en') INDEX = idx;
  return idx;
}
/** load the indexes for every language that appears in the given set ids */
async function getIndexesFor(ids) {
  await Promise.all([...new Set(['en', ...ids.map(langOf)])].map((l) => getIndex(l)));
  return ALLMETA;
}

function getSet(id) {
  if (!setCache.has(id)) {
    const lang = langOf(id);
    const p = fetch(lang === 'en' ? `data/sets/${encodeURIComponent(id)}.json` : `data/${lang}/sets/${encodeURIComponent(rawId(id))}.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`Set ${id} not found`);
        return r.json();
      })
      .then((s) => {
        s.cards.forEach((c, i) => {
          c.idx = i;
          applyLive(c);
        });
        return s;
      });
    p.catch(() => setCache.delete(id));
    setCache.set(id, p);
  }
  return setCache.get(id);
}

// --------------------------------------------------------------------------
// Live prices – fetched from TCGdex in the browser, cached for LIVE_TTL.
// The pricing rules mirror scripts/build-data.mjs so keys and prices match.
// --------------------------------------------------------------------------
const LS_LIVE = 'pokevault.live.v1';
const LIVE_TTL = 12 * 60 * 60 * 1000;
/** live: { cardId: { t: fetchedAt, p: { variantKey: [usd|null, eur|null] } } } */
let live = load(LS_LIVE, {});
const liveFresh = (id) => live[id] && Date.now() - live[id].t < LIVE_TTL;

function saveLive() {
  const now = Date.now();
  for (const id of Object.keys(live)) if (now - live[id].t > LIVE_TTL) delete live[id];
  save(LS_LIVE, live);
}

function applyLive(card) {
  if (!liveFresh(card.id)) return false;
  const p = live[card.id].p;
  for (const v of card.v) {
    const lp = p[v.k];
    if (!lp) continue;
    if (v.im || v.src) continue; // keep TCGplayer's own price for stamped / added printings
    if (lp[0] != null) v.u = lp[0];
    if (lp[1] != null) v.e = lp[1];
  }
  return true;
}

const r2 = (n) => (typeof n === 'number' && n > 0 ? Math.round(n * 100) / 100 : null);
function tpPrice(tp, v) {
  if (!tp) return null;
  const keys = Object.keys(tp).filter((k) => tp[k] && typeof tp[k] === 'object');
  if (!keys.length) return null;
  const pick = (p) => r2(p.marketPrice ?? p.midPrice ?? p.lowPrice);
  const prefs = [];
  if ((v.stamp || []).includes('1st-edition')) prefs.push(v.type === 'normal' ? '1st-edition-normal' : '1st-edition-holofoil', '1st-edition');
  if (v.type === 'reverse') prefs.push('reverse-holofoil');
  else if (v.type === 'normal') prefs.push('normal', 'unlimited');
  else prefs.push('holofoil', 'unlimited-holofoil', 'normal', 'unlimited');
  for (const k of prefs) if (tp[k]) return pick(tp[k]);
  return keys.length === 1 ? pick(tp[keys[0]]) : null;
}
function cmPrice(cm, v) {
  if (!cm) return null;
  return v.type === 'reverse' ? r2(cm['trend-holo'] || cm['avg30-holo'] || cm['avg-holo']) : r2(cm.trend || cm.avg30 || cm.avg);
}
function rawVariantKey(v) {
  let k = v.type;
  if (v.subtype) k += '~' + v.subtype;
  if (v.foil) k += ':' + v.foil;
  if (v.stamp && v.stamp.length) k += '#' + v.stamp.join('+');
  if (v.size && v.size !== 'standard') k += '@' + v.size;
  return k;
}
/** { variantKey: [usd, eur] } from a TCGdex card response */
function pricesFromApi(c) {
  let list = Array.isArray(c.variants_detailed) && c.variants_detailed.length ? c.variants_detailed : null;
  if (!list) {
    const f = c.variants || {};
    list = [];
    if (f.firstEdition) list.push({ type: f.holo ? 'holo' : 'normal', stamp: ['1st-edition'] });
    if (f.normal) list.push({ type: 'normal' });
    if (f.holo) list.push({ type: 'holo' });
    if (f.reverse) list.push({ type: 'reverse' });
    if (!list.length) list.push({ type: 'normal' });
  }
  const out = {};
  for (const v of list) {
    const plain = !(v.stamp && v.stamp.length) && !v.foil && (v.size || 'standard') === 'standard' && (!v.subtype || v.subtype === 'unlimited');
    const own = v.pricing || null;
    const fb = plain ? c.pricing || null : null;
    out[rawVariantKey(v)] = [
      tpPrice(own?.tcgplayer, v) ?? tpPrice(fb?.tcgplayer, v),
      cmPrice(own?.cardmarket, v) ?? cmPrice(fb?.cardmarket, v),
    ];
  }
  return out;
}

let liveDown = 0; // time of the last failure, to back off when TCGdex is unreachable
/**
 * Fetch live prices for the given cards (skips ones fetched recently).
 * Returns how many cards were updated; onProgress(done, total) reports progress.
 */
async function refreshLive(cards, onProgress) {
  if (Date.now() - liveDown < 5 * 60 * 1000) return { updated: 0, failed: true };
  const todo = cards.filter((c) => !c.src && !liveFresh(c.id));
  let done = 0, updated = 0, failures = 0, i = 0;
  onProgress?.(0, todo.length);
  await Promise.all(
    Array.from({ length: Math.min(6, todo.length) }, async () => {
      while (i < todo.length && failures < 8) {
        const card = todo[i++];
        try {
          const res = await fetch(`https://api.tcgdex.net/v2/${langOf(card.id)}/cards/${encodeURIComponent(rawId(card.id))}`);
          if (!res.ok) throw new Error(res.status);
          live[card.id] = { t: Date.now(), p: pricesFromApi(await res.json()) };
          if (applyLive(card)) updated++;
        } catch {
          failures++;
        }
        onProgress?.(++done, todo.length);
        if (done % 40 === 0) saveLive();
      }
    }),
  );
  saveLive();
  if (failures >= 8) liveDown = Date.now();
  return { updated, failed: failures >= 8, skipped: cards.length - todo.length };
}

/** Load live prices for `cards`, show progress in #live, call redraw() if anything changed. */
function startLive(cards, redraw) {
  cards = cards.filter((c) => !c.src); // cards from pokemontcg.io have no TCGdex live price
  const seq = routeSeq;
  const el = () => (seq === routeSeq ? $('#live') : null);
  const show = (html) => el() && (el().innerHTML = html);
  if (!cards.length) return;
  refreshLive(cards, (d, t) => {
    if (t) show(`<span class="live-dot busy"></span>Updating live prices… ${d}/${t}`);
  }).then((r) => {
    if (seq !== routeSeq) return;
    if (r.updated) redraw();
    const allLive = cards.every((c) => liveFresh(c.id));
    show(
      allLive
        ? `<span class="live-dot"></span>Live prices · updated ${agoText(Math.min(...cards.map((c) => live[c.id].t)))}`
        : `<span class="live-dot off"></span>Saved prices from ${new Date(INDEX.updated).toLocaleDateString()}${r.failed ? ' (live prices unavailable right now)' : ''}`,
    );
  });
}
function agoText(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

async function getSets(ids, onProgress) {
  let done = 0;
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (i < ids.length) {
        const id = ids[i++];
        try {
          out.push(await getSet(id));
        } catch {
          /* skip missing set */
        }
        onProgress?.(++done, ids.length);
      }
    }),
  );
  return out;
}

/** owned slot count per set straight from the collection keys */
/** owned printings per set (stamped ones left out while they're hidden) */
function ownedBySet() {
  const m = new Map();
  for (const k of Object.keys(collection)) {
    if (prefs.master === 'standard' && !isStandardKey(k)) continue;
    const sid = setIdOfCard(k.split('|')[0]);
    m.set(sid, (m.get(sid) || 0) + 1);
  }
  return m;
}

// --------------------------------------------------------------------------
// Formatting
// --------------------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** price of a variant in the chosen currency → { v: number|null, approx: bool } */
function priceOf(v) {
  const cur = prefs.currency;
  if (cur === 'USD') {
    if (v.u != null) return { v: v.u, approx: false };
    if (v.e != null) return { v: v.e * FX.USD, approx: true };
  } else {
    // EUR and GBP both come from Cardmarket (GBP converted at today's rate)
    const k = cur === 'GBP' ? FX.GBP : 1;
    if (v.e != null) return { v: v.e * k, approx: false };
    if (v.u != null) return { v: (v.u / FX.USD) * k, approx: true };
  }
  return { v: null, approx: false };
}
/** whole-set value from the set index, in the chosen currency */
const setValue = (s) => (prefs.currency === 'USD' ? s.valueUSD : prefs.currency === 'GBP' ? (s.valueEUR || 0) * FX.GBP : s.valueEUR) || 0;
const priceSource = () =>
  prefs.currency === 'USD' ? 'TCGplayer market prices' : prefs.currency === 'GBP' ? 'Cardmarket prices in pounds' : 'Cardmarket trend prices';
const priceNum = (v) => priceOf(v).v ?? 0;
/** convert an amount entered in `cur` into the selected currency */
function toCur(amount, cur) {
  const eur = cur === 'EUR' ? amount : cur === 'GBP' ? amount / FX.GBP : amount / FX.USD;
  return prefs.currency === 'EUR' ? eur : eur * FX[prefs.currency];
}
/** value of one graded copy; without an entered value it counts at the raw price */
// Graded market prices (eBay sold, via Pokemon Price Tracker) – data/graded.json, built by a daily job
let GRADED = {};
let GRADED_UPDATED = null;
let gradedLoad = null;
function getGraded() {
  gradedLoad ||= fetch('data/graded.json', { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : {}))
    .then((d) => ((GRADED = d.cards || {}), (GRADED_UPDATED = d.updated || null)))
    .catch(() => {});
  return gradedLoad;
}
const isGraded = (sl) => sl.co !== 'Raw';
/** market price (USD) for a graded copy's grade, if known */
const marketGradeUSD = (cardId, sl) => (isGraded(sl) ? GRADED[cardId]?.usd?.[`${sl.co} ${sl.gr}`] : null) ?? null;
/** where a copy's value comes from: 'entered' | 'market' | 'raw' */
const slabSource = (sl, cardId) => (sl.v != null ? 'entered' : marketGradeUSD(cardId, sl) != null ? 'market' : 'raw');
/** value of one extra copy (graded and/or another language): your value, else the market price for its grade, else the raw price */
function slabValue(sl, v, cardId) {
  if (sl.v != null) return toCur(sl.v, sl.cur);
  const m = marketGradeUSD(cardId, sl);
  return m != null ? toCur(m, 'USD') : priceNum(v);
}
/** value of every copy you hold of a printing, split raw / graded */
function heldValue(cardId, v) {
  let raw = priceNum(v) * rawOf(cardId, v.k);
  let graded = 0;
  for (const sl of gradedOf(cardId, v.k)) {
    if (isGraded(sl)) graded += slabValue(sl, v, cardId);
    else raw += slabValue(sl, v, cardId);
  }
  return { raw, graded, total: raw + graded };
}
const GRADERS = ['PSA', 'CGC', 'BGS', 'SGC', 'TAG', 'ACE', 'Other'];
const GRADES = ['10', '9.5', '9', '8.5', '8', '7.5', '7', '6.5', '6', '5.5', '5', '4.5', '4', '3.5', '3', '2.5', '2', '1.5', '1', 'Authentic'];
// languages a copy can be in (for English-set cards; other catalogues have their own sets)
const COPY_LANGS = [
  ['EN', 'English'], ['JP', 'Japanese'], ['DE', 'German'], ['FR', 'French'], ['IT', 'Italian'], ['ES', 'Spanish'],
  ['PT', 'Portuguese'], ['NL', 'Dutch'], ['PL', 'Polish'], ['RU', 'Russian'], ['KO', 'Korean'], ['ZH', 'Chinese'], ['TH', 'Thai'], ['ID', 'Indonesian'],
];
const copyLangName = (code) => (COPY_LANGS.find((l) => l[0] === code) || [code, code])[1];
const slabLabel = (sl) => {
  const lang = sl.lang && sl.lang !== 'EN' ? sl.lang : '';
  if (!isGraded(sl)) return lang ? `${copyLangName(lang)}` : 'Raw';
  return `${sl.co} ${sl.gr}${lang ? ' · ' + lang : ''}`;
};
/** best grade first, ungraded other-language copies last */
const sortSlabs = (g) => [...g].sort((a, b) => (isGraded(b) ? parseFloat(b.gr) || 0.1 : 0) - (isGraded(a) ? parseFloat(a.gr) || 0.1 : 0));

function money(n, { compact = false } = {}) {
  if (n == null) return '—';
  const opts = { style: 'currency', currency: prefs.currency, maximumFractionDigits: n >= 1000 || compact ? 0 : 2, minimumFractionDigits: n >= 1000 || compact ? 0 : 2 };
  if (compact && n >= 100000) Object.assign(opts, { notation: 'compact', maximumFractionDigits: 1 });
  return new Intl.NumberFormat(undefined, opts).format(n);
}
function priceHtml(v) {
  const p = priceOf(v);
  if (p.v == null) return '<span class="approx">no price</span>';
  return `<span class="value">${p.approx ? '<span class="approx" title="Converted from the other market">≈</span>' : ''}${money(p.v)}</span>`;
}
const num = (n) => new Intl.NumberFormat().format(n);
const pct = (a, b) => (b ? Math.floor((a / b) * 1000) / 10 : 0);
function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  return isNaN(dt) ? d : dt.toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
}
// TCGdex images take a quality suffix; cards filled in from pokemontcg.io carry full URLs
// A stamped printing from TCGplayer carries its own photo (v.im) showing the stamp.
const imgUrl = (c, q = 'low', v = null) =>
  v?.im ? (q === 'high' ? v.im.replace('_200w', '_in_1000x1000') : v.im) : c.img ? `${c.img}/${q}.webp` : (q === 'high' ? c.iml : c.ims) || '';

const STAMP_NAMES = {
  '1st-edition': '1st Edition', 'pokemon-center': 'Pokémon Center', 'set-logo': 'Set Logo', staff: 'Staff', 'w-promo': 'W Promo',
  'player-rewards-program': 'Play! Pokémon', 'prize-pack-series-1': 'Series 1', 'prize-pack-series-2': 'Series 2',
  'prize-pack-series-3': 'Series 3', 'prize-pack-series-4': 'Series 4', 'prize-pack-series-5': 'Series 5', 'prize-pack-series-6': 'Series 6',
  'prize-pack-series-7': 'Series 7', 'prize-pack-series-8': 'Series 8', 'left-stamp': 'Left Stamp', 'right-stamp': 'Right Stamp', 'pokemon-together': 'Pokémon Together',
  gamestop: 'GameStop', 'eb-games': 'EB Games', 'top-thirty-two': 'Top 32', 'top-sixteen': 'Top 16', 'top-eight': 'Top 8',
  'semi-finalist': 'Semi-Finalist', finalist: 'Finalist', winner: 'Winner', prerelease: 'Prerelease',
  'no-rarity': 'No Rarity Symbol',
  'pokemon-league': 'Pokémon League', 'league-promo': 'League Promo', 'trick-or-trade': 'Trick or Trade', 'w-stamped': 'W Stamp',
  'kids-wb': 'Kids WB', 'toys-r-us-promo': 'Toys "R" Us', 'best-of-game': 'Best of Game', 'play-pokemon': 'Play! Pokémon',
  'deck-exclusive': 'Deck Exclusive', 'blister-exclusive': 'Blister Exclusive', 'prerelease-kit-exclusive': 'Prerelease Kit',
  'battle-arena-deck-exclusive': 'Battle Arena Deck', 'professor-program': 'Professor Program',
};
const FOIL_NAMES = {
  cosmos: 'Cosmos Holo', pokeball: 'Poké Ball', masterball: 'Master Ball', galaxy: 'Galaxy Holo', gold: 'Gold', league: 'League',
  cracked_ice: 'Cracked Ice', 'cracked-ice': 'Cracked Ice', energy: 'Energy Symbol', duskball: 'Dusk Ball', loveball: 'Love Ball',
  friendball: 'Friend Ball', quickball: 'Quick Ball', 'team-rocket': 'Team Rocket', wave: 'Wave Foil', tinsel: 'Tinsel Holo',
};
const titleCase = (s) => s.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bPokemon\b/g, 'Pokémon');

/** [{text, cls}] badges describing the printing */
function variantBadges(v, card) {
  const out = [];
  const stamps = v.s || [];
  if (stamps.includes('1st-edition')) out.push({ text: '1st Edition', cls: 'ed' });
  if (v.sub && v.sub !== 'unlimited') out.push({ text: titleCase(v.sub), cls: 'ed' });
  else if (v.sub === 'unlimited') out.push({ text: 'Unlimited', cls: '' });
  const plain = !stamps.length && !v.f && !v.z && (!v.sub || v.sub === 'unlimited');
  if (v.t === 'reverse') out.push({ text: 'Reverse Holo', cls: 'rev' });
  else if (v.t === 'holo') {
    // make it clear when the regular printing of a card is holo
    if (plain) out.push({ text: 'Normal (Holo)', cls: 'holo' });
  } else if (v.t !== 'normal') out.push({ text: titleCase(v.t), cls: 'holo' });
  if (v.f) out.push({ text: FOIL_NAMES[v.f] || titleCase(v.f), cls: 'foilb' });
  for (const s of stamps) if (s !== '1st-edition') out.push({ text: STAMP_NAMES[s] || titleCase(s), cls: 'stamp' });
  if (v.z) out.push({ text: titleCase(v.z), cls: 'size' });
  if (v.t === 'holo' && !plain && !v.f) out.push({ text: '(Holo)', cls: 'holo' });
  return out;
}
const badgesHtml = (v, card) => variantBadges(v, card).map((b) => `<span class="badge ${b.cls}">${esc(b.text)}</span>`).join('');
const isFoil = (v) => v.t !== 'normal' || !!v.f;
/** stamped / exclusive printing. 1st Edition doesn't count (it's part of every classic master set), nor does
 *  the set logo on EX-era reverse holos (that *is* their reverse holo). */
const isStamped = (v) => (v.s || []).some((x) => x !== '1st-edition') && !(v.t === 'reverse' && v.s.length === 1 && v.s[0] === 'set-logo');
const EXTRA_FOIL_KEY = /^[a-z]+(~[^:#@]+)?:(cosmos|galaxy|cracked-ice|cracked_ice|wave|tinsel|league)(#|@|$)/;
/** standard-master-set test from a collection key (close enough for the Sets page counts) */
const isStandardKey = (key) => {
  if (isStampedKey(key)) return false;
  const vk = key.split('|')[1] || '';
  if (vk.startsWith('metal')) return false;
  if (EXTRA_FOIL_KEY.test(vk)) return (ALLMETA.get(setIdOfCard(key.split('|')[0]))?.releaseDate || '') < '2003';
  return true;
};
/** the same test from a collection key ("cardId|holo#staff") */
const isStampedKey = (key) => {
  const vk = key.split('|')[1] || '';
  const stamps = (vk.split('#')[1] || '').split('@')[0].split('+').filter(Boolean);
  return stamps.some((x) => x !== '1st-edition') && !(vk.startsWith('reverse') && stamps.join() === 'set-logo');
};
/** printings shown with the current "Stamped: show / hide" setting */
/** part of the standard master set? (not stamped, not a tin/blister/box extra or duplicate listing – flagged x by the build) */
const isStandard = (v) => !isStamped(v) && !v.x;
/** printings shown in the current mode */
const visibleV = (card) => (prefs.master === 'standard' ? card.v.filter(isStandard) : card.v);
const masterLabel = () => (prefs.master === 'standard' ? 'standard master set' : 'true master set');
const MASTER_SEG = `<div class="seg mset" title="Standard: every card plus its regular printings (normal, holo, reverse, 1st Edition, set patterns) – what checklists count. True: also stamped, Prize Pack, and tin / blister / box versions.">
  <button data-v="standard">Standard master set</button><button data-v="true">True master set</button></div>`;

// --------------------------------------------------------------------------
// UI helpers
// --------------------------------------------------------------------------
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}
const bar = (p, done = false) => `<div class="bar${done ? ' done' : ''}"><i style="width:${Math.min(100, p)}%"></i></div>`;
function ring(p) {
  const r = 50, c = 2 * Math.PI * r;
  const done = p >= 100;
  return `<svg class="ring" viewBox="0 0 120 120" role="img" aria-label="${p}% complete">
    <defs><linearGradient id="rg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${done ? '#f59e0b' : '#7c3aed'}"/><stop offset="1" stop-color="${done ? '#fbbf24' : '#c084fc'}"/></linearGradient></defs>
    <circle cx="60" cy="60" r="${r}" fill="none" stroke="#321e52" stroke-width="12"/>
    <circle cx="60" cy="60" r="${r}" fill="none" stroke="url(#rg)" stroke-width="12" stroke-linecap="round"
      stroke-dasharray="${(c * Math.min(p, 100)) / 100} ${c}" transform="rotate(-90 60 60)"/>
    <text x="60" y="66" text-anchor="middle" fill="#f3eefe" font-size="22" font-weight="700" font-family="Outfit, sans-serif">${p}%</text>
  </svg>`;
}
function setLogo(s, cls = '') {
  return s.logo ? `<img class="${cls}" src="${esc(s.logo)}.webp" alt="${esc(s.name)} logo" loading="lazy" data-fallback="${esc(s.name)}">` : `<span class="txt">${esc(s.name)}</span>`;
}
// Broken images → text/placeholder fallback
document.addEventListener(
  'error',
  (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    if (img.dataset.fallback != null) {
      const span = document.createElement('span');
      span.className = 'txt';
      span.textContent = img.dataset.fallback;
      img.replaceWith(span);
    } else if (img.classList.contains('card-img')) {
      if (img.src.endsWith('.webp')) {
        img.src = img.src.replace(/\.webp$/, '.png');
        return;
      }
      const ph = document.createElement('div');
      ph.className = 'placeholder';
      ph.textContent = img.alt || 'No image';
      img.replaceWith(ph);
    }
  },
  true,
);

function loading(msg = 'Loading…') {
  app.innerHTML = `<div class="loading"><div class="spinner"></div><p>${esc(msg)}</p></div>`;
}

/** One card tile. `entry` = { card, v, set } */
function tileHtml({ card, v, set }, { showSet = false, anyOwned = null, slab = null, also = null } = {}) {
  const q = qtyOf(card.id, v.k);
  const owned = anyOwned ?? q > 0;
  const k = keyOf(card.id, v.k);
  return `<div class="tile${owned ? ' owned' : ''}${isFoil(v) ? ' foil' : ''}${selected.has(k) ? ' sel' : ''}" data-key="${esc(k)}">
    <span class="selmark" aria-hidden="true"></span>
    <div class="fw"><button class="face" data-act="toggle" aria-pressed="${owned}" title="${owned ? 'Owned – click to remove' : 'Click to mark as owned'}">
      ${imgUrl(card, 'low', v) ? `<img class="card-img" src="${esc(imgUrl(card, 'low', v))}" alt="${esc(card.name)}" loading="lazy" decoding="async">` : `<div class="placeholder"><b>${esc(card.name)}</b>${card.en ? `<span>${esc(card.en)}</span>` : ''}<span>#${esc(card.n)}</span><small>No image yet</small></div>`}
      <span class="check" aria-hidden="true">✓</span>
      ${q > 1 && !slab ? `<span class="qty">×${q}</span>` : ''}
      ${!v?.im && card.imlang ? '<span class="imglang" title="Picture of the Japanese print – this card has no picture of its own yet">JP image</span>' : ''}
      ${(() => {
        if (slab) return `<span class="slabchip">${esc(slabLabel(slab))}</span>`;
        const g = gradedOf(card.id, v.k);
        return g.length ? `<span class="slabchip" title="${esc(sortSlabs(g).map(slabLabel).join(', '))}">${esc(slabLabel(sortSlabs(g)[0]))}${g.length > 1 ? ` +${g.length - 1}` : ''}</span>` : '';
      })()}
    </button>
    <button class="info-btn" data-act="info" aria-label="Details for ${esc(card.name)}">i</button></div>
    <div class="cap"><span class="nm" title="${esc(card.name)}${card.en ? ` (${esc(card.en)})` : ''}">${esc(card.name)}</span><span class="num">${esc(card.n)}${set?.official && /^\d+$/.test(card.n) && !card.from ? '/' + set.official : ''}</span></div>
    <div class="row2"><span class="badges">${badgesHtml(v, card)}</span>${
      slab
        ? slabSource(slab, card.id) === 'raw'
          ? '<span class="approx" title="No value entered and no market price for this grade yet – counted at the raw price">raw price</span>'
          : `<span class="value" title="${slabSource(slab, card.id) === 'market' ? 'Market price for this grade (eBay sold)' : 'Your value'}">${money(slabValue(slab, v, card.id))}</span>`
        : priceHtml(v)
    }</div>
    ${card.en ? `<div class="enname">${esc(card.en)}</div>` : ''}
    ${card.from && !showSet ? `<div class="setname">from ${esc(card.from)}</div>` : ''}
    ${showSet ? `<div class="setname">${set.lang && set.lang !== 'en' ? `<span class="langchip">${langInfo(set.lang).short}</span> ` : ''}${esc(set.name)}</div>` : ''}
    ${also ? `<div class="also" title="Appears in the artwork"><span class="also-chip">✦ in art</span> ${esc(also)}</div>` : ''}
  </div>`;
}

const BINDERS = { '2x2': [2, 2], '3x3': [3, 3], '4x3': [4, 3], '4x4': [4, 4] };
const gridHtml = (tiles) => `<div class="card-grid">${tiles.join('')}</div>`;
const narrowMQ = matchMedia('(max-width: 900px)');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
let binderCtl = null; // the binder currently on screen (for keyboard control)

/**
 * Render tiles as a binder you flip through. Wide screens show two-page spreads
 * like a real binder (inside cover + page 1, then 2–3, 4–5, …); narrow screens
 * show one page at a time. `key` remembers the open page per set.
 */
function mountBinder(container, tiles, layout, key) {
  const [cols, rows] = BINDERS[layout];
  const per = cols * rows;
  const pages = [];
  for (let i = 0; i < tiles.length; i += per) {
    const pocketTiles = tiles.slice(i, i + per);
    while (pocketTiles.length < per) pocketTiles.push('<div class="pocket-empty" aria-hidden="true"></div>');
    pages.push(pocketTiles);
  }
  const single = narrowMQ.matches;
  const pageHtml = (i) =>
    `<section class="bpage" style="--cols:${cols}" aria-label="Binder page ${i + 1}"><div class="bgrid">${pages[i].join('')}</div><div class="pno">Page ${i + 1}</div></section>`;
  // spreads: list of page indexes shown together (-1 = inside cover)
  const spreads = [];
  if (single) pages.forEach((_, i) => spreads.push([i]));
  else {
    spreads.push([-1, 0]);
    for (let p = 1; p < pages.length; p += 2) spreads.push(p + 1 < pages.length ? [p, p + 1] : [p]);
  }
  const label = (sp) => {
    const nums = sp.filter((i) => i >= 0).map((i) => i + 1);
    return nums.length > 1 ? `Pages ${nums[0]}–${nums[1]} of ${pages.length}` : `Page ${nums[0]} of ${pages.length}`;
  };
  // open at the remembered page
  prefs.bpage = prefs.bpage || {};
  const wantPage = Math.min((prefs.bpage[key] || 1) - 1, pages.length - 1);
  let cur = Math.max(0, spreads.findIndex((sp) => sp.includes(wantPage)));

  container.innerHTML = `<div class="binder b${cols}x${rows}${single ? ' single' : ''}" tabindex="-1">
    <div class="bnav">
      <button class="btn sm" data-b="first" aria-label="First page">«</button>
      <button class="btn sm" data-b="prev" aria-label="Previous page">‹ Prev</button>
      <span class="bpos" aria-live="polite"></span>
      <button class="btn sm" data-b="next" aria-label="Next page">Next ›</button>
      <button class="btn sm" data-b="last" aria-label="Last page">»</button>
      <input class="bslider" type="range" min="0" max="${spreads.length - 1}" value="${cur}" aria-label="Jump to page" ${spreads.length < 2 ? 'hidden' : ''}>
    </div>
    <div class="bstage">
      <button class="bturn prev" data-b="prev" aria-label="Previous page">‹</button>
      ${spreads
        .map((sp, i) => `<div class="spread${i === cur ? ' active' : ''}${sp.length === 1 && sp[0] >= 0 && !single ? ' lone' : ''}" data-i="${i}">${sp.map((p) => (p < 0 ? '<div class="bcover" aria-hidden="true"><span>Inside cover</span></div>' : pageHtml(p))).join('')}</div>`)
        .join('')}
      <button class="bturn next" data-b="next" aria-label="Next page">›</button>
    </div>
    <p class="muted binder-note">${pages.length} pages · ${per}-pocket binder · use ← → keys or swipe to turn pages</p>
  </div>`;

  const root = container.firstElementChild;
  const els = [...root.querySelectorAll('.spread')];
  const slider = root.querySelector('.bslider');
  let busy = false;
  const update = () => {
    root.querySelector('.bpos').textContent = label(spreads[cur]);
    slider.value = cur;
    root.querySelectorAll('[data-b="prev"],[data-b="first"]').forEach((b) => (b.disabled = cur === 0));
    root.querySelectorAll('[data-b="next"],[data-b="last"]').forEach((b) => (b.disabled = cur === spreads.length - 1));
    prefs.bpage[key] = Math.max(0, spreads[cur].find((p) => p >= 0)) + 1;
    savePrefs();
  };
  const go = (target, animate = true) => {
    target = Math.max(0, Math.min(spreads.length - 1, target));
    if (target === cur || busy) return;
    const out = els[cur], inn = els[target];
    const dir = target > cur ? 'next' : 'prev';
    cur = target;
    update();
    if (!animate || reduceMotion.matches) {
      out.classList.remove('active');
      inn.classList.add('active');
      return;
    }
    busy = true;
    out.classList.add('out-' + dir);
    setTimeout(() => {
      out.classList.remove('active', 'out-' + dir);
      inn.classList.add('active', 'in-' + dir);
      setTimeout(() => {
        inn.classList.remove('in-' + dir);
        busy = false;
      }, 260);
    }, 230);
  };
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-b]');
    if (!b || b.disabled) return;
    const a = b.dataset.b;
    go(a === 'next' ? cur + 1 : a === 'prev' ? cur - 1 : a === 'first' ? 0 : spreads.length - 1, a === 'next' || a === 'prev');
  });
  slider.addEventListener('input', () => go(Number(slider.value), false));
  // swipe on touch screens
  let sx = null, sy = 0;
  const stage = root.querySelector('.bstage');
  stage.addEventListener('touchstart', (e) => ((sx = e.touches[0].clientX), (sy = e.touches[0].clientY)), { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (sx == null) return;
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    sx = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(cur + (dx < 0 ? 1 : -1));
  });
  binderCtl = { root, go: (d) => go(cur + d) };
  update();
}
// ← → turn pages (unless typing in a box or a dialog is open)
document.addEventListener('keydown', (e) => {
  if (!binderCtl || !document.contains(binderCtl.root) || modal.open) return;
  if (e.target.closest('input, select, textarea') || e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === 'ArrowRight') (binderCtl.go(1), e.preventDefault());
  if (e.key === 'ArrowLeft') (binderCtl.go(-1), e.preventDefault());
});
// switching between one page and two-page spreads when the window is resized
narrowMQ.addEventListener('change', () => binderCtl && document.contains(binderCtl.root) && redrawPage?.());

// Delegated grid clicks (toggle ownership / select / open details)
let gridLookup = new Map(); // key -> {card, v, set}
let afterToggle = () => {};
let redrawPage = null; // set by pages that support multi-select
let selectMode = false;
const selected = new Set();
let lastSelKey = null;

app.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const tile = btn.closest('.tile');
  if (!tile) return;
  const entry = gridLookup.get(tile.dataset.key);
  if (!entry) return;
  if (btn.dataset.act === 'info') return openCard(entry.card, entry.set);
  const picker = tile.closest('.picker');
  if (picker && btn.dataset.act === 'toggle') {
    pickerToggle?.(entry, tile);
    return;
  }
  if (btn.dataset.act === 'toggle' && selectMode) {
    const k = tile.dataset.key;
    if (e.shiftKey && lastSelKey && lastSelKey !== k) {
      // shift-click: select everything between the last clicked card and this one
      const keys = [...app.querySelectorAll('.tile[data-key]')].map((t) => t.dataset.key);
      const a = keys.indexOf(lastSelKey), b = keys.indexOf(k);
      if (a >= 0 && b >= 0) for (const key of keys.slice(Math.min(a, b), Math.max(a, b) + 1)) selected.add(key);
    } else if (selected.has(k)) selected.delete(k);
    else selected.add(k);
    lastSelKey = k;
    syncSelection();
    return;
  }
  if (btn.dataset.act === 'toggle') {
    const { card, v } = entry;
    if (entry.base) {
      // base-set mode: toggle the whole card number
      const any = card.v.some((x) => qtyOf(card.id, x.k));
      if (any) card.v.forEach((x) => setQty(card.id, x.k, 0));
      else setQty(card.id, v.k, 1);
    } else {
      setQty(card.id, v.k, qtyOf(card.id, v.k) ? 0 : 1);
      if (gradedOf(card.id, v.k).length) toast('Graded copies kept – remove them in the card details (i)');
    }
    refreshTile(tile, entry);
    afterToggle();
  }
});

// ---- multi-select bar ----
const selbar = $('#selbar');
function setSelectMode(on) {
  selectMode = on;
  if (!on) selected.clear();
  lastSelKey = null;
  document.body.classList.toggle('selecting', on);
  if (!on) setTimeout(() => Sync.flushRedraw());
  const b = $('#selbtn');
  if (b) {
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on);
  }
  syncSelection();
}
function syncSelection() {
  app.querySelectorAll('.tile[data-key]').forEach((t) => t.classList.toggle('sel', selected.has(t.dataset.key)));
  selbar.hidden = !selectMode;
  const n = selected.size;
  $('#selcount').textContent = n ? `${num(n)} selected` : 'Tap cards to select them · Shift-click selects a range';
  selbar.querySelectorAll('[data-need]').forEach((b) => (b.disabled = !n));
}
selbar.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const act = b.dataset.sel;
  if (act === 'done') return setSelectMode(false);
  if (act === 'all') {
    app.querySelectorAll('.tile[data-key]').forEach((t) => gridLookup.has(t.dataset.key) && selected.add(t.dataset.key));
    return syncSelection();
  }
  if (act === 'none') return (selected.clear(), syncSelection());
  if ((act === 'unbind' || act === 'front' || act === 'back') && selBinder) {
    const keys = [...selected].filter((k) => selBinder.cards.includes(k));
    const rest = selBinder.cards.filter((k) => !selected.has(k));
    selBinder.cards = act === 'unbind' ? rest : act === 'front' ? [...keys, ...rest] : [...rest, ...keys];
    selBinder.m = Date.now();
    saveCollection();
    toast(act === 'unbind' ? `Removed ${num(keys.length)} cards from the binder` : `Moved ${num(keys.length)} cards to the ${act === 'front' ? 'start' : 'end'}`);
    selected.clear();
    redrawPage?.();
    syncSelection();
    return;
  }
  if (act === 'own' || act === 'remove') {
    let n = 0;
    for (const k of selected) {
      const entry = gridLookup.get(k);
      if (!entry) continue;
      const { card, v } = entry;
      if (act === 'own') {
        const has = entry.base ? card.v.some((x) => qtyOf(card.id, x.k)) : qtyOf(card.id, v.k);
        if (!has) (setQty(card.id, v.k, 1), n++);
      } else {
        for (const x of entry.base ? card.v : [v]) if (qtyOf(card.id, x.k)) (setQty(card.id, x.k, 0), n++);
      }
    }
    toast(act === 'own' ? `Added ${num(n)} cards to your collection` : `Removed ${num(n)} cards`);
    selected.clear();
    redrawPage?.();
    syncSelection();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && selectMode && !modal.open) setSelectMode(false);
});
/** wire up a page's "Select" button */
let selBinder = null; // binder whose page is open (enables the binder-only selection actions)
function bindSelectButton(binder = null) {
  selBinder = binder;
  selbar.querySelectorAll('[data-binder-only]').forEach((b) => (b.hidden = !binder));
  const b = $('#selbtn');
  if (b) b.onclick = () => setSelectMode(!selectMode);
  setSelectMode(false);
}

function refreshTile(tile, entry) {
  const html = tileHtml(entry, entry.tileOpts || {});
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  const fresh = wrap.firstElementChild;
  if (entry.base) {
    const any = entry.card.v.some((x) => qtyOf(entry.card.id, x.k));
    fresh.classList.toggle('owned', any);
  }
  // keep the already-loaded image element to avoid flicker
  const oldImg = tile.querySelector('.face img, .face .placeholder');
  const newImg = fresh.querySelector('.face img, .face .placeholder');
  if (oldImg && newImg) newImg.replaceWith(oldImg);
  tile.replaceWith(fresh);
}

// --------------------------------------------------------------------------
// Card detail modal
// --------------------------------------------------------------------------
function openCard(card, set) {
  const render = () => {
    const ownedAny = card.v.some((v) => qtyOf(card.id, v.k));
    modal.innerHTML = `<button class="close" aria-label="Close">✕</button>
    <div class="modal-body">
      <div>${imgUrl(card) ? `<img class="big card-img" src="${esc(imgUrl(card, 'high'))}" alt="${esc(card.name)}">` : `<div class="big" style="display:grid;place-items:center">${esc(card.name)}</div>`}</div>
      <div>
        <div class="muted">${esc(set.name)} · #${esc(card.n)}${set.official ? ' / ' + set.official : ''}</div>
        <h2>${esc(card.name)}</h2>${card.en ? `<div class="muted">${esc(card.en)}</div>` : ''}${card.imlang ? '<p class="muted small-note">The picture shows the Japanese print of this card – no picture of this language version is available yet.</p>' : ''}
        <dl class="facts">
          ${set.lang && set.lang !== 'en' ? `<dt>Language</dt><dd>${esc(langInfo(set.lang).name)}</dd>` : ''}
          ${card.r ? `<dt>Rarity</dt><dd>${esc(card.r)}</dd>` : ''}
          ${card.cat ? `<dt>Category</dt><dd>${esc(card.cat)}${card.ty ? ' · ' + card.ty.map(esc).join(', ') : ''}</dd>` : ''}
          ${card.ill ? `<dt>Illustrator</dt><dd>${esc(card.ill)}</dd>` : ''}
          ${card.from ? `<dt>Jumbo of</dt><dd><a href="#/set/${encodeURIComponent(card.fromId)}" data-close>${esc(card.from)}</a> #${esc(card.n)}</dd>` : ''}
          <dt>Set</dt><dd><a href="#/set/${encodeURIComponent(set.id)}" data-close>${esc(set.name)}</a> <span class="muted">(${esc(set.seriesName)}, ${fmtDate(set.releaseDate)})</span></dd>
          ${cameosOf(card).length ? `<dt>Also in the art</dt><dd>${cameosOf(card).map(esc).join(', ')}</dd>` : ''}
          <dt>Status</dt><dd>${ownedAny ? '<span style="color:var(--green)">In your collection</span>' : '<span class="muted">Not owned</span>'}</dd>
          ${(() => {
            const inB = liveBinders().filter((b) => card.v.some((v) => b.cards.includes(keyOf(card.id, v.k))));
            return inB.length ? `<dt>In binders</dt><dd>${inB.map((b) => `<a href="#/binder/${encodeURIComponent(b.id)}" data-close>${esc(b.name)}</a>`).join(', ')}</dd>` : '';
          })()}
        </dl>
        <div class="addbinder">
          <select id="addbinder-sel" aria-label="Binder">
            ${liveBinders().map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('')}
            <option value="__new">＋ New binder…</option>
          </select>
          <button class="btn sm" data-addbinder>Add to binder</button>
        </div>
        <h3 style="margin:18px 0 10px">Printings in the master set</h3>
        <div class="variant-list">
          ${card.v
            .map((v) => {
              const raw = rawOf(card.id, v.k);
              const slabs = sortSlabs(gradedOf(card.id, v.k));
              return `<div class="variant-row${raw || slabs.length ? ' owned' : ''}">
                <div><div class="badges">${badgesHtml(v, card) || '<span class="badge">Normal</span>'}</div></div>
                ${priceHtml(v)}
                <div class="stepper" data-vk="${esc(v.k)}" title="Raw (ungraded) copies"><button data-d="-1" aria-label="Remove one raw copy">−</button><span>${raw}</span><button data-d="1" aria-label="Add one raw copy">+</button></div>
                <div class="slabs">
                  ${slabs
                    .map(
                      (sl) => `<div class="slab"><span class="slabchip">${esc(slabLabel(sl))}</span>
                        <span class="${slabSource(sl, card.id) === 'raw' ? 'approx' : 'value'}">${
                          slabSource(sl, card.id) === 'entered'
                            ? money(slabValue(sl, v, card.id))
                            : slabSource(sl, card.id) === 'market'
                              ? `${money(slabValue(sl, v, card.id))} <small class="muted">market</small>`
                              : isGraded(sl)
                                ? 'no value yet · counted at raw price'
                                : '≈ English price'
                        }</span>
                        ${sl.cert ? `<span class="muted">Cert ${esc(sl.cert)}</span>` : '<span></span>'}
                        <button class="slab-x" data-rmslab="${esc(sl.id)}" data-vk="${esc(v.k)}" aria-label="Remove ${esc(slabLabel(sl))}">✕</button></div>`,
                    )
                    .join('')}
                  ${addingSlab === v.k ? slabFormHtml(card, set, v) : `<button class="btn sm" data-addslab="${esc(v.k)}">+ Add graded or other-language copy</button>`}
                </div>
              </div>`;
            })
            .join('')}
        </div>
        <p class="muted small-note">The − / + buttons count raw English copies. Graded copies and copies in other languages are added separately, each with its own value.</p>
        ${gradedPricesHtml(card)}
        <div class="ext-links">
          <a class="btn sm" target="_blank" rel="noopener" href="https://www.tcgplayer.com/search/pokemon/product?q=${encodeURIComponent(card.name + ' ' + set.name)}">TCGplayer ↗</a>
          <a class="btn sm" target="_blank" rel="noopener" href="https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=${encodeURIComponent(card.name)}">Cardmarket ↗</a>
          <a class="btn sm" target="_blank" rel="noopener" href="https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(`pokemon ${card.name} ${set.name} ${card.n}`)}&LH_Sold=1">eBay sold ↗</a>
        </div>
      </div>
    </div>`;
  };
  addingSlab = null;
  render();
  modal.onclick = (e) => {
    if (e.target === modal || e.target.closest('.close') || e.target.closest('[data-close]')) return modal.close();
    const b = e.target.closest('.stepper button');
    if (b) {
      const vk = b.parentElement.dataset.vk;
      setQty(card.id, vk, Math.max(0, rawOf(card.id, vk) + Number(b.dataset.d)));
      render();
      changedWhileModal = true;
      return;
    }
    const add = e.target.closest('[data-addslab]');
    if (add) {
      addingSlab = add.dataset.addslab;
      render();
      modal.querySelector('.slabform select')?.focus();
      return;
    }
    if (e.target.closest('[data-cancelslab]')) {
      addingSlab = null;
      return render();
    }
    if (e.target.closest('[data-addbinder]')) {
      let id = modal.querySelector('#addbinder-sel').value;
      if (id === '__new') {
        const name = prompt('Name for the new binder');
        if (!name || !name.trim()) return;
        id = createBinder(name).id;
      }
      const b = binders[id];
      // add the printing you own (or the first printing) of this card
      const v = card.v.find((x) => qtyOf(card.id, x.k)) || card.v[0];
      const k = keyOf(card.id, v.k);
      if (b.cards.includes(k)) return toast(`Already in ${b.name}`);
      b.cards.push(k);
      touchBinder(b);
      changedWhileModal = true;
      render();
      return toast(`Added to ${b.name}`);
    }
    const rm = e.target.closest('[data-rmslab]');
    if (rm) {
      removeGraded(card.id, rm.dataset.vk, rm.dataset.rmslab);
      changedWhileModal = true;
      return render();
    }
  };
  modal.onchange = (e) => {
    // keep the eBay link and hints in step with the chosen language, grader and grade
    const f = e.target.closest('.slabform');
    if (!f) return;
    const { lang, co, gr } = f.elements;
    gr.disabled = co.value === 'Raw';
    f.querySelector('.ebay-grade').href = ebayGradedUrl(card, set, co.value, gr.value, lang.value);
    const m = co.value !== 'Raw' ? GRADED[card.id]?.usd?.[`${co.value} ${gr.value}`] : null;
    f.querySelector('[data-hint]').textContent =
      co.value === 'Raw' && lang.value === 'EN' ? 'Raw English copies are counted with the − / + buttons.'
      : m != null && lang.value === 'EN' ? `Market price for ${co.value} ${gr.value}: ${money(toCur(m, 'USD'))} – leave the value empty to use it.`
      : lang.value !== 'EN' ? 'There is no price feed for this language – enter a value, or it counts at the English price.'
      : '';
  };
  modal.onsubmit = (e) => {
    const f = e.target.closest('.slabform');
    if (!f) return;
    e.preventDefault();
    const val = f.elements.v.value.trim();
    const co = f.elements.co.value, lang = f.elements.lang.value;
    if (co === 'Raw' && lang === 'EN') {
      setQty(card.id, f.dataset.vk, rawOf(card.id, f.dataset.vk) + 1); // a plain raw copy
    } else {
      addGraded(card.id, f.dataset.vk, {
        co,
        gr: co === 'Raw' ? '' : f.elements.gr.value,
        lang: lang === 'EN' ? undefined : lang,
        v: val === '' ? null : Math.max(0, Number(val)),
        cur: prefs.currency,
        cert: f.elements.cert.value.trim() || undefined,
      });
    }
    addingSlab = null;
    changedWhileModal = true;
    render();
    toast(co === 'Raw' ? `${copyLangName(lang)} copy added` : 'Graded copy added');
  };
  changedWhileModal = false;
  modal.showModal();
}
let changedWhileModal = false;
let addingSlab = null; // variant key whose "add graded copy" form is open
const curSymbol = () => ({ GBP: '£', USD: '$', EUR: '€' })[prefs.currency];
const ebayGradedUrl = (card, set, co, gr, lang) =>
  `https://www.ebay.co.uk/sch/i.html?_nkw=${encodeURIComponent(
    `${co !== 'Raw' ? `${co} ${gr} ` : ''}${lang && lang !== 'EN' ? copyLangName(lang) + ' ' : ''}${card.name} ${set.name} ${card.n}`,
  )}&LH_Sold=1&LH_Complete=1`;
/** market prices by grade for a card, if the daily job has fetched them */
function gradedPricesHtml(card) {
  const g = GRADED[card.id]?.usd;
  if (!g || !Object.keys(g).length) return '';
  const order = (k) => -(parseFloat(k.split(' ')[1]) || 0) + (k.startsWith('PSA') ? 0 : 0.01);
  const rows = Object.entries(g).sort((a, b) => order(a[0]) - order(b[0]));
  return `<div class="graded-prices"><h3>Graded market prices</h3>
    <div class="gp-list">${rows.map(([grade, usd]) => `<div><span class="slabchip">${esc(grade)}</span><span class="value">${money(toCur(usd, 'USD'))}</span></div>`).join('')}</div>
    <p class="muted small-note">eBay sold prices via Pokemon Price Tracker, ${GRADED[card.id].t ? 'checked ' + new Date(GRADED[card.id].t).toLocaleDateString() : ''}. Graded copies without your own value use these.</p></div>`;
}
function slabFormHtml(card, set, v) {
  return `<form class="slabform" data-vk="${esc(v.k)}">
    <label>Language<select name="lang">${COPY_LANGS.map(([c, n]) => `<option value="${c}">${n}</option>`).join('')}</select></label>
    <label>Grader<select name="co"><option value="Raw">Not graded</option>${GRADERS.map((g) => `<option${g === 'PSA' ? ' selected' : ''}>${g}</option>`).join('')}</select></label>
    <label>Grade<select name="gr">${GRADES.map((g) => `<option>${g}</option>`).join('')}</select></label>
    <label>Value (${curSymbol()})<input name="v" type="number" min="0" step="0.01" inputmode="decimal" placeholder="optional"></label>
    <label>Cert no.<input name="cert" type="text" maxlength="20" placeholder="optional" autocomplete="off"></label>
    <div class="slabform-actions">
      <button class="btn sm primary" type="submit">Save copy</button>
      <button class="btn sm" type="button" data-cancelslab>Cancel</button>
      <a class="ebay-grade" href="${ebayGradedUrl(card, set, 'PSA', '10', 'EN')}" target="_blank" rel="noopener">Check eBay sold prices for this copy ↗</a>
      <span class="slabform-hint muted" data-hint></span>
    </div>
  </form>`;
}
modal.addEventListener('close', () => {
  if (changedWhileModal) route(true);
  else Sync.flushRedraw();
});

// --------------------------------------------------------------------------
// Pages
// --------------------------------------------------------------------------
async function pagePortfolio() {
  const idx = await getIndex();
  const owned = ownedBySet();
  const meta = await getIndexesFor([...owned.keys()]);
  const ownedSetIds = [...owned.keys()].filter((id) => meta.has(id));

  if (!ownedSetIds.length) {
    const featured = [...idx.sets].sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || '')).slice(0, 6);
    app.innerHTML = `
      <section class="hero">
        <div class="hero-label">Your portfolio</div>
        <div class="hero-value">${money(0)}</div>
        <div class="hero-sub">Start tracking – every set from Base Set (1999) to today, with reverse holos, stamps and promos.</div>
        <div class="stats">
          <div class="stat"><b>${num(idx.sets.length)}</b><span>sets available</span></div>
          <div class="stat"><b>${num(idx.sets.reduce((a, s) => a + s.total, 0))}</b><span>cards</span></div>
          <div class="stat"><b>${num(idx.sets.reduce((a, s) => a + s.variants, 0))}</b><span>master-set printings</span></div>
        </div>
      </section>
      <div class="empty"><h3>Your vault is empty</h3><p>Open a set and tap the cards you own – they light up in full colour.</p>
        <a class="btn primary" href="#/sets">Browse sets →</a></div>
      <h2 class="section">Latest sets</h2>
      <div class="set-grid">${featured.map((s) => setCardHtml(s, 0)).join('')}</div>`;
    return;
  }

  app.innerHTML = `<div class="load-progress">Valuing your collection…${bar(0)}</div>`;
  const sets = await getSets(ownedSetIds, (d, t) => {
    const b = app.querySelector('.load-progress .bar i');
    if (b) b.style.width = `${(d / t) * 100}%`;
  });

  let total = 0, copies = 0, slots = 0, priced = 0, rawTotal = 0, gradedTotal = 0;
  const entries = [];
  const slabEntries = [];
  const perSet = [];
  const perSeries = new Map();
  for (const s of sets) {
    let sOwned = 0, sValue = 0, sCards = 0, sShown = 0, sShownOwned = 0;
    for (const card of s.cards) {
      let any = false;
      for (const v of visibleV(card)) {
        sShown++;
        if (qtyOf(card.id, v.k)) sShownOwned++;
      }
      for (const v of card.v) {
        const q = qtyOf(card.id, v.k);
        if (!q) continue;
        any = true;
        const hv = heldValue(card.id, v);
        const slabs = gradedOf(card.id, v.k);
        // a card's headline value: its best single copy (raw price or best graded value)
        const p = Math.max(rawOf(card.id, v.k) ? priceNum(v) : 0, ...slabs.map((sl) => slabValue(sl, v, card.id)));
        sOwned++;
        copies += q;
        sValue += hv.total;
        rawTotal += hv.raw;
        gradedTotal += hv.graded;
        if (p) priced++;
        entries.push({ card, v, set: s, p, t: collection[keyOf(card.id, v.k)].t });
        for (const sl of slabs) if (isGraded(sl)) slabEntries.push({ card, v, set: s, sl, p: slabValue(sl, v, card.id) });
      }
      if (any) sCards++;
    }
    slots += sOwned;
    total += sValue;
    perSet.push({ s, sOwned, sValue, sCards, sShown, sShownOwned });
    const era = s.seriesName + (s.lang && s.lang !== 'en' ? ` (${langInfo(s.lang).short})` : '');
    const ser = perSeries.get(era) || { v: 0, n: 0, order: meta.get(s.id)?.seriesOrder ?? 99 };
    ser.v += sValue;
    ser.n += sOwned;
    perSeries.set(era, ser);
  }
  const complete = perSet.filter((x) => x.sShown && x.sShownOwned >= x.sShown).length;
  const top = [...entries].sort((a, b) => b.p - a.p).slice(0, 12);
  const recent = [...entries].sort((a, b) => b.t - a.t).slice(0, 12);
  const progress = [...perSet].sort((a, b) => b.sShownOwned / (b.sShown || 1) - a.sShownOwned / (a.sShown || 1));
  const series = [...perSeries.entries()].sort((a, b) => b[1].v - a[1].v);
  const maxSeries = Math.max(1, ...series.map((x) => x[1].v));
  const best = top[0];

  gridLookup = new Map();
  const reg = (e) => (gridLookup.set(keyOf(e.card.id, e.v.k), { ...e, tileOpts: { showSet: true } }), tileHtml(e, { showSet: true }));

  app.innerHTML = `
    <section class="hero">
      <div class="hero-label">Total collection value</div>
      <div class="hero-value">${money(total)}</div>
      <div class="hero-sub">${priceSource()} · ${num(priced)} of ${num(slots)} owned printings priced${best ? ` · Top card: <b>${esc(best.card.name)}</b> (${money(best.p)})` : ''}</div>
      <div class="live" id="live"></div>
      <div class="stats">
        <div class="stat"><b>${num(slots)}</b><span>unique printings</span></div>
        <div class="stat"><b>${num(copies)}</b><span>total cards incl. duplicates</span></div>
        <div class="stat"><b>${num(sets.length)}</b><span>sets started</span></div>
        <div class="stat"><b>${num(complete)}</b><span>master sets complete</span></div>
        <div class="stat"><b>${money(slots ? total / copies : 0)}</b><span>average card value</span></div>
      </div>
      <div class="stats split">
        <div class="stat"><b class="value">${money(rawTotal)}</b><span>Raw cards · ${num(copies - slabEntries.length)} ${copies - slabEntries.length === 1 ? 'copy' : 'copies'}</span></div>
        <div class="stat"><b class="value">${money(gradedTotal)}</b><span>Graded cards · ${num(slabEntries.length)} slab${slabEntries.length === 1 ? '' : 's'}</span></div>
      </div>
    </section>
    ${
      slabEntries.length
        ? `<h2 class="section">Graded cards <small>${num(slabEntries.length)} slabs · ${money(gradedTotal)}</small></h2>
      <div class="card-grid">${[...slabEntries]
        .sort((a, b) => b.p - a.p)
        .map((e) => {
          gridLookup.set(keyOf(e.card.id, e.v.k), { ...e, tileOpts: { showSet: true } });
          return tileHtml(e, { showSet: true, slab: e.sl });
        })
        .join('')}</div>`
        : ''
    }

    <h2 class="section">Most valuable cards <small>your top 12</small></h2>
    <div class="card-grid">${top.map(reg).join('')}</div>

    <div class="two-col">
      <div>
        <h2 class="section">Set progress <small>master set completion</small></h2>
        <div class="progress-list">
          ${progress
            .map(({ s, sValue, sCards, sShown, sShownOwned }) => {
              const p = pct(sShownOwned, sShown);
              return `<a class="progress-item" href="#/set/${encodeURIComponent(s.id)}">
                ${s.logo ? `<img src="${esc(s.logo)}.webp" alt="" loading="lazy" data-fallback="">` : '<span></span>'}
                <div><div class="name">${esc(s.name)}</div>${bar(p, p >= 100)}
                  <div class="meta"><span>${num(sShownOwned)}/${num(sShown)} printings · ${num(sCards)}/${num(s.total)} cards</span><span class="value">${money(sValue)}</span></div></div>
                <div class="pct">${p}%</div></a>`;
            })
            .join('')}
        </div>
      </div>
      <div>
        <h2 class="section">Value by era</h2>
        <div class="panel era-bars">
          ${series
            .map(([name, x]) => `<div class="era-row"><span>${esc(name)}</span>${bar((x.v / maxSeries) * 100)}<span class="value">${money(x.v, { compact: true })}</span></div>`)
            .join('')}
        </div>
      </div>
    </div>

    <h2 class="section">Recently added</h2>
    <div class="card-grid">${recent.map(reg).join('')}</div>`;
  afterToggle = () => {};
  const ownedCards = [...new Set(entries.map((e) => e.card))];
  startLive(ownedCards, () => pagePortfolio());
}

/** master-set size from the set index, following the stamped toggle */
const setSlots = (s) => (prefs.master === 'standard' ? s.standard ?? s.regular ?? s.variants : s.variants);
function setCardHtml(s, ownedCount) {
  const p = pct(ownedCount, setSlots(s));
  const cls = p >= 100 ? 'complete' : ownedCount ? 'started' : '';
  const value = setValue(s);
  return `<a class="set-card ${cls}" href="#/set/${encodeURIComponent(s.id)}">
    <div class="logo">${setLogo(s)}</div>
    <div class="title">${s.symbol ? `<img src="${esc(s.symbol)}.webp" alt="" loading="lazy" data-fallback="">` : ''}<span>${esc(s.name)}</span></div>
    <div class="sub"><span>${fmtDate(s.releaseDate)}${s.code || (s.lang && s.lang !== 'en' && s.series !== s.id) ? ' · ' + esc(s.code || rawId(s.id)) : ''}</span><span>${num(s.total)} cards</span></div>
    ${bar(p, p >= 100)}
    <div class="sub"><span>${num(ownedCount)}/${num(setSlots(s))} printings</span><span>${value ? `<span class="value">${money(value, { compact: true })}</span> set` : ''}</span></div>
  </a>`;
}

async function pageSets() {
  const lang = prefs.lang || 'en';
  const idx = await getIndex(lang);
  const owned = ownedBySet();
  app.innerHTML = `
    <h1>All sets</h1>
    <div class="langtabs" role="tablist" aria-label="Card language">
      ${LANGS.map((l) => `<button role="tab" data-lang="${l.id}" aria-selected="${l.id === lang}" class="${l.id === lang ? 'on' : ''}">${esc(l.name)}</button>`).join('')}
    </div>
    <p class="muted">${
      lang === 'en'
        ? `${num(idx.sets.length)} sets, grouped by era – including Black Star promos, trainer kits, McDonald's and special collections.`
        : idx.missing
          ? 'This catalogue is still being built – check back after the next data update.'
          : `${num(idx.sets.length)} ${esc(langInfo(lang).name)} sets. Names are shown as printed, with the English Pokémon name underneath. Not every card has a picture yet – they appear as the card database adds them.`
    }</p>
    <div class="toolbar">
      <div class="grow"><input class="search" id="q" type="search" placeholder="Search sets…" autocomplete="off"></div>
      <div class="seg" id="sfilter">
        <button data-v="all">All</button><button data-v="started">Started</button><button data-v="promo">Promos</button>
      </div>
      ${MASTER_SEG.replace('class="seg mset"', 'class="seg mset" id="smset"')}
      <select id="ssort" aria-label="Sort sets">
        <option value="newest">Newest first</option><option value="oldest">Oldest first</option>
        <option value="progress">Most complete</option><option value="value">Most valuable set</option>
      </select>
    </div>
    <div id="setlist"></div>`;
  let filter = 'all';
  const sortSel = $('#ssort');
  sortSel.value = prefs.setsSort;
  const ms = $('#smset');
  ms.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.v === prefs.master));
  ms.onclick = (e) => {
    const x = e.target.closest('button');
    if (!x) return;
    prefs.master = x.dataset.v;
    savePrefs();
    pageSets();
  };
  app.querySelector('.langtabs').onclick = (e) => {
    const t = e.target.closest('[data-lang]');
    if (!t) return;
    prefs.lang = t.dataset.lang;
    savePrefs();
    pageSets();
  };
  const draw = () => {
    const q = $('#q').value.trim().toLowerCase();
    let list = idx.sets.filter((s) => !q || s.name.toLowerCase().includes(q) || s.seriesName.toLowerCase().includes(q) || (s.code || rawId(s.id)).toLowerCase() === q);
    if (filter === 'started') list = list.filter((s) => owned.get(s.id));
    if (filter === 'promo') list = list.filter((s) => /promo/i.test(s.name));
    const sort = prefs.setsSort;
    const val = setValue;
    const html = [];
    if (sort === 'newest' || sort === 'oldest') {
      const dir = sort === 'newest' ? -1 : 1;
      const groups = new Map();
      for (const s of list) {
        if (!groups.has(s.series)) groups.set(s.series, { name: s.seriesName, sets: [], date: s.releaseDate || '' });
        const g = groups.get(s.series);
        g.sets.push(s);
        if ((s.releaseDate || '') < g.date) g.date = s.releaseDate;
      }
      const gs = [...groups.values()].sort((a, b) => dir * a.date.localeCompare(b.date));
      for (const g of gs) {
        g.sets.sort((a, b) => dir * (a.releaseDate || '').localeCompare(b.releaseDate || ''));
        const o = g.sets.reduce((a, s) => a + (owned.get(s.id) || 0), 0);
        const t = g.sets.reduce((a, s) => a + setSlots(s), 0);
        html.push(`<section class="series-block"><div class="series-head"><h2>${esc(g.name)}</h2><span class="muted">${g.sets.length} sets · ${num(o)}/${num(t)} printings</span></div>
          <div class="set-grid">${g.sets.map((s) => setCardHtml(s, owned.get(s.id) || 0)).join('')}</div></section>`);
      }
    } else {
      const key = sort === 'value' ? (s) => val(s) : (s) => (owned.get(s.id) || 0) / setSlots(s);
      list = [...list].sort((a, b) => key(b) - key(a));
      html.push(`<div class="set-grid">${list.map((s) => setCardHtml(s, owned.get(s.id) || 0)).join('')}</div>`);
    }
    $('#setlist').innerHTML = html.join('') || '<div class="empty"><h3>No sets match</h3></div>';
  };
  const seg = $('#sfilter');
  const markSeg = () => seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === filter));
  seg.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    filter = b.dataset.v;
    markSeg();
    draw();
  };
  sortSel.onchange = () => {
    prefs.setsSort = sortSel.value;
    savePrefs();
    draw();
  };
  $('#q').oninput = draw;
  markSeg();
  draw();
}

async function pageSet(id) {
  const idx = await getIndex(langOf(id));
  if (langOf(id) !== (prefs.lang || 'en')) ((prefs.lang = langOf(id)), savePrefs()); // "All sets" opens on this language
  loading('Loading set…');
  let set;
  try {
    set = await getSet(id);
  } catch {
    app.innerHTML = `<div class="empty"><h3>Set not found</h3><a class="btn" href="#/sets">Back to sets</a></div>`;
    return;
  }
  await getCameos();

  app.innerHTML = `
    <a class="back" href="#/sets">← All sets</a>
    <section class="panel">
      <div class="set-header">
        <div>${set.logo ? `<img class="logo" src="${esc(set.logo)}.webp" alt="${esc(set.name)}" data-fallback="${esc(set.name)}">` : ''}</div>
        <div>
          <h1>${esc(set.name)}</h1>
          <div class="meta"><span>${esc(set.seriesName)}</span><span>Released ${fmtDate(set.releaseDate)}</span>${set.code || (set.lang && set.lang !== 'en' && set.series !== set.id) ? `<span>Code ${esc(set.code || rawId(set.id))}</span>` : ''}${set.lang && set.lang !== 'en' ? `<span class="langchip">${esc(langInfo(set.lang).name)}</span>` : ''}<span>${set.official} official + ${Math.max(0, set.total - set.official)} secret</span></div>
          <div class="live" id="live"></div>
        </div>
        <div id="ring"></div>
      </div>
      <div class="set-stats" id="setstats"></div>
    </section>
    <div class="toolbar">
      <div class="seg" id="mode" title="Master set shows every printing (reverse holos, stamps…); Base set shows one per card number">
        <button data-v="master">Master set</button><button data-v="base">Base set</button>
      </div>
      <div class="seg" id="filter"><button data-v="all">All</button><button data-v="owned">Owned</button><button data-v="missing">Missing</button></div>
      ${MASTER_SEG.replace('class="seg mset"', 'class="seg mset" id="mset"')}
      <select id="sort" aria-label="Sort cards">
        <option value="number">Set order</option><option value="value-desc">Value: high → low</option>
        <option value="value-asc">Value: low → high</option><option value="name">Name A–Z</option>
      </select>
      <div class="grow"><input class="search" id="q" type="search" placeholder="Search name, number or a Pokémon in the art…" autocomplete="off"></div>
      <select id="layout" aria-label="Layout" title="Show the set as binder pages">
        <option value="grid">Grid</option>
        <option value="2x2">Binder · 4-pocket (2×2)</option>
        <option value="3x3">Binder · 9-pocket (3×3)</option>
        <option value="4x3">Binder · 12-pocket (4×3)</option>
        <option value="4x4">Binder · 16-pocket (4×4)</option>
      </select>
      <span class="count" id="count"></span>
      <button class="btn sm" id="selbtn" aria-pressed="false" title="Select several cards, then add or remove them together">☐ Select</button>
    </div>
    <div id="grid"></div>`;

  let shown = [];
  const stats = () => {
    let o = 0, cards = 0, vOwned = 0, vTotal = 0, slots = 0;
    for (const c of set.cards) {
      let any = false;
      for (const v of visibleV(c)) {
        slots++;
        const p = priceNum(v);
        vTotal += p;
        const q = qtyOf(c.id, v.k);
        if (q) {
          o++;
          any = true;
          vOwned += heldValue(c.id, v).total;
        }
      }
      if (any) cards++;
    }
    const mp = pct(o, slots);
    const bp = pct(cards, set.total);
    const officialOwned = set.cards.filter((c, i) => i < set.official && c.v.some((v) => qtyOf(c.id, v.k))).length;
    $('#ring').innerHTML = ring(prefs.mode === 'master' ? mp : bp);
    $('#setstats').innerHTML = `
      <div class="stat"><b>${num(o)} / ${num(slots)}</b><span>Printings in the ${masterLabel()}</span>${bar(mp, mp >= 100)}</div>
      <div class="stat"><b>${num(cards)} / ${num(set.total)}</b><span>Unique cards (incl. secret rares)</span>${bar(bp, bp >= 100)}</div>
      <div class="stat"><b>${num(officialOwned)} / ${num(set.official)}</b><span>Official set (${set.official} numbered)</span>${bar(pct(officialOwned, set.official), officialOwned >= set.official)}</div>
      <div class="stat"><b class="value">${money(vOwned)}</b><span>Your value · master set ≈ ${money(vTotal, { compact: true })}</span></div>`;
  };

  const draw = () => {
    const q = $('#q').value.trim().toLowerCase();
    const base = prefs.mode === 'base';
    let list = [];
    for (const card of set.cards) {
      const numHit = q && (card.n.toLowerCase() === q || card.n.replace(/^0+/, '') === q.replace(/^0+/, ''));
      const hit = numHit ? { by: 'name' } : searchHit(card, q, card.from || '');
      if (!hit) continue;
      const also = hit.by === 'cameo' ? hit.names.join(', ') : null;
      if (base) {
        const ownedV = card.v.find((v) => qtyOf(card.id, v.k));
        list.push({ card, v: ownedV || card.v[0], set, base: true, also, maxP: Math.max(0, ...card.v.map(priceNum)) });
      } else for (const v of visibleV(card)) list.push({ card, v, set, also });
    }
    const isOwned = (e) => (e.base ? e.card.v.some((v) => qtyOf(e.card.id, v.k)) : qtyOf(e.card.id, e.v.k) > 0);
    if (prefs.filter === 'owned') list = list.filter(isOwned);
    if (prefs.filter === 'missing') list = list.filter((e) => !isOwned(e));
    const pv = (e) => (e.base ? e.maxP : priceNum(e.v));
    if (prefs.sort === 'value-desc') list.sort((a, b) => pv(b) - pv(a));
    else if (prefs.sort === 'value-asc') list.sort((a, b) => (pv(a) || Infinity) - (pv(b) || Infinity));
    else if (prefs.sort === 'name') list.sort((a, b) => a.card.name.localeCompare(b.card.name) || a.card.idx - b.card.idx);
    shown = list;
    gridLookup = new Map();
    const html = list.map((e) => {
      const k = keyOf(e.card.id, e.v.k);
      gridLookup.set(k, e);
      e.tileOpts = { also: e.also, ...(e.base ? { anyOwned: isOwned(e) } : {}) };
      return tileHtml(e, e.tileOpts);
    });
    if (!list.length) $('#grid').innerHTML = '<div class="empty"><h3>Nothing here</h3><p>Try a different filter.</p></div>';
    else if (BINDERS[prefs.layout]) mountBinder($('#grid'), html, prefs.layout, set.id);
    else $('#grid').innerHTML = gridHtml(html);
    $('#count').textContent = `${num(list.length)} shown`;
    stats();
  };

  const bindSeg = (elId, prop) => {
    const seg = $('#' + elId);
    const mark = () => seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === prefs[prop]));
    seg.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      prefs[prop] = b.dataset.v;
      savePrefs();
      mark();
      draw();
    };
    mark();
  };
  bindSeg('mode', 'mode');
  bindSeg('filter', 'filter');
  bindSeg('mset', 'master');
  const sortSel = $('#sort');
  sortSel.value = prefs.sort;
  sortSel.onchange = () => {
    prefs.sort = sortSel.value;
    savePrefs();
    draw();
  };
  $('#q').oninput = draw;
  const layoutSel = $('#layout');
  layoutSel.value = prefs.layout;
  layoutSel.onchange = () => {
    prefs.layout = layoutSel.value;
    savePrefs();
    draw();
  };
  bindSelectButton();
  redrawPage = draw;
  afterToggle = () => {
    stats();
    if (prefs.filter !== 'all') {
      // the toggled card no longer matches the filter – redraw after a beat
      clearTimeout(afterToggle.t);
      afterToggle.t = setTimeout(draw, 450);
    }
  };
  document.title = `${set.name} – PokéVault`;
  draw();
  startLive(set.cards, draw);
}

async function pageCards() {
  await getIndex();
  const exLang = prefs.exLang || 'en';
  const idx = await getIndex(exLang);
  app.innerHTML = `<h1>Card Explorer</h1><p class="muted">Every printing from every set, ranked by value.</p>
    <div class="load-progress" id="lp">Loading ${num(idx.sets.length)} sets…${bar(0)}</div>`;
  const sets = await getSets(idx.sets.map((s) => s.id), (d, t) => {
    const b = app.querySelector('#lp .bar i');
    if (b) b.style.width = `${(d / t) * 100}%`;
  });
  await getCameos();
  if (location.hash.split('?')[0] !== '#/cards') return; // navigated away meanwhile
  const all = [];
  for (const s of sets) for (const card of s.cards) for (const v of card.v) all.push({ card, v, set: s });
  const seriesList = [...new Map(idx.sets.map((s) => [s.series, s.seriesName])).entries()];

  app.innerHTML = `<h1>Card Explorer</h1><p class="muted">Every printing from every ${exLang === 'en' ? '' : esc(langInfo(exLang).name) + ' '}set (${num(all.length)} in total), sorted across sets.</p>
    <div class="toolbar">
      <select id="exlang" aria-label="Card language">${LANGS.map((l) => `<option value="${l.id}"${l.id === exLang ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}</select>
      <div class="grow"><input class="search" id="q" type="search" placeholder="Search any card or a Pokémon in the art, e.g. Snivy…" autocomplete="off"></div>
      <div class="seg" id="filter"><button data-v="all">All</button><button data-v="owned">Owned</button><button data-v="graded">Graded</button><button data-v="missing">Missing</button></div>
      ${MASTER_SEG.replace('class="seg mset"', 'class="seg mset" id="exstamps"')}
      <select id="series" aria-label="Era"><option value="all">All eras</option>${seriesList.map(([id, n]) => `<option value="${esc(id)}">${esc(n)}</option>`).join('')}</select>
      <select id="sort" aria-label="Sort">
        <option value="value-desc">Value: high → low</option><option value="value-asc">Value: low → high</option>
        <option value="name">Name A–Z</option><option value="newest">Newest set first</option><option value="oldest">Oldest set first</option>
      </select>
      <span class="count" id="count"></span>
      <button class="btn sm" id="selbtn" aria-pressed="false" title="Select several cards, then add or remove them together">☐ Select</button>
    </div>
    <div class="card-grid" id="grid"></div>
    <div class="more"><button class="btn" id="more">Show more</button></div>`;

  const PAGE = 120;
  let list = [], limit = PAGE;
  const filterSeg = $('#filter');
  const sortSel = $('#sort');
  const seriesSel = $('#series');
  sortSel.value = prefs.exSort;
  seriesSel.value = prefs.exSeries;
  const compute = () => {
    const q = $('#q').value.trim().toLowerCase();
    list = all.filter((e) => {
      if (prefs.exSeries !== 'all' && e.set.series !== prefs.exSeries) return false;
      if (prefs.master === 'standard' && !isStandard(e.v)) return false;
      if (q) {
        const hit = searchHit(e.card, q, e.set.name);
        if (!hit) return false;
        e.also = hit.by === 'cameo' ? hit.names.join(', ') : null;
      } else e.also = null;
      if (prefs.exFilter === 'owned' && !qtyOf(e.card.id, e.v.k)) return false;
      if (prefs.exFilter === 'missing' && qtyOf(e.card.id, e.v.k)) return false;
      if (prefs.exFilter === 'graded' && !gradedOf(e.card.id, e.v.k).some(isGraded)) return false;
      return true;
    });
    const s = prefs.exSort;
    if (s === 'value-desc') list.sort((a, b) => priceNum(b.v) - priceNum(a.v));
    else if (s === 'value-asc') list.sort((a, b) => (priceNum(a.v) || Infinity) - (priceNum(b.v) || Infinity));
    else if (s === 'name') list.sort((a, b) => a.card.name.localeCompare(b.card.name));
    else {
      const dir = s === 'newest' ? -1 : 1;
      list.sort((a, b) => dir * (a.set.releaseDate || '').localeCompare(b.set.releaseDate || '') || a.card.idx - b.card.idx);
    }
    limit = PAGE;
    render();
  };
  const render = () => {
    gridLookup = new Map();
    const slice = list.slice(0, limit);
    $('#grid').innerHTML =
      slice
        .map((e) => {
          gridLookup.set(keyOf(e.card.id, e.v.k), { ...e, tileOpts: { showSet: true, also: e.also } });
          return tileHtml(e, { showSet: true, also: e.also });
        })
        .join('') || '<div class="empty" style="grid-column:1/-1"><h3>No cards match</h3></div>';
    const owned =
      prefs.exFilter === 'owned' ? list.reduce((a, e) => a + heldValue(e.card.id, e.v).total, 0)
      : prefs.exFilter === 'graded' ? list.reduce((a, e) => a + heldValue(e.card.id, e.v).graded, 0)
      : null;
    $('#count').innerHTML = `${num(list.length)} printings${owned != null ? ` · <span class="value">${money(owned)}</span>` : ''}`;
    $('#more').style.display = list.length > limit ? '' : 'none';
  };
  const mark = () => filterSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === prefs.exFilter));
  filterSeg.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    prefs.exFilter = b.dataset.v;
    savePrefs();
    mark();
    compute();
  };
  sortSel.onchange = () => ((prefs.exSort = sortSel.value), savePrefs(), compute());
  seriesSel.onchange = () => ((prefs.exSeries = seriesSel.value), savePrefs(), compute());
  let t;
  $('#q').oninput = () => (clearTimeout(t), (t = setTimeout(compute, 200)));
  $('#more').onclick = () => ((limit += PAGE), render(), syncSelection());
  const stSeg = $('#exstamps');
  const markSt = () => stSeg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.v === prefs.master));
  stSeg.onclick = (e) => {
    const x = e.target.closest('button');
    if (!x) return;
    prefs.master = x.dataset.v;
    savePrefs();
    markSt();
    compute();
  };
  markSt();
  $('#exlang').onchange = (e) => {
    prefs.exLang = e.target.value;
    prefs.exSeries = 'all';
    savePrefs();
    pageCards();
  };
  afterToggle = () => {};
  bindSelectButton();
  redrawPage = render;
  mark();
  compute();
}

// --------------------------------------------------------------------------
// Cameos: other Pokémon that appear in a card's artwork (data/cameos.json)
// --------------------------------------------------------------------------
let CAMEOS = null;
async function getCameos() {
  if (!CAMEOS) {
    try {
      CAMEOS = (await (await fetch('data/cameos.json')).json()).cards || {};
    } catch {
      CAMEOS = {};
    }
  }
  return CAMEOS;
}
const cameosOf = (card) => (CAMEOS && CAMEOS[card.id]) || [];
/** does the card match the search? 'name' | 'cameo' | null (cameo hits return the matching names) */
function searchHit(card, q, extra = '') {
  if (!q) return { by: 'name' };
  if (card.name.toLowerCase().includes(q) || (card.en && card.en.toLowerCase().includes(q)) || (extra && extra.toLowerCase().includes(q))) return { by: 'name' };
  const hits = cameosOf(card).filter((n) => n.toLowerCase().includes(q));
  return hits.length ? { by: 'cameo', names: hits } : null;
}

// --------------------------------------------------------------------------
// Custom binders
// --------------------------------------------------------------------------
const liveBinders = () => Object.values(binders).filter((b) => !b.del).sort((a, b) => (a.created || 0) - (b.created || 0));
function createBinder(name) {
  const id = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  binders[id] = { id, name: name.trim().slice(0, 60) || 'My binder', cards: [], layout: '3x3', created: Date.now(), m: Date.now() };
  saveCollection();
  return binders[id];
}
function touchBinder(b) {
  b.m = Date.now();
  saveCollection();
}
/** resolve binder keys ("cardId|variant") to { card, v, set } entries, in binder order */
async function binderEntries(b, onProgress) {
  const setIds = [...new Set(b.cards.map((k) => setIdOfCard(k.split('|')[0])))];
  await getIndexesFor(setIds);
  const sets = await getSets(setIds, onProgress);
  const byCard = new Map();
  for (const s of sets) for (const c of s.cards) byCard.set(c.id, { c, s });
  const out = [];
  for (const k of b.cards) {
    const [cid, vk] = k.split('|');
    const hit = byCard.get(cid);
    const v = hit?.c.v.find((x) => x.k === vk);
    if (v) out.push({ card: hit.c, v, set: hit.s });
  }
  return out;
}

async function pageBinders() {
  await getIndex();
  const list = liveBinders();
  // cover = first card of each binder
  const covers = new Map();
  await Promise.all(
    list.map(async (b) => {
      if (!b.cards.length) return;
      const [cid] = b.cards[0].split('|');
      try {
        const s = await getSet(setIdOfCard(cid));
        covers.set(b.id, s.cards.find((c) => c.id === cid));
      } catch {}
    }),
  );
  app.innerHTML = `<h1>My binders</h1>
    <p class="muted">Make your own binders – a favourite Pokémon, an artist, a colour theme – from any cards in any set.</p>
    <form class="panel newbinder" id="newbinder">
      <label for="bname">New binder</label>
      <input id="bname" type="text" maxlength="60" placeholder="e.g. Jigglypuff collection" autocomplete="off" required>
      <button class="btn primary" type="submit">＋ Create binder</button>
    </form>
    ${
      list.length
        ? `<div class="binder-list">${list
            .map((b) => {
              const owned = b.cards.filter((k) => collection[k]).length;
              const p = pct(owned, b.cards.length);
              const cover = covers.get(b.id);
              return `<a class="binder-card" href="#/binder/${encodeURIComponent(b.id)}">
                <div class="bc-cover">${cover && imgUrl(cover) ? `<img class="card-img" src="${esc(imgUrl(cover))}" alt="" loading="lazy">` : '<span>Empty</span>'}</div>
                <div class="bc-body"><div class="bc-name">${esc(b.name)}</div>
                  <div class="muted">${num(b.cards.length)} cards · ${num(owned)} owned</div>${bar(p, p >= 100 && b.cards.length > 0)}</div>
              </a>`;
            })
            .join('')}</div>`
        : '<div class="empty"><h3>No binders yet</h3><p>Give your first binder a name above, then add cards to it.</p></div>'
    }`;
  $('#newbinder').onsubmit = (e) => {
    e.preventDefault();
    const b = createBinder($('#bname').value);
    location.hash = `#/binder/${encodeURIComponent(b.id)}/add`;
  };
}

let pickerToggle = null; // set while the "add cards" picker is open
async function pageBinder(id, sub) {
  const b = binders[id];
  if (!b || b.del) {
    app.innerHTML = `<div class="empty"><h3>Binder not found</h3><a class="btn" href="#/binders">Back to binders</a></div>`;
    return;
  }
  await getIndex();
  await getCameos();
  if (sub === 'add') return binderPicker(b);
  loading('Opening binder…');
  let entries = await binderEntries(b);
  b.sort = b.sort || 'custom';
  b.filter = b.filter || 'all';
  app.innerHTML = `
    <a class="back" href="#/binders">← All binders</a>
    <section class="panel binder-head">
      <div><h1 id="bname">${esc(b.name)}</h1><div class="meta muted" id="bmeta"></div></div>
      <div class="row">
        <a class="btn primary" href="#/binder/${encodeURIComponent(b.id)}/add">＋ Add cards</a>
        <button class="btn" id="brename">Rename</button>
        <button class="btn danger" id="bdelete">Delete</button>
      </div>
      <div class="set-stats" id="bstats"></div>
    </section>
    <div class="toolbar">
      <div class="seg" id="bfilter"><button data-v="all">All</button><button data-v="owned">Owned</button><button data-v="missing">Missing</button></div>
      <select id="bsort" aria-label="Order">
        <option value="custom">Binder order</option><option value="release">Oldest set first</option><option value="newest">Newest set first</option>
        <option value="value-desc">Value: high → low</option><option value="value-asc">Value: low → high</option><option value="name">Name A–Z</option>
      </select>
      <select id="blayout" aria-label="Layout">
        <option value="grid">Grid</option><option value="2x2">Binder · 4-pocket (2×2)</option><option value="3x3">Binder · 9-pocket (3×3)</option>
        <option value="4x3">Binder · 12-pocket (4×3)</option><option value="4x4">Binder · 16-pocket (4×4)</option>
      </select>
      <span class="count" id="count"></span>
      <button class="btn sm" id="selbtn" aria-pressed="false" title="Select cards to reorder, remove from the binder or mark owned">☐ Select</button>
    </div>
    <div id="grid"></div>`;

  const stats = () => {
    let owned = 0, have = 0, need = 0;
    for (const e of entries) {
      const p = priceNum(e.v);
      if (qtyOf(e.card.id, e.v.k)) (owned++, (have += heldValue(e.card.id, e.v).total));
      else need += p;
    }
    const p = pct(owned, entries.length);
    $('#bmeta').textContent = `${num(entries.length)} cards from ${num(new Set(entries.map((e) => e.set.id)).size)} sets`;
    $('#bstats').innerHTML = `
      <div class="stat"><b>${num(owned)} / ${num(entries.length)}</b><span>Cards owned</span>${bar(p, p >= 100 && entries.length > 0)}</div>
      <div class="stat"><b class="value">${money(have)}</b><span>Value of what you own</span></div>
      <div class="stat"><b class="value">${money(need)}</b><span>Cost to complete</span></div>`;
  };
  const draw = () => {
    let list = entries.slice();
    const isOwned = (e) => qtyOf(e.card.id, e.v.k) > 0;
    if (b.filter === 'owned') list = list.filter(isOwned);
    if (b.filter === 'missing') list = list.filter((e) => !isOwned(e));
    const so = b.sort;
    if (so === 'value-desc') list.sort((x, y) => priceNum(y.v) - priceNum(x.v));
    else if (so === 'value-asc') list.sort((x, y) => (priceNum(x.v) || Infinity) - (priceNum(y.v) || Infinity));
    else if (so === 'name') list.sort((x, y) => x.card.name.localeCompare(y.card.name));
    else if (so === 'release' || so === 'newest') {
      const dir = so === 'newest' ? -1 : 1;
      list.sort((x, y) => dir * (x.set.releaseDate || '').localeCompare(y.set.releaseDate || '') || x.card.idx - y.card.idx);
    }
    gridLookup = new Map();
    const tiles = list.map((e) => {
      gridLookup.set(keyOf(e.card.id, e.v.k), { ...e, tileOpts: { showSet: true } });
      return tileHtml(e, { showSet: true });
    });
    if (!entries.length)
      $('#grid').innerHTML = `<div class="empty"><h3>This binder is empty</h3><p>Search for a Pokémon and add its cards – including ones where it appears in the background.</p>
        <a class="btn primary" href="#/binder/${encodeURIComponent(b.id)}/add">＋ Add cards</a></div>`;
    else if (!list.length) $('#grid').innerHTML = '<div class="empty"><h3>Nothing here</h3><p>Try a different filter.</p></div>';
    else if (BINDERS[b.layout]) mountBinder($('#grid'), tiles, b.layout, 'binder:' + b.id);
    else $('#grid').innerHTML = gridHtml(tiles);
    $('#count').textContent = `${num(list.length)} shown`;
    stats();
  };
  const seg = $('#bfilter');
  const markSeg = () => seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.v === b.filter));
  seg.onclick = (e) => {
    const x = e.target.closest('button');
    if (!x) return;
    b.filter = x.dataset.v;
    save(LS_BINDERS, binders);
    markSeg();
    draw();
  };
  $('#bsort').value = b.sort;
  $('#bsort').onchange = (e) => ((b.sort = e.target.value), save(LS_BINDERS, binders), draw());
  $('#blayout').value = b.layout || 'grid';
  $('#blayout').onchange = (e) => ((b.layout = e.target.value), touchBinder(b), draw());
  $('#brename').onclick = () => {
    const name = prompt('Rename binder', b.name);
    if (!name || !name.trim()) return;
    b.name = name.trim().slice(0, 60);
    touchBinder(b);
    $('#bname').textContent = b.name;
  };
  $('#bdelete').onclick = () => {
    if (!confirm(`Delete the binder "${b.name}"? Your cards stay in your collection.`)) return;
    binders[b.id] = { id: b.id, del: true, m: Date.now() };
    saveCollection();
    toast('Binder deleted');
    location.hash = '#/binders';
  };
  afterToggle = stats;
  bindSelectButton(b);
  redrawPage = async () => {
    entries = await binderEntries(b);
    draw();
  };
  draw();
  startLive([...new Set(entries.map((e) => e.card))], draw);
}

/** search every card (names and cameos) and tap to add/remove from the binder */
async function binderPicker(b) {
  await getIndex();
  const pickLang = b.pickLang || 'en';
  const idx = await getIndex(pickLang);
  app.innerHTML = `<a class="back" href="#/binder/${encodeURIComponent(b.id)}">← Back to ${esc(b.name)}</a>
    <h1>Add cards to ${esc(b.name)}</h1>
    <div class="load-progress" id="lp">Loading every set…${bar(0)}</div>`;
  const sets = await getSets(idx.sets.map((s) => s.id), (d, t) => {
    const x = app.querySelector('#lp .bar i');
    if (x) x.style.width = `${(d / t) * 100}%`;
  });
  if (!location.hash.endsWith('/add')) return;
  sets.sort((x, y) => (x.releaseDate || '').localeCompare(y.releaseDate || ''));
  const inBinder = new Set(b.cards);
  b.pickMode = b.pickMode || 'card';
  app.innerHTML = `<a class="back" href="#/binder/${encodeURIComponent(b.id)}">← Back to ${esc(b.name)}</a>
    <h1>Add cards to ${esc(b.name)}</h1>
    <p class="muted">Search a Pokémon, then tap cards to add or remove them. Cards where it appears in the artwork are included and marked <span class="also-chip">✦ in art</span>.</p>
    <div class="toolbar">
      <div class="grow"><input class="search" id="q" type="search" placeholder="Search a Pokémon, card or set, e.g. Jigglypuff" autocomplete="off" value="${esc(b.lastSearch || '')}"></div>
      <div class="seg" id="pmode" title="Show one tile per card, or every printing (reverse holo, stamps…)">
        <button data-v="card">One per card</button><button data-v="all">Every printing</button>
      </div>
      <div class="seg" id="pcam"><button data-v="yes">Include cameos</button><button data-v="no">Name only</button></div>
      <select id="plang" aria-label="Card language">${LANGS.map((l) => `<option value="${l.id}"${l.id === pickLang ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}</select>
      <span class="count" id="count"></span>
      <button class="btn sm" id="addall">＋ Add all results</button>
      <a class="btn sm primary" href="#/binder/${encodeURIComponent(b.id)}">Done</a>
    </div>
    <div class="card-grid picker" id="grid"></div>
    <div class="more"><button class="btn" id="more">Show more</button></div>`;
  let results = [], limit = 120;
  let cam = 'yes';
  const compute = () => {
    const q = $('#q').value.trim().toLowerCase();
    b.lastSearch = $('#q').value.trim();
    results = [];
    if (q.length >= 2) {
      for (const s of sets)
        for (const card of s.cards) {
          const hit = searchHit(card, q, s.name);
          if (!hit || (hit.by === 'cameo' && cam === 'no')) continue;
          // one per card: the printing already in the binder, else the regular (unlimited, unstamped) one
          const plain = card.v.find((v) => !v.s && !v.f && !v.z && (!v.sub || v.sub === 'unlimited')) || card.v[0];
          const vs = b.pickMode === 'all' ? visibleV(card) : [card.v.find((v) => b.cards.includes(keyOf(card.id, v.k))) || plain];
          for (const v of vs) results.push({ card, v, set: s, also: hit.by === 'cameo' ? hit.names.join(', ') : null });
        }
    }
    limit = 120;
    render();
  };
  const render = () => {
    gridLookup = new Map();
    const q = $('#q').value.trim();
    $('#grid').innerHTML =
      q.length < 2
        ? '<div class="empty" style="grid-column:1/-1"><h3>Search to find cards</h3><p>Try a Pokémon name like Jigglypuff, an artist-style theme like Eevee, or a set name.</p></div>'
        : results.length
          ? results
              .slice(0, limit)
              .map((e) => {
                const k = keyOf(e.card.id, e.v.k);
                gridLookup.set(k, e);
                return tileHtml(e, { showSet: true, also: e.also }).replace('class="tile', `class="tile${inBinder.has(k) ? ' inbinder' : ''}`);
              })
              .join('')
          : '<div class="empty" style="grid-column:1/-1"><h3>No cards found</h3></div>';
    const added = results.filter((e) => inBinder.has(keyOf(e.card.id, e.v.k))).length;
    $('#count').textContent = q.length < 2 ? '' : `${num(results.length)} found · ${num(added)} in binder`;
    $('#more').style.display = results.length > limit ? '' : 'none';
    $('#addall').disabled = !results.length;
  };
  pickerToggle = (entry, tile) => {
    const k = keyOf(entry.card.id, entry.v.k);
    if (inBinder.has(k)) {
      inBinder.delete(k);
      b.cards = b.cards.filter((x) => x !== k);
    } else {
      inBinder.add(k);
      b.cards.push(k);
    }
    touchBinder(b);
    tile.classList.toggle('inbinder', inBinder.has(k));
    const added = results.filter((e) => inBinder.has(keyOf(e.card.id, e.v.k))).length;
    $('#count').textContent = `${num(results.length)} found · ${num(added)} in binder`;
  };
  $('#addall').onclick = () => {
    const toAdd = results.map((e) => keyOf(e.card.id, e.v.k)).filter((k) => !inBinder.has(k));
    if (!toAdd.length) return toast('All of these are already in the binder');
    if (toAdd.length > 50 && !confirm(`Add ${toAdd.length} cards to ${b.name}?`)) return;
    toAdd.forEach((k) => (inBinder.add(k), b.cards.push(k)));
    touchBinder(b);
    render();
    toast(`Added ${num(toAdd.length)} cards`);
  };
  const bindSeg = (id, get, set) => {
    const seg = $('#' + id);
    const mark = () => seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.v === get()));
    seg.onclick = (e) => {
      const x = e.target.closest('button');
      if (!x) return;
      set(x.dataset.v);
      mark();
      compute();
    };
    mark();
  };
  bindSeg('pmode', () => b.pickMode, (v) => ((b.pickMode = v), save(LS_BINDERS, binders)));
  bindSeg('pcam', () => cam, (v) => (cam = v));
  let t;
  $('#q').oninput = () => (clearTimeout(t), (t = setTimeout(compute, 200)));
  $('#more').onclick = () => ((limit += 120), render());
  $('#plang').onchange = (e) => {
    b.pickLang = e.target.value;
    b.lastSearch = $('#q').value.trim();
    save(LS_BINDERS, binders);
    binderPicker(b);
  };
  afterToggle = () => {};
  compute();
  $('#q').focus();
}

async function pageSettings() {
  const idx = await getIndex();
  const n = Object.keys(collection).length;
  app.innerHTML = `<h1>Settings</h1>
    <div class="settings" style="margin-top:20px">
      <section class="panel" id="syncpanel"></section>
      <section class="panel"><h3>Back up your collection</h3>
        <p>Your collection (${num(n)} printings) and binders are saved in this browser${Sync.enabled ? ' and synced to GitHub' : ''}. You can also export them to a file as a backup.</p>
        <div class="row"><button class="btn primary" id="export">⬇ Export collection</button>
        <label class="btn">⬆ Import file<input type="file" id="import" accept="application/json,.json" hidden></label></div>
      </section>
      <section class="panel"><h3>Prices</h3>
        <p><b>Pounds (default)</b> use Cardmarket prices converted at today's exchange rate (£1 = €${(1 / FX.GBP).toFixed(3)}${FX.date ? `, rate from ${new Date(FX.date).toLocaleDateString()}` : ''}).
        <b>US dollars</b> use TCGplayer market prices and <b>euros</b> use Cardmarket trend prices.
        When a printing has no price in the selected market it is converted from the other one and marked with ≈.</p>
        <p>Graded market prices (PSA, CGC, BGS…): ${
          Object.keys(GRADED).length
            ? `${num(Object.values(GRADED).filter((g) => Object.keys(g.usd || {}).length).length)} cards covered${GRADED_UPDATED ? `, updated ${new Date(GRADED_UPDATED).toLocaleDateString()}` : ''}.`
            : 'not set up yet – add a free Pokemon Price Tracker API key as the <code>PPT_API_KEY</code> repository secret (see the README).'
        }</p>
        <p>Set pages and your portfolio load live prices when you open them (kept for 12 hours). Everything else uses the saved prices from
        <b>${idx.updated ? new Date(idx.updated).toLocaleString() : 'unknown'}</b>.</p>
      </section>
      <section class="panel"><h3>Display</h3>
        <p>Card size in grids.</p>
        <div class="row"><input type="range" id="tile" min="110" max="260" step="10" value="${prefs.tile}" style="flex:1"><span id="tilev">${prefs.tile}px</span></div>
      </section>
      <section class="panel"><h3>Reset</h3><p>Remove every card from your collection on this device.</p>
        <button class="btn danger" id="reset">Delete my collection</button></section>
    </div>`;
  $('#export').onclick = () => {
    const blob = new Blob([JSON.stringify({ app: 'pokevault', version: 2, exported: new Date().toISOString(), collection, binders }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pokevault-collection-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('#import').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const incoming = data.collection || data;
      if (typeof incoming !== 'object') throw new Error();
      const replace = confirm('Replace your current collection with this file?\n\nOK = replace, Cancel = merge into current collection');
      if (replace) clearCollection();
      let added = 0;
      for (const [k, v] of Object.entries(incoming)) {
        const q = typeof v === 'number' ? v : Number(v?.q) || 0;
        const g = Array.isArray(v?.g) ? v.g : [];
        if (!k.includes('|') || !(q > 0 || g.length)) continue;
        collection[k] = { q: Math.max(q, collection[k]?.q || 0), t: v?.t || Date.now(), m: Date.now() };
        const slabs = [...(collection[k].g || []), ...g.filter((sl) => !(collection[k].g || []).some((x) => x.id === sl.id))];
        if (slabs.length) collection[k].g = slabs;
        delete tombs[k];
        added++;
      }
      // binders from the backup (a newer copy of the same binder wins)
      let nb = 0;
      for (const [id, b] of Object.entries(data.binders || {})) {
        if (!b || typeof b !== 'object' || !Array.isArray(b.cards ?? []) || (binders[id] && (binders[id].m || 0) >= (b.m || 0))) continue;
        binders[id] = { ...b, m: Date.now() };
        if (!b.del) nb++;
      }
      saveCollection();
      toast(`Imported ${added} printings${nb ? ` and ${nb} binder${nb === 1 ? '' : 's'}` : ''}`);
      pageSettings();
    } catch {
      toast('That file is not a PokéVault backup');
    }
  };
  $('#tile').oninput = (e) => {
    prefs.tile = Number(e.target.value);
    $('#tilev').textContent = prefs.tile + 'px';
    applyTile();
    savePrefs();
  };
  $('#reset').onclick = () => {
    if (!confirm(`Delete your whole collection${Sync.enabled ? ' on all your synced devices' : ' from this browser'}? This cannot be undone (export first!).`)) return;
    clearCollection();
    saveCollection();
    toast('Collection deleted');
    pageSettings();
  };
  renderSyncPanel();
}

function renderSyncPanel() {
  const el = $('#syncpanel');
  if (!el) return;
  const c = Sync.cfg;
  if (!c) {
    el.innerHTML = `<h3>Sync across devices</h3>
      <p>Save your collection to your GitHub account so it's the same on your phone, tablet and computer.
      Each person uses their own GitHub account, so you each keep a separate collection.</p>
      <ol class="steps">
        <li><a href="https://github.com/settings/tokens/new?scopes=gist&description=Pok%C3%A9Vault%20sync" target="_blank" rel="noopener">Create a GitHub token ↗</a>
          – the link pre-ticks only the <b>gist</b> permission. Choose an expiry (or "No expiration"), then click <b>Generate token</b> and copy it.</li>
        <li>Paste it below and press <b>Connect</b>. Do the same on each of your devices with the same token and collection name.</li>
      </ol>
      <form id="syncform" class="syncform">
        <label>GitHub token<input id="synctoken" type="password" autocomplete="off" placeholder="ghp_…" required></label>
        <label>Collection name<input id="syncprofile" type="text" value="main" autocomplete="off" maxlength="40"></label>
        <button class="btn primary" type="submit" id="syncconnect">Connect</button>
      </form>
      <p class="small">Sharing one GitHub account? Use a different collection name for each person (for example "dom" and "sam").
      The token is stored only in this browser and can only read and write your gists.</p>
      <p class="error" id="syncerr" hidden></p>`;
    $('#syncform').onsubmit = async (e) => {
      e.preventDefault();
      const btn = $('#syncconnect');
      btn.disabled = true;
      btn.textContent = 'Connecting…';
      $('#syncerr').hidden = true;
      try {
        await Sync.connect($('#synctoken').value, $('#syncprofile').value);
        toast('Sync is on');
        pageSettings();
      } catch (err) {
        if (!$('#syncerr')) return pageSettings(); // connected, but the first sync failed – the panel shows why
        $('#syncerr').textContent = err.message;
        $('#syncerr').hidden = false;
        btn.disabled = false;
        btn.textContent = 'Connect';
      }
    };
    return;
  }
  const status =
    Sync.state === 'error' ? `<span class="error">${esc(Sync.message)}</span>`
    : Sync.state === 'syncing' || Sync.state === 'pending' ? 'Syncing…'
    : c.last ? `Last synced ${agoText(c.last)}` : 'Not synced yet';
  el.innerHTML = `<h3>Sync across devices</h3>
    <p>Signed in as <b>@${esc(c.login || '?')}</b> · collection <b>${esc(c.profile)}</b> · ${status}</p>
    <p class="small">Changes sync automatically a couple of seconds after you make them, and other devices pick them up when you open or switch back to the site.
    ${c.gistId ? `Stored in <a href="https://gist.github.com/${esc(c.login || '')}/${esc(c.gistId)}" target="_blank" rel="noopener">this private gist ↗</a> as <code>${esc(Sync.fileName())}</code>.` : ''}</p>
    <div class="row"><button class="btn primary" id="syncnow">⟳ Sync now</button><button class="btn danger" id="syncoff">Turn off sync on this device</button></div>`;
  $('#syncnow').onclick = () => Sync.sync();
  $('#syncoff').onclick = () => {
    if (!confirm('Turn off sync on this device? Your cards stay on this device and in GitHub.')) return;
    Sync.disconnect();
    pageSettings();
  };
}

// sync status chip in the top bar
const syncChip = $('#syncchip');
function renderSyncChip() {
  syncChip.hidden = !Sync.enabled;
  if (!Sync.enabled) return;
  const st = Sync.state;
  syncChip.className = 'syncchip ' + st;
  syncChip.querySelector('span').textContent = st === 'error' ? 'Sync problem' : st === 'syncing' || st === 'pending' ? 'Syncing…' : 'Synced';
  syncChip.title = st === 'error' ? Sync.message : Sync.cfg.last ? `Last synced ${agoText(Sync.cfg.last)} – click for sync settings` : 'Sync settings';
  if (location.hash === '#/settings' && st !== 'pending') renderSyncPanel();
}
Sync.subscribe(renderSyncChip);

// --------------------------------------------------------------------------
// Router
// --------------------------------------------------------------------------
function applyTile() {
  document.documentElement.style.setProperty('--tile', prefs.tile + 'px');
}
function markCurrency() {
  document.querySelectorAll('.currency button').forEach((b) => b.classList.toggle('on', b.dataset.cur === prefs.currency));
}
document.querySelector('.currency').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.dataset.cur === prefs.currency) return;
  prefs.currency = b.dataset.cur;
  savePrefs();
  markCurrency();
  route(true);
});

let lastHash = null;
let routeSeq = 0;
async function route(keepScroll = false) {
  routeSeq++;
  const prevHash = lastHash;
  if ((location.hash || '#/') !== prevHash) {
    redrawPage = null;
    if (selectMode) setSelectMode(false);
  }
  const hash = location.hash || '#/';
  const [, page, arg] = hash.split('?')[0].split('/');
  const name = page || 'portfolio';
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === (name === 'set' ? 'sets' : name === 'binder' ? 'binders' : name)));
  pickerToggle = null;
  document.title = 'PokéVault – Card Set Tracker';
  const y = window.scrollY;
  if (modal.open) {
    changedWhileModal = false; // we're re-rendering anyway
    modal.close();
  }
  try {
    await getGraded();
    if (name === 'portfolio' || name === '') await pagePortfolio();
    else if (name === 'sets') await pageSets();
    else if (name === 'set') await pageSet(decodeURIComponent(arg || ''));
    else if (name === 'cards') await pageCards();
    else if (name === 'settings') await pageSettings();
    else if (name === 'binders') await pageBinders();
    else if (name === 'binder') await pageBinder(decodeURIComponent(arg || ''), hash.split('?')[0].split('/')[3]);
    else await pagePortfolio();
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="empty"><h3>Something went wrong</h3><p>${esc(e.message)}</p><button class="btn" onclick="location.reload()">Reload</button></div>`;
  }
  if (keepScroll && hash === lastHash) window.scrollTo(0, y);
  else window.scrollTo(0, 0);
  lastHash = hash;
}
window.addEventListener('hashchange', () => route());
// keep tabs in sync if the collection is edited in another tab
window.addEventListener('storage', (e) => {
  if (e.key === LS_COLLECTION) {
    collection = load(LS_COLLECTION, {});
    tombs = load(LS_TOMBS, {});
    route(true);
  }
});

if (migrateJumbos()) saveCollection();
applyTile();
markCurrency();
renderSyncChip();
route();
Sync.sync();
// fetch today's exchange rates; re-render once if they changed and a converted currency is shown
loadRates().then((changed) => {
  if (changed && prefs.currency !== 'EUR') route(true);
});
