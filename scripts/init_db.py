#!/usr/bin/env python3
"""Create the Terraria Wiki Sniffer SQLite database."""

from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path


def init_db(db_path: Path) -> None:
    root = Path(__file__).resolve().parents[1]
    schema = root / "db" / "schema.sql"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(db_path) as conn:
        conn.executescript(schema.read_text(encoding="utf-8"))
        conn.commit()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True, type=Path, help="Path to SQLite database")
    args = parser.parse_args()
    init_db(args.db)
    print(f"Initialized {args.db}")


if __name__ == "__main__":
    main()
