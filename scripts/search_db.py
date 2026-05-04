#!/usr/bin/env python3
"""Search the local wiki database and emit JSON chunks."""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

STOPWORDS = {
    "a",
    "an",
    "and",
    "are",
    "best",
    "can",
    "craft",
    "do",
    "does",
    "find",
    "for",
    "get",
    "how",
    "i",
    "in",
    "is",
    "it",
    "of",
    "on",
    "obtain",
    "the",
    "to",
    "what",
    "where",
    "which",
    "who",
    "why",
}


def sanitize_fts_query(query: str) -> str:
    words = ["".join(ch for ch in token if ch.isalnum() or ch in "_-") for token in query.split()]
    words = [word for word in words if word]
    if not words:
        return ""
    return " OR ".join(f'"{word}"' for word in words[:16])


def significant_terms(query: str) -> list[str]:
    raw_words = ["".join(ch for ch in token if ch.isalnum() or ch in "_-'") for token in query.split()]
    words = [word for word in raw_words if len(word) > 2 and word.lower() not in STOPWORDS]
    terms = []
    cleaned_query = " ".join(words)
    if cleaned_query:
        terms.append(cleaned_query)
    terms.extend(words)
    deduped = []
    seen = set()
    for term in terms:
        key = term.lower()
        if key not in seen:
            seen.add(key)
            deduped.append(term)
    return deduped[:8]


def row_key(row: sqlite3.Row | dict) -> tuple:
    return (row["url"], row["section_path"], row["content"][:80])


def append_unique(target: list[dict], rows: list[sqlite3.Row], limit: int) -> None:
    seen = {row_key(row) for row in target}
    for row in rows:
        item = dict(row)
        key = row_key(item)
        if key in seen:
            continue
        seen.add(key)
        target.append(item)
        if len(target) >= limit:
            return


def search(db_path: Path, query: str, limit: int) -> list[dict]:
    if not db_path.exists():
        return []

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        results: list[dict] = []
        for term in significant_terms(query):
            rows = conn.execute(
                """
                SELECT c.title, c.url, c.section_path, c.content,
                       pi.image_path, pi.image_caption,
                       -1000.0 AS rank
                FROM chunks c
                LEFT JOIN page_images pi ON pi.page_id = c.page_id
                WHERE lower(c.title) = lower(?)
                   OR lower(c.title) LIKE lower(?)
                ORDER BY
                  CASE WHEN lower(c.title) = lower(?) THEN 0 ELSE 1 END,
                  c.chunk_index
                LIMIT ?
                """,
                (term, f"%{term}%", term, max(1, limit - len(results))),
            ).fetchall()
            append_unique(results, rows, limit)
            if len(results) >= limit:
                return results

        fts_query = sanitize_fts_query(query)
        if fts_query:
            rows = conn.execute(
                """
                SELECT c.title, c.url, c.section_path, c.content,
                       pi.image_path, pi.image_caption,
                       bm25(chunks_fts, 8.0, 3.0, 1.0) AS rank
                FROM chunks_fts
                JOIN chunks c ON c.id = chunks_fts.rowid
                LEFT JOIN page_images pi ON pi.page_id = c.page_id
                WHERE chunks_fts MATCH ?
                ORDER BY rank
                LIMIT ?
                """,
                (fts_query, limit),
            ).fetchall()
            if rows:
                append_unique(results, rows, limit)
                if len(results) >= limit:
                    return results

        like = f"%{query}%"
        rows = conn.execute(
            """
            SELECT c.title, c.url, c.section_path, c.content,
                   pi.image_path, pi.image_caption,
                   999.0 AS rank
            FROM chunks c
            LEFT JOIN page_images pi ON pi.page_id = c.page_id
            WHERE c.title LIKE ? OR c.section_path LIKE ? OR c.content LIKE ?
            LIMIT ?
            """,
            (like, like, like, limit),
        ).fetchall()
        append_unique(results, rows, limit)
        return results
    finally:
        conn.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True, type=Path)
    parser.add_argument("--query", required=True)
    parser.add_argument("--limit", type=int, default=5)
    args = parser.parse_args()
    print(json.dumps(search(args.db, args.query, args.limit), ensure_ascii=True))


if __name__ == "__main__":
    main()
