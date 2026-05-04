#!/usr/bin/env python3
"""Build recursive crafting trees from the local recipe database."""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def normalize(value: str) -> str:
    return " ".join(value.strip().split()).lower()


def slug(value: str) -> str:
    return value.strip().replace(" ", "_").lower()


def row_to_image(row: sqlite3.Row | None) -> dict | None:
    if not row or not row["image_path"]:
        return None
    return {
        "path": f"/{str(row['image_path']).replace(chr(92), '/')}",
        "caption": row["image_caption"] or row["title"],
    }


def image_for(conn: sqlite3.Connection, item: str) -> dict | None:
    row = conn.execute(
        """
        SELECT p.title, pi.image_path, pi.image_caption
        FROM pages p
        LEFT JOIN page_images pi ON pi.page_id = p.id
        WHERE lower(p.title) = lower(?)
        LIMIT 1
        """,
        (item,),
    ).fetchone()
    return row_to_image(row)


def recipe_rows(conn: sqlite3.Connection, item: str) -> list[sqlite3.Row]:
    rows = conn.execute(
        """
        SELECT result_item, result_amount, ingredient_item, ingredient_amount, crafting_station, page_slug
        FROM recipes
        WHERE lower(result_item) = lower(?)
        ORDER BY id
        """,
        (item,),
    ).fetchall()
    own_page_rows = [row for row in rows if slug(row["page_slug"] or "") == slug(item)]
    rows = own_page_rows or rows

    deduped = []
    seen = set()
    for row in rows:
        key = (
            normalize(row["result_item"]),
            normalize(row["ingredient_item"]),
            int(row["ingredient_amount"] or 1),
            normalize(row["crafting_station"] or ""),
        )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(row)
    return deduped


def has_recipe(conn: sqlite3.Connection, item: str) -> bool:
    return conn.execute("SELECT 1 FROM recipes WHERE lower(result_item) = lower(?) LIMIT 1", (item,)).fetchone() is not None


def build_tree(conn: sqlite3.Connection, item: str, amount: int = 1, depth: int = 0, seen: set[str] | None = None) -> dict:
    seen = seen or set()
    rows = recipe_rows(conn, item)
    key = normalize(item)
    image = image_for(conn, item)
    node = {
        "item": item,
        "amount": amount,
        "crafting_station": rows[0]["crafting_station"] if rows else "",
        "node_type": "final" if depth == 0 else ("crafted" if rows else "raw"),
        "image": image,
        "ingredients": [],
    }
    if key in seen:
        node["cycle"] = True
        return node
    if depth >= 7:
        node["truncated"] = True
        return node

    next_seen = {*seen, key}
    grouped: dict[str, dict] = {}
    for row in rows:
        ingredient = row["ingredient_item"]
        amount_needed = int(row["ingredient_amount"] or 1)
        group = grouped.setdefault(
            normalize(ingredient),
            {
                "item": ingredient,
                "amount": 0,
                "stations": set(),
            },
        )
        group["amount"] = max(group["amount"], amount_needed)
        if row["crafting_station"]:
            group["stations"].add(row["crafting_station"])

    for group in grouped.values():
        child = build_tree(conn, group["item"], group["amount"], depth + 1, next_seen)
        if not child.get("crafting_station") and group["stations"]:
            child["crafting_station"] = " / ".join(sorted(group["stations"]))
        node["ingredients"].append(child)
    return node


def tree(db_path: Path, item: str) -> dict:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        if not has_recipe(conn, item):
            return {"item": item, "found": False, "ingredients": []}
        result = build_tree(conn, item)
        result["found"] = True
        return result
    finally:
        conn.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True, type=Path)
    parser.add_argument("--item", required=True)
    args = parser.parse_args()
    print(json.dumps(tree(args.db, args.item), ensure_ascii=True))


if __name__ == "__main__":
    main()
