import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactFlow, { Background, Controls, MiniMap } from "reactflow";
import "reactflow/dist/style.css";
import "./styles.css";

const starters = [
  "How do I craft Terra Blade?",
  "What does Plantera drop?",
  "Where do I find shimmer?",
  "Best accessories before Moon Lord"
];

const commonTerms = new Set([
  "According",
  "Context",
  "Question",
  "Answer",
  "Terraria",
  "Wiki",
  "Desktop",
  "Console",
  "Mobile"
]);

function AnswerText({ text, terms, onTermClick, onCraftingTermClick }) {
  if (!text) return null;
  const lines = text.split(/\n+/).filter(Boolean);
  return (
    <div className="answer">
      {lines.map((line, index) => {
        const trimmed = line.trim();
        const bullet = /^[-*]\s+/.test(trimmed);
        const body = trimmed.replace(/^[-*]\s+/, "").replace(/\*\*(.*?)\*\*/g, "$1");
        return (
          <p key={`${line}-${index}`} className={bullet ? "answerBullet" : undefined}>
            {renderAnswerPieces(body, terms, onTermClick, onCraftingTermClick)}
          </p>
        );
      })}
    </div>
  );
}

function App() {
  const [apiBase, setApiBase] = useState("");
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState("");
  const [status, setStatus] = useState("Ready when your guide is.");
  const [isSearching, setIsSearching] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateLines, setUpdateLines] = useState([]);
  const [updateProgress, setUpdateProgress] = useState(null);
  const [sources, setSources] = useState([]);
  const [selectedTerm, setSelectedTerm] = useState("");
  const [termContext, setTermContext] = useState([]);
  const [termImage, setTermImage] = useState(null);
  const [isLoadingContext, setIsLoadingContext] = useState(false);
  const [previewImage, setPreviewImage] = useState(null);
  const [selectedAnswerText, setSelectedAnswerText] = useState("");
  const [autoExpandCrafting, setAutoExpandCrafting] = useState(true);
  const [craftingTree, setCraftingTree] = useState(null);
  const [craftingHistory, setCraftingHistory] = useState([]);
  const [craftingNotice, setCraftingNotice] = useState("");
  const [craftingCollapsed, setCraftingCollapsed] = useState(false);
  const abortRef = useRef(null);
  const primaryImage = sources.find((source) => source.image)?.image || null;

  useEffect(() => {
    if (!window.sniffer?.getApiBase) {
      setStatus("Electron preload did not expose the API bridge. Restart the app from npm run dev.");
      return;
    }

    window.sniffer
      .getApiBase()
      .then(setApiBase)
      .catch((error) => setStatus(`Could not connect to local API: ${error.message}`));
  }, []);

  async function runSearch(nextQuery = query) {
    const trimmed = nextQuery.trim();
    if (!trimmed || !apiBase) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setIsSearching(true);
    setAnswer("");
    setSelectedAnswerText("");
    setCraftingTree(null);
    setCraftingHistory([]);
    setCraftingNotice("");
    setCraftingCollapsed(false);
    setSources([]);
    setSelectedTerm("");
    setTermContext([]);
    setTermImage(null);
    setStatus("Searching local wiki chunks, then asking Ollama...");

    try {
      const response = await fetch(`${apiBase}/api/search?q=${encodeURIComponent(trimmed)}&crafting=${autoExpandCrafting ? "1" : "0"}`, {
        signal: controller.signal
      });
      if (!response.ok || !response.body) throw new Error(await response.text());

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let built = "";
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";
        for (const eventText of events) {
          const event = parseServerEvent(eventText);
          if (!event) continue;
          if (event.event === "sources") setSources(event.data);
          if (event.event === "crafting_tree") {
            setCraftingTree(event.data);
            setCraftingHistory([]);
            setCraftingNotice("");
          }
          if (event.event === "token") {
            built += event.data.text || "";
            setAnswer(built);
          }
          if (event.event === "error") throw new Error(event.data.message || "Search failed");
        }
      }
      setStatus("Answer generated from local wiki context.");
    } catch (error) {
      if (error.name !== "AbortError") {
        setStatus(error.message.includes("Ollama") ? "Ollama is not responding. Start Ollama and try again." : error.message);
        setAnswer("");
      }
    } finally {
      setIsSearching(false);
    }
  }

  async function loadTermContext(term) {
    if (!apiBase || !term) return;
    setSelectedTerm(term);
    setIsLoadingContext(true);
    setTermContext([]);
    setTermImage(null);
    try {
      const response = await fetch(`${apiBase}/api/context?term=${encodeURIComponent(term)}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not load context");
      setTermContext(payload.sources || []);
      setTermImage(payload.image || payload.sources?.find((source) => source.image)?.image || null);
    } catch (error) {
      setTermContext([{ title: "Context lookup failed", section: "Error", excerpt: error.message, url: "" }]);
      setTermImage(null);
    } finally {
      setIsLoadingContext(false);
    }
  }

  async function updateWiki() {
    if (!apiBase || isUpdating) return;
    setIsUpdating(true);
    setUpdateLines([]);
    setUpdateProgress(null);
    setStatus("Updating wiki data in the background...");

    try {
      const response = await fetch(`${apiBase}/api/update`, { method: "POST" });
      if (!response.ok || !response.body) throw new Error("Could not start scraper.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";
        for (const event of events) {
          const line = event.split("\n").find((part) => part.startsWith("data: "));
          if (!line) continue;
          const payload = JSON.parse(line.slice(6));
          setUpdateLines((lines) => [formatUpdate(payload), ...lines].slice(0, 8));
          if (payload.max_pages) setUpdateProgress(payload);
          if (payload.event === "done") setStatus("Wiki data update complete.");
          if (payload.event === "error") setStatus(payload.message || "Wiki update failed.");
        }
      }
    } catch (error) {
      setStatus(error.message);
    } finally {
      setIsUpdating(false);
    }
  }

  function submit(event) {
    event.preventDefault();
    runSearch();
  }

  function captureAnswerSelection() {
    const selection = window.getSelection()?.toString().trim() || "";
    setSelectedAnswerText(selection.length > 240 ? `${selection.slice(0, 237)}...` : selection);
  }

  function followUpOnSelection() {
    if (!selectedAnswerText) return;
    const followUp = `Explain this Terraria wiki detail in more context: ${selectedAnswerText}`;
    setQuery(followUp);
    runSearch(followUp);
  }

  async function fetchCraftingTree(item, options = {}) {
    if (!apiBase || !item) return;
    setCraftingCollapsed(false);
    setCraftingNotice("");
    setStatus(`Loading crafting tree for ${item}...`);
    try {
      const response = await fetch(`${apiBase}/api/crafting-tree?item=${encodeURIComponent(item)}&force=${options.force ? "1" : "0"}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not load crafting tree");
      if (payload.found) {
        if (options.pushHistory !== false && craftingTree?.found && craftingTree.item !== payload.item) {
          setCraftingHistory((history) => [...history, craftingTree].slice(-8));
        }
        setCraftingTree(payload);
        setCraftingNotice("");
        setStatus(`Crafting tree loaded for ${payload.item}.`);
      } else {
        setCraftingNotice(`${item} does not have a known crafting recipe in the local wiki data yet. It may be a raw material, drop, purchase, or found item.`);
        setStatus(`No crafting tree found for ${item}.`);
      }
    } catch (error) {
      setStatus(error.message);
    }
  }

  function goBackCraftingTree() {
    setCraftingHistory((history) => {
      const previous = history[history.length - 1];
      if (previous) {
        setCraftingTree(previous);
        setCraftingNotice("");
      }
      return history.slice(0, -1);
    });
  }

  return (
    <main className="shell">
      <section className="topbar">
        <div>
          <span className="eyebrow">Offline after scrape - Ollama powered</span>
          <h1>Terraria Wiki Sniffer</h1>
        </div>
        <button className="updateButton" onClick={updateWiki} disabled={isUpdating || !apiBase}>
          <span className={isUpdating ? "spinner small" : "spark"} />
          {isUpdating ? "Updating..." : "Update Wiki Data"}
        </button>
      </section>

      <section className="searchPanel">
        <form onSubmit={submit} className="searchBox">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Ask about bosses, crafting, biomes, NPCs, drops..."
            autoFocus
          />
          <button disabled={isSearching || !query.trim() || !apiBase}>{isSearching ? "Thinking" : "Ask"}</button>
        </form>
        <label className="craftingToggle">
          <input
            type="checkbox"
            checked={autoExpandCrafting}
            onChange={(event) => setAutoExpandCrafting(event.target.checked)}
          />
          <span>Auto-expand crafting trees</span>
        </label>
        <div className="starterRow">
          {starters.map((starter) => (
            <button
              key={starter}
              onClick={() => {
                setQuery(starter);
                runSearch(starter);
              }}
            >
              {starter}
            </button>
          ))}
        </div>
      </section>

      <section className="workspace">
        <div className="resultPane">
          <div className="paneHeader">
            <h2>Answer</h2>
            {isSearching && <span className="pulse">Streaming</span>}
          </div>
          {!answer && !isSearching && (
            <div className="emptyState">
              <div className="orb">?</div>
              <p>Scrape the wiki, then ask anything the local database can support.</p>
            </div>
          )}
          {isSearching && !answer && <div className="loader"><span className="spinner" />Reading wiki context...</div>}
          {(answer || primaryImage) && (
            <div className={primaryImage ? "answerLayout" : undefined} onMouseUp={captureAnswerSelection}>
              {primaryImage && (
                <button className="answerImage" onClick={() => setPreviewImage(primaryImage)}>
                  <img src={imageUrl(apiBase, primaryImage.path)} alt={primaryImage.caption} />
                  <span>{primaryImage.caption}</span>
                </button>
              )}
              <AnswerText
                text={answer}
                terms={getHighlightTerms(answer, sources)}
                onTermClick={loadTermContext}
                onCraftingTermClick={fetchCraftingTree}
              />
            </div>
          )}
          {selectedAnswerText && (
            <div className="selectionFollowUp">
              <span>{selectedAnswerText}</span>
              <button onClick={followUpOnSelection}>Follow up</button>
            </div>
          )}
          {sources.length > 0 && (
            <div className="sourcesBlock">
              <h3>References</h3>
              <div className="sourceList">
                {sources.map((source) => (
                  <a
                    key={`${source.id}-${source.url}-${source.section}`}
                    className={source.image ? "hasImage" : undefined}
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {source.image && <img src={imageUrl(apiBase, source.image.path)} alt={source.image.caption} />}
                    <strong>{source.title}</strong>
                    <span>{source.section}</span>
                    <p>{source.excerpt}</p>
                  </a>
                ))}
              </div>
            </div>
          )}
          {craftingTree?.found && (
            <CraftingTreePanel
              apiBase={apiBase}
              tree={craftingTree}
              collapsed={craftingCollapsed}
              notice={craftingNotice}
              canGoBack={craftingHistory.length > 0}
              onToggle={() => setCraftingCollapsed((value) => !value)}
              onBack={goBackCraftingTree}
              onNodeClick={fetchCraftingTree}
            />
          )}
        </div>

        <aside className="sidePane">
          <div className="contextCard">
            <span>Context</span>
            {!selectedTerm && <p className="muted">Click a highlighted word in the answer to inspect related wiki chunks.</p>}
            {selectedTerm && <h3>{selectedTerm}</h3>}
            {isLoadingContext && <div className="loader compact"><span className="spinner small" />Loading context...</div>}
            {!isLoadingContext && termImage && (
              <button className="contextHeroImage" onClick={() => setPreviewImage(termImage)}>
                <img src={imageUrl(apiBase, termImage.path)} alt={termImage.caption} />
                <span>{termImage.caption}</span>
              </button>
            )}
            {!isLoadingContext && termContext.length > 0 && (
              <div className="contextList">
                {termContext.map((item, index) => (
                  <a
                    key={`${item.url}-${item.section}-${index}`}
                    className={item.image ? "hasImage" : undefined}
                    href={item.url || undefined}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {item.image && <img src={imageUrl(apiBase, item.image.path)} alt={item.image.caption} />}
                    <strong>{item.title}</strong>
                    <span>{item.section}</span>
                    <p>{item.excerpt}</p>
                  </a>
                ))}
              </div>
            )}
          </div>
          <div className="statusCard">
            <span>Status</span>
            <p>{status}</p>
          </div>
          <div className="logCard">
            <span>Update Log</span>
            {updateProgress && <ProgressMeter progress={updateProgress} />}
            {updateLines.length === 0 ? (
              <p className="muted">No scraper activity yet.</p>
            ) : (
              <ul>
                {updateLines.map((line, index) => (
                  <li key={`${line}-${index}`}>{line}</li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </section>
      {previewImage && (
        <div className="imageModal" onClick={() => setPreviewImage(null)}>
          <div className="imageModalBody" onClick={(event) => event.stopPropagation()}>
            <button className="closeButton" onClick={() => setPreviewImage(null)}>Close</button>
            <img src={imageUrl(apiBase, previewImage.path)} alt={previewImage.caption} />
            <p>{previewImage.caption}</p>
          </div>
        </div>
      )}
    </main>
  );
}

function ProgressMeter({ progress }) {
  const processed = Number(progress.processed || 0);
  const maxPages = Number(progress.max_pages || 0);
  const percent = maxPages ? Math.min(100, Math.round((processed / maxPages) * 100)) : 0;
  return (
    <div className="progressMeter">
      <div className="progressHeader">
        <strong>{percent}%</strong>
        <span>{processed}/{maxPages} pages</span>
      </div>
      <div className="progressTrack">
        <div style={{ width: `${percent}%` }} />
      </div>
      <p>
        {Number(progress.scraped || 0)} scraped, {Number(progress.skipped || 0)} skipped
        {progress.eta_seconds != null ? ` - ETA ${formatEta(progress.eta_seconds)}` : ""}
      </p>
    </div>
  );
}

function CraftingTreePanel({ apiBase, tree, collapsed, notice, canGoBack, onToggle, onBack, onNodeClick }) {
  const { nodes, edges } = useMemo(() => treeToFlow(tree, apiBase), [tree, apiBase]);
  return (
    <div className="craftingPanel">
      <div className="craftingHeader">
        <div>
          <span>Crafting Tree</span>
          <h3>{tree.item}</h3>
        </div>
        <div className="craftingHeaderActions">
          {canGoBack && <button onClick={onBack}>Back</button>}
          <button onClick={onToggle}>{collapsed ? "Expand" : "Collapse"}</button>
        </div>
      </div>
      {notice && <div className="craftingNotice">{notice}</div>}
      {!collapsed && (
        <div className="craftingGraph">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            fitView
            nodesDraggable
            onNodeClick={(_, node) => node.data?.item && onNodeClick(node.data.item, { force: true })}
          >
            <MiniMap pannable zoomable />
            <Controls />
            <Background gap={18} color="rgba(255,255,255,0.08)" />
          </ReactFlow>
        </div>
      )}
    </div>
  );
}

function treeToFlow(tree, apiBase) {
  const nodes = [];
  const edges = [];
  const levels = [];
  function walk(node, depth = 0, parentId = null, index = 0) {
    const id = `${depth}-${nodes.length}-${node.item}`;
    levels[depth] = levels[depth] || 0;
    const x = levels[depth] * 230;
    const y = depth * 145;
    levels[depth] += 1;
    const nodeType = node.node_type || (node.ingredients?.length ? "crafted" : "raw");
    nodes.push({
      id,
      position: { x, y },
      data: { label: <CraftingNode node={node} apiBase={apiBase} />, item: node.item },
      className: `craftNode ${nodeType}`,
      sourcePosition: "bottom",
      targetPosition: "top"
    });
    if (parentId) {
      edges.push({
        id: `${parentId}-${id}`,
        source: parentId,
        target: id,
        label: `x${node.amount || 1}`,
        animated: depth <= 2
      });
    }
    if (node.crafting_station && node.ingredients?.length) {
      const stationId = `${id}-station`;
      nodes.push({
        id: stationId,
        position: { x: x + 28, y: y + 78 },
        data: { label: node.crafting_station },
        className: "craftStationNode"
      });
      edges.push({ id: `${stationId}-${id}`, source: stationId, target: id, label: "station" });
    }
    for (const [childIndex, child] of (node.ingredients || []).entries()) {
      walk(child, depth + 1, id, childIndex);
    }
  }
  walk(tree);
  return { nodes, edges };
}

function CraftingNode({ node, apiBase }) {
  return (
    <div className="craftNodeInner">
      {node.image?.path && <img src={imageUrl(apiBase, node.image.path)} alt={node.image.caption || node.item} />}
      <strong>{node.item}</strong>
      <span>x{node.amount || 1}</span>
      <em>{node.ingredients?.length ? "open recipe" : "check progression"}</em>
    </div>
  );
}

function formatUpdate(payload) {
  if (payload.title) return `Scraped ${payload.processed || ""}: ${payload.title} (${payload.chunks || 0} chunks)`;
  if (payload.url && payload.event === "not_modified") return `Fresh cache: ${payload.url.replace("https://terraria.wiki.gg/wiki/", "")}`;
  if (payload.url && payload.event?.startsWith("skip")) return `Skipped: ${payload.url.replace("https://terraria.wiki.gg/wiki/", "")}`;
  if (payload.message) return payload.message.trim();
  if (payload.event === "done") return "Update complete";
  return payload.event || "Scraper event";
}

function formatEta(seconds) {
  const value = Math.max(0, Number(seconds || 0));
  const minutes = Math.floor(value / 60);
  const rest = value % 60;
  if (minutes <= 0) return `${rest}s`;
  return `${minutes}m ${rest}s`;
}

function parseServerEvent(raw) {
  const event = raw.split("\n").find((line) => line.startsWith("event: "))?.slice(7) || "message";
  const dataLine = raw.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) return null;
  return { event, data: JSON.parse(dataLine.slice(6)) };
}

function getHighlightTerms(answer, sources) {
  const terms = new Set();
  for (const source of sources) {
    if (source.title && !commonTerms.has(source.title)) terms.add(source.title);
    for (const part of String(source.section || "").split(/\s*\/\s*/)) {
      if (part.length > 3 && !commonTerms.has(part)) terms.add(part);
    }
  }

  const matches = answer.match(/\b[A-Z][A-Za-z0-9']+(?:\s+(?:of|the|and|[A-Z][A-Za-z0-9']+)){0,4}/g) || [];
  for (const match of matches) {
    const clean = match.trim().replace(/[.,:;!?)]$/, "");
    if (clean.length > 3 && !commonTerms.has(clean) && !/^(I|If|The|This|That|According)$/.test(clean)) {
      terms.add(clean);
    }
  }

  return [...terms].sort((a, b) => b.length - a.length).slice(0, 28);
}

function renderAnswerPieces(text, terms, onTermClick, onCraftingTermClick) {
  const pieces = text.split(/(\[[^\]]{2,80}\])/g);
  return pieces.map((piece, index) => {
    const bracketed = piece.match(/^\[([^\]]+)\]$/);
    if (bracketed) {
      const item = bracketed[1];
      return (
        <button key={`${piece}-${index}`} className="craftingTerm" onClick={() => onCraftingTermClick(item)}>
          {item}
        </button>
      );
    }
    return <React.Fragment key={`${piece}-${index}`}>{renderHighlighted(piece, terms, onTermClick)}</React.Fragment>;
  });
}

function renderHighlighted(text, terms, onTermClick) {
  if (!terms.length) return text;
  const escaped = terms.map(escapeRegExp).join("|");
  const regex = new RegExp(`\\b(${escaped})\\b`, "gi");
  const pieces = text.split(regex);
  return pieces.map((piece, index) => {
    const term = terms.find((candidate) => candidate.toLowerCase() === piece.toLowerCase());
    if (!term) return <React.Fragment key={`${piece}-${index}`}>{piece}</React.Fragment>;
    return (
      <button key={`${piece}-${index}`} className="highlightTerm" onClick={() => onTermClick(term)}>
        {piece}
      </button>
    );
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function imageUrl(apiBase, imagePath) {
  if (!apiBase || !imagePath) return "";
  return `${apiBase}${imagePath.startsWith("/") ? imagePath : `/${imagePath}`}`;
}

createRoot(document.getElementById("root")).render(<App />);
