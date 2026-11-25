// Chat view: one conversation over your PDFs, with "#" tools.
//
//   #ask        plain question (default)
//   #compare    compare quotations and recommend a vendor
//   #extract    pull structured fields out of a PO or invoice
//   #summarize  build a downloadable summary report
//   #plan       step-by-step plan using the documents
//   #action     save the latest result into a local folder
//
// Every tool is a prompt over the existing /query RAG endpoint, so it runs on
// whichever model is selected (Ollama by default, fully local). Results are
// saved through /workspace/save into a folder on this computer, never to the
// cloud. Chats are stored in this browser (see sessions.js).
//
// The module keeps the export names the rest of the app already uses
// (initUploadRag, activateUploadRag, clearUploadRag, refreshDocuments).

import { api, ApiError } from "./api.js";
import { getAccessToken } from "./auth.js";
import { COMMANDS, DOC_TYPES, findCommand, guessDocType, parseCommand, parseJsonAnswer } from "./commands.js";
import { API_BASE_URL } from "./config.js";
import { blockIfGuest, getGuestData, isGuest } from "./guest.js";
import { getLanguage, t } from "./i18n.js";
import { renderMarkdown } from "./markdown.js";
import { countUp, heroIn, messageIn, popIn, staggerIn } from "./motion.js";
import {
  appendMessage,
  createSession,
  getSession,
  listSessions,
  onSessionsChange,
  setPersistEnabled,
} from "./sessions.js";
import { folderFor, formatMoney, getSettings, onSettingsChange } from "./settings.js";
import { currentProvider, onProviderChange } from "./state.js";
import { showToast } from "./toast.js";

const $ = (id) => document.getElementById(id);

const messagesEl = $("messages");
const chatScroll = $("chatScroll");
const chatEmpty = $("chatEmpty");
const heroTitle = $("heroTitle");
const chatTitle = $("chatTitle");
const chatMeta = $("chatMeta");
const composer = $("composer");
const questionInput = $("questionInput");
const sendBtn = $("sendBtn");
const uploadBtn = $("uploadBtn");
const hashBtn = $("hashBtn");
const fileInput = $("fileInput");
const commandMenu = $("commandMenu");
const commandPill = $("commandPill");
const contextRow = $("contextRow");
const documentsBtn = $("documentsBtn");
const documentsBtnLabel = $("documentsBtnLabel");
const documentsOverlay = $("documentsOverlay");
const documentsList = $("documentsList");
const recentList = $("recentList");
const reportOverlay = $("reportOverlay");
const reportContent = $("reportContent");
const exportFormatEl = $("exportFormat");

const DOC_TYPES_KEY = "d2d.docTypes.v1";
const ASSETS_BASE_URL = new URL("../assets/", import.meta.url);

let session = createSession();
let activeCommand = null;
let menuIndex = 0;
let busy = false;
let latestReportText = "";
/** The latest thing #action / "Save to folder" would write. */
let lastResult = null;

const knownDocumentsByProvider = { openai: [], ollama: [] };
const selectedSourcesByProvider = { openai: new Set(), ollama: new Set() };
let docTypes = loadDocTypes();

// ---------------------------------------------------------------------------
// Document types + selection
// ---------------------------------------------------------------------------

function loadDocTypes() {
  try {
    return JSON.parse(window.localStorage.getItem(DOC_TYPES_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function saveDocTypes() {
  try {
    window.localStorage.setItem(DOC_TYPES_KEY, JSON.stringify(docTypes));
  } catch {
    // ignore
  }
}

function docTypeOf(name) {
  return docTypes[name] || guessDocType(name);
}

function allDocuments() {
  return knownDocumentsByProvider[currentProvider()] || [];
}

function selectedSet() {
  const p = currentProvider();
  if (!selectedSourcesByProvider[p]) selectedSourcesByProvider[p] = new Set();
  return selectedSourcesByProvider[p];
}

function selectedDocuments() {
  const sel = selectedSet();
  return allDocuments().filter((n) => sel.has(n));
}

function updateDocumentsBtnLabel() {
  const total = allDocuments().length;
  const selected = selectedDocuments().length;
  documentsBtnLabel.textContent =
    selected === total ? t("chat.docsBtn", { count: total }) : t("chat.docsBtnPartial", { selected, total });
  documentsBtn.classList.toggle("is-empty", total === 0);
}

function renderDocumentsList() {
  documentsList.replaceChildren();
  const sel = selectedSet();
  for (const name of allDocuments()) {
    const item = document.createElement("li");
    item.className = "documents-item";

    const label = document.createElement("label");
    label.className = "documents-item-label";
    label.classList.toggle("is-selected", sel.has(name));

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "documents-checkbox";
    checkbox.checked = sel.has(name);

    const checkmark = document.createElement("span");
    checkmark.className = "documents-checkmark";
    checkmark.setAttribute("aria-hidden", "true");

    const text = document.createElement("span");
    text.className = "documents-name";
    text.textContent = name;

    checkbox.addEventListener("change", () => {
      if (checkbox.checked) sel.add(name);
      else sel.delete(name);
      label.classList.toggle("is-selected", checkbox.checked);
      updateDocumentsBtnLabel();
      renderContextRow();
    });

    label.append(checkbox, checkmark, text);

    const typeSelect = document.createElement("select");
    typeSelect.className = "doc-type-select";
    typeSelect.setAttribute("aria-label", `Type of ${name}`);
    for (const type of DOC_TYPES) {
      const opt = document.createElement("option");
      opt.value = type;
      opt.textContent = t(`doc.${type}`);
      typeSelect.appendChild(opt);
    }
    typeSelect.value = docTypeOf(name);
    typeSelect.addEventListener("change", () => {
      docTypes[name] = typeSelect.value;
      saveDocTypes();
      renderContextRow();
    });

    item.append(label, typeSelect);
    documentsList.appendChild(item);
  }
}

function setAllDocumentSelection(checked) {
  const sel = selectedSet();
  sel.clear();
  if (checked) for (const name of allDocuments()) sel.add(name);
  renderDocumentsList();
  updateDocumentsBtnLabel();
  renderContextRow();
}

export async function refreshDocuments() {
  const guestData = isGuest() ? getGuestData() : null;
  const data = guestData
    ? { documents: (guestData.documents || []).map((d) => d.source) }
    : await api.get(`/documents?provider=${encodeURIComponent(currentProvider())}`);
  const docs = data.documents || [];
  const provider = currentProvider();
  const prevKnown = knownDocumentsByProvider[provider] || [];
  const sel = selectedSet();

  if (!prevKnown.length) {
    sel.clear();
    for (const name of docs) sel.add(name);
  } else {
    for (const name of [...sel]) if (!docs.includes(name)) sel.delete(name);
    for (const name of docs) if (!prevKnown.includes(name)) sel.add(name);
  }
  knownDocumentsByProvider[provider] = docs;

  updateDocumentsBtnLabel();
  renderDocumentsList();
  renderContextRow();
}

// ---------------------------------------------------------------------------
// Context row: selected docs as chips, plus tools suggested for their types
// ---------------------------------------------------------------------------

function renderContextRow() {
  contextRow.replaceChildren();
  const docs = selectedDocuments();
  const shown = docs.slice(0, 3);
  for (const name of shown) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "doc-chip";
    chip.title = name;
    const type = docTypeOf(name);
    const badge = document.createElement("span");
    badge.className = `doc-badge doc-badge-${type}`;
    badge.textContent = t(`doc.${type}`);
    const label = document.createElement("span");
    label.className = "doc-chip-name";
    label.textContent = name.replace(/\.pdf$/i, "");
    chip.append(badge, label);
    chip.addEventListener("click", showDocumentsModal);
    contextRow.appendChild(chip);
  }
  if (docs.length > shown.length) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "doc-chip doc-chip-more";
    more.textContent = `+${docs.length - shown.length}`;
    more.addEventListener("click", showDocumentsModal);
    contextRow.appendChild(more);
  }

  const types = new Set(docs.map(docTypeOf));
  const suggested = COMMANDS.filter((c) => c.docTypes.some((d) => types.has(d)) && c.id !== "action");
  if (suggested.length && !activeCommand) {
    const sep = document.createElement("span");
    sep.className = "context-sep";
    sep.textContent = t("chat.suggest");
    contextRow.appendChild(sep);
    for (const cmd of suggested.slice(0, 3)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "suggest-chip";
      btn.textContent = `#${cmd.id}`;
      btn.title = t(`cmd.${cmd.id}`);
      btn.addEventListener("click", () => {
        setActiveCommand(cmd);
        questionInput.focus();
      });
      contextRow.appendChild(btn);
    }
  }
  contextRow.classList.toggle("hidden", !contextRow.children.length);
}

// ---------------------------------------------------------------------------
// "#" command menu
// ---------------------------------------------------------------------------

function menuMatches() {
  const m = /^#([a-z]*)$/i.exec(questionInput.value.trim());
  const prefix = m ? m[1].toLowerCase() : "";
  return COMMANDS.filter((c) => c.id.startsWith(prefix));
}

function renderCommandMenu(forceOpen = false) {
  const typingHash = /^#[a-z]*$/i.test(questionInput.value.trim());
  if (!typingHash && !forceOpen) {
    hideCommandMenu();
    return;
  }
  const items = forceOpen && !typingHash ? COMMANDS : menuMatches();
  if (!items.length) {
    hideCommandMenu();
    return;
  }
  menuIndex = Math.min(menuIndex, items.length - 1);
  const wasHidden = commandMenu.classList.contains("hidden");
  commandMenu.replaceChildren();
  items.forEach((cmd, i) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `command-item${i === menuIndex ? " active" : ""}`;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(i === menuIndex));
    const icon = document.createElement("span");
    icon.className = "command-icon";
    icon.textContent = cmd.icon;
    const name = document.createElement("span");
    name.className = "command-name";
    name.textContent = `#${cmd.id}`;
    const desc = document.createElement("span");
    desc.className = "command-desc";
    desc.textContent = t(`cmd.${cmd.id}`);
    row.append(icon, name, desc);
    if (cmd.docTypes.length && cmd.id !== "action") {
      const fits = document.createElement("span");
      fits.className = "command-fits";
      fits.textContent = cmd.docTypes.length > 3 ? "" : cmd.docTypes.map((d) => t(`doc.${d}`)).join(" · ");
      row.appendChild(fits);
    }
    row.addEventListener("mousedown", (e) => {
      e.preventDefault();
      pickCommand(cmd);
    });
    commandMenu.appendChild(row);
  });
  commandMenu.dataset.items = items.map((c) => c.id).join(",");
  commandMenu.classList.remove("hidden");
  if (wasHidden) {
    popIn(commandMenu);
    staggerIn(commandMenu.children, { y: 6, stagger: 0.025 });
  }
}

function hideCommandMenu() {
  commandMenu.classList.add("hidden");
  menuIndex = 0;
}

function menuOpen() {
  return !commandMenu.classList.contains("hidden");
}

function pickCommand(cmd) {
  hideCommandMenu();
  if (/^#[a-z]*$/i.test(questionInput.value.trim())) questionInput.value = "";
  setActiveCommand(cmd);
  autoResize();
  questionInput.focus();
}

function setActiveCommand(cmd) {
  activeCommand = cmd;
  if (!cmd) {
    commandPill.classList.add("hidden");
    commandPill.textContent = "";
  } else {
    commandPill.textContent = `#${cmd.id}`;
    commandPill.title = t(`cmd.${cmd.id}`);
    commandPill.classList.remove("hidden");
    popIn(commandPill);
  }
  renderContextRow();
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function providerAvatar(provider) {
  const file = provider === "openai" ? "openAI-icon.png" : "ollama-icon.png";
  return new URL(file, ASSETS_BASE_URL).pathname;
}

function scrollToBottom() {
  chatScroll.scrollTo({ top: chatScroll.scrollHeight, behavior: "smooth" });
}

function updateEmptyState() {
  const hasMessages = session.messages.some((m) => m.role !== "system") || messagesEl.querySelector(".msg-user");
  chatEmpty.classList.toggle("hidden", Boolean(hasMessages));
  chatTitle.textContent = session.title || t("chat.untitled");
  const count = session.messages.filter((m) => m.role !== "system").length;
  chatMeta.textContent = count
    ? `${new Date(session.createdAt).toLocaleDateString(getLanguage(), { month: "short", day: "numeric" })} · ${t(
        "chat.messages",
        { count }
      )}`
    : "";
}

function renderHero() {
  const name = getSettings().displayName;
  heroTitle.textContent = name ? t("chat.heroHello", { name }) : t("chat.hero");
  heroIn(heroTitle);
}

function actionButton(label, onClick, variant = "") {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `msg-action ${variant}`.trim();
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

function renderExtractCard(card) {
  const wrap = document.createElement("div");
  wrap.className = "result-card";
  const data = card.data || {};
  const currency = data.currency || getSettings().currency;

  const head = document.createElement("div");
  head.className = "result-head";
  const type = document.createElement("span");
  type.className = `doc-badge doc-badge-${card.docType || "other"}`;
  type.textContent = t(`doc.${card.docType || "other"}`);
  const title = document.createElement("strong");
  title.textContent = data.document_number || (card.sources || [])[0] || "Document";
  head.append(type, title);
  if (data.document_date) {
    const date = document.createElement("span");
    date.className = "result-date";
    date.textContent = data.document_date;
    head.appendChild(date);
  }
  wrap.appendChild(head);

  const total = document.createElement("div");
  total.className = "result-total";
  const totalLabel = document.createElement("span");
  totalLabel.textContent = "Total";
  const totalValue = document.createElement("span");
  totalValue.className = "result-total-value";
  total.append(totalLabel, totalValue);
  wrap.appendChild(total);
  const totalNum = Number(data.total);
  if (Number.isFinite(totalNum) && data.total !== null) countUp(totalValue, totalNum, (v) => formatMoney(v, currency));
  else totalValue.textContent = "–";

  const fields = document.createElement("dl");
  fields.className = "result-fields";
  for (const [key, label] of [
    ["vendor", "Vendor"],
    ["buyer", "Buyer"],
    ["subtotal", "Subtotal"],
    ["tax", "Tax"],
    ["payment_terms", "Payment terms"],
    ["currency", "Currency"],
  ]) {
    const value = data[key];
    if (value === undefined || value === null || value === "") continue;
    const field = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent =
      (key === "subtotal" || key === "tax") && Number.isFinite(Number(value))
        ? formatMoney(value, currency)
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value);
    field.append(dt, dd);
    fields.appendChild(field);
  }
  wrap.appendChild(fields);

  const items = Array.isArray(data.line_items) ? data.line_items : [];
  if (items.length) {
    const table = document.createElement("table");
    table.className = "result-items";
    table.innerHTML = "<thead><tr><th>Item</th><th>Qty</th><th>Unit</th><th>Amount</th></tr></thead>";
    const body = document.createElement("tbody");
    for (const it of items) {
      const tr = document.createElement("tr");
      for (const [val, money] of [
        [it.description, false],
        [it.quantity, false],
        [it.unit_price, true],
        [it.amount, true],
      ]) {
        const td = document.createElement("td");
        td.textContent = money ? formatMoney(val, currency) : val ?? "–";
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
    table.appendChild(body);
    wrap.appendChild(table);
  }
  return wrap;
}

function renderMessage(msg, { animate = true } = {}) {
  let el;
  if (msg.role === "system") {
    el = document.createElement("div");
    el.className = "msg-system";
    el.textContent = msg.text;
  } else if (msg.role === "user") {
    el = document.createElement("div");
    el.className = "msg-user";
    if (msg.command) {
      const tag = document.createElement("span");
      tag.className = "msg-command";
      tag.textContent = `#${msg.command}`;
      el.appendChild(tag);
    }
    if (msg.text) {
      const body = document.createElement("span");
      body.textContent = msg.text;
      el.appendChild(body);
    }
  } else {
    el = document.createElement("div");
    el.className = "msg-bot";
    const avatar = document.createElement("img");
    avatar.className = "bot-avatar";
    avatar.src = providerAvatar(msg.provider || currentProvider());
    avatar.alt = "";
    const col = document.createElement("div");
    col.className = "msg-bot-body";

    if (msg.card?.type === "extract") {
      if (msg.card.data) col.appendChild(renderExtractCard(msg.card));
      else {
        const note = document.createElement("p");
        note.className = "msg-note";
        note.textContent = t("chat.extractFailed");
        col.appendChild(note);
      }
    }
    if (msg.text && !(msg.card?.type === "extract" && msg.card.data)) {
      const prose = document.createElement("div");
      prose.className = "prose";
      prose.innerHTML = renderMarkdown(msg.text);
      col.appendChild(prose);
    }

    const actions = document.createElement("div");
    actions.className = "msg-actions";
    actions.appendChild(
      actionButton(t("chat.copy"), async (e) => {
        const payload = msg.card?.data ? JSON.stringify(msg.card.data, null, 2) : msg.text;
        try {
          await navigator.clipboard.writeText(payload);
          e.target.textContent = t("chat.copied");
          setTimeout(() => (e.target.textContent = t("chat.copy")), 1400);
        } catch {
          showToast("Copy isn't available here", "error");
        }
      })
    );
    if (msg.result) {
      actions.appendChild(actionButton(t("chat.saveResult"), () => saveResult(msg.result), "primary"));
    }
    if (msg.command === "summarize") {
      actions.appendChild(actionButton(t("chat.openReport"), () => showReport(buildReportText(msg.text))));
    }
    col.appendChild(actions);
    el.append(avatar, col);
  }
  messagesEl.appendChild(el);
  if (animate) messageIn(el, msg.role === "user");
  return el;
}

function addMessage(message, opts) {
  const msg = appendMessage(session, { provider: currentProvider(), ...message });
  renderMessage(msg, opts);
  updateEmptyState();
  scrollToBottom();
  return msg;
}

function system(text) {
  return addMessage({ role: "system", text });
}

function addTyping() {
  const row = document.createElement("div");
  row.className = "msg-bot typing-row";
  const avatar = document.createElement("img");
  avatar.className = "bot-avatar";
  avatar.src = providerAvatar(currentProvider());
  avatar.alt = "";
  const bubble = document.createElement("div");
  bubble.className = "typing";
  bubble.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
  const label = document.createElement("span");
  label.className = "typing-label";
  label.textContent = currentProvider() === "ollama" ? "Thinking locally…" : "Thinking…";
  bubble.appendChild(label);
  row.append(avatar, bubble);
  messagesEl.appendChild(row);
  messageIn(row);
  scrollToBottom();
  return row;
}

// ---------------------------------------------------------------------------
// Sessions + sidebar recent list
// ---------------------------------------------------------------------------

function renderSession() {
  messagesEl.replaceChildren();
  for (const msg of session.messages) renderMessage(msg, { animate: false });
  lastResult = [...session.messages].reverse().find((m) => m.result)?.result || null;
  updateEmptyState();
  if (chatEmpty.classList.contains("hidden")) chatScroll.scrollTop = chatScroll.scrollHeight;
  else renderHero();
  renderRecent();
}

export function newChat() {
  session = createSession();
  setActiveCommand(null);
  questionInput.value = "";
  autoResize();
  renderSession();
  questionInput.focus();
}

export function openSession(id) {
  const found = getSession(id);
  if (!found) return;
  session = found;
  setActiveCommand(null);
  renderSession();
}

function renderRecent() {
  recentList.replaceChildren();
  const items = listSessions().slice(0, 8);
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "recent-empty";
    li.textContent = t("nav.noRecent");
    recentList.appendChild(li);
    return;
  }
  for (const s of items) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `recent-item${s.id === session.id ? " active" : ""}`;
    btn.textContent = s.title;
    btn.title = s.title;
    btn.addEventListener("click", () => {
      openSession(s.id);
      document.querySelector('.nav-link[data-view="rag"]')?.click();
    });
    li.appendChild(btn);
    recentList.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Running tools
// ---------------------------------------------------------------------------

function ensureDocumentsSelected() {
  if (!allDocuments().length) {
    system(t("chat.noDocs"));
    return false;
  }
  if (!selectedDocuments().length) {
    system(t("chat.noneSelected"));
    return false;
  }
  return true;
}

/** Docs a tool should look at: selected docs of the tool's types, else all selected. */
function targetDocuments(cmd) {
  const selected = selectedDocuments();
  if (!cmd.docTypes.length) return selected;
  const typed = selected.filter((n) => cmd.docTypes.includes(docTypeOf(n)));
  return typed.length ? typed : selected;
}

function stamp() {
  return new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/^(\d{8})/, "$1-");
}

function safeName(s) {
  return (
    String(s || "")
      .replace(/\.pdf$/i, "")
      .replace(/[^\w\-. ()&]+/g, "_")
      .trim()
      .slice(0, 80) || "result"
  );
}

async function runTool(cmd, text) {
  if (cmd.local) {
    if (lastResult) await saveResult(lastResult);
    else system(t("chat.nothingToSave"));
    return;
  }
  if (!ensureDocumentsSelected()) return;

  const docs = targetDocuments(cmd);
  const filterNeeded = docs.length < allDocuments().length;
  const settings = getSettings();
  const question = cmd.build({
    text,
    docs: filterNeeded ? docs : [],
    lang: getLanguage(),
    currency: settings.currency,
  });

  const payload = { provider: currentProvider(), question, intent: cmd.intent };
  if (filterNeeded) payload.source_filter = docs;
  if (cmd.id !== "ask") payload.top_k = 8;

  const typing = addTyping();
  let data;
  try {
    data = await api.post("/query", payload);
  } finally {
    typing.remove();
  }
  const answer = data.answer || "(no answer)";

  if (cmd.id === "extract") {
    const parsed = parseJsonAnswer(answer);
    const said = String(parsed?.document_type || "").toLowerCase();
    const fromModel = said.includes("invoice") ? "invoice" : /purchase|\bpo\b/.test(said) ? "po" : null;
    const fromFile = docTypeOf(docs[0]);
    const docType = fromModel || (fromFile === "other" || fromFile === "quotation" ? "invoice" : fromFile);
    const result = {
      docType,
      filename: `${safeName(parsed?.document_number || docs[0])}.json`,
      format: "json",
      content: parsed ? JSON.stringify({ ...parsed, _sources: docs }, null, 2) : answer,
    };
    if (!parsed) result.filename = result.filename.replace(/\.json$/, ".md");
    if (!parsed) result.format = "md";
    lastResult = result;
    addMessage({
      role: "bot",
      command: cmd.id,
      text: parsed ? "" : answer,
      card: { type: "extract", data: parsed, docType, sources: docs },
      result,
    });
    return;
  }

  if (cmd.id === "compare" || cmd.id === "summarize") {
    const docType = cmd.id === "compare" ? "quotation" : docTypeOf(docs[0]);
    const body = cmd.id === "summarize" ? buildReportText(answer) : answer;
    const result = {
      docType,
      filename: `${cmd.id === "compare" ? "comparison" : "summary"}-${stamp()}.md`,
      format: "md",
      content: `# ${cmd.id === "compare" ? "Quotation comparison" : "Summary"}\n\nDocuments: ${docs.join(", ")}\n\n${body}\n`,
    };
    lastResult = result;
    addMessage({ role: "bot", command: cmd.id, text: answer, result });
    if (cmd.id === "summarize") showReport(body);
    return;
  }

  addMessage({ role: "bot", command: cmd.id, text: answer });
}

async function saveResult(result) {
  if (blockIfGuest("Sign in to save files. You're viewing sample data as a guest.")) return;
  try {
    const data = await api.post("/workspace/save", {
      folder: folderFor(result.docType),
      filename: result.filename,
      content: result.content,
    });
    system(t("chat.saved", { path: data.path }));
    showToast(t("chat.saved", { path: data.path }), "success");
  } catch (err) {
    showToast(err.message, "error");
    system(`Error: ${err.message}`);
  }
}

async function submit() {
  if (busy) return;
  hideCommandMenu();
  if (blockIfGuest("Sign in to ask questions. You're viewing sample data as a guest.")) return;

  const raw = questionInput.value.trim();
  let cmd = activeCommand;
  let text = raw;
  if (!cmd) {
    const parsed = parseCommand(raw);
    cmd = parsed.command;
    text = parsed.text;
  }
  if (!cmd && !text) return;
  cmd = cmd || findCommand("ask");
  if (cmd.id === "ask" && !text) return;

  questionInput.value = "";
  autoResize();
  setActiveCommand(null);
  addMessage({ role: "user", text, command: cmd.id === "ask" ? null : cmd.id });

  busy = true;
  sendBtn.disabled = true;
  try {
    await runTool(cmd, text);
  } catch (err) {
    system(`Error: ${err.message}`);
    showToast(err.message, "error");
  } finally {
    busy = false;
    sendBtn.disabled = false;
    renderRecent();
  }
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

async function ingestFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;

  const hint = activeCommand?.docTypes?.length === 1 ? activeCommand.docTypes[0] : null;
  for (const file of files) {
    const guess = guessDocType(file.name);
    docTypes[file.name] = guess === "other" && hint ? hint : guess;
  }
  saveDocTypes();

  const form = new FormData();
  form.append("provider", currentProvider());
  for (const file of files) form.append("files", file);

  system(t("chat.uploading", { count: files.length }));
  const typing = addTyping();
  try {
    const token = getAccessToken();
    const res = await fetch(`${API_BASE_URL}/ingest-upload`, {
      method: "POST",
      body: form,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.detail || "Ingest failed");
    const ingested = Array.isArray(json.ingest) ? json.ingest : [json.ingest];
    for (const item of ingested) {
      system(t("chat.ingested", { source: item.source, pages: item.pages, chunks: item.chunks }));
    }
    showToast(`Indexed ${files.length} PDF(s)`, "success");
  } finally {
    typing.remove();
  }
  await refreshDocuments();
}

// ---------------------------------------------------------------------------
// Report modal
// ---------------------------------------------------------------------------

function buildReportText(summaryText) {
  const s = getSettings();
  const docs = selectedDocuments();
  return [
    "DocsToData summary report",
    `Generated: ${new Date().toLocaleString(getLanguage())}`,
    s.displayName ? `Prepared by: ${s.displayName}${s.company ? `, ${s.company}` : ""}` : null,
    `Model: ${currentProvider()}`,
    `Documents: ${docs.length ? docs.join(", ") : "all indexed PDFs"}`,
    "",
    summaryText,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

function showReport(text) {
  latestReportText = text;
  reportContent.textContent = text;
  reportOverlay.classList.remove("hidden");
  popIn(reportOverlay.firstElementChild);
}

function hideReport() {
  reportOverlay.classList.add("hidden");
}

function downloadName(ext) {
  return `summary-report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${ext}`;
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportReport() {
  if (!latestReportText) return;
  const format = exportFormatEl.value || "txt";
  if (format === "pdf") {
    const jsPdf = window.jspdf?.jsPDF;
    if (!jsPdf) {
      showToast("PDF export needs an internet connection the first time. Try .txt instead.", "error");
      return;
    }
    const doc = new jsPdf({ unit: "pt", format: "a4" });
    doc.setFont("courier", "normal");
    doc.setFontSize(11);
    doc.text(doc.splitTextToSize(latestReportText, 515), 40, 40);
    doc.save(downloadName("pdf"));
    return;
  }
  if (format === "png") {
    const lines = latestReportText.split("\n");
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = Math.max(64 + lines.length * 24, 600);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#faf8f3";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#14201c";
    ctx.font = "20px Menlo, Monaco, Consolas, monospace";
    lines.forEach((line, i) => ctx.fillText(line, 32, 42 + i * 24));
    canvas.toBlob((blob) => blob && downloadBlob(blob, downloadName("png")), "image/png");
    return;
  }
  downloadBlob(new Blob([latestReportText], { type: "text/plain;charset=utf-8" }), downloadName("txt"));
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function autoResize() {
  questionInput.style.height = "auto";
  questionInput.style.height = `${Math.min(questionInput.scrollHeight, 200)}px`;
}

function showDocumentsModal() {
  renderDocumentsList();
  documentsOverlay.classList.remove("hidden");
  popIn(documentsOverlay.firstElementChild);
}

function hideDocumentsModal() {
  documentsOverlay.classList.add("hidden");
}

export function initUploadRag() {
  composer.addEventListener("submit", (e) => {
    e.preventDefault();
    submit();
  });

  questionInput.addEventListener("input", () => {
    autoResize();
    // "#compare " typed in full turns into the pill.
    const m = /^#([a-z]+)\s$/i.exec(questionInput.value);
    if (m && findCommand(m[1].toLowerCase())) {
      questionInput.value = "";
      setActiveCommand(findCommand(m[1].toLowerCase()));
      hideCommandMenu();
      return;
    }
    renderCommandMenu();
  });

  questionInput.addEventListener("keydown", (e) => {
    if (menuOpen()) {
      const ids = (commandMenu.dataset.items || "").split(",").filter(Boolean);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        menuIndex = (menuIndex + (e.key === "ArrowDown" ? 1 : -1) + ids.length) % ids.length;
        renderCommandMenu(true);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickCommand(findCommand(ids[menuIndex]));
        return;
      }
      if (e.key === "Escape") {
        hideCommandMenu();
        return;
      }
    }
    if (e.key === "Backspace" && !questionInput.value && activeCommand) {
      setActiveCommand(null);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  questionInput.addEventListener("blur", () => setTimeout(hideCommandMenu, 120));

  hashBtn.addEventListener("click", () => {
    questionInput.focus();
    if (menuOpen()) hideCommandMenu();
    else renderCommandMenu(true);
  });

  commandPill.addEventListener("click", () => setActiveCommand(null));

  for (const starter of document.querySelectorAll("[data-starter]")) {
    starter.addEventListener("click", () => {
      setActiveCommand(findCommand(starter.dataset.starter));
      questionInput.focus();
    });
  }

  uploadBtn.addEventListener("click", () => {
    if (blockIfGuest("Sign in to upload PDFs. You're viewing sample data as a guest.")) return;
    fileInput.click();
  });

  fileInput.addEventListener("change", async () => {
    // The Library's upload button switches to the chat and reuses this input.
    const files = fileInput.files;
    if (!files?.length) return;
    try {
      await ingestFiles(files);
    } catch (err) {
      system(`Error: ${err.message}`);
      showToast(err.message, "error");
    } finally {
      fileInput.value = "";
    }
  });

  documentsBtn.addEventListener("click", showDocumentsModal);
  $("closeDocumentsBtn").addEventListener("click", hideDocumentsModal);
  $("selectAllDocumentsBtn").addEventListener("click", () => setAllDocumentSelection(true));
  $("clearDocumentsBtn").addEventListener("click", () => setAllDocumentSelection(false));
  documentsOverlay.addEventListener("click", (e) => {
    if (e.target === documentsOverlay) hideDocumentsModal();
  });

  $("closeReportBtn").addEventListener("click", hideReport);
  reportOverlay.addEventListener("click", (e) => {
    if (e.target === reportOverlay) hideReport();
  });
  $("exportReportBtn").addEventListener("click", exportReport);

  onProviderChange(() => {
    refreshDocuments().catch((err) => system(`Error loading documents: ${err.message}`));
  });
  onSessionsChange(renderRecent);
  onSettingsChange(() => {
    updateDocumentsBtnLabel();
    renderContextRow();
    renderRecent();
    if (!chatEmpty.classList.contains("hidden")) renderHero();
  });

  renderSession();
  refreshDocuments().catch((err) => {
    if (err instanceof ApiError && err.status === 401) return; // handled by auth guard
  });
}

export function activateUploadRag() {
  if (isGuest()) {
    renderGuestChat();
    refreshDocuments().catch(() => {});
    return;
  }
  setPersistEnabled(true);
  if (!chatEmpty.classList.contains("hidden")) renderHero();
  refreshDocuments().catch((err) => {
    if (err instanceof ApiError && err.status === 401) return;
    system(`Error loading documents: ${err.message}`);
  });
}

// Guest preview: replay the sample transcript without saving it anywhere.
function renderGuestChat() {
  setPersistEnabled(false);
  session = createSession();
  const chat = getGuestData()?.ragChat || [];
  for (const m of chat) {
    const msg = { role: m.role || m.type, text: m.text, command: m.command || null };
    if (m.card) msg.card = m.card;
    session.messages.push({ ts: Date.now(), ...msg });
    if (!session.title && msg.role === "user") session.title = msg.text;
  }
  renderSession();
}

/** Wipe everything on sign-out so nothing leaks into the next session. */
export function clearUploadRag() {
  session = createSession();
  messagesEl.replaceChildren();
  latestReportText = "";
  lastResult = null;
  reportContent.textContent = "";
  reportOverlay.classList.add("hidden");
  documentsOverlay.classList.add("hidden");
  documentsList.replaceChildren();
  knownDocumentsByProvider.openai = [];
  knownDocumentsByProvider.ollama = [];
  selectedSourcesByProvider.openai = new Set();
  selectedSourcesByProvider.ollama = new Set();
  setPersistEnabled(true);
  updateDocumentsBtnLabel();
  renderContextRow();
  updateEmptyState();
}
