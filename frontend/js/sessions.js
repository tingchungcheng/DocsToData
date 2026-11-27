// Chat sessions, stored in this browser (local-first). Powers the chat's
// "New chat", the sidebar's Recent list and the History calendar.
//
// A message is plain data so a session can be re-rendered later:
//   { role: "user" | "bot" | "system", text, command?, card?, ts }

const STORAGE_KEY = "d2d.sessions.v1";
const MAX_SESSIONS = 200;
const MAX_MESSAGES = 200;

let sessions = load();
let persistEnabled = true;
const listeners = new Set();

function load() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    for (const s of parsed) for (const m of s.messages || []) expandMessage(m);
    return parsed;
  } catch {
    return [];
  }
}

// Browser storage is only ~5 MB, so an extract answer's download copy
// (result.content) is not stored twice: when it is exactly the card's data
// pretty-printed, we save a flag and rebuild it on load.
function extractContent(m) {
  return JSON.stringify({ ...m.card.data, _sources: m.card.sources }, null, 2);
}

function compactMessage(m) {
  if (
    m.result?.format === "json" &&
    m.card?.type === "extract" &&
    m.card.data &&
    m.result.content === extractContent(m)
  ) {
    const { content, ...rest } = m.result;
    return { ...m, result: { ...rest, contentFromCard: true } };
  }
  return m;
}

function expandMessage(m) {
  if (m.result?.contentFromCard && m.card?.data) {
    delete m.result.contentFromCard;
    m.result.content = extractContent(m);
  }
}

function persist() {
  if (!persistEnabled) return;
  try {
    const compact = sessions
      .slice(0, MAX_SESSIONS)
      .map((s) => ({ ...s, messages: s.messages.map(compactMessage) }));
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(compact));
  } catch {
    // Storage full or blocked: keep working in memory.
  }
}

function emit() {
  for (const fn of listeners) fn(sessions);
}

/** Guest mode shows sample data; it must never write to the real history. */
export function setPersistEnabled(value) {
  persistEnabled = Boolean(value);
}

export function onSessionsChange(fn) {
  listeners.add(fn);
}

export function listSessions() {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getSession(id) {
  return sessions.find((s) => s.id === id) || null;
}

export function createSession() {
  const now = Date.now();
  const session = {
    id: `s_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    title: "",
    createdAt: now,
    updatedAt: now,
    commands: [],
    messages: [],
  };
  return session;
}

/** Add a message; the session is only stored once it has a user message. */
export function appendMessage(session, message) {
  const msg = { ts: Date.now(), ...message };
  session.messages.push(msg);
  if (session.messages.length > MAX_MESSAGES) session.messages.splice(0, session.messages.length - MAX_MESSAGES);
  session.updatedAt = msg.ts;
  if (msg.command && !session.commands.includes(msg.command)) session.commands.push(msg.command);
  if (!session.title && msg.role === "user") {
    const label = [msg.command ? `#${msg.command}` : "", msg.text || ""].join(" ").trim();
    session.title = label.replace(/\s+/g, " ").slice(0, 60);
  }
  if (session.title) {
    if (!sessions.includes(session)) sessions.unshift(session);
    persist();
    emit();
  }
  return msg;
}

export function deleteSession(id) {
  sessions = sessions.filter((s) => s.id !== id);
  persist();
  emit();
}

export function clearAllSessionsInMemory() {
  sessions = load();
  emit();
}

/** Local calendar day key, e.g. "2026-11-25". */
export function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function sessionsByDay() {
  const map = new Map();
  for (const s of sessions) {
    const key = dayKey(s.createdAt);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(s);
  }
  return map;
}
