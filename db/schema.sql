PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  categories TEXT NOT NULL DEFAULT '[]',
  infobox_json TEXT NOT NULL DEFAULT '{}',
  etag TEXT,
  last_modified TEXT,
  content_hash TEXT,
  scraped_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  section_path TEXT NOT NULL DEFAULT '',
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS page_images (
  id INTEGER PRIMARY KEY,
  page_id INTEGER NOT NULL UNIQUE REFERENCES pages(id) ON DELETE CASCADE,
  image_path TEXT NOT NULL,
  image_caption TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  scraped_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS recipes (
  id INTEGER PRIMARY KEY,
  result_item TEXT NOT NULL,
  result_amount INTEGER DEFAULT 1,
  ingredient_item TEXT NOT NULL,
  ingredient_amount INTEGER DEFAULT 1,
  crafting_station TEXT,
  page_slug TEXT
);

CREATE INDEX IF NOT EXISTS idx_recipes_result ON recipes(result_item COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_recipes_ingredient ON recipes(ingredient_item COLLATE NOCASE);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  title,
  section_path,
  content,
  url UNINDEXED,
  content='chunks',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, title, section_path, content, url)
  VALUES (new.id, new.title, new.section_path, new.content, new.url);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, title, section_path, content, url)
  VALUES ('delete', old.id, old.title, old.section_path, old.content, old.url);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, title, section_path, content, url)
  VALUES ('delete', old.id, old.title, old.section_path, old.content, old.url);
  INSERT INTO chunks_fts(rowid, title, section_path, content, url)
  VALUES (new.id, new.title, new.section_path, new.content, new.url);
END;
