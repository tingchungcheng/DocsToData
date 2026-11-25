// User preferences (language, profile, currency, local folders, appearance).
//
// Local-first: settings live in this browser's localStorage. Every read and
// write is wrapped so a blocked or private-mode storage just falls back to
// defaults instead of breaking the app.

import { api } from "./api.js";
import { LANGUAGES, applyI18n, setLanguage, t } from "./i18n.js";
import { setMotionEnabled } from "./motion.js";
import { showToast } from "./toast.js";

const STORAGE_KEY = "d2d.settings.v1";

export const CURRENCIES = [
  { id: "MYR", label: "Malaysian ringgit" },
  { id: "SGD", label: "Singapore dollar" },
  { id: "USD", label: "US dollar" },
  { id: "TWD", label: "New Taiwan dollar" },
  { id: "CNY", label: "Chinese yuan" },
  { id: "HKD", label: "Hong Kong dollar" },
  { id: "EUR", label: "Euro" },
];

const DEFAULTS = {
  language: "en",
  currency: "MYR",
  displayName: "",
  company: "",
  theme: "system",
  motion: true,
  folders: {
    quotation: "Quotations",
    po: "Purchase Orders",
    invoice: "Invoices",
    other: "Other",
  },
  folderByMonth: true,
};

let settings = load();
const listeners = new Set();

function load() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const parsed = JSON.parse(raw);
    return { ...structuredClone(DEFAULTS), ...parsed, folders: { ...DEFAULTS.folders, ...(parsed.folders || {}) } };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

function persist() {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable: keep the in-memory copy for this visit.
  }
}

export function getSettings() {
  return settings;
}

export function updateSettings(patch) {
  settings = { ...settings, ...patch, folders: { ...settings.folders, ...(patch.folders || {}) } };
  persist();
  applySettings();
  for (const fn of listeners) fn(settings);
}

export function onSettingsChange(fn) {
  listeners.add(fn);
}

export function formatMoney(amount, currency = settings.currency) {
  if (amount === null || amount === undefined || amount === "" || Number.isNaN(Number(amount))) return "–";
  try {
    return new Intl.NumberFormat(settings.language, { style: "currency", currency }).format(Number(amount));
  } catch {
    return `${currency} ${Number(amount).toLocaleString()}`;
  }
}

/** Folder (relative to the workspace root) where a result of this doc type is saved. */
export function folderFor(docType) {
  const base = settings.folders[docType] || settings.folders.other || "Other";
  if (!settings.folderByMonth) return base;
  const now = new Date();
  return `${base}/${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function applyTheme() {
  const root = document.documentElement;
  if (settings.theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", settings.theme);
}

function applySettings() {
  setLanguage(settings.language);
  setMotionEnabled(settings.motion);
  applyTheme();
}

// ---------------------------------------------------------------------------
// Settings view
// ---------------------------------------------------------------------------

function renderChoices(container, items, activeId, onPick) {
  container.replaceChildren();
  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `choice${item.id === activeId ? " active" : ""}`;
    btn.setAttribute("aria-pressed", String(item.id === activeId));
    const title = document.createElement("span");
    title.className = "choice-title";
    title.textContent = item.title;
    const sub = document.createElement("span");
    sub.className = "choice-sub";
    sub.textContent = item.sub;
    btn.append(title, sub);
    btn.addEventListener("click", () => onPick(item.id));
    container.appendChild(btn);
  }
}

function renderPanels() {
  renderChoices(
    document.getElementById("languageChoices"),
    LANGUAGES.map((l) => ({ id: l.id, title: l.native, sub: l.label })),
    settings.language,
    (id) => {
      updateSettings({ language: id });
      showToast(t("settings.saved"), "success");
    }
  );

  renderChoices(
    document.getElementById("currencyChoices"),
    CURRENCIES.map((c) => ({ id: c.id, title: c.id, sub: c.label })),
    settings.currency,
    (id) => {
      updateSettings({ currency: id });
      showToast(t("settings.saved"), "success");
    }
  );
  document.getElementById("currencyPreview").textContent = t("settings.currencyPreview", {
    amount: formatMoney(12345.6),
  });

  renderChoices(
    document.getElementById("themeChoices"),
    ["system", "light", "dark"].map((id) => ({ id, title: t(`theme.${id}`), sub: "" })),
    settings.theme,
    (id) => updateSettings({ theme: id })
  );
}

function bindInput(id, read, write) {
  const el = document.getElementById(id);
  const sync = () => {
    if (el.type === "checkbox") el.checked = read();
    else el.value = read();
  };
  sync();
  el.addEventListener("change", () => write(el.type === "checkbox" ? el.checked : el.value.trim()));
  return sync;
}

export async function refreshWorkspaceInfo() {
  const rootEl = document.getElementById("workspaceRoot");
  const list = document.getElementById("workspaceFiles");
  try {
    const data = await api.get("/workspace");
    rootEl.textContent = data.root;
    list.replaceChildren();
    const files = data.files || [];
    if (!files.length) {
      const li = document.createElement("li");
      li.className = "card-hint";
      li.textContent = t("settings.noFiles");
      list.appendChild(li);
    }
    for (const f of files.slice(0, 8)) {
      const li = document.createElement("li");
      const name = document.createElement("code");
      name.textContent = f.path;
      const when = document.createElement("span");
      when.textContent = new Date(f.modified * 1000).toLocaleString(settings.language);
      li.append(name, when);
      list.appendChild(li);
    }
  } catch {
    // Backend not reachable or older backend without /workspace: keep defaults.
  }
}

export function initSettings() {
  applySettings();

  const syncers = [
    bindInput("settingDisplayName", () => settings.displayName, (v) => updateSettings({ displayName: v })),
    bindInput("settingCompany", () => settings.company, (v) => updateSettings({ company: v })),
    bindInput("settingMotion", () => settings.motion, (v) => updateSettings({ motion: v })),
    bindInput("folderByMonth", () => settings.folderByMonth, (v) => updateSettings({ folderByMonth: v })),
  ];
  for (const [id, key] of [
    ["folderQuotation", "quotation"],
    ["folderPo", "po"],
    ["folderInvoice", "invoice"],
    ["folderOther", "other"],
  ]) {
    syncers.push(
      bindInput(
        id,
        () => settings.folders[key],
        (v) => updateSettings({ folders: { [key]: v || DEFAULTS.folders[key] } })
      )
    );
  }

  const tabs = Array.from(document.querySelectorAll(".settings-tab"));
  const panels = Array.from(document.querySelectorAll(".settings-panel"));
  for (const tab of tabs) {
    tab.addEventListener("click", () => showSettingsTab(tab.dataset.tab));
  }

  renderPanels();
  onSettingsChange(() => {
    renderPanels();
    for (const sync of syncers) sync();
  });
  applyI18n();

  // Keep a reference for showSettingsTab.
  showSettingsTab.tabs = tabs;
  showSettingsTab.panels = panels;
}

export function showSettingsTab(name) {
  for (const tab of showSettingsTab.tabs || []) tab.classList.toggle("active", tab.dataset.tab === name);
  for (const panel of showSettingsTab.panels || []) panel.classList.toggle("active", panel.dataset.panel === name);
  if (name === "workspace") refreshWorkspaceInfo();
}
