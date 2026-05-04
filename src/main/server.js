import cors from "cors";
import express from "express";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function projectRoot() {
  return path.resolve(__dirname, "../..");
}

function resourcePath(resourcesPath, isDev, ...parts) {
  return isDev ? path.join(projectRoot(), ...parts) : path.join(resourcesPath, ...parts);
}

function pythonCommand() {
  return process.platform === "win32" ? "python" : "python3";
}

const QUERY_STOPWORDS = new Set([
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
  "the",
  "to",
  "what",
  "where",
  "which",
  "who",
  "why"
]);

async function ensureDatabase({ dbPath, resourcesPath, isDev }) {
  await fsp.mkdir(path.dirname(dbPath), { recursive: true });
  if (!fs.existsSync(dbPath)) {
    const emptyDb = resourcePath(resourcesPath, isDev, "db", "empty.sqlite");
    if (fs.existsSync(emptyDb)) {
      await fsp.copyFile(emptyDb, dbPath);
    }
  }

  await runPython(resourcePath(resourcesPath, isDev, "scripts", "init_db.py"), ["--db", dbPath]);
}

function runPython(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonCommand(), [script, ...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `Python exited with code ${code}`));
    });
  });
}

async function getChunks({ dbPath, resourcesPath, isDev, query, limit = 5 }) {
  const script = resourcePath(resourcesPath, isDev, "scripts", "search_db.py");
  const stdout = await runPython(script, ["--db", dbPath, "--query", query, "--limit", String(limit)]);
  return JSON.parse(stdout || "[]");
}

async function getCraftingTree({ dbPath, resourcesPath, isDev, item }) {
  const script = resourcePath(resourcesPath, isDev, "scripts", "crafting_tree.py");
  const stdout = await runPython(script, ["--db", dbPath, "--item", item]);
  return JSON.parse(stdout || "{}");
}

async function cacheLikelyPages({ dbPath, imagesDir, resourcesPath, isDev, query, refreshRecipes = false, force = false }) {
  const candidates = pageCandidatesFromQuery(query);
  if (!candidates.length) return;

  const script = resourcePath(resourcesPath, isDev, "scripts", "scraper.py");
  for (const title of candidates.slice(0, 2)) {
    const chunks = await getChunks({ dbPath, resourcesPath, isDev, query: title, limit: 1 });
    const exactLocalChunk = chunks.find((chunk) => String(chunk.title || "").toLowerCase() === title.toLowerCase());
    const existingTree = refreshRecipes ? await getCraftingTree({ dbPath, resourcesPath, isDev, item: title }) : null;
    if (!force && exactLocalChunk?.image_path && exactLocalChunk?.image_caption && (!refreshRecipes || existingTree?.found)) {
      continue;
    }

    const urlTitle = title.trim().replace(/\s+/g, "_");
    try {
      await runPython(script, [
        "--db",
        dbPath,
        "--images-dir",
        imagesDir,
        "--start-url",
        `https://terraria.wiki.gg/wiki/${encodeURIComponent(urlTitle).replaceAll("%2F", "/")}`,
        "--max-pages",
        "1",
        "--delay",
        "0"
      ]);
    } catch {
      // Search should still work from the existing offline database if a page guess fails.
    }
  }
}

function pageCandidatesFromQuery(query) {
  const candidates = [];
  const capitalized = query.match(/\b[A-Z][A-Za-z0-9']+(?:\s+[A-Z][A-Za-z0-9']+){0,4}\b/g) || [];
  candidates.push(...capitalized);

  const words = query
    .replace(/[^\w\s'-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !QUERY_STOPWORDS.has(word.toLowerCase()));
  if (words.length === 1) candidates.push(words[0]);
  if (words.length >= 2 && words.length <= 4) candidates.push(words.join(" "));

  const seen = new Set();
  return candidates
    .map((candidate) => candidate.trim())
    .filter((candidate) => {
      const key = candidate.toLowerCase();
      if (!candidate || QUERY_STOPWORDS.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function buildPrompt(question, chunks) {
  const context = chunks
    .map((chunk, index) => {
      return [
        `Source ${index + 1}: ${chunk.title}`,
        `Section: ${chunk.section_path || "Article"}`,
        `URL: ${chunk.url}`,
        chunk.content
      ].join("\n");
    })
    .join("\n\n---\n\n");

  const imageCaptions = uniqueImageCaptions(chunks);
  const imageBlock = imageCaptions.length
    ? `\n\nVisual context from scraped wiki images. Use this only as supplementary evidence. If the user asks about appearance, images, or visual identification, answer from these descriptions and do not recommend outside websites:\n${imageCaptions
        .map((image, index) => `Image ${index + 1}: ${image.title} - ${image.caption}`)
        .join("\n")}`
    : "";

  const noImageInstruction = imageCaptions.length
    ? ""
    : "\nNo scraped image descriptions were available for these results. Do not suggest checking online images or outside resources.";

  return `You are a Terraria wiki assistant. Answer using ONLY the provided context.
Rules:
- Do not use outside knowledge.
- Do not tell the user to check the wiki, websites, online resources, or image galleries.
- If the text context answers the question, answer it directly.
- If visual context is available, include a brief "Visual context:" sentence after the factual answer.
- Wrap concrete Terraria item names in square brackets, like [Zenith] or [Terra Blade], when you mention them.
- If visual context is not available and the user asks for visuals, say the local scrape does not include visual details for that result.
- If the answer is not in the context, say "I don't have that information."${noImageInstruction}

Text context:
${context}${imageBlock}

User question: ${question}`;
}

async function streamOllama({ prompt, onToken }) {
  const model = process.env.OLLAMA_MODEL || "llama3";
  const ollamaUrl = process.env.OLLAMA_URL || "http://127.0.0.1:11434/api/generate";
  const response = await fetch(ollamaUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, stream: true })
  });

  if (!response.ok || !response.body) {
    throw new Error(`Ollama returned ${response.status} ${response.statusText}`);
  }

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.response) onToken(event.response);
      if (event.done) return;
    }
  }
}

function sendEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sourceFromChunk(chunk, index) {
  const excerpt = String(chunk.content || "").replace(/\s+/g, " ").trim();
  return {
    id: index + 1,
    title: chunk.title,
    url: chunk.url,
    section: chunk.section_path || "Article",
    excerpt: excerpt.length > 320 ? `${excerpt.slice(0, 317)}...` : excerpt,
    image:
      chunk.image_path && chunk.image_caption
        ? {
            path: `/${chunk.image_path.replaceAll("\\", "/")}`,
            caption: chunk.image_caption
          }
        : null
  };
}

function uniqueImageCaptions(chunks) {
  const seen = new Set();
  const images = [];
  for (const chunk of chunks) {
    const caption = String(chunk.image_caption || "").trim();
    const imagePath = String(chunk.image_path || "").trim();
    if (!caption || seen.has(imagePath || caption)) continue;
    seen.add(imagePath || caption);
    images.push({ title: chunk.title, caption });
  }
  return images;
}

async function firstCraftingTree({ dbPath, resourcesPath, isDev, query, answer, sources }) {
  const candidates = craftingCandidates(query, answer, sources);
  for (const item of candidates) {
    const tree = await getCraftingTree({ dbPath, resourcesPath, isDev, item });
    if (tree?.found) return tree;
  }
  return null;
}

function craftingCandidates(query, answer, sources) {
  const candidates = [];
  const bracketed = String(answer || "").match(/\[([^\]]{2,80})\]/g) || [];
  candidates.push(...bracketed.map((value) => value.slice(1, -1)));
  candidates.push(...pageCandidatesFromQuery(query));
  for (const source of sources || []) {
    if (source.title) candidates.push(source.title);
  }
  const seen = new Set();
  return candidates
    .map((candidate) => String(candidate).trim())
    .filter((candidate) => {
      const key = candidate.toLowerCase();
      if (!candidate || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);
}

function isCraftingQuestion(query) {
  return /\b(craft|crafting|recipe|recipes|make|made|build)\b/i.test(String(query || ""));
}

function streamScraper({ res, dbPath, imagesDir, resourcesPath, isDev }) {
  const script = resourcePath(resourcesPath, isDev, "scripts", "scraper.py");
  const maxPages = process.env.SNIFFER_MAX_PAGES || "250";
  const delay = process.env.SNIFFER_SCRAPE_DELAY || "1.0";
  const child = spawn(
    pythonCommand(),
    [script, "--db", dbPath, "--max-pages", maxPages, "--delay", delay, "--images-dir", imagesDir],
    {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  const send = (event, data) => res.write(`data: ${JSON.stringify({ event, ...data })}\n\n`);
  child.stdout.on("data", (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        send("progress", JSON.parse(line));
      } catch {
        send("log", { message: line });
      }
    }
  });
  child.stderr.on("data", (chunk) => send("stderr", { message: chunk.toString() }));
  child.on("error", (error) => send("error", { message: error.message }));
  child.on("close", (code) => {
    send(code === 0 ? "done" : "error", { code });
    res.end();
  });
  res.on("close", () => child.kill());
}

export async function startServer({ userDataPath, resourcesPath, isDev }) {
  const dbPath = path.join(userDataPath, "terraria-wiki.sqlite");
  const imagesDir = path.join(userDataPath, "images");
  await ensureDatabase({ dbPath, resourcesPath, isDev });
  await fsp.mkdir(imagesDir, { recursive: true });

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use("/images", express.static(imagesDir));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, dbPath });
  });

  app.get("/api/search", async (req, res) => {
    const query = String(req.query.q || "").trim();
    const includeCrafting = String(req.query.crafting || "1") !== "0";
    if (!query) {
      res.status(400).send("Missing q parameter");
      return;
    }

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Connection", "keep-alive");
    try {
      const chunks = await getChunks({ dbPath, resourcesPath, isDev, query, limit: 5 });
      if (!chunks.some((chunk) => String(chunk.title || "").toLowerCase().includes(query.toLowerCase()))) {
        await cacheLikelyPages({ dbPath, imagesDir, resourcesPath, isDev, query, refreshRecipes: isCraftingQuestion(query) });
      }
      const refreshedChunks = await getChunks({ dbPath, resourcesPath, isDev, query, limit: 5 });
      sendEvent(res, "sources", refreshedChunks.map(sourceFromChunk));
      if (!refreshedChunks.length) {
        sendEvent(res, "token", { text: "I don't have that information." });
        sendEvent(res, "done", {});
        res.end();
        return;
      }
      let fullAnswer = "";
      await streamOllama({
        prompt: buildPrompt(query, refreshedChunks),
        onToken: (text) => {
          fullAnswer += text;
          sendEvent(res, "token", { text });
        }
      });
      if (includeCrafting) {
        const tree = await firstCraftingTree({ dbPath, resourcesPath, isDev, query, answer: fullAnswer, sources: refreshedChunks });
        if (tree?.found) sendEvent(res, "crafting_tree", tree);
      }
      sendEvent(res, "done", {});
      res.end();
    } catch (error) {
      sendEvent(res, "error", { message: `Search failed: ${error.message}` });
      res.end();
    }
  });

  app.get("/api/crafting-tree", async (req, res) => {
    const item = String(req.query.item || "").trim();
    const force = String(req.query.force || "0") === "1";
    if (!item) {
      res.status(400).json({ error: "Missing item parameter" });
      return;
    }
    try {
      await cacheLikelyPages({ dbPath, imagesDir, resourcesPath, isDev, query: item, refreshRecipes: true, force });
      const tree = await getCraftingTree({ dbPath, resourcesPath, isDev, item });
      res.json(tree);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/context", async (req, res) => {
    const term = String(req.query.term || "").trim();
    if (!term) {
      res.status(400).json({ error: "Missing term parameter" });
      return;
    }

    try {
      const chunks = await getChunks({ dbPath, resourcesPath, isDev, query: term, limit: 3 });
      const exactOrTop = chunks.find((chunk) => String(chunk.title || "").toLowerCase() === term.toLowerCase()) || chunks[0];
      if (!exactOrTop?.image_path || !exactOrTop?.image_caption) {
        await cacheLikelyPages({ dbPath, imagesDir, resourcesPath, isDev, query: term });
      }
      const refreshedChunks = await getChunks({ dbPath, resourcesPath, isDev, query: term, limit: 3 });
      const sources = refreshedChunks.map(sourceFromChunk);
      const image = sources.find((source) => source.image)?.image || null;
      res.json({ term, image, sources });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/update", async (_req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });
    streamScraper({ res, dbPath, imagesDir, resourcesPath, isDev });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}
