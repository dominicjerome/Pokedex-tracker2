# PokéVault – Pokémon TCG set tracker

A dark-purple, no-build static website for tracking Pokémon card master sets.

## Features

- **Portfolio splash page** – total collection value, unique printings, copies, sets started/completed,
  your most valuable cards, set progress, value by era and recently added cards.
- **Every set** – 205 English sets from Base Set (1999) to today, grouped by era, including Black Star
  promos, trainer kits, McDonald's collections, Pop series and special sets. TCG Pocket (digital) is left out.
- **True master-set order** – each card number lists every printing in order: 1st Edition / Shadowless /
  Unlimited, normal, holo, reverse holo, special foils (Cosmos, Poké Ball…), stamped variants
  (Pokémon Center, prerelease/set logo, staff, GameStop, Worlds…) and jumbos.
- **Owned cards in full colour, missing cards dimmed** – click a card to mark it owned; use the **i**
  button to set quantities for each printing.
- **Sort by value** – inside a set (Value high→low / low→high) and across *all* sets in the Card Explorer.
- **Multi-select** – press *Select*, tap cards (Shift-click for a range, or *Select all shown*), then
  *Mark owned* or *Remove* them in one go. Works on set pages and in the Card Explorer.
- **Binder layouts** – view a set as binder pages: 4-pocket (2×2), 9-pocket (3×3), 12-pocket (4×3) or
  16-pocket (4×4), with two-page spreads on wide screens.
- **Prices in £ (default), $ or €** – pounds use Cardmarket prices at today's exchange rate, dollars use TCGplayer.
  Set pages and the portfolio load live prices when opened (cached for 12 hours).
- **Graded cards** – add PSA / CGC / BGS / SGC / TAG / ACE copies with grade, your own value and cert number
  (open a card's **i** details). The portfolio splits raw and graded value and lists your slabs; the Card Explorer
  has a *Graded* filter. There is no free source of graded prices, so values are entered by you (each card links
  to eBay sold listings for that grade); a slab without a value counts at the raw price.
- **My binders** – make your own binders (a favourite Pokémon, an artist, a theme) from any cards in any set:
  search, tap to add, or *Add all results*; reorder with Select → Move to start / end; view as a grid or a
  flip-through binder. Binders sync with your collection.
- **Search finds Pokémon in the artwork** – searching "Snivy" also finds Fates Collide Jigglypuff 65/124, where
  Snivy appears in the background (marked ✦ in art). Data: [RotomAmiti's Cameo Pokémon Card Database](https://docs.google.com/spreadsheets/d/18nIkOgqQrHZTz0TrH_gL1e1nL1RcHiCmPF5finAjToY),
  rebuilt by `python3 scripts/build_cameos.py`.
- **Sync across devices** – in Settings, connect a GitHub token (gist permission only) and your collection
  is saved to a private gist and kept in step on every device. Each person uses their own account (or their
  own collection name on a shared account), so collections stay separate.
- Master-set / base-set views, owned/missing filters and search. Your collection and settings
  (currency, layout, filters) are remembered in your browser.
- Export/import your collection as JSON (it is stored in your browser's localStorage).

## Running it

It is plain HTML/CSS/JS, so any static host works:

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

To publish on GitHub Pages: *Settings → Pages → Deploy from a branch* and pick the branch / root folder.

## Card data

`data/` is generated from the free [TCGdex API](https://tcgdex.dev), with cards TCGdex is missing (for example
Sun & Moon "a" alternate prints and the 30th Celebration Mew B/G/R) filled in from [pokemontcg.io](https://pokemontcg.io), by:

```sh
node scripts/build-data.mjs            # rebuild everything (~10 minutes)
node scripts/build-data.mjs sv01 svp   # rebuild only some sets
node scripts/fill-gaps.mjs             # only re-check pokemontcg.io for missing cards
```

The `Refresh card data & prices` GitHub Action re-runs this every Monday (or on demand) and commits the
new prices. Coverage of stamps and variants depends on TCGdex.

Pokémon and its trademarks are © Nintendo, Creatures and GAME FREAK. This project is not affiliated with them.
