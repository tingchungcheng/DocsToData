// Teach mode: an "Under the hood" panel that replays what the RAG pipeline
// just did, step by step, using the real numbers from the run.
//
// English: When Teach mode is on, /ingest-upload and /query are called with
// `teach: true` and the backend adds a small `teach` trace to its normal
// response (see rag/teach_trace.py). The work itself happens on the server
// in one request, so while it runs this panel only shows the steps that are
// coming up; once the response lands it replays each step with animation,
// a plain-language explanation and the real data (chunks, vectors, scores).
// Animations go through motion.js, so they are skipped when the user turned
// animations off or the OS asks for reduced motion; the step-by-step reveal
// still works without them.
// 中文: Teach 模式開啟時，/ingest-upload 與 /query 會帶上 `teach: true`，後端
// 在原本的回應中附上一份小型 `teach` trace（見 rag/teach_trace.py）。實際運算
// 在伺服器端一次完成，所以執行中這個面板只顯示即將進行的步驟；回應回來後，
// 再用動畫、白話說明與真實資料（chunk、向量、分數）逐步重播。動畫經由
// motion.js，使用者關閉動畫或系統要求減少動態時會略過，但逐步顯示仍可運作。

import { getGsap } from "./motion.js";
import { getSettings, onSettingsChange, updateSettings } from "./settings.js";

const DEMO_URL = new URL("../data/teach-demo.json", import.meta.url);
const DWELL_MS = 2600;

const panel = document.getElementById("teachPanel");
const toggle = document.getElementById("teachToggle");
const stage = document.getElementById("teachStage");
const rail = document.getElementById("teachRail");
const kindLabel = document.getElementById("teachKind");
const statusEl = document.getElementById("teachStatus");
const skipBtn = document.getElementById("teachSkip");
const replayBtn = document.getElementById("teachReplay");
const closeBtn = document.getElementById("teachClose");

let playId = 0;
let skipping = false;
let currentTl = null;
let lastTrace = null;
let pendingTimer = null;
let demoCache = null;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function fmtMs(ms) {
  if (!Number.isFinite(ms)) return "";
  if (ms < 1) return "<1 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
}

function fmtNum(n) {
  return Number.isFinite(n) ? Number(n).toLocaleString() : "–";
}

function fmtScore(s) {
  return Number.isFinite(s) ? Number(s).toFixed(s < 0.1 ? 4 : 3) : "–";
}

function sleep(ms, id) {
  return new Promise((resolve) => {
    if (skipping || id !== playId) return resolve();
    const started = Date.now();
    const tick = () => {
      if (skipping || id !== playId || Date.now() - started >= ms) return resolve();
      setTimeout(tick, 80);
    };
    setTimeout(tick, 80);
  });
}

function facts(pairs) {
  const wrap = el("dl", "teach-facts");
  for (const [label, value] of pairs) {
    if (value === undefined || value === null || value === "") continue;
    const item = el("div", "teach-fact");
    item.append(el("dt", "", label), el("dd", "", String(value)));
    wrap.appendChild(item);
  }
  return wrap;
}

function tokenPills(sample, { showIds = true } = {}) {
  const wrap = el("div", "teach-tokens");
  sample.forEach(([id, text], i) => {
    const pill = el("span", `teach-token tone-${i % 4}`);
    const shown = String(text).replace(/\n/g, "↵").replace(/^ /, "·");
    pill.appendChild(el("span", "teach-token-text", shown));
    if (showIds) pill.appendChild(el("span", "teach-token-id", String(id)));
    pill.title = `Token ID ${id}`;
    wrap.appendChild(pill);
  });
  return wrap;
}

function vectorBars(values, dim) {
  const wrap = el("div", "teach-vector");
  const bars = el("div", "teach-vector-bars");
  const max = Math.max(...values.map((v) => Math.abs(v)), 1e-9);
  for (const v of values) {
    const bar = el("span", `teach-vbar ${v < 0 ? "neg" : "pos"}`);
    bar.style.setProperty("--h", String(Math.max(4, (Math.abs(v) / max) * 100)));
    bar.title = String(v);
    bars.appendChild(bar);
  }
  const more = el("span", "teach-vector-more", `+ ${fmtNum(Math.max(0, dim - values.length))} more`);
  bars.appendChild(more);
  const nums = el(
    "code",
    "teach-vector-nums",
    `[${values.slice(0, 6).map((v) => v.toFixed(3)).join(", ")}, …]  ${fmtNum(dim)} numbers`
  );
  wrap.append(bars, nums);
  return wrap;
}

function hitList(title, hits, note) {
  const box = el("div", "teach-hits");
  const head = el("div", "teach-hits-head");
  head.appendChild(el("span", "teach-hits-title", title));
  if (note) head.appendChild(el("span", "teach-hits-note", note));
  box.appendChild(head);
  if (!hits.length) {
    box.appendChild(el("p", "teach-muted", "No matches."));
    return box;
  }
  const max = Math.max(...hits.map((h) => Math.abs(h.score)), 1e-9);
  for (const hit of hits) {
    const row = el("div", "teach-hit");
    row.title = hit.text || "";
    const label = el("span", "teach-hit-label", `${hit.source} · p.${hit.page}`);
    const meter = el("span", "teach-hit-meter");
    const fill = el("span", "teach-hit-fill");
    fill.style.setProperty("--w", `${Math.max(3, (Math.abs(hit.score) / max) * 100)}%`);
    meter.appendChild(fill);
    row.append(label, meter, el("span", "teach-hit-score", fmtScore(hit.score)));
    box.appendChild(row);
  }
  return box;
}

function chunkCard(sample) {
  const card = el("div", "teach-chunk");
  const head = el("div", "teach-chunk-head");
  head.append(el("span", "", `p.${sample.page}`), el("span", "", `${fmtNum(sample.tokens)} tokens`));
  card.append(head, el("p", "teach-chunk-text", sample.text));
  return card;
}

// ---------------------------------------------------------------------------
// Step catalogue: title, explanation and visual for each step id
// ---------------------------------------------------------------------------

const STEPS = {
  parse: {
    title: "Read the PDF",
    explain: () =>
      "The PDF is opened and the text of each page is pulled out. Fonts, layout and images are dropped, and pages with no text (like scanned images) are skipped. Everything after this works on plain text.",
    visual(d) {
      const wrap = el("div", "teach-visual");
      const pages = el("div", "teach-pages");
      const n = Math.min(d.pages || 0, 14);
      for (let i = 0; i < n; i++) pages.appendChild(el("span", "teach-page anim-pop"));
      if (d.pages > n) pages.appendChild(el("span", "teach-page-more", `+${d.pages - n}`));
      wrap.appendChild(pages);
      if (d.first_page_text) {
        const box = el("div", "teach-textbox anim-rise");
        box.append(el("span", "teach-textbox-label", `Page ${d.first_page} as plain text`), el("p", "", d.first_page_text));
        wrap.appendChild(box);
      }
      return wrap;
    },
    facts: (d, ms) => [
      ["Pages with text", fmtNum(d.pages)],
      ["Characters", fmtNum(d.chars)],
      ["Took", fmtMs(ms)],
    ],
  },
  tokenize: {
    title: "Split the text into tokens",
    explain: (d, trace) => {
      const chars = trace.steps.find((s) => s.id === "parse")?.data?.chars;
      const ratio = chars && d.total_tokens ? (chars / d.total_tokens).toFixed(1) : null;
      return (
        "Language models don't read letters or words. They read tokens: common pieces of text, each with an ID number. " +
        "The app counts tokens with tiktoken so it can cut chunks to an exact size." +
        (ratio ? ` In this document, 1 token is about ${ratio} characters.` : "")
      );
    },
    visual(d) {
      const wrap = el("div", "teach-visual");
      wrap.appendChild(tokenPills(d.sample || []));
      wrap.appendChild(el("p", "teach-caption", "First tokens of the first page. The small number is each token's ID. · is a space, ↵ a new line."));
      return wrap;
    },
    facts: (d, ms) => [
      ["Total tokens", fmtNum(d.total_tokens)],
      ["Tokenizer", d.encoding],
      ["Took", fmtMs(ms)],
    ],
  },
  chunk: {
    title: "Cut into overlapping chunks",
    explain: (d) =>
      `A whole document is too big to hand to the model and too blurry to search, so it is cut into windows of up to ${fmtNum(d.chunk_size)} tokens. ` +
      `Each window repeats the last ${fmtNum(d.chunk_overlap)} tokens of the one before it, so a sentence sitting on a boundary isn't cut in half.` +
      (d.strategy === "page" ? " With the page strategy, a chunk never crosses a page, so every chunk can cite its page number." : ""),
    visual(d) {
      const wrap = el("div", "teach-visual");
      const ribbon = el("div", "teach-ribbon");
      const sizes = d.chunk_tokens || [];
      const max = Math.max(d.chunk_size || 1, ...sizes);
      sizes.slice(0, 24).forEach((tok, i) => {
        const seg = el("span", `teach-seg tone-${i % 4} anim-grow`);
        seg.style.setProperty("--w", `${Math.max(6, (tok / max) * 100)}%`);
        seg.title = `${tok} tokens`;
        // Overlap only exists between windows cut from the same stretch of
        // text; with the page strategy a new page starts fresh.
        const pagesList = d.chunk_pages || [];
        const samePage = !pagesList.length || pagesList[i] === pagesList[i - 1];
        if (i > 0 && d.chunk_overlap && samePage) {
          const ov = el("span", "teach-seg-overlap");
          ov.style.setProperty("--ow", `${Math.min(60, (d.chunk_overlap / Math.max(tok, 1)) * 100)}%`);
          seg.appendChild(ov);
        }
        ribbon.appendChild(seg);
      });
      wrap.appendChild(ribbon);
      wrap.appendChild(el("p", "teach-caption", "Each bar is one chunk, sized by its token count. The striped start is the overlap with the chunk before."));
      const cards = el("div", "teach-chunks");
      for (const s of d.samples || []) {
        const card = chunkCard(s);
        card.classList.add("anim-rise");
        cards.appendChild(card);
      }
      wrap.appendChild(cards);
      return wrap;
    },
    facts: (d, ms) => [
      ["Chunks", fmtNum(d.count)],
      ["Strategy", d.strategy],
      ["Size / overlap", `${fmtNum(d.chunk_size)} / ${fmtNum(d.chunk_overlap)} tokens`],
      ["Took", fmtMs(ms)],
    ],
  },
  embed: {
    title: "Turn each chunk into a vector",
    explain: (d) =>
      `The embedding model (${d.model}) reads each chunk and outputs a list of ${fmtNum(d.dim)} numbers that describe its meaning. ` +
      "Chunks about similar things get similar numbers, even when they use different words. " +
      "This model has its own tokenizer, separate from the one used for chunking.",
    visual(d) {
      const wrap = el("div", "teach-visual");
      const v = (d.vectors || [])[0];
      if (v) {
        wrap.appendChild(el("p", "teach-caption", `First ${v.values.length} numbers of ${v.chunk_id}`));
        const vec = vectorBars(v.values, d.dim);
        vec.classList.add("anim-bars");
        wrap.appendChild(vec);
      }
      return wrap;
    },
    facts: (d, ms) => [
      ["Vectors made", fmtNum(d.count)],
      ["Numbers each", fmtNum(d.dim)],
      ["Model", d.model],
      ["Took", `${fmtMs(ms)}${d.count ? ` (${fmtMs(ms / d.count)} each)` : ""}`],
    ],
  },
  store: {
    title: "Save in the FAISS vector index",
    explain: (d) =>
      `Each vector is scaled to length 1 and added to a FAISS index (${d.index_type}). ` +
      "Because every vector has the same length, a dot product between two of them is their cosine similarity: how closely their meanings point the same way. " +
      "The chunk text and page number are saved next to it, so a match can be turned back into words." +
      (d.removed ? ` ${fmtNum(d.removed)} old chunks from an earlier upload of this file were replaced.` : ""),
    visual(d) {
      const wrap = el("div", "teach-visual");
      const grid = el("div", "teach-index");
      const kept = Math.max(0, (d.before || 0) - (d.removed || 0));
      const scale = Math.max(1, Math.ceil((kept + d.added) / 120));
      for (let i = 0; i < Math.ceil(kept / scale); i++) grid.appendChild(el("span", "teach-dot"));
      for (let i = 0; i < Math.ceil(d.added / scale); i++) grid.appendChild(el("span", "teach-dot is-new anim-drop"));
      wrap.appendChild(grid);
      wrap.appendChild(
        el("p", "teach-caption", `Each dot is ${scale === 1 ? "one vector" : `${scale} vectors`}. Green dots were just added.`)
      );
      return wrap;
    },
    facts: (d, ms) => [
      ["Added", fmtNum(d.added)],
      ["Vectors in index", fmtNum(d.total)],
      ["Documents", fmtNum(d.documents)],
      ["Took", fmtMs(ms)],
    ],
  },
  question: {
    title: "Your question",
    explain: () =>
      "Your question goes through the same kind of steps the document did, so it can be compared with the chunks. To the model, it's a short list of tokens.",
    visual(d) {
      const wrap = el("div", "teach-visual");
      wrap.appendChild(el("blockquote", "teach-quote anim-rise", d.text));
      wrap.appendChild(tokenPills(d.sample || []));
      return wrap;
    },
    facts: (d) => [["Tokens", fmtNum(d.tokens)]],
  },
  intent: {
    title: "Pick a route",
    explain: (d) =>
      d.by === "tool"
        ? d.intent === "qa"
          ? "Plain questions go straight to the Answer route, so no extra model call was needed to decide."
          : `You used the #${d.intent} tool, so the route was set directly and no extra model call was needed.`
        : "The model first reads your question and picks a route: answer a question, summarize, or compare. Each route gives the model a different instruction.",
    visual(d) {
      const wrap = el("div", "teach-visual");
      const routes = el("div", "teach-routes");
      for (const [id, label] of [
        ["qa", "Answer"],
        ["summarize", "Summarize"],
        ["compare", "Compare"],
      ]) {
        routes.appendChild(el("span", `teach-route${id === d.intent ? " is-chosen" : ""}`, label));
      }
      wrap.appendChild(routes);
      if (d.llm_output) wrap.appendChild(el("code", "teach-code", `Model said: ${d.llm_output}`));
      return wrap;
    },
    facts: (d, ms) => [
      ["Route", d.intent],
      ["Decided by", d.by === "tool" ? "the chat tool" : "the model"],
      ["Took", d.by === "tool" ? "" : fmtMs(ms)],
    ],
  },
  embed_query: {
    title: "Turn the question into a vector",
    explain: (d) =>
      `The same embedding model (${d.model}) turns your question into ${fmtNum(d.dim)} numbers. ` +
      "Because it's the same model, the question and the chunks sit in the same space of meaning and can be measured against each other." +
      (d.calls > 1 ? ` This ran ${d.calls} times, once per document.` : ""),
    visual(d) {
      const wrap = el("div", "teach-visual");
      const vec = vectorBars(d.vector || [], d.dim);
      vec.classList.add("anim-bars");
      wrap.appendChild(vec);
      return wrap;
    },
    facts: (d, ms) => [
      ["Numbers", fmtNum(d.dim)],
      ["Took", fmtMs(ms)],
    ],
  },
  search: {
    title: "Find the most relevant chunks",
    explain: (d) =>
      d.hybrid
        ? `Two searches run side by side. Meaning search compares your question's vector with all ${fmtNum(d.index_total)} vectors in the index. ` +
          "Keyword search (BM25) looks for your exact words. The two lists are merged with Reciprocal Rank Fusion, then reranked by word overlap, " +
          `and the top ${d.top_k} are kept. Scores in different lists use different scales, so only compare scores within one list.`
        : `Your question's vector is compared with all ${fmtNum(d.index_total)} vectors in the index, and the ${d.top_k} closest are kept.`,
    visual(d) {
      const wrap = el("div", "teach-visual");
      const runs = d.runs || [];
      const first = runs[0];
      if (!first) return wrap;
      if (d.hybrid) {
        const cols = el("div", "teach-hits-cols");
        const a = hitList("Meaning", first.vector_hits.slice(0, 5), "cosine");
        const b = hitList("Keywords", first.keyword_hits.slice(0, 5), "BM25");
        a.classList.add("anim-rise");
        b.classList.add("anim-rise");
        cols.append(a, b);
        wrap.appendChild(cols);
        wrap.appendChild(el("div", "teach-merge anim-pop", "merge (RRF) → rerank"));
      }
      const final = runs.flatMap((r) => r.final);
      const fin = hitList(`Kept: top ${final.length}`, final, d.hybrid ? "rerank score" : "cosine");
      fin.classList.add("teach-hits-final", "anim-rise");
      wrap.appendChild(fin);
      if (runs.length > 1) wrap.appendChild(el("p", "teach-caption", `Searched each of the ${runs.length} documents separately, then combined.`));
      return wrap;
    },
    facts: (d, ms) => [
      ["Searched", `${fmtNum(d.index_total)} vectors`],
      ["Took", fmtMs(ms)],
    ],
  },
  prompt: {
    title: "Build the prompt",
    explain: (d) =>
      "The kept chunks are pasted into a prompt under your question, with an instruction to answer only from that context. " +
      `This is the "augmented" part of retrieval-augmented generation: the model never sees your whole PDF, only these ${fmtNum(d.chunks)} chunks.`,
    visual(d) {
      const wrap = el("div", "teach-visual");
      const box = el("div", "teach-prompt anim-rise");
      box.appendChild(el("span", "teach-prompt-role", "Instruction"));
      box.appendChild(el("p", "teach-prompt-system", d.system));
      box.appendChild(el("span", "teach-prompt-role", "Question + context"));
      box.appendChild(el("pre", "teach-prompt-user", d.prompt));
      wrap.appendChild(box);
      return wrap;
    },
    facts: (d) => [
      ["Prompt tokens", d.prompt_tokens ? fmtNum(d.prompt_tokens) : ""],
      ["Characters", fmtNum(d.prompt_chars)],
    ],
  },
  generate: {
    title: "The model writes the answer",
    explain: (d) =>
      `${d.model || "The model"} reads the prompt and writes the answer one token at a time. Each new token is picked based on everything before it, including the chunks you just saw.`,
    visual(d) {
      const wrap = el("div", "teach-visual");
      const out = el("p", "teach-typed", "");
      out.dataset.text = d.output || "";
      wrap.appendChild(out);
      return wrap;
    },
    facts: (d, ms) => [
      ["Tokens written", d.completion_tokens ? fmtNum(d.completion_tokens) : ""],
      ["Speed", d.completion_tokens && ms ? `${(d.completion_tokens / (ms / 1000)).toFixed(1)} tokens/s` : ""],
      ["Took", fmtMs(ms)],
    ],
  },
  answer: {
    title: "Answer with sources",
    explain: () =>
      "Each kept chunk becomes a citation, so you can check the answer against the page it came from. " +
      "Confidence is the average match score of the top chunks: a hint about how well your documents matched, not a guarantee the answer is right.",
    visual(d) {
      const wrap = el("div", "teach-visual");
      const chips = el("div", "teach-cites");
      for (const c of d.citations || []) {
        chips.appendChild(el("span", "teach-cite anim-pop", `${c.document} · p.${c.page}`));
      }
      wrap.appendChild(chips);
      const conf = Math.max(0, Math.min(1, Number(d.confidence) || 0));
      const meter = el("div", "teach-confidence");
      const fill = el("span", "teach-confidence-fill");
      fill.style.setProperty("--w", `${conf * 100}%`);
      meter.appendChild(fill);
      wrap.append(meter, el("p", "teach-caption", `Confidence ${Math.round(conf * 100)}%`));
      return wrap;
    },
    facts: () => [],
  },
};

const PLANNED = {
  ingest: ["parse", "tokenize", "chunk", "embed", "store"],
  query: ["question", "intent", "embed_query", "search", "prompt", "generate", "answer"],
};

const KIND_LABEL = { ingest: "Uploading a PDF", query: "Answering a question" };

// ---------------------------------------------------------------------------
// Rendering + animation
// ---------------------------------------------------------------------------

function renderRail(ids, activeIndex = -1, pending = false) {
  rail.replaceChildren();
  ids.forEach((id, i) => {
    const chip = el("li", "teach-rail-item");
    if (pending) chip.classList.add("is-pending");
    else if (i < activeIndex) chip.classList.add("is-done");
    else if (i === activeIndex) chip.classList.add("is-active");
    chip.append(el("span", "teach-rail-num", String(i + 1)), el("span", "teach-rail-label", STEPS[id]?.title || id));
    chip.addEventListener("click", () => {
      stage.querySelector(`[data-step-index="${i}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    rail.appendChild(chip);
  });
}

function buildCard(step, index, trace) {
  const def = STEPS[step.id];
  const card = el("article", "teach-card");
  card.dataset.stepIndex = String(index);
  const head = el("header", "teach-card-head");
  head.append(el("span", "teach-card-num", String(index + 1)), el("h3", "teach-card-title", def.title));
  card.appendChild(head);
  card.appendChild(el("p", "teach-explain", def.explain(step.data || {}, trace)));
  card.appendChild(def.visual(step.data || {}, trace));
  card.appendChild(facts(def.facts(step.data || {}, step.ms)));
  return card;
}

function typeOut(node, g, tl) {
  const text = node.dataset.text || "";
  if (!g) {
    node.textContent = text;
    return;
  }
  const state = { n: 0 };
  tl.to(
    state,
    {
      n: text.length,
      duration: Math.min(2.2, 0.25 + text.length / 140),
      ease: "none",
      onUpdate: () => (node.textContent = text.slice(0, Math.round(state.n))),
      onComplete: () => (node.textContent = text),
    },
    0.3
  );
}

function animateCard(card) {
  const g = getGsap();
  const typed = card.querySelector(".teach-typed");
  if (!g) {
    if (typed) typed.textContent = typed.dataset.text || "";
    return Promise.resolve();
  }
  const tl = g.timeline();
  currentTl = tl;
  tl.fromTo(card, { autoAlpha: 0, y: 16 }, { autoAlpha: 1, y: 0, duration: 0.45, ease: "power3.out" });
  const q = (sel) => Array.from(card.querySelectorAll(sel));
  const pops = q(".anim-pop");
  if (pops.length) tl.fromTo(pops, { autoAlpha: 0, scale: 0.6 }, { autoAlpha: 1, scale: 1, duration: 0.3, ease: "back.out(2)", stagger: 0.04 }, 0.2);
  const tokens = q(".teach-token");
  if (tokens.length) tl.fromTo(tokens, { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: 0.22, ease: "power2.out", stagger: 0.035 }, 0.3);
  const grows = q(".anim-grow");
  if (grows.length) tl.fromTo(grows, { scaleX: 0, transformOrigin: "left center" }, { scaleX: 1, duration: 0.35, ease: "power2.out", stagger: 0.06 }, 0.3);
  const bars = q(".anim-bars .teach-vbar");
  if (bars.length) tl.fromTo(bars, { scaleY: 0 }, { scaleY: 1, duration: 0.4, ease: "back.out(1.6)", stagger: 0.035 }, 0.35);
  const drops = q(".anim-drop");
  if (drops.length) tl.fromTo(drops, { autoAlpha: 0, y: -24, scale: 0.4 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.35, ease: "bounce.out", stagger: { amount: 1 } }, 0.3);
  const rises = q(".anim-rise");
  if (rises.length) tl.fromTo(rises, { autoAlpha: 0, y: 12 }, { autoAlpha: 1, y: 0, duration: 0.4, ease: "power3.out", stagger: 0.18 }, 0.45);
  const fills = q(".teach-hit-fill, .teach-confidence-fill");
  if (fills.length) tl.fromTo(fills, { scaleX: 0, transformOrigin: "left center" }, { scaleX: 1, duration: 0.5, ease: "power2.out", stagger: 0.03 }, 0.6);
  if (typed) typeOut(typed, g, tl);
  return new Promise((resolve) => tl.eventCallback("onComplete", resolve));
}

function setStatus(text) {
  statusEl.textContent = text;
}

function finishInstantly() {
  if (currentTl) currentTl.progress(1);
  for (const typed of stage.querySelectorAll(".teach-typed")) typed.textContent = typed.dataset.text || "";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function isTeachOn() {
  return Boolean(getSettings().teach);
}

function openPanel() {
  panel.hidden = false;
}

function closePanel() {
  panel.hidden = true;
}

function syncToggle() {
  const on = isTeachOn();
  toggle.setAttribute("aria-pressed", String(on));
  toggle.classList.toggle("is-on", on);
  if (on) openPanel();
  else {
    playId++;
    closePanel();
  }
}

/** Show the upcoming steps while the request runs on the server. */
export function beginTeach(kind) {
  if (!isTeachOn()) return;
  openPanel();
  playId++;
  skipping = false;
  clearInterval(pendingTimer);
  kindLabel.textContent = KIND_LABEL[kind] || "";
  renderRail(PLANNED[kind] || [], -1, true);
  stage.replaceChildren();
  const box = el("div", "teach-waiting");
  box.appendChild(el("div", "teach-spinner"));
  box.appendChild(
    el(
      "p",
      "",
      kind === "ingest"
        ? "Your PDF is being read, tokenized, chunked, embedded and stored on the server. When it's done, each step will replay here with your real data."
        : "Your question is being routed, searched and answered. When the answer arrives, each step will replay here with the real chunks and scores."
    )
  );
  stage.appendChild(box);
  replayBtn.disabled = true;
  skipBtn.disabled = true;
  const started = Date.now();
  setStatus("Working… 0 s");
  pendingTimer = setInterval(() => setStatus(`Working… ${Math.round((Date.now() - started) / 1000)} s`), 1000);
}

export function failTeach(message) {
  clearInterval(pendingTimer);
  if (!isTeachOn()) return;
  stage.replaceChildren(el("p", "teach-muted", `The run stopped with an error, so there is nothing to replay: ${message}`));
  setStatus("Stopped");
}

/** Replay a trace returned by the backend. */
export async function playTeach(trace) {
  clearInterval(pendingTimer);
  if (!trace?.steps?.length) {
    if (isTeachOn()) {
      stage.replaceChildren(el("p", "teach-muted", "This answer came back without step details. Make sure the backend is up to date."));
      setStatus("");
    }
    return;
  }
  openPanel();
  lastTrace = trace;
  const id = ++playId;
  skipping = false;
  kindLabel.textContent = KIND_LABEL[trace.kind] || "";
  const steps = trace.steps.filter((s) => STEPS[s.id]);
  const ids = steps.map((s) => s.id);
  stage.replaceChildren();
  replayBtn.disabled = false;
  skipBtn.disabled = false;

  for (let i = 0; i < steps.length; i++) {
    if (id !== playId) return;
    renderRail(ids, i);
    setStatus(`Step ${i + 1} of ${steps.length}`);
    const card = buildCard(steps[i], i, trace);
    stage.appendChild(card);
    if (!skipping) card.scrollIntoView({ behavior: getGsap() ? "smooth" : "auto", block: "nearest" });
    if (skipping) continue;
    await animateCard(card);
    await sleep(DWELL_MS, id);
  }
  if (id !== playId) return;
  finishInstantly();
  renderRail(ids, steps.length);
  skipBtn.disabled = true;
  setStatus(`Done · ${fmtMs(trace.total_ms)} on the server`);
}

async function loadDemo() {
  if (demoCache) return demoCache;
  const res = await fetch(DEMO_URL);
  if (!res.ok) throw new Error("Couldn't load the demo.");
  demoCache = await res.json();
  return demoCache;
}

/** Sample traces for guest mode and the "Play a demo" buttons. */
export async function demoTrace(kind) {
  const demo = await loadDemo();
  return demo[kind];
}

function renderIntro() {
  kindLabel.textContent = "";
  renderRail([], -1);
  stage.replaceChildren();
  const intro = el("div", "teach-intro");
  intro.appendChild(el("h3", "", "See what happens under the hood"));
  intro.appendChild(
    el(
      "p",
      "",
      "Upload a PDF or ask a question while Teach mode is on. When the result comes back, this panel replays every step with your real data: the tokens, the chunks, the vectors and the search scores."
    )
  );
  const row = el("div", "teach-intro-actions");
  for (const [kind, label] of [
    ["ingest", "Demo: upload a PDF"],
    ["query", "Demo: ask a question"],
  ]) {
    const btn = el("button", "teach-btn", label);
    btn.type = "button";
    btn.addEventListener("click", async () => {
      try {
        playTeach(await demoTrace(kind));
      } catch (err) {
        setStatus(err.message);
      }
    });
    row.appendChild(btn);
  }
  intro.appendChild(row);
  stage.appendChild(intro);
  setStatus("");
  replayBtn.disabled = true;
  skipBtn.disabled = true;
}

export function initTeach() {
  toggle.addEventListener("click", () => {
    updateSettings({ teach: !isTeachOn() });
  });
  closeBtn.addEventListener("click", () => updateSettings({ teach: false }));
  skipBtn.addEventListener("click", () => {
    skipping = true;
    finishInstantly();
  });
  replayBtn.addEventListener("click", () => {
    if (lastTrace) playTeach(lastTrace);
  });
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") updateSettings({ teach: false });
  });
  let wasOn = isTeachOn();
  onSettingsChange(() => {
    const on = isTeachOn();
    if (on === wasOn) return;
    wasOn = on;
    syncToggle();
    if (on && !lastTrace) renderIntro();
  });
  syncToggle();
  if (isTeachOn()) renderIntro();
}

/** Open the panel (turning Teach mode on) and replay a saved trace. */
export async function replayTrace(trace) {
  if (!isTeachOn()) updateSettings({ teach: true });
  // Guest sample messages point at the bundled demo ("demo:query").
  if (typeof trace === "string" && trace.startsWith("demo:")) {
    try {
      trace = await demoTrace(trace.slice(5));
    } catch (err) {
      setStatus(err.message);
      return;
    }
  }
  playTeach(trace);
}
