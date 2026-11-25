// History view: a month calendar of past chats (stored on this device).
// Days with chats show dots; pick a day to list its chats and reopen one.

import { getLanguage, t } from "./i18n.js";
import { staggerIn } from "./motion.js";
import { dayKey, deleteSession, onSessionsChange, sessionsByDay } from "./sessions.js";
import { onSettingsChange } from "./settings.js";
import { openSession } from "./uploadRag.js";
import { goToView } from "./nav.js";

const $ = (id) => document.getElementById(id);
const grid = $("calGrid");
const weekdays = $("calWeekdays");
const title = $("calTitle");
const dayTitle = $("historyDayTitle");
const sessionsList = $("historySessions");
const emptyEl = $("historyEmpty");

let month = startOfMonth(new Date());
let selectedDay = dayKey(Date.now());

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function renderWeekdays() {
  weekdays.replaceChildren();
  const fmt = new Intl.DateTimeFormat(getLanguage(), { weekday: "narrow" });
  // 2026-11-01 is a Sunday; use it as a fixed reference week.
  for (let i = 0; i < 7; i++) {
    const span = document.createElement("span");
    span.textContent = fmt.format(new Date(2026, 10, 1 + i));
    weekdays.appendChild(span);
  }
}

function renderCalendar({ animate = false } = {}) {
  const byDay = sessionsByDay();
  title.textContent = new Intl.DateTimeFormat(getLanguage(), { year: "numeric", month: "long" }).format(month);
  grid.replaceChildren();

  const first = month.getDay();
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const today = dayKey(Date.now());

  for (let i = 0; i < first; i++) {
    const pad = document.createElement("span");
    pad.className = "cal-pad";
    grid.appendChild(pad);
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(month.getFullYear(), month.getMonth(), d);
    const key = dayKey(date.getTime());
    const count = byDay.get(key)?.length || 0;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cal-day";
    if (key === today) btn.classList.add("is-today");
    if (key === selectedDay) btn.classList.add("is-selected");
    if (count) btn.classList.add("has-chats");
    btn.setAttribute("aria-label", `${date.toDateString()}, ${count} chats`);
    const num = document.createElement("span");
    num.className = "cal-num";
    num.textContent = String(d);
    btn.appendChild(num);
    if (count) {
      const dots = document.createElement("span");
      dots.className = "cal-dots";
      for (let i = 0; i < Math.min(count, 3); i++) dots.appendChild(document.createElement("i"));
      btn.appendChild(dots);
    }
    btn.addEventListener("click", () => {
      selectedDay = key;
      renderCalendar();
      renderDay(true);
    });
    grid.appendChild(btn);
  }
  if (animate) staggerIn(grid.querySelectorAll(".cal-day"), { y: 8, stagger: 0.008 });
}

function renderDay(animate = false) {
  const [y, m, d] = selectedDay.split("-").map(Number);
  dayTitle.textContent = new Intl.DateTimeFormat(getLanguage(), {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(y, m - 1, d));

  const items = (sessionsByDay().get(selectedDay) || []).sort((a, b) => b.createdAt - a.createdAt);
  sessionsList.replaceChildren();
  emptyEl.classList.toggle("hidden", items.length > 0);

  for (const s of items) {
    const li = document.createElement("li");
    li.className = "history-session";

    const open = document.createElement("button");
    open.type = "button";
    open.className = "history-open";
    const time = document.createElement("span");
    time.className = "history-time";
    time.textContent = new Date(s.createdAt).toLocaleTimeString(getLanguage(), { hour: "2-digit", minute: "2-digit" });
    const name = document.createElement("span");
    name.className = "history-name";
    name.textContent = s.title;
    const meta = document.createElement("span");
    meta.className = "history-meta";
    const count = s.messages.filter((x) => x.role !== "system").length;
    meta.textContent = [t("chat.messages", { count }), ...s.commands.map((c) => `#${c}`)].join(" · ");
    open.append(time, name, meta);
    open.addEventListener("click", () => {
      openSession(s.id);
      goToView("rag");
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn btn-ghost btn-sm history-delete";
    del.textContent = t("history.delete");
    del.addEventListener("click", () => deleteSession(s.id));

    li.append(open, del);
    sessionsList.appendChild(li);
  }
  if (animate) staggerIn(sessionsList.children, { y: 10, stagger: 0.04 });
}

export function initHistory() {
  $("calPrev").addEventListener("click", () => {
    month = new Date(month.getFullYear(), month.getMonth() - 1, 1);
    renderCalendar({ animate: true });
  });
  $("calNext").addEventListener("click", () => {
    month = new Date(month.getFullYear(), month.getMonth() + 1, 1);
    renderCalendar({ animate: true });
  });
  $("calToday").addEventListener("click", () => {
    month = startOfMonth(new Date());
    selectedDay = dayKey(Date.now());
    renderCalendar({ animate: true });
    renderDay(true);
  });
  onSessionsChange(() => {
    renderCalendar();
    renderDay();
  });
  onSettingsChange(() => {
    renderWeekdays();
    renderCalendar();
    renderDay();
  });
  renderWeekdays();
  renderCalendar();
  renderDay();
}

export function activateHistory() {
  renderWeekdays();
  renderCalendar({ animate: true });
  renderDay(true);
}
