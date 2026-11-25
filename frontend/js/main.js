// App bootstrap: settings first (language, theme, motion), then auth, then
// the views and navigation.

import { activateEvaluation, initEvaluation } from "./evaluation.js";
import { initAuthView, refreshAuthUi } from "./authView.js";
import { activateHistory, initHistory } from "./history.js";
import { t } from "./i18n.js";
import { activateLibrary, initLibrary } from "./library.js";
import { introSequence } from "./motion.js";
import { goToView, initNav, onViewChange } from "./nav.js";
import { initSettings, onSettingsChange, showSettingsTab } from "./settings.js";
import { currentProvider, onProviderChange } from "./state.js";
import { activateUploadRag, initUploadRag, newChat } from "./uploadRag.js";

function updateLocalBadge() {
  const local = currentProvider() === "ollama";
  const badge = document.getElementById("localBadge");
  badge.classList.toggle("is-cloud", !local);
  document.getElementById("localBadgeText").textContent = t(local ? "nav.localOn" : "nav.cloudOn");
}

async function bootstrap() {
  initSettings();

  // Auth must initialize before views render: it consumes the Cognito
  // redirect (?code=...) and resolves the current identity.
  await initAuthView();

  initUploadRag();
  initHistory();
  initLibrary();
  initEvaluation();

  onViewChange((viewName) => {
    if (viewName === "rag") activateUploadRag();
    if (viewName === "history") activateHistory();
    if (viewName === "library") activateLibrary();
    if (viewName === "evaluation") activateEvaluation();
    if (viewName === "auth") showSettingsTab("profile");
    if (viewName === "auth" || viewName === "settings") refreshAuthUi();
  });
  initNav("rag");
  introSequence();

  document.getElementById("newChatBtn").addEventListener("click", () => {
    goToView("rag");
    newChat();
  });
  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      goToView("rag");
      newChat();
    }
  });

  updateLocalBadge();
  onProviderChange(updateLocalBadge);
  onSettingsChange(updateLocalBadge);
}

bootstrap();

// Exposed for debugging in the browser console only; not part of the public API.
window.__d2d = { goToView };
