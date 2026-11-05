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
function saveCollection({ fromSync = false } = {}) {
  save(LS_COLLECTION, collection);
  save(LS_TOMBS, tombs);
  if (!fromSync) Sync.changed();
}
/** remove everything (keeps tombstones so other devices remove it too) */
function clearCollection() {
  const now = Date.now();
  for (const k of Object.keys(collection)) tombs[k] = now;
  collection = {};
}

const keyOf = (cardId, vk) => `${cardId}|${vk}`;
const qtyOf = (cardId, vk) => collection[keyOf(cardId, vk)]?.q || 0;
const setIdOfCard = (cardId) => cardId.slice(0, cardId.lastIndexOf('-'));

function setQty(cardId, vk, q) {
  const k = keyOf(cardId, vk);
  const now = Date.now();
  if (q > 0) {
    collection[k] = { q, t: collection[k]?.t || now, m: now };
    delete tombs[k];
  } else if (collection[k]) {
    delete collection[k];
    tombs[k] = now;
  }
  saveCollection();
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

  const payload = () => JSON.stringify({ app: 'pokevault', version: 2, updated: new Date().toISOString(), collection, deleted: tombs });

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
        if (!local || local.q !== r.q) localChanged = true;
        collection[k] = { q: r.q, t: r.t || stamp(r), m: stamp(r) };
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
      for (const [k, e] of Object.entries(collection)) if (!R[k] || stamp(R[k]) !== stamp(e) || R[k].q !== e.q) { remoteStale = true; break; }
      if (!remoteStale) for (const k of Object.keys(R)) if (!collection[k]) { remoteStale = true; break; }
      if (!remoteStale) for (const [k, m] of Object.entries(tombs)) if (RD[k] !== m) { remoteStale = true; break; }
    }
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
      const { localChanged, remoteStale } = merge(remote);
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

async function getIndex() {
  if (INDEX) return INDEX;
  const res = await fetch('data/sets.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('Could not load set list');
  INDEX = await res.json();
  INDEX.byId = new Map(INDEX.sets.map((s) => [s.id, s]));
  return INDEX;
}

function getSet(id) {
  if (!setCache.has(id)) {
    const p = fetch(`data/sets/${encodeURIComponent(id)}.json`)
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
const LIVE_API = 'https://api.tcgdex.net/v2/en/cards/';
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
  const todo = cards.filter((c) => !liveFresh(c.id));
  let done = 0, updated = 0, failures = 0, i = 0;
  onProgress?.(0, todo.length);
  await Promise.all(
    Array.from({ length: Math.min(6, todo.length) }, async () => {
      while (i < todo.length && failures < 8) {
        const card = todo[i++];
        try {
          const res = await fetch(LIVE_API + encodeURIComponent(card.id));
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
function ownedBySet() {
  const m = new Map();
  for (const k of Object.keys(collection)) {
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
const imgUrl = (c, q = 'low') => (c.img ? `${c.img}/${q}.webp` : '');

const STAMP_NAMES = {
  '1st-edition': '1st Edition', 'pokemon-center': 'Pokémon Center', 'set-logo': 'Set Logo', staff: 'Staff', 'w-promo': 'W Promo',
  'player-rewards-program': 'Play! Rewards', 'professor-program': 'Professor', 'pokemon-together': 'Pokémon Together',
  gamestop: 'GameStop', 'eb-games': 'EB Games', 'top-thirty-two': 'Top 32', 'top-sixteen': 'Top 16', 'top-eight': 'Top 8',
  'semi-finalist': 'Semi-Finalist', finalist: 'Finalist', winner: 'Winner', prerelease: 'Prerelease',
};
const FOIL_NAMES = { cosmos: 'Cosmos Holo', pokeball: 'Poké Ball', masterball: 'Master Ball', galaxy: 'Galaxy Holo', gold: 'Gold', league: 'League', cracked_ice: 'Cracked Ice', 'cracked-ice': 'Cracked Ice' };
const titleCase = (s) => s.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bPokemon\b/g, 'Pokémon');

/** [{text, cls}] badges describing the printing */
function variantBadges(v, card) {
  const out = [];
  const stamps = v.s || [];
  if (stamps.includes('1st-edition')) out.push({ text: '1st Edition', cls: 'ed' });
  if (v.sub && v.sub !== 'unlimited') out.push({ text: titleCase(v.sub), cls: 'ed' });
  else if (v.sub === 'unlimited') out.push({ text: 'Unlimited', cls: '' });
  if (v.t === 'reverse') out.push({ text: 'Reverse Holo', cls: 'rev' });
  else if (v.t === 'holo') {
    if (!/holo|rare|ex|gx|v$|vmax|vstar|ultra|secret|illustration|hyper|amazing|radiant|ace/i.test(card?.r || '') || card?.v?.some((x) => x.t === 'normal' && !x.s && !x.f))
      out.push({ text: 'Holo', cls: 'holo' });
  } else if (v.t !== 'normal') out.push({ text: titleCase(v.t), cls: 'holo' });
  if (v.f) out.push({ text: FOIL_NAMES[v.f] || titleCase(v.f), cls: 'foilb' });
  for (const s of stamps) if (s !== '1st-edition') out.push({ text: STAMP_NAMES[s] || titleCase(s), cls: 'stamp' });
  if (v.z) out.push({ text: titleCase(v.z), cls: 'size' });
  return out;
}
const variantName = (v, card) => variantBadges(v, card).map((b) => b.text).join(' · ') || (v.t === 'holo' ? 'Holo' : 'Normal');
const badgesHtml = (v, card) => variantBadges(v, card).map((b) => `<span class="badge ${b.cls}">${esc(b.text)}</span>`).join('');
const isFoil = (v) => v.t !== 'normal' || !!v.f;

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
function tileHtml({ card, v, set }, { showSet = false, anyOwned = null } = {}) {
  const q = qtyOf(card.id, v.k);
  const owned = anyOwned ?? q > 0;
  const k = keyOf(card.id, v.k);
  return `<div class="tile${owned ? ' owned' : ''}${isFoil(v) ? ' foil' : ''}${selected.has(k) ? ' sel' : ''}" data-key="${esc(k)}">
    <span class="selmark" aria-hidden="true"></span>
    <div class="fw"><button class="face" data-act="toggle" aria-pressed="${owned}" title="${owned ? 'Owned – click to remove' : 'Click to mark as owned'}">
      ${card.img ? `<img class="card-img" src="${esc(imgUrl(card))}" alt="${esc(card.name)}" loading="lazy" decoding="async">` : `<div class="placeholder">${esc(card.name)}</div>`}
      <span class="check" aria-hidden="true">✓</span>
      ${q > 1 ? `<span class="qty">×${q}</span>` : ''}
    </button>
    <button class="info-btn" data-act="info" aria-label="Details for ${esc(card.name)}">i</button></div>
    <div class="cap"><span class="nm" title="${esc(card.name)}">${esc(card.name)}</span><span class="num">${esc(card.n)}${set?.official && /^\d+$/.test(card.n) ? '/' + set.official : ''}</span></div>
    <div class="row2"><span class="badges">${badgesHtml(v, card)}</span>${priceHtml(v)}</div>
    ${showSet ? `<div class="setname">${esc(set.name)}</div>` : ''}
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
function bindSelectButton() {
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
      <div>${card.img ? `<img class="big card-img" src="${esc(imgUrl(card, 'high'))}" alt="${esc(card.name)}">` : `<div class="big" style="display:grid;place-items:center">${esc(card.name)}</div>`}</div>
      <div>
        <div class="muted">${esc(set.name)} · #${esc(card.n)}${set.official ? ' / ' + set.official : ''}</div>
        <h2>${esc(card.name)}</h2>
        <dl class="facts">
          ${card.r ? `<dt>Rarity</dt><dd>${esc(card.r)}</dd>` : ''}
          ${card.cat ? `<dt>Category</dt><dd>${esc(card.cat)}${card.ty ? ' · ' + card.ty.map(esc).join(', ') : ''}</dd>` : ''}
          ${card.ill ? `<dt>Illustrator</dt><dd>${esc(card.ill)}</dd>` : ''}
          <dt>Set</dt><dd><a href="#/set/${encodeURIComponent(set.id)}" data-close>${esc(set.name)}</a> <span class="muted">(${esc(set.seriesName)}, ${fmtDate(set.releaseDate)})</span></dd>
          <dt>Status</dt><dd>${ownedAny ? '<span style="color:var(--green)">In your collection</span>' : '<span class="muted">Not owned</span>'}</dd>
        </dl>
        <h3 style="margin:18px 0 10px">Printings in the master set</h3>
        <div class="variant-list">
          ${card.v
            .map((v) => {
              const q = qtyOf(card.id, v.k);
              return `<div class="variant-row${q ? ' owned' : ''}">
                <div><div class="badges">${badgesHtml(v, card) || '<span class="badge">Normal</span>'}</div></div>
                ${priceHtml(v)}
                <div class="stepper" data-vk="${esc(v.k)}"><button data-d="-1" aria-label="Remove one">−</button><span>${q}</span><button data-d="1" aria-label="Add one">+</button></div>
              </div>`;
            })
            .join('')}
        </div>
        <div class="ext-links">
          <a class="btn sm" target="_blank" rel="noopener" href="https://www.tcgplayer.com/search/pokemon/product?q=${encodeURIComponent(card.name + ' ' + set.name)}">TCGplayer ↗</a>
          <a class="btn sm" target="_blank" rel="noopener" href="https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=${encodeURIComponent(card.name)}">Cardmarket ↗</a>
          <a class="btn sm" target="_blank" rel="noopener" href="https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(`pokemon ${card.name} ${set.name} ${card.n}`)}&LH_Sold=1">eBay sold ↗</a>
        </div>
      </div>
    </div>`;
  };
  render();
  modal.onclick = (e) => {
    if (e.target === modal || e.target.closest('.close') || e.target.closest('[data-close]')) return modal.close();
    const b = e.target.closest('.stepper button');
    if (b) {
      const vk = b.parentElement.dataset.vk;
      setQty(card.id, vk, Math.max(0, qtyOf(card.id, vk) + Number(b.dataset.d)));
      render();
      changedWhileModal = true;
    }
  };
  changedWhileModal = false;
  modal.showModal();
}
let changedWhileModal = false;
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
  const ownedSetIds = [...owned.keys()].filter((id) => idx.byId.has(id));

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

  let total = 0, copies = 0, slots = 0, priced = 0;
  const entries = [];
  const perSet = [];
  const perSeries = new Map();
  for (const s of sets) {
    let sOwned = 0, sValue = 0, sCards = 0;
    for (const card of s.cards) {
      let any = false;
      for (const v of card.v) {
        const q = qtyOf(card.id, v.k);
        if (!q) continue;
        any = true;
        const p = priceNum(v);
        sOwned++;
        copies += q;
        sValue += p * q;
        if (p) priced++;
        entries.push({ card, v, set: s, p, t: collection[keyOf(card.id, v.k)].t });
      }
      if (any) sCards++;
    }
    slots += sOwned;
    total += sValue;
    perSet.push({ s, sOwned, sValue, sCards });
    const ser = perSeries.get(s.seriesName) || { v: 0, n: 0, order: idx.byId.get(s.id)?.seriesOrder ?? 99 };
    ser.v += sValue;
    ser.n += sOwned;
    perSeries.set(s.seriesName, ser);
  }
  const complete = perSet.filter((x) => x.sOwned >= x.s.variants).length;
  const top = [...entries].sort((a, b) => b.p - a.p).slice(0, 12);
  const recent = [...entries].sort((a, b) => b.t - a.t).slice(0, 12);
  const progress = [...perSet].sort((a, b) => b.sOwned / b.s.variants - a.sOwned / a.s.variants);
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
    </section>

    <h2 class="section">Most valuable cards <small>your top 12</small></h2>
    <div class="card-grid">${top.map(reg).join('')}</div>

    <div class="two-col">
      <div>
        <h2 class="section">Set progress <small>master set completion</small></h2>
        <div class="progress-list">
          ${progress
            .map(({ s, sOwned, sValue, sCards }) => {
              const p = pct(sOwned, s.variants);
              return `<a class="progress-item" href="#/set/${encodeURIComponent(s.id)}">
                ${s.logo ? `<img src="${esc(s.logo)}.webp" alt="" loading="lazy" data-fallback="">` : '<span></span>'}
                <div><div class="name">${esc(s.name)}</div>${bar(p, p >= 100)}
                  <div class="meta"><span>${num(sOwned)}/${num(s.variants)} printings · ${num(sCards)}/${num(s.total)} cards</span><span class="value">${money(sValue)}</span></div></div>
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

function setCardHtml(s, ownedCount) {
  const p = pct(ownedCount, s.variants);
  const cls = p >= 100 ? 'complete' : ownedCount ? 'started' : '';
  const value = setValue(s);
  return `<a class="set-card ${cls}" href="#/set/${encodeURIComponent(s.id)}">
    <div class="logo">${setLogo(s)}</div>
    <div class="title">${s.symbol ? `<img src="${esc(s.symbol)}.webp" alt="" loading="lazy" data-fallback="">` : ''}<span>${esc(s.name)}</span></div>
    <div class="sub"><span>${fmtDate(s.releaseDate)}${s.code ? ' · ' + esc(s.code) : ''}</span><span>${num(s.total)} cards</span></div>
    ${bar(p, p >= 100)}
    <div class="sub"><span>${num(ownedCount)}/${num(s.variants)} printings</span><span>${value ? `<span class="value">${money(value, { compact: true })}</span> set` : ''}</span></div>
  </a>`;
}

async function pageSets() {
  const idx = await getIndex();
  const owned = ownedBySet();
  app.innerHTML = `
    <h1>All sets</h1>
    <p class="muted">${num(idx.sets.length)} sets, grouped by era – including Black Star promos, trainer kits, McDonald's and special collections.</p>
    <div class="toolbar">
      <div class="grow"><input class="search" id="q" type="search" placeholder="Search sets…" autocomplete="off"></div>
      <div class="seg" id="sfilter">
        <button data-v="all">All</button><button data-v="started">Started</button><button data-v="promo">Promos</button>
      </div>
      <select id="ssort" aria-label="Sort sets">
        <option value="newest">Newest first</option><option value="oldest">Oldest first</option>
        <option value="progress">Most complete</option><option value="value">Most valuable set</option>
      </select>
    </div>
    <div id="setlist"></div>`;
  let filter = 'all';
  const sortSel = $('#ssort');
  sortSel.value = prefs.setsSort;
  const draw = () => {
    const q = $('#q').value.trim().toLowerCase();
    let list = idx.sets.filter((s) => !q || s.name.toLowerCase().includes(q) || s.seriesName.toLowerCase().includes(q) || (s.code || '').toLowerCase() === q);
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
        const t = g.sets.reduce((a, s) => a + s.variants, 0);
        html.push(`<section class="series-block"><div class="series-head"><h2>${esc(g.name)}</h2><span class="muted">${g.sets.length} sets · ${num(o)}/${num(t)} printings</span></div>
          <div class="set-grid">${g.sets.map((s) => setCardHtml(s, owned.get(s.id) || 0)).join('')}</div></section>`);
      }
    } else {
      const key = sort === 'value' ? (s) => val(s) : (s) => (owned.get(s.id) || 0) / s.variants;
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
  const idx = await getIndex();
  loading('Loading set…');
  let set;
  try {
    set = await getSet(id);
  } catch {
    app.innerHTML = `<div class="empty"><h3>Set not found</h3><a class="btn" href="#/sets">Back to sets</a></div>`;
    return;
  }
  const meta = idx.byId.get(id) || set;

  app.innerHTML = `
    <a class="back" href="#/sets">← All sets</a>
    <section class="panel">
      <div class="set-header">
        <div>${set.logo ? `<img class="logo" src="${esc(set.logo)}.webp" alt="${esc(set.name)}" data-fallback="${esc(set.name)}">` : ''}</div>
        <div>
          <h1>${esc(set.name)}</h1>
          <div class="meta"><span>${esc(set.seriesName)}</span><span>Released ${fmtDate(set.releaseDate)}</span>${set.code ? `<span>Code ${esc(set.code)}</span>` : ''}<span>${set.official} official + ${Math.max(0, set.total - set.official)} secret</span></div>
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
      <select id="sort" aria-label="Sort cards">
        <option value="number">Set order</option><option value="value-desc">Value: high → low</option>
        <option value="value-asc">Value: low → high</option><option value="name">Name A–Z</option>
      </select>
      <div class="grow"><input class="search" id="q" type="search" placeholder="Search name or number…" autocomplete="off"></div>
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
    let o = 0, cards = 0, vOwned = 0, vTotal = 0;
    for (const c of set.cards) {
      let any = false;
      for (const v of c.v) {
        const p = priceNum(v);
        vTotal += p;
        const q = qtyOf(c.id, v.k);
        if (q) {
          o++;
          any = true;
          vOwned += p * q;
        }
      }
      if (any) cards++;
    }
    const mp = pct(o, set.variants);
    const bp = pct(cards, set.total);
    const officialOwned = set.cards.filter((c, i) => i < set.official && c.v.some((v) => qtyOf(c.id, v.k))).length;
    $('#ring').innerHTML = ring(prefs.mode === 'master' ? mp : bp);
    $('#setstats').innerHTML = `
      <div class="stat"><b>${num(o)} / ${num(set.variants)}</b><span>Master set printings</span>${bar(mp, mp >= 100)}</div>
      <div class="stat"><b>${num(cards)} / ${num(set.total)}</b><span>Unique cards (incl. secret rares)</span>${bar(bp, bp >= 100)}</div>
      <div class="stat"><b>${num(officialOwned)} / ${num(set.official)}</b><span>Official set (${set.official} numbered)</span>${bar(pct(officialOwned, set.official), officialOwned >= set.official)}</div>
      <div class="stat"><b class="value">${money(vOwned)}</b><span>Your value · master set ≈ ${money(vTotal, { compact: true })}</span></div>`;
  };

  const draw = () => {
    const q = $('#q').value.trim().toLowerCase();
    const base = prefs.mode === 'base';
    let list = [];
    for (const card of set.cards) {
      if (q && !card.name.toLowerCase().includes(q) && card.n.toLowerCase() !== q && !(card.n.replace(/^0+/, '') === q.replace(/^0+/, ''))) continue;
      if (base) {
        const ownedV = card.v.find((v) => qtyOf(card.id, v.k));
        list.push({ card, v: ownedV || card.v[0], set, base: true, maxP: Math.max(0, ...card.v.map(priceNum)) });
      } else for (const v of card.v) list.push({ card, v, set });
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
      return tileHtml(e, e.base ? { anyOwned: isOwned(e) } : {});
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
  const idx = await getIndex();
  app.innerHTML = `<h1>Card Explorer</h1><p class="muted">Every printing from every set, ranked by value.</p>
    <div class="load-progress" id="lp">Loading ${num(idx.sets.length)} sets…${bar(0)}</div>`;
  const sets = await getSets(idx.sets.map((s) => s.id), (d, t) => {
    const b = app.querySelector('#lp .bar i');
    if (b) b.style.width = `${(d / t) * 100}%`;
  });
  if (location.hash.split('?')[0] !== '#/cards') return; // navigated away meanwhile
  const all = [];
  for (const s of sets) for (const card of s.cards) for (const v of card.v) all.push({ card, v, set: s });
  const seriesList = [...new Map(idx.sets.map((s) => [s.series, s.seriesName])).entries()];

  app.innerHTML = `<h1>Card Explorer</h1><p class="muted">Every printing from every set (${num(all.length)} in total), sorted across sets.</p>
    <div class="toolbar">
      <div class="grow"><input class="search" id="q" type="search" placeholder="Search any card, e.g. Charizard…" autocomplete="off"></div>
      <div class="seg" id="filter"><button data-v="all">All</button><button data-v="owned">Owned</button><button data-v="missing">Missing</button></div>
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
      if (q && !e.card.name.toLowerCase().includes(q) && !e.set.name.toLowerCase().includes(q)) return false;
      if (prefs.exFilter === 'owned' && !qtyOf(e.card.id, e.v.k)) return false;
      if (prefs.exFilter === 'missing' && qtyOf(e.card.id, e.v.k)) return false;
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
          gridLookup.set(keyOf(e.card.id, e.v.k), { ...e, tileOpts: { showSet: true } });
          return tileHtml(e, { showSet: true });
        })
        .join('') || '<div class="empty" style="grid-column:1/-1"><h3>No cards match</h3></div>';
    const owned = prefs.exFilter === 'owned' ? list.reduce((a, e) => a + priceNum(e.v) * qtyOf(e.card.id, e.v.k), 0) : null;
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
  afterToggle = () => {};
  bindSelectButton();
  redrawPage = render;
  mark();
  compute();
}

async function pageSettings() {
  const idx = await getIndex();
  const n = Object.keys(collection).length;
  app.innerHTML = `<h1>Settings</h1>
    <div class="settings" style="margin-top:20px">
      <section class="panel" id="syncpanel"></section>
      <section class="panel"><h3>Back up your collection</h3>
        <p>Your collection (${num(n)} printings) is saved in this browser${Sync.enabled ? ' and synced to GitHub' : ''}. You can also export it to a file as a backup.</p>
        <div class="row"><button class="btn primary" id="export">⬇ Export collection</button>
        <label class="btn">⬆ Import file<input type="file" id="import" accept="application/json,.json" hidden></label></div>
      </section>
      <section class="panel"><h3>Prices</h3>
        <p><b>Pounds (default)</b> use Cardmarket prices converted at today's exchange rate (£1 = €${(1 / FX.GBP).toFixed(3)}${FX.date ? `, rate from ${new Date(FX.date).toLocaleDateString()}` : ''}).
        <b>US dollars</b> use TCGplayer market prices and <b>euros</b> use Cardmarket trend prices.
        When a printing has no price in the selected market it is converted from the other one and marked with ≈.</p>
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
    const blob = new Blob([JSON.stringify({ app: 'pokevault', version: 1, exported: new Date().toISOString(), collection }, null, 1)], { type: 'application/json' });
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
        const q = typeof v === 'number' ? v : Number(v?.q);
        if (!k.includes('|') || !(q > 0)) continue;
        collection[k] = { q: Math.max(q, collection[k]?.q || 0), t: v?.t || Date.now(), m: Date.now() };
        delete tombs[k];
        added++;
      }
      saveCollection();
      toast(`Imported ${added} printings`);
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
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === (name === 'set' ? 'sets' : name)));
  document.title = 'PokéVault – Card Set Tracker';
  const y = window.scrollY;
  if (modal.open) modal.close();
  try {
    if (name === 'portfolio' || name === '') await pagePortfolio();
    else if (name === 'sets') await pageSets();
    else if (name === 'set') await pageSet(decodeURIComponent(arg || ''));
    else if (name === 'cards') await pageCards();
    else if (name === 'settings') await pageSettings();
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

applyTile();
markCurrency();
renderSyncChip();
route();
Sync.sync();
// fetch today's exchange rates; re-render once if they changed and a converted currency is shown
loadRates().then((changed) => {
  if (changed && prefs.currency !== 'EUR') route(true);
});
