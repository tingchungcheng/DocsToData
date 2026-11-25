// Sidebar navigation: switches views, slides the active pill with GSAP and
// handles the mobile drawer. "auth" is kept as an alias of Settings so older
// callers (authView.js) still land on the sign-in panel.

import { moveIndicator, viewIn } from "./motion.js";

const navLinks = Array.from(document.querySelectorAll(".nav-link"));
const indicator = document.getElementById("navIndicator");
const viewSections = Array.from(document.querySelectorAll(".view"));
const sidebar = document.getElementById("sidebar");
const scrim = document.getElementById("sidebarScrim");

const ALIASES = { auth: "settings" };
const listeners = new Set();
let current = null;
let guard = null;
let pendingView = null;

/**
 * Register a check run before every view switch. When it returns true for a
 * view, the user is sent to the sign-in panel instead, and the view they
 * wanted is remembered so sign-in can take them back to it.
 */
export function setNavGuard(fn) {
  guard = fn;
}

/** The view a signed-out user tried to open, cleared once read. */
export function consumePendingView() {
  const view = pendingView;
  pendingView = null;
  return view;
}

function activateView(requested) {
  if (guard && guard(ALIASES[requested] || requested)) {
    pendingView = ALIASES[requested] || requested;
    requested = "auth";
  }
  const viewName = ALIASES[requested] || requested;
  const changed = viewName !== current;
  current = viewName;

  for (const section of viewSections) {
    section.classList.toggle("active", section.dataset.view === viewName);
  }
  for (const link of navLinks) {
    const active = link.dataset.view === viewName;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  moveIndicator(indicator, navLinks.find((l) => l.dataset.view === viewName));
  if (changed) viewIn(viewSections.find((s) => s.dataset.view === viewName));
  closeDrawer();

  // Listeners get the requested name so "auth" can open the profile tab.
  for (const fn of listeners) fn(requested);
}

function openDrawer() {
  sidebar.classList.add("open");
  scrim.classList.add("open");
}

function closeDrawer() {
  sidebar.classList.remove("open");
  scrim.classList.remove("open");
}

export function onViewChange(fn) {
  listeners.add(fn);
}

export function goToView(viewName) {
  activateView(viewName);
}

export function currentView() {
  return current;
}

export function initNav(defaultView = "rag") {
  for (const link of navLinks) {
    link.addEventListener("click", () => activateView(link.dataset.view));
  }
  window.addEventListener("resize", () => {
    moveIndicator(indicator, navLinks.find((l) => l.classList.contains("active")));
  });
  document.getElementById("sidebarOpen").addEventListener("click", openDrawer);
  document.getElementById("sidebarClose").addEventListener("click", closeDrawer);
  scrim.addEventListener("click", closeDrawer);

  activateView(defaultView);
}
