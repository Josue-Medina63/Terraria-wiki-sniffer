#!/usr/bin/env python3
"""Recursive scraper for terraria.wiki.gg with HTTP cache validation."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sqlite3
import sys
import time
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urldefrag, urljoin, urlparse
from urllib.robotparser import RobotFileParser

import requests
from bs4 import BeautifulSoup, Tag

BASE_URL = "https://terraria.wiki.gg"
USER_AGENT = "TerrariaWikiSniffer/1.0 (+local desktop app; respects robots.txt)"
SKIP_PREFIXES = (
    "/wiki/Special:",
    "/wiki/File:",
    "/wiki/Template:",
    "/wiki/Category:",
    "/wiki/Help:",
    "/wiki/Talk:",
    "/wiki/User:",
    "/wiki/MediaWiki:",
)

for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8", errors="replace")


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=True), flush=True)


@dataclass
class PageData:
    url: str
    title: str
    content: str
    categories: list[str]
    infobox: dict[str, str]
    chunks: list[dict[str, str | int]]
    links: list[str]
    etag: str | None
    last_modified: str | None
    content_hash: str
    image_url: str | None = None
    image_caption: str = ""
    image_path: str = ""
    recipes: list[dict[str, str | int]] | None = None


def init_db(db_path: Path) -> None:
    root = Path(__file__).resolve().parents[1]
    schema = root / "db" / "schema.sql"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(db_path) as conn:
        conn.executescript(schema.read_text(encoding="utf-8"))
        conn.commit()


def canonicalize(url: str) -> str | None:
    url, _fragment = urldefrag(url)
    parsed = urlparse(url)
    if parsed.netloc and parsed.netloc != "terraria.wiki.gg":
        return None
    path = parsed.path or "/wiki/Terraria_Wiki"
    if not path.startswith("/wiki/") or any(path.startswith(prefix) for prefix in SKIP_PREFIXES):
        return None
    if "?" in url:
        return None
    return f"{BASE_URL}{path}"


def get_cache_headers(conn: sqlite3.Connection, url: str) -> dict[str, str]:
    row = conn.execute(
        """
        SELECT p.etag, p.last_modified, pi.image_path, COUNT(r.id) AS recipe_count
        FROM pages p
        LEFT JOIN page_images pi ON pi.page_id = p.id
        LEFT JOIN recipes r ON r.page_slug = substr(p.url, instr(p.url, '/wiki/') + 6)
        WHERE p.url = ?
        GROUP BY p.id, pi.image_path
        """,
        (url,),
    ).fetchone()
    headers: dict[str, str] = {}
    if row:
        if not row[2] or int(row[3] or 0) == 0:
            return headers
        if row[0]:
            headers["If-None-Match"] = row[0]
        if row[1]:
            headers["If-Modified-Since"] = row[1]
    return headers


def clean_text(text: str) -> str:
    text = re.sub(r"\[\s*edit\s*\]", "", text, flags=re.I)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def slugify(value: str) -> str:
    value = re.sub(r"[^\w\s.-]", "", value, flags=re.UNICODE)
    value = re.sub(r"[\s_]+", "-", value).strip(".-")
    return value[:80] or "wiki-image"


def table_to_text(table: Tag) -> str:
    lines: list[str] = []
    for row in table.select("tr"):
        cells = [clean_text(cell.get_text(" ", strip=True)) for cell in row.select("th,td")]
        cells = [cell for cell in cells if cell]
        if cells:
            lines.append(" | ".join(cells))
    return "\n".join(lines)


def parse_amount(text: str) -> int:
    patterns = [
        r"[×x]\s*(\d+)",
        r"\((\d+)\)",
        r"\b(\d+)\s*$",
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            return max(1, int(match.group(1)))
    return 1


def clean_item_name(text: str) -> str:
    text = clean_text(text)
    text = re.sub(r"\([^)]*versions?\)", "", text, flags=re.I)
    text = re.sub(r"\s+[×x]\s*\d+\b", "", text)
    text = re.sub(r"\s+\(\d+\)$", "", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip(" |,.;")


def cell_items(cell: Tag) -> list[dict[str, str | int]]:
    items: list[dict[str, str | int]] = []
    seen: set[str] = set()
    links = [link for link in cell.select("a[href]") if not (link.get("href") or "").startswith("#")]
    for link in links:
        name = clean_item_name(link.get_text(" ", strip=True) or str(link.get("title") or ""))
        href = str(link.get("href") or "")
        if not name or name.lower() in {"desktop", "console", "mobile", "old-gen console"}:
            continue
        if "/wiki/" not in href or any(href.startswith(prefix) for prefix in SKIP_PREFIXES):
            continue
        if name.lower() in seen:
            continue
        seen.add(name.lower())
        parent_text = clean_text(link.parent.get_text(" ", strip=True) if isinstance(link.parent, Tag) else cell.get_text(" ", strip=True))
        items.append({"item": name, "amount": parse_amount(parent_text)})

    if items:
        return items

    text = clean_text(cell.get_text(" ", strip=True))
    if not text or text.lower() in {"none", "n/a"}:
        return []
    parts = re.split(r"\s{2,}|\n|,| or ", text)
    for part in parts:
        name = clean_item_name(part)
        if name and len(name) > 1:
            items.append({"item": name, "amount": parse_amount(part)})
    return items[:12]


def table_headers(table: Tag) -> list[str]:
    header_row = table.select_one("tr")
    if not header_row:
        return []
    return [clean_text(cell.get_text(" ", strip=True)).lower() for cell in header_row.select("th,td")]


def header_index(headers: list[str], *needles: str) -> int:
    for index, header in enumerate(headers):
        if any(needle in header for needle in needles):
            return index
    return -1


def page_slug(url: str) -> str:
    return urlparse(url).path.rsplit("/", 1)[-1]


def extract_recipes(main: Tag, title: str, url: str) -> list[dict[str, str | int]]:
    recipes: list[dict[str, str | int]] = []
    slug = page_slug(url)
    section = ""
    for node in main.descendants:
        if isinstance(node, Tag) and node.name in {"h2", "h3"}:
            section = clean_text(node.get_text(" ", strip=True)).lower()
        if not isinstance(node, Tag) or node.name != "table":
            continue
        if "craft" not in section and "recipe" not in section and "used in" not in section:
            classes = " ".join(node.get("class", []))
            if "terraria" not in classes and "infobox" not in classes:
                continue
        headers = table_headers(node)
        if not headers:
            continue

        result_i = header_index(headers, "result", "output")
        ingredient_i = header_index(headers, "ingredient", "input")
        station_i = header_index(headers, "crafting station", "station", "crafted at")
        if result_i < 0 or ingredient_i < 0:
            continue

        rows = node.select("tr")[1:]
        for row in rows:
            cells = row.select("td,th")
            if len(cells) <= max(result_i, ingredient_i):
                continue
            result_items = cell_items(cells[result_i])
            ingredient_items = cell_items(cells[ingredient_i])
            station = clean_text(cells[station_i].get_text(" ", strip=True)) if 0 <= station_i < len(cells) else ""
            if not result_items or not ingredient_items:
                continue
            for result in result_items:
                for ingredient in ingredient_items:
                    if str(result["item"]).lower() == str(ingredient["item"]).lower():
                        continue
                    recipes.append(
                        {
                            "result_item": str(result["item"]),
                            "result_amount": int(result["amount"]),
                            "ingredient_item": str(ingredient["item"]),
                            "ingredient_amount": int(ingredient["amount"]),
                            "crafting_station": station,
                            "page_slug": slug,
                        }
                    )
    return dedupe_recipes(recipes)


def dedupe_recipes(recipes: list[dict[str, str | int]]) -> list[dict[str, str | int]]:
    deduped: list[dict[str, str | int]] = []
    seen: set[tuple] = set()
    for recipe in recipes:
        key = (
            str(recipe["result_item"]).lower(),
            str(recipe["ingredient_item"]).lower(),
            int(recipe["ingredient_amount"]),
            str(recipe.get("crafting_station") or "").lower(),
        )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(recipe)
    return deduped


def extract_infobox(soup: BeautifulSoup) -> dict[str, str]:
    info: dict[str, str] = {}
    for table in soup.select("table.infobox, table.terraria"):
        for row in table.select("tr"):
            header = row.find("th")
            value = row.find("td")
            if header and value:
                key = clean_text(header.get_text(" ", strip=True)).rstrip(":")
                val = clean_text(value.get_text(" ", strip=True))
                if key and val:
                    info[key] = val
        if info:
            break
    return info


def extract_categories(soup: BeautifulSoup) -> list[str]:
    cats = []
    for link in soup.select("#catlinks a, .mw-normal-catlinks a"):
        text = clean_text(link.get_text(" ", strip=True))
        if text and text.lower() != "category":
            cats.append(text)
    return sorted(set(cats))


def section_chunks(section_path: str, text: str, chunk_index: int, size: int = 500) -> tuple[list[dict], int]:
    words = text.split()
    chunks = []
    for start in range(0, len(words), size):
        body = " ".join(words[start : start + size]).strip()
        if body:
            chunks.append({"section_path": section_path, "chunk_index": chunk_index, "content": body})
            chunk_index += 1
    return chunks, chunk_index


def extract_content(main: Tag) -> tuple[str, list[dict[str, str | int]]]:
    for selector in [
        ".mw-editsection",
        ".reference",
        "sup",
        "script",
        "style",
        ".navbox",
        ".metadata",
        ".printfooter",
    ]:
        for node in main.select(selector):
            node.decompose()

    sections: list[tuple[str, list[str]]] = [("Lead", [])]
    h2 = ""
    h3 = ""
    for child in main.children:
        if not isinstance(child, Tag):
            continue
        if child.name == "h2":
            h2 = clean_text(child.get_text(" ", strip=True))
            h3 = ""
            sections.append((h2 or "Section", []))
            continue
        if child.name == "h3":
            h3 = clean_text(child.get_text(" ", strip=True))
            name = " / ".join(part for part in [h2, h3] if part) or "Section"
            sections.append((name, []))
            continue
        if child.name == "table":
            text = table_to_text(child)
        else:
            text = clean_text(child.get_text(" ", strip=True))
        if text:
            sections[-1][1].append(text)

    all_text: list[str] = []
    chunks: list[dict[str, str | int]] = []
    chunk_index = 0
    for section, parts in sections:
        text = "\n".join(parts).strip()
        if not text:
            continue
        all_text.append(f"{section}\n{text}")
        sectioned_chunks, chunk_index = section_chunks(section, text, chunk_index)
        chunks.extend(sectioned_chunks)
    return "\n\n".join(all_text), chunks


def extract_links(soup: BeautifulSoup, current_url: str) -> list[str]:
    links = []
    for anchor in soup.select("a[href]"):
        href = anchor.get("href")
        if not href:
            continue
        url = canonicalize(urljoin(current_url, href))
        if url:
            links.append(url)
    return sorted(set(links))


def numeric_attr(tag: Tag, name: str) -> int:
    value = tag.get(name) or ""
    match = re.search(r"\d+", str(value))
    return int(match.group(0)) if match else 0


def image_score(img: Tag) -> int:
    width = numeric_attr(img, "width")
    height = numeric_attr(img, "height")
    score = width * height
    parent_classes = " ".join(" ".join(parent.get("class", [])) for parent in img.parents if isinstance(parent, Tag))
    if "infobox" in parent_classes:
        score += 500_000
    if "thumb" in parent_classes:
        score += 100_000
    return score


def find_caption(img: Tag, title: str) -> str:
    for parent in img.parents:
        if not isinstance(parent, Tag):
            continue
        caption = parent.select_one(".thumbcaption, figcaption")
        if caption:
            text = clean_text(caption.get_text(" ", strip=True))
            if text:
                return text
    for attr in ("alt", "title"):
        text = clean_text(str(img.get(attr) or ""))
        if text:
            return text
    return title


def extract_main_image(soup: BeautifulSoup, main: Tag, page_url: str, title: str) -> tuple[str | None, str]:
    candidates: list[Tag] = []
    for selector in [".infobox-image img", "table.infobox img", ".thumb img", "#mw-content-text img"]:
        for img in soup.select(selector):
            if img not in candidates:
                candidates.append(img)

    filtered = []
    for img in candidates:
        src = img.get("src") or img.get("data-src")
        if not src:
            continue
        width = numeric_attr(img, "width")
        height = numeric_attr(img, "height")
        if (width and width < 40) or (height and height < 40):
            continue
        if ".svg" in src.lower() and image_score(img) < 100_000:
            continue
        filtered.append(img)

    if not filtered:
        return None, ""

    image = sorted(filtered, key=image_score, reverse=True)[0]
    src = str(image.get("src") or image.get("data-src"))
    if src.startswith("//"):
        image_url = f"https:{src}"
    else:
        image_url = urljoin(page_url, src)
    return image_url, find_caption(image, title)


def extension_from_url(url: str, content_type: str = "") -> str:
    path = urlparse(url).path.lower()
    for ext in (".png", ".jpg", ".jpeg", ".webp", ".gif"):
        if path.endswith(ext):
            return ".jpg" if ext == ".jpeg" else ext
    if "jpeg" in content_type:
        return ".jpg"
    if "webp" in content_type:
        return ".webp"
    if "gif" in content_type:
        return ".gif"
    return ".png"


def normalize_image_url(url: str) -> str:
    parsed = urlparse(url)
    parts = parsed.path.split("/")
    if "/thumb/" in parsed.path:
        thumb_index = parts.index("thumb")
        if len(parts) >= thumb_index + 2:
            filename = parts[-2] if len(parts) >= thumb_index + 3 and re.match(r"^\d+px-", parts[-1]) else parts[-1]
            filename = filename.split("?", 1)[0]
            original_path = "/".join(parts[:thumb_index] + [filename])
            return parsed._replace(path=original_path, query="").geturl()
    if parsed.query:
        original_path = parsed.path
        original_query = parsed.query
        if re.match(r"^[A-Za-z0-9]{5,}$", original_query):
            return parsed._replace(path=original_path, query="").geturl()
    return url


def candidate_image_urls(url: str) -> list[str]:
    normalized = normalize_image_url(url)
    candidates = [normalized]
    if normalized != url:
        candidates.append(url)
    parsed = urlparse(url)
    if parsed.query:
        without_query = parsed._replace(query="").geturl()
        if without_query not in candidates:
            candidates.append(without_query)
    return candidates


def download_image(session: requests.Session, image_url: str | None, title: str, images_dir: Path) -> str:
    if not image_url:
        return ""
    images_dir.mkdir(parents=True, exist_ok=True)
    base = slugify(title)
    existing = next(images_dir.glob(f"{base}.*"), None)
    if existing:
        return f"images/{existing.name}"

    response = None
    last_error = ""
    final_url = image_url
    for candidate in candidate_image_urls(image_url):
        try:
            response = session.get(candidate, timeout=30)
            response.raise_for_status()
            final_url = candidate
            break
        except requests.RequestException as exc:
            last_error = str(exc)
            response = None
    if response is None:
        emit({"event": "image_error", "url": image_url, "message": last_error})
        return ""

    content_type = response.headers.get("content-type", "")
    if not content_type.startswith("image/"):
        emit({"event": "image_error", "url": final_url, "message": f"Unexpected content type {content_type}"})
        return ""

    ext = extension_from_url(final_url, content_type)
    filename = f"{base}{ext}"
    target = images_dir / filename
    temp = images_dir / f"{filename}.tmp"
    temp.write_bytes(response.content)
    temp.replace(target)
    return f"images/{filename}"


def parse_page(url: str, html: str, etag: str | None, last_modified: str | None) -> PageData:
    soup = BeautifulSoup(html, "html.parser")
    main = soup.select_one("#mw-content-text .mw-parser-output") or soup.select_one("main") or soup.body
    if main is None:
        raise ValueError(f"No content found for {url}")

    title_node = soup.select_one("#firstHeading") or soup.find("h1")
    title = clean_text(title_node.get_text(" ", strip=True)) if title_node else url.rsplit("/", 1)[-1]
    categories = extract_categories(soup)
    infobox = extract_infobox(soup)
    content, chunks = extract_content(main)
    image_url, image_caption = extract_main_image(soup, main, url, title)
    recipes = extract_recipes(main, title, url)
    if infobox:
        infobox_text = "\n".join(f"{key}: {value}" for key, value in infobox.items())
        chunks.insert(0, {"section_path": "Infobox", "chunk_index": -1, "content": infobox_text})
    digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
    return PageData(
        url=url,
        title=title,
        content=content,
        categories=categories,
        infobox=infobox,
        chunks=chunks,
        links=extract_links(soup, url),
        etag=etag,
        last_modified=last_modified,
        content_hash=digest,
        image_url=image_url,
        image_caption=image_caption,
        recipes=recipes,
    )


def save_page(conn: sqlite3.Connection, page: PageData) -> int:
    old = conn.execute("SELECT id, content_hash FROM pages WHERE url = ?", (page.url,)).fetchone()
    if old and old[1] == page.content_hash:
        conn.execute(
            "UPDATE pages SET etag = ?, last_modified = ?, scraped_at = ? WHERE id = ?",
            (page.etag, page.last_modified, utc_now(), old[0]),
        )
        return int(old[0])

    conn.execute(
        """
        INSERT INTO pages(url, title, content, categories, infobox_json, etag, last_modified, content_hash, scraped_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(url) DO UPDATE SET
          title = excluded.title,
          content = excluded.content,
          categories = excluded.categories,
          infobox_json = excluded.infobox_json,
          etag = excluded.etag,
          last_modified = excluded.last_modified,
          content_hash = excluded.content_hash,
          scraped_at = excluded.scraped_at
        """,
        (
            page.url,
            page.title,
            page.content,
            json.dumps(page.categories),
            json.dumps(page.infobox),
            page.etag,
            page.last_modified,
            page.content_hash,
            utc_now(),
        ),
    )
    page_id = conn.execute("SELECT id FROM pages WHERE url = ?", (page.url,)).fetchone()[0]
    conn.execute("DELETE FROM chunks WHERE page_id = ?", (page_id,))
    for index, chunk in enumerate(page.chunks):
        conn.execute(
            """
            INSERT INTO chunks(page_id, url, title, section_path, chunk_index, content)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                page_id,
                page.url,
                page.title,
                str(chunk["section_path"]),
                int(chunk["chunk_index"]) if int(chunk["chunk_index"]) >= 0 else index,
                str(chunk["content"]),
            ),
        )
    return int(page_id)


def save_page_image(conn: sqlite3.Connection, page_id: int, page: PageData) -> None:
    if not page.image_path:
        return
    conn.execute(
        """
        INSERT INTO page_images(page_id, image_path, image_caption, image_url, scraped_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(page_id) DO UPDATE SET
          image_path = excluded.image_path,
          image_caption = excluded.image_caption,
          image_url = excluded.image_url,
          scraped_at = excluded.scraped_at
        """,
        (page_id, page.image_path, page.image_caption, page.image_url or "", utc_now()),
    )


def save_recipes(conn: sqlite3.Connection, page: PageData) -> None:
    conn.execute("DELETE FROM recipes WHERE page_slug = ?", (page_slug(page.url),))
    for recipe in page.recipes or []:
        conn.execute(
            """
            INSERT INTO recipes(result_item, result_amount, ingredient_item, ingredient_amount, crafting_station, page_slug)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                recipe["result_item"],
                recipe["result_amount"],
                recipe["ingredient_item"],
                recipe["ingredient_amount"],
                recipe.get("crafting_station") or "",
                recipe.get("page_slug") or page_slug(page.url),
            ),
        )


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def scrape(db_path: Path, start_url: str, max_pages: int, delay: float, images_dir: Path) -> None:
    init_db(db_path)
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})

    robots = RobotFileParser()
    robots.set_url(f"{BASE_URL}/robots.txt")
    robots.read()

    queue: deque[str] = deque([canonicalize(start_url) or f"{BASE_URL}/wiki/Terraria_Wiki"])
    seen: set[str] = set()
    processed = 0
    scraped = 0
    skipped = 0
    started_at = time.monotonic()

    def progress_payload(event: str, **extra: object) -> dict:
        elapsed = max(0.001, time.monotonic() - started_at)
        pages_left = max(0, max_pages - processed)
        eta_seconds = int((elapsed / max(1, processed)) * pages_left) if processed else None
        payload = {
            "event": event,
            "processed": processed,
            "scraped": scraped,
            "skipped": skipped,
            "max_pages": max_pages,
            "eta_seconds": eta_seconds,
        }
        payload.update(extra)
        return payload

    with sqlite3.connect(db_path) as conn:
        while queue and processed < max_pages:
            url = queue.popleft()
            if url in seen:
                continue
            seen.add(url)

            if not robots.can_fetch(USER_AGENT, url):
                skipped += 1
                processed += 1
                emit(progress_payload("skip_robots", url=url))
                continue

            headers = get_cache_headers(conn, url)
            try:
                response = session.get(url, headers=headers, timeout=30)
            except requests.RequestException as exc:
                skipped += 1
                processed += 1
                emit(progress_payload("error", url=url, message=str(exc)))
                continue

            if response.status_code == 304:
                skipped += 1
                processed += 1
                emit(progress_payload("not_modified", url=url))
                continue
            if response.status_code != 200 or "text/html" not in response.headers.get("content-type", ""):
                skipped += 1
                processed += 1
                emit(progress_payload("skip_http", url=url, status=response.status_code))
                continue

            page = parse_page(
                url,
                response.text,
                response.headers.get("ETag"),
                response.headers.get("Last-Modified"),
            )
            page.image_path = download_image(session, page.image_url, page.title, images_dir)
            page_id = save_page(conn, page)
            save_page_image(conn, page_id, page)
            save_recipes(conn, page)
            conn.commit()
            scraped += 1
            processed += 1
            emit(progress_payload("scraped", url=page.url, title=page.title, chunks=len(page.chunks), recipes=len(page.recipes or []), image=page.image_path))

            for link in page.links:
                if link not in seen:
                    queue.append(link)
            time.sleep(delay)


def main() -> None:
    parser = argparse.ArgumentParser(description="Scrape terraria.wiki.gg into a local SQLite FTS database.")
    parser.add_argument("--db", required=True, type=Path, help="Output SQLite database")
    parser.add_argument("--start-url", default=f"{BASE_URL}/wiki/Terraria_Wiki")
    parser.add_argument("--max-pages", type=int, default=250)
    parser.add_argument("--delay", type=float, default=1.0, help="Delay between requests in seconds")
    parser.add_argument("--images-dir", type=Path, default=Path("./images"), help="Directory for downloaded wiki images")
    args = parser.parse_args()

    try:
        scrape(args.db, args.start_url, args.max_pages, args.delay, args.images_dir)
    except KeyboardInterrupt:
        print("Interrupted", file=sys.stderr)


if __name__ == "__main__":
    main()
