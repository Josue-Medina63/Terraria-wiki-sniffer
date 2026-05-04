# Terraria Wiki Sniffer

Terraria Wiki Sniffer is a cross-platform Electron desktop app that scrapes the official Terraria wiki at `https://terraria.wiki.gg`, stores the data in a local SQLite FTS5 database, and answers natural-language questions with a locally running Ollama model.

The app works offline after the initial scrape. Ollama must be running locally for answer generation.

## Features

- Recursive wiki scraper with `robots.txt`, `ETag`, and `Last-Modified` support
- Local SQLite database with FTS5 search
- Ollama-powered streaming answers using only retrieved local context
- Source references that open the original wiki pages
- Scraped wiki images, thumbnails, and captions as visual context
- Clickable highlighted terms with side-panel context cards
- Select text in an answer and ask a follow-up
- Crafting tree visualizer powered by React Flow
- Background wiki update button with progress and ETA

## Requirements

- Node.js 20+
- Python 3.10+
- Python packages: `beautifulsoup4`, `requests`
- Ollama installed and running
- An Ollama model pulled locally, for example:

```bash
ollama pull llama3
```

## Install

```bash
npm install
python -m pip install -r requirements.txt
npm run init-db
```

`npm run init-db` creates the pre-built empty SQLite database that is bundled with packaged releases.
Copy `.env.example` to `.env` if you want to customize Ollama or scraper defaults.

## Run In Development

```bash
npm run dev
```

The Electron main process starts the local Express API automatically. The SQLite database lives in Electron's user data folder as `terraria-wiki.sqlite`.

## Update Wiki Data

From the app, click **Update Wiki Data**. This runs the bundled Python scraper in the background and streams progress into the UI.

You can also run the scraper manually:

```bash
python scripts/scraper.py --db db/wiki.sqlite --images-dir images --max-pages 250 --delay 1.0
```

Useful options:

- `--db`: target SQLite database path
- `--start-url`: starting wiki page, defaults to the Terraria Wiki home page
- `--max-pages`: maximum pages to scrape in one run
- `--delay`: seconds to wait between requests
- `--images-dir`: directory for downloaded page images, defaults to `./images`

The scraper respects `robots.txt`, avoids pages outside `terraria.wiki.gg/wiki/`, skips wiki utility namespaces, and uses `ETag` / `Last-Modified` headers to avoid re-scraping unchanged pages.
It also stores one relevant page image when available, preferring infobox images and large thumbnail images. Existing image files are reused instead of downloaded again.
Crafting recipe tables are stored in `recipes` for the crafting tree visualizer.

## Search And Ollama

The app exposes:

```text
GET /api/search?q=user_question
GET /api/context?term=item_or_topic
GET /api/crafting-tree?item=Zenith
POST /api/update
```

Search retrieves the top FTS chunks from SQLite, streams source metadata, streams Ollama tokens, and can attach a crafting tree event when recipe data exists.

```text
Text context:
{chunks}

Visual context:
{image captions}

User question: {question}
```

When matching pages have scraped image captions, those captions are passed as a separate supplementary context block. Images are served locally from Electron's user data folder via `/images/<filename>`.

Environment variables:

- `OLLAMA_MODEL`: model name, defaults to `llama3`
- `OLLAMA_URL`: Ollama generate endpoint, defaults to `http://127.0.0.1:11434/api/generate`
- `SNIFFER_MAX_PAGES`: pages scraped by the in-app update button, defaults to `250`
- `SNIFFER_SCRAPE_DELAY`: scrape delay in seconds, defaults to `1.0`
- `VITE_PORT`: preferred dev server port, defaults to `5173`

## Build

Linux GNOME targets:

```bash
npm run dist:linux
```

This creates `.deb` and AppImage artifacts in `release/`. The `.deb` declares Python, BeautifulSoup, and Requests package dependencies for Ubuntu 22.04+.

Windows targets:

```bash
npm run dist:win
```

This creates an NSIS installer and portable `.exe` in `release/`. Windows users should have Python installed and on `PATH`; install scraper dependencies with:

```powershell
python -m pip install -r requirements.txt
```

## Project Layout

```text
src/main/          Electron main process and Express API
src/preload/       Safe renderer bridge
src/renderer/      React UI
scripts/           Python scraper, search helper, DB initializer
db/schema.sql      SQLite + FTS5 schema
db/empty.sqlite    Empty bundled DB created by npm run init-db
.github/workflows/ GitHub Actions CI
```

## GitHub Notes

Commit source files, `package-lock.json`, `db/schema.sql`, and `db/empty.sqlite`.
Do not commit `node_modules/`, `dist/`, `release/`, local scraped `images/`, or runtime `db/wiki.sqlite`; these are covered by `.gitignore`.

This repo includes a CI workflow that runs install, DB init, Python compile checks, Vite build, and a production dependency audit on Ubuntu 22.04.

## Notes

- The runtime database is copied/created inside `app.getPath('userData')`.
- Scraped images are stored inside `app.getPath('userData')/images`.
- Search remains local and offline after scraping.
- The only network calls during Q&A are to local Ollama.
- The scraper network calls go only to the official wiki and its `robots.txt`.
