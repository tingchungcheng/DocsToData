// App bootstrap: settings first (language, theme, motion), then auth, then
// the views and navigation.

import { isAuthEnabled, isSignedIn } from "./auth.js";
import { activateEvaluation, initEvaluation } from "./evaluation.js";
import { initAuthView, refreshAuthUi } from "./authView.js";
import { activateHistory, initHistory } from "./history.js";
import { t } from "./i18n.js";
import { activateLibrary, initLibrary } from "./library.js";
import { introSequence } from "./motion.js";
import { goToView, initNav, onViewChange, setNavGuard } from "./nav.js";
import { initSettings, onSettingsChange, showSettingsTab } from "./settings.js";
import { isGuest } from "./guest.js";
import { currentProvider, onProviderChange } from "./state.js";
import { showToast } from "./toast.js";
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
  // Screens that call the backend need a signed-in user when sign-in is
  // turned on. Signed-out users go to the sign-in panel instead of seeing
  // "Missing bearer token", and come back to the screen after signing in.
  const PROTECTED_VIEWS = new Set(["rag", "history", "library", "evaluation"]);
  const needsSignIn = () => isAuthEnabled() && !isSignedIn() && !isGuest();
  let lastPrompt = 0;
  const promptSignIn = () => {
    if (Date.now() - lastPrompt < 1500) return;
    lastPrompt = Date.now();
    showToast(t("auth.required"), "info");
  };
  setNavGuard((view) => {
    if (!PROTECTED_VIEWS.has(view) || !needsSignIn()) return false;
    promptSignIn();
    return true;
  });
  window.addEventListener("d2d:auth-required", () => {
    if (isGuest()) return;
    promptSignIn();
    goToView("auth");
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
