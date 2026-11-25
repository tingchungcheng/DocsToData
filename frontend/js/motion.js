// GSAP-powered motion with graceful fallback.
//
// Local-first means the app must work with no internet. GSAP loads from a
// CDN, so every helper here checks for it and simply skips the animation
// (leaving elements in their final state) when it isn't there, when the
// user turned animations off in Settings, or when the OS asks for reduced
// motion.

let enabled = true;
const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

export function setMotionEnabled(value) {
  enabled = Boolean(value);
}

function gsap() {
  if (!enabled || reducedQuery.matches) return null;
  return window.gsap || null;
}

/** A view slides up and fades in; its cards follow in a short stagger. */
export function viewIn(view) {
  const g = gsap();
  if (!g || !view) return;
  g.fromTo(view, { autoAlpha: 0, y: 14 }, { autoAlpha: 1, y: 0, duration: 0.45, ease: "power3.out", clearProps: "transform,opacity,visibility" });
  const items = view.querySelectorAll(".view-header > *, .card, .starter, .library-toolbar");
  if (items.length) {
    g.fromTo(
      items,
      { autoAlpha: 0, y: 18 },
      { autoAlpha: 1, y: 0, duration: 0.5, ease: "power3.out", stagger: 0.035, delay: 0.05, clearProps: "transform,opacity,visibility" }
    );
  }
}

/** The sliding pill behind the active sidebar link. */
export function moveIndicator(indicator, link) {
  if (!indicator || !link) return;
  const y = link.offsetTop;
  const h = link.offsetHeight;
  const g = gsap();
  if (!g) {
    indicator.style.transform = `translateY(${y}px)`;
    indicator.style.height = `${h}px`;
    return;
  }
  g.to(indicator, { y, height: h, duration: 0.45, ease: "expo.out" });
}

export function messageIn(el, fromUser = false) {
  const g = gsap();
  if (!g || !el) return;
  g.fromTo(
    el,
    { autoAlpha: 0, y: 12, x: fromUser ? 12 : 0, scale: 0.985 },
    { autoAlpha: 1, y: 0, x: 0, scale: 1, duration: 0.42, ease: "power3.out", clearProps: "transform,opacity,visibility" }
  );
}

export function popIn(el) {
  const g = gsap();
  if (!g || !el) return;
  g.fromTo(
    el,
    { autoAlpha: 0, y: 8, scale: 0.97 },
    { autoAlpha: 1, y: 0, scale: 1, duration: 0.25, ease: "back.out(1.6)", clearProps: "transform,opacity,visibility" }
  );
}

export function staggerIn(nodes, { y = 10, stagger = 0.02 } = {}) {
  const g = gsap();
  if (!g || !nodes || !nodes.length) return;
  g.fromTo(
    nodes,
    { autoAlpha: 0, y },
    { autoAlpha: 1, y: 0, duration: 0.35, ease: "power2.out", stagger, clearProps: "transform,opacity,visibility" }
  );
}

/** Hero headline: words rise in one by one. */
export function heroIn(heading) {
  const g = gsap();
  if (!heading) return;
  const text = heading.textContent;
  if (!g) return;
  heading.replaceChildren();
  // Chinese has no spaces: split per character there, per word elsewhere.
  const parts = /\s/.test(text) ? text.split(/(\s+)/) : Array.from(text);
  for (const part of parts) {
    if (/^\s+$/.test(part)) {
      heading.appendChild(document.createTextNode(part));
      continue;
    }
    const span = document.createElement("span");
    span.className = "hero-word";
    span.textContent = part;
    heading.appendChild(span);
  }
  g.fromTo(
    heading.querySelectorAll(".hero-word"),
    { yPercent: 110, autoAlpha: 0, rotate: 2 },
    { yPercent: 0, autoAlpha: 1, rotate: 0, duration: 0.8, ease: "expo.out", stagger: 0.05 }
  );
}

/** First paint: sidebar items cascade in. */
export function introSequence() {
  const g = gsap();
  if (!g) return;
  g.from(".sidebar .brand, .sidebar .new-chat-btn, .sidebar .nav-link, .sidebar-section, .sidebar-footer > *", {
    autoAlpha: 0,
    x: -14,
    duration: 0.5,
    ease: "power3.out",
    stagger: 0.04,
    clearProps: "transform,opacity,visibility",
  });
}

/** Number ticker for figures in result cards. */
export function countUp(el, to, format) {
  const g = gsap();
  if (!g || !Number.isFinite(to)) {
    el.textContent = format(to);
    return;
  }
  const state = { v: 0 };
  g.to(state, {
    v: to,
    duration: 0.9,
    ease: "power2.out",
    onUpdate: () => {
      el.textContent = format(state.v);
    },
    onComplete: () => {
      el.textContent = format(to);
    },
  });
}
