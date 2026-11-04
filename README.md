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
- Master-set / base-set views, owned/missing filters, search, USD (TCGplayer) or EUR (Cardmarket) prices.
- Export/import your collection as JSON (it is stored in your browser's localStorage).

## Running it

It is plain HTML/CSS/JS, so any static host works:

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

To publish on GitHub Pages: *Settings → Pages → Deploy from a branch* and pick the branch / root folder.

## Card data

`data/` is generated from the free [TCGdex API](https://tcgdex.dev) by:

```sh
node scripts/build-data.mjs            # rebuild everything (~10 minutes)
node scripts/build-data.mjs sv01 svp   # rebuild only some sets
```

The `Refresh card data & prices` GitHub Action re-runs this every Monday (or on demand) and commits the
new prices. Coverage of stamps and variants depends on TCGdex.

Pokémon and its trademarks are © Nintendo, Creatures and GAME FREAK. This project is not affiliated with them.
