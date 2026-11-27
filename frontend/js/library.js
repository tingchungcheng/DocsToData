// Document Library view: browse indexed PDFs per provider with page/chunk
// counts, rename or delete a document, and jump into the upload flow.

import { api } from "./api.js";
import { blockIfGuest, getGuestData, isGuest } from "./guest.js";
import { t } from "./i18n.js";
import { currentProvider, onProviderChange } from "./state.js";
import { showToast } from "./toast.js";
import { renameDocumentLocally } from "./uploadRag.js";

const grid = document.getElementById("libraryGrid");
const countEl = document.getElementById("libraryCount");
const emptyEl = document.getElementById("libraryEmpty");
const uploadBtn = document.getElementById("libraryUploadBtn");
const emptyUploadBtn = document.getElementById("libraryEmptyUploadBtn");
const fileInput = document.getElementById("fileInput");

let loaded = false;

function docIcon(name) {
  // Auto-renamed PDFs start with a date ("2025-12-26_Quotation_..."): show the type instead.
  const type = /^\d{4}-\d{2}-\d{2}_([^_]+)_/.exec(name || "")?.[1];
  return (type || name || "?").slice(0, 2).toUpperCase();
}

function renderSkeleton() {
  grid.replaceChildren();
  for (let i = 0; i < 4; i++) {
    const card = document.createElement("div");
    card.className = "card library-doc-card";
    card.style.setProperty("--stagger", String(i));
    card.innerHTML = `
      <div class="skeleton" style="width:36px;height:36px;border-radius:10px;"></div>
      <div class="skeleton" style="width:80%;"></div>
      <div class="skeleton" style="width:50%;"></div>
    `;
    grid.appendChild(card);
  }
}

function renderDocuments(docs) {
  grid.replaceChildren();
  countEl.textContent = `${docs.length} document${docs.length === 1 ? "" : "s"}`;

  if (!docs.length) {
    emptyEl.classList.remove("hidden");
    return;
  }
  emptyEl.classList.add("hidden");

  docs.forEach((doc, i) => {
    const card = document.createElement("div");
    card.className = "card library-doc-card";
    card.style.setProperty("--stagger", String(i));

    const icon = document.createElement("div");
    icon.className = "library-doc-icon";
    icon.textContent = docIcon(doc.source);

    const name = document.createElement("div");
    name.className = "library-doc-name";
    name.textContent = doc.source;

    const original = document.createElement("div");
    original.className = "library-doc-original";
    const originalStem = (doc.original_name || "").replace(/\.pdf$/i, "");
    if (originalStem && originalStem !== doc.source) {
      original.textContent = t("library.original", { name: doc.original_name });
      original.title = doc.original_name;
    } else {
      original.hidden = true;
    }

    const stats = document.createElement("div");
    stats.className = "library-doc-stats";
    stats.innerHTML = `<span>${doc.pages} page${doc.pages === 1 ? "" : "s"}</span><span>${doc.chunks} chunk${doc.chunks === 1 ? "" : "s"}</span>`;

    const actions = document.createElement("div");
    actions.className = "library-doc-actions";
    const renameBtn = document.createElement("button");
    renameBtn.className = "btn btn-ghost btn-sm";
    renameBtn.type = "button";
    renameBtn.textContent = t("library.rename");
    renameBtn.addEventListener("click", () => startRename(doc.source, name, actions));
    actions.appendChild(renameBtn);
    const delBtn = document.createElement("button");
    delBtn.className = "btn btn-danger btn-sm";
    delBtn.type = "button";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => deleteDocument(doc.source, card));
    actions.appendChild(delBtn);

    card.appendChild(icon);
    card.appendChild(name);
    card.appendChild(original);
    card.appendChild(stats);
    card.appendChild(actions);
    grid.appendChild(card);
  });
}

/** Swap the card's title for an input; Enter or Save renames, Esc cancels. */
function startRename(source, nameEl, actions) {
  if (blockIfGuest("Sign in to manage documents. You're viewing sample data as a guest.")) return;
  if (nameEl.querySelector("input")) return;

  const form = document.createElement("form");
  form.className = "library-rename";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "library-rename-input";
  input.value = source;
  input.maxLength = 150;
  input.setAttribute("aria-label", t("library.renameLabel", { name: source }));
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "btn btn-primary btn-sm";
  save.textContent = t("library.renameSave");
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn btn-ghost btn-sm";
  cancel.textContent = t("library.renameCancel");
  const buttons = document.createElement("div");
  buttons.className = "library-rename-buttons";
  buttons.append(cancel, save);
  form.append(input, buttons);

  const close = () => {
    nameEl.textContent = source;
    actions.hidden = false;
  };
  cancel.addEventListener("click", close);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const next = input.value.trim();
    if (!next || next === source) {
      close();
      return;
    }
    save.disabled = true;
    try {
      const res = await api.post(
        `/documents/${encodeURIComponent(currentProvider())}/${encodeURIComponent(source)}/rename`,
        { name: next },
      );
      showToast(t("library.renamed", { name: res.name }), "success");
      await renameDocumentLocally(source, res.name);
      await loadDocuments();
    } catch (err) {
      save.disabled = false;
      showToast(err.message || t("library.renameFailed"), "error");
    }
  });

  actions.hidden = true;
  nameEl.replaceChildren(form);
  input.focus();
  input.select();
}

async function deleteDocument(source, card) {
  if (blockIfGuest("Sign in to manage documents. You're viewing sample data as a guest.")) return;
  if (!window.confirm(`Delete "${source}" from the index? This removes all its chunks.`)) {
    return;
  }
  card.classList.add("removing");
  try {
    await api.del(`/documents/${encodeURIComponent(currentProvider())}/${encodeURIComponent(source)}`);
    showToast(`Deleted "${source}"`, "success");
    await loadDocuments();
  } catch (err) {
    card.classList.remove("removing");
    showToast(err.message || "Failed to delete document", "error");
  }
}

export async function loadDocuments() {
  // Guest preview: render the bundled sample documents, no backend call.
  if (isGuest()) {
    renderDocuments((getGuestData()?.documents) || []);
    return;
  }
  renderSkeleton();
  try {
    const data = await api.get(`/documents/details?provider=${encodeURIComponent(currentProvider())}`);
    renderDocuments(data.documents || []);
  } catch (err) {
    grid.replaceChildren();
    countEl.textContent = "0 documents";
    showToast(err.message || "Failed to load documents", "error");
  }
}

export function initLibrary() {
  const goToUpload = () => {
    if (blockIfGuest("Sign in to upload PDFs. You're viewing sample data as a guest.")) return;
    document.querySelector('.nav-link[data-view="rag"]')?.click();
    window.setTimeout(() => fileInput?.click(), 260);
  };
  uploadBtn.addEventListener("click", goToUpload);
  emptyUploadBtn.addEventListener("click", goToUpload);

  onProviderChange(() => {
    if (loaded) loadDocuments();
  });
}

export function activateLibrary() {
  loaded = true;
  loadDocuments();
}

/** Wipe rendered documents + cached state on sign-out. */
export function clearLibrary() {
  loaded = false;
  grid.replaceChildren();
  countEl.textContent = "0 documents";
  emptyEl.classList.add("hidden");
}
