#!/usr/bin/env python3
"""Build data/cameos.json: which Pokémon appear in a card's artwork without being in its name.

Source: RotomAmiti's Cameo Pokémon Card Database (community Google Sheet)
https://docs.google.com/spreadsheets/d/18nIkOgqQrHZTz0TrH_gL1e1nL1RcHiCmPF5finAjToY

Output: { "<cardId>": ["Snivy", "Snubbull"], ... } for cards in data/sets/*.json.
Rows for cards never released in English (light-blue rows) are skipped, and every match is
checked against the card name at that number so a cameo can't land on the wrong card.

Run:  pip install openpyxl && python3 scripts/build_cameos.py
"""
import io
import json
import re
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SHEET = "https://docs.google.com/spreadsheets/d/18nIkOgqQrHZTz0TrH_gL1e1nL1RcHiCmPF5finAjToY/export?format=xlsx"
NOT_ENGLISH = "FFCFE2F3"  # light-blue fill used by the sheet for non-English cards

# sheet set name -> TCGdex set id, where the names differ
ALIASES = {
    "MEP Promos": "mep", "SV Promos": "svp", "SVP Promos": "svp", "SWSH Promos": "swshp",
    "SM Promos": "smp", "XY Promos": "xyp", "BW Promos": "bwp", "HGSS Promos": "hgssp",
    "DP Promos": "dpp", "Nintendo Promos": "np", "Wizards Promos": "basep",
    "HeartGold & SoulSilver": "hgss1", "Expedition": "ecard1", "151": "sv03.5",
    "Twlight Masquerade": "sv06",
}


# main set -> its Shiny Vault subset
SHINY_VAULTS = {"sm115": "sma", "swsh4.5": "swsh4.5sv"}


def norm(s):
    s = str(s).lower().replace("&", "and").replace("é", "e").replace("♀", "f").replace("♂", "m")
    return re.sub(r"[^a-z0-9]", "", s)


def num_value(n):
    """'XY176' / '065' / 65.0 -> 176 / 65 / 65 ; None if there is no number"""
    if isinstance(n, float):
        return int(n)
    m = re.search(r"(\d+)", str(n))
    return int(m.group(1)) if m else None


def main():
    print("Downloading cameo sheet…")
    raw = urllib.request.urlopen(SHEET, timeout=120).read()
    wb = openpyxl.load_workbook(io.BytesIO(raw), data_only=True)

    index = json.loads((DATA / "sets.json").read_text())["sets"]
    by_name = {norm(s["name"]): s["id"] for s in index}
    set_cache = {}

    def cards_of(set_id):
        if set_id not in set_cache:
            set_cache[set_id] = json.loads((DATA / "sets" / f"{set_id}.json").read_text())["cards"]
        return set_cache[set_id]

    cameos = defaultdict(list)
    stats = defaultdict(int)
    unknown_sets = defaultdict(int)
    for tab in wb.sheetnames[1:]:
        ws = wb[tab]
        current = [None, None, None]  # Ndex, cameo Pokémon, card name (merged cells carry down)
        for row in ws.iter_rows(min_row=2):
            vals = [c.value for c in row[:6]] + [None] * 6
            for i in range(3):
                if vals[i] not in (None, ""):
                    current[i] = vals[i]
            set_name, number = vals[3], vals[4]
            if set_name in (None, "") or not current[1] or not current[2]:
                continue
            fill = row[3].fill.fgColor.rgb if row[3].fill and row[3].fill.fgColor else None
            if fill == NOT_ENGLISH:
                stats["not English"] += 1
                continue
            set_name = str(set_name).strip()
            if set_name.endswith(".0"):
                set_name = set_name[:-2]
            set_id = ALIASES.get(set_name) or by_name.get(norm(set_name))
            if not set_id:
                unknown_sets[set_name] += 1
                stats["set not in the site"] += 1
                continue
            # Trainer Gallery / Galarian Gallery / Shiny Vault cards are separate sets on the site
            prefix = re.match(r"([A-Za-z]+)\d", str(number))
            prefix = prefix.group(1).upper() if prefix else ""
            if prefix in ("TG", "GG", "SV"):
                sub = {"TG": set_id + "tg", "GG": set_id + "gg", "SV": SHINY_VAULTS.get(set_id, set_id + "sv")}[prefix]
                if (DATA / "sets" / f"{sub}.json").exists():
                    set_id = sub
            want = num_value(number)
            card_name = norm(current[2])
            match = None
            for c in cards_of(set_id):
                if want is not None and num_value(c["n"]) == want and (norm(c["name"]) == card_name or norm(c["name"]).startswith(card_name) or card_name.startswith(norm(c["name"]))):
                    match = c
                    break
            if not match:
                stats["card not matched"] += 1
                continue
            poke = str(current[1]).strip()
            if poke not in cameos[match["id"]]:
                cameos[match["id"]].append(poke)
            stats["matched"] += 1

    out = {k: sorted(v) for k, v in sorted(cameos.items())}
    (DATA / "cameos.json").write_text(json.dumps({"source": "RotomAmiti's Cameo Pokémon Card Database", "cards": out}, ensure_ascii=False, separators=(",", ":")))
    print(dict(stats))
    print(f"{len(out)} cards with cameos written to data/cameos.json")
    if unknown_sets:
        print("Sets not on the site (skipped):", ", ".join(f"{k} ({v})" for k, v in sorted(unknown_sets.items(), key=lambda x: -x[1])))


if __name__ == "__main__":
    sys.exit(main())
