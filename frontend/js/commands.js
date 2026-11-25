// Chat "#" commands and document-type helpers.
//
// Each command turns what the user typed into a prompt for the existing
// /query RAG endpoint. Nothing here talks to the network: the chat view
// (uploadRag.js) owns the calls, this module only describes the tools.

export const DOC_TYPES = ["quotation", "po", "invoice", "other"];

/** Best-effort guess of a document's type from its file name. */
export function guessDocType(fileName = "") {
  const n = fileName.toLowerCase();
  if (/quot|(^|[^a-z])(qt|qtn)([^a-z]|$)/.test(n)) return "quotation";
  if (/(^|[^a-z])po([^a-z]|$)|purchase[\s_-]*order/.test(n)) return "po";
  if (/invoice|(^|[^a-z])inv([^a-z]|$)/.test(n)) return "invoice";
  return "other";
}

const LANGUAGE_HINT = {
  en: "",
  "zh-TW": " Respond in Traditional Chinese.",
  "zh-CN": " Respond in Simplified Chinese.",
};

function languageHint(lang) {
  return LANGUAGE_HINT[lang] || "";
}

function docList(docs) {
  return docs.length ? ` Only use these documents: ${docs.join(", ")}.` : "";
}

export const EXTRACT_FIELDS = [
  "document_type",
  "document_number",
  "document_date",
  "vendor",
  "buyer",
  "currency",
  "line_items",
  "subtotal",
  "tax",
  "total",
  "payment_terms",
];

/**
 * The tools a user can call with "#name". `docTypes` lists the document
 * types a tool is meant for; the chat uses it to suggest tools.
 */
export const COMMANDS = [
  {
    id: "ask",
    icon: "?",
    intent: "qa",
    docTypes: [],
    build: ({ text, docs, lang }) => `${text}${docList(docs)}${languageHint(lang)}`,
  },
  {
    id: "compare",
    icon: "⇄",
    intent: "compare",
    docTypes: ["quotation"],
    build: ({ text, docs, lang, currency }) =>
      "Compare the vendor quotations side by side. For each vendor list: total price, " +
      "key line items, delivery or timeline, payment terms, validity and anything excluded. " +
      `Show amounts in ${currency} where the document allows. ` +
      "Then say clearly which vendor is the better choice and why, in 2-4 bullet points." +
      (text ? ` Extra focus from the user: ${text}.` : "") +
      docList(docs) +
      languageHint(lang),
  },
  {
    id: "extract",
    icon: "⧉",
    intent: "qa",
    docTypes: ["po", "invoice"],
    structured: true,
    build: ({ text, docs }) =>
      "Extract the key fields from the purchase order or invoice. Reply with ONLY one JSON " +
      `object, no prose, using these keys: ${EXTRACT_FIELDS.join(", ")}. ` +
      "line_items is an array of objects with description, quantity, unit_price, amount. " +
      "Use numbers for amounts and null for anything not in the document." +
      (text ? ` Extra instruction: ${text}.` : "") +
      docList(docs),
  },
  {
    id: "summarize",
    icon: "≡",
    intent: "summarize",
    docTypes: ["quotation", "po", "invoice", "other"],
    report: true,
    build: ({ text, docs, lang }) =>
      "Summarize the documents. Include parties, amounts and totals, dates and timeline, " +
      "scope or line items, and anything that needs attention." +
      (text ? ` Focus: ${text}.` : "") +
      docList(docs) +
      languageHint(lang),
  },
  {
    id: "plan",
    icon: "☰",
    intent: "qa",
    docTypes: [],
    build: ({ text, docs, lang }) =>
      `Using the documents as context, write a short numbered step-by-step plan for: ${
        text || "processing these documents"
      }. For each step name the document and the data it needs.` +
      docList(docs) +
      languageHint(lang),
  },
  {
    id: "action",
    icon: "↧",
    local: true,
    docTypes: ["po", "invoice", "quotation"],
  },
];

export function findCommand(id) {
  return COMMANDS.find((c) => c.id === id) || null;
}

/** Split "#compare focus on price" into { command, text }. */
export function parseCommand(input) {
  const match = /^#([a-z]+)\b\s*/i.exec(input.trim());
  if (!match) return { command: null, text: input.trim() };
  const command = findCommand(match[1].toLowerCase());
  if (!command) return { command: null, text: input.trim() };
  return { command, text: input.trim().slice(match[0].length).trim() };
}

/** Pull the first JSON object out of an LLM answer, tolerating prose and code fences. */
export function parseJsonAnswer(answer) {
  if (!answer) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(answer);
  const body = fenced ? fenced[1] : answer;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
