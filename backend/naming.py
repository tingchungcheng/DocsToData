"""Consistent display names for uploaded PDFs.

English: After upload, each PDF is renamed to
`YYYY-MM-DD_Type_Subject-vN`, e.g. `2025-12-26_Quotation_2512-001-DAMA-Bitrise-v1`.

- Date: the document's own date when one can be found on the first pages
  (the date seen most often wins, with a bonus for labelled ones such as
  "Date:" / "Invoice date:"), else a date in the file name, else the
  upload date.
- Type: Quotation / PO / Invoice / Other, from the document's heading, then
  the original file name, then an optional hint from the UI.
- Subject: the original file name with type words, dates, copy markers and
  version suffixes stripped. When that leaves nothing useful (e.g.
  "scan_0012.pdf"), the project / client named in the content is used.
- vN: one more than the highest version already indexed under the same
  `Date_Type_Subject` base.

中文: 上傳後，每份 PDF 會改名為 `YYYY-MM-DD_類型_主旨-vN`。日期優先取文件內容
中的日期，否則用上傳日期；類型依標題、原始檔名或介面提示判斷；主旨取自整理後
的原始檔名，若原檔名沒有意義則改用內容中的專案或客戶名稱；同名時版本號 +1。
"""

from __future__ import annotations

import re
from collections import Counter
from datetime import date

TYPE_LABELS = {"quotation": "Quotation", "po": "PO", "invoice": "Invoice", "other": "Other"}

_MONTHS = {
    m: i
    for i, names in enumerate(
        [
            ("jan", "january"),
            ("feb", "february"),
            ("mar", "march"),
            ("apr", "april"),
            ("may",),
            ("jun", "june"),
            ("jul", "july"),
            ("aug", "august"),
            ("sep", "sept", "september"),
            ("oct", "october"),
            ("nov", "november"),
            ("dec", "december"),
        ],
        start=1,
    )
    for m in names
}
_MONTH_RE = "|".join(sorted(_MONTHS, key=len, reverse=True))

# Each pattern yields named groups y, m (number or month name) and d.
_DATE_PATTERNS = [
    re.compile(r"\b(?P<y>(?:19|20)\d{2})[-/.](?P<m>\d{1,2})[-/.](?P<d>\d{1,2})\b"),
    re.compile(r"\b(?P<d>\d{1,2})[-/.](?P<m>\d{1,2})[-/.](?P<y>(?:19|20)\d{2})\b"),
    re.compile(rf"\b(?P<d>\d{{1,2}})(?:st|nd|rd|th)?[\s\-/.,]+(?P<m>{_MONTH_RE})\.?[\s\-/.,]+(?P<y>(?:19|20)\d{{2}})\b", re.I),
    re.compile(rf"\b(?P<m>{_MONTH_RE})\.?\s+(?P<d>\d{{1,2}})(?:st|nd|rd|th)?,?\s+(?P<y>(?:19|20)\d{{2}})\b", re.I),
]
_DATE_LABEL_RE = re.compile(
    r"(?:invoice\s+date|quotation\s+date|quote\s+date|order\s+date|issue[d]?\s+(?:date|on)|"
    r"revised\s+on|dated?)\s*[:：]?\s*$",
    re.I,
)

_TYPE_HEADING = [
    ("quotation", re.compile(r"\bquotation\b|\bquote\b|報價|报价", re.I)),
    ("po", re.compile(r"\bpurchase\s+order\b|採購單|采购单", re.I)),
    ("invoice", re.compile(r"\binvoice\b|發票|发票", re.I)),
]

# Words that describe the type or the file, not the subject.
_NOISE_WORDS = re.compile(
    r"\b(?:quotations?|quotes?|qtn|qt|invoices?|inv|tax|purchase[\s_-]*orders?|po|"
    r"copy|final|draft|scan(?:ned)?|signed|new|untitled|document|doc|file|pdf|img|image)\b",
    re.I,
)
_VERSION_RE = re.compile(
    r"(?:[\s_\-]+(?:v|ver|version|rev)\.?\s*\d+(?:\.\d+)*|\s+-\s+\d+(?:\.\d+)+|\s*\(\d+\))\s*$", re.I
)
_COMPACT_DATE_RE = re.compile(r"(?<!\d)(?P<y>(?:19|20)\d{2})(?P<m>[01]\d)(?P<d>[0-3]\d)(?!\d)")
_SUBJECT_LABELS = re.compile(
    r"^\s*(?:project\s*(?:title|name)?|subject(?:\s*/\s*project\s*name)?|client|customer|"
    r"bill(?:ed)?\s+to|prepared\s+for|attention|attn)\s*[:：]\s*(?P<v>.*)$",
    re.I,
)
_MAX_SUBJECT = 48


def guess_type_from_name(name: str) -> str:
    """Same rules as `guessDocType` in frontend/js/commands.js."""

    n = name.lower()
    if re.search(r"quot|(^|[^a-z])(qt|qtn)([^a-z]|$)|報價|报价", n):
        return "quotation"
    if re.search(r"(^|[^a-z])po([^a-z]|$)|purchase[\s_-]*order", n):
        return "po"
    if re.search(r"invoice|(^|[^a-z])inv([^a-z]|$)", n):
        return "invoice"
    return "other"


def detect_type(text: str, original_name: str, hint: str | None = None) -> str:
    """Document heading first, then the file name, then the UI hint."""

    heading = text[:400]
    for doc_type, pattern in _TYPE_HEADING:
        if pattern.search(heading):
            return doc_type
    from_name = guess_type_from_name(original_name)
    if from_name != "other":
        return from_name
    if hint in TYPE_LABELS:
        return hint
    return "other"


def _to_date(y: str, m: str, d: str) -> date | None:
    try:
        month = int(m) if m.isdigit() else _MONTHS[m.lower().rstrip(".")]
        day, year = int(d), int(y)
        if month > 12 and day <= 12:  # US order, e.g. 12/31/2025
            month, day = day, month
        return date(year, month, day)
    except (KeyError, ValueError):
        return None


def detect_date(text: str, today: date | None = None) -> date | None:
    """Pick the document's own date from its text, or None."""

    today = today or date.today()
    scores: Counter[date] = Counter()
    first_seen: dict[date, int] = {}
    for pattern in _DATE_PATTERNS:
        for match in pattern.finditer(text):
            found = _to_date(match["y"], match["m"], match["d"])
            if not found or found.year < 1990 or found > date(today.year + 1, 12, 31):
                continue
            line_start = text.rfind("\n", 0, match.start()) + 1
            labelled = bool(_DATE_LABEL_RE.search(text[line_start : match.start()]))
            scores[found] += 1 + (1.5 if labelled else 0)
            first_seen.setdefault(found, match.start())
    if not scores:
        return None
    return max(scores, key=lambda d: (scores[d], -first_seen[d]))


def date_from_name(original_name: str) -> date | None:
    """A date written in the file name, e.g. `PO_20251102.pdf` or `2025-11-02 Acme.pdf`."""

    for pattern in [*_DATE_PATTERNS, _COMPACT_DATE_RE]:
        for match in pattern.finditer(original_name.replace("_", " ")):
            found = _to_date(match["y"], match["m"], match["d"])
            if found:
                return found
    return None


def _slug(value: str) -> str:
    value = re.sub(r"[^\w]+", "-", value, flags=re.UNICODE)
    value = re.sub(r"_+", "-", value)
    value = re.sub(r"-{2,}", "-", value).strip("-")
    if len(value) > _MAX_SUBJECT:
        value = value[:_MAX_SUBJECT].rsplit("-", 1)[0] or value[:_MAX_SUBJECT]
    return value


def _subject_from_name(original_name: str) -> str:
    stem = re.sub(r"\.pdf$", "", original_name.strip(), flags=re.I)
    stem = _VERSION_RE.sub("", stem).replace("_", " ")
    for pattern in [*_DATE_PATTERNS, _COMPACT_DATE_RE]:
        stem = pattern.sub(" ", stem)
    stem = _NOISE_WORDS.sub(" ", stem)
    slug = _slug(stem)
    # Junk such as "scan_0012" or "IMG-4411" leaves only digits behind.
    letters = sum(ch.isalpha() for ch in slug)
    return slug if letters >= 3 else ""


def _subject_from_text(text: str) -> str:
    lines = [ln.strip(" ​\t") for ln in text.splitlines()]
    for i, line in enumerate(lines[:120]):
        match = _SUBJECT_LABELS.match(line)
        if not match:
            continue
        value = match["v"].strip()
        if not value:  # label on its own line, value on the next non-empty one
            value = next((ln for ln in lines[i + 1 : i + 4] if ln.strip()), "")
        value = value.split(",")[0]
        slug = _slug(value)
        if sum(ch.isalpha() for ch in slug) >= 3:
            return slug
    return ""


def detect_subject(text: str, original_name: str) -> str:
    return _subject_from_name(original_name) or _subject_from_text(text) or "Document"


def next_version(base: str, existing: list[str] | set[str]) -> int:
    pattern = re.compile(rf"^{re.escape(base)}-v(\d+)$", re.I)
    versions = [int(m.group(1)) for name in existing if (m := pattern.match(name))]
    return max(versions, default=0) + 1


def build_display_name(
    text: str,
    original_name: str,
    existing: list[str] | set[str],
    *,
    type_hint: str | None = None,
    upload_date: date | None = None,
) -> tuple[str, str]:
    """Return `(display_name, doc_type)` for a freshly uploaded PDF."""

    upload_date = upload_date or date.today()
    doc_type = detect_type(text, original_name, type_hint)
    when = detect_date(text, today=upload_date) or date_from_name(original_name) or upload_date
    base = f"{when.isoformat()}_{TYPE_LABELS[doc_type]}_{detect_subject(text, original_name)}"
    return f"{base}-v{next_version(base, existing)}", doc_type


def clean_user_name(name: str) -> str:
    """Sanitize a name typed in the Library rename box (keeps `_` and `.`)."""

    name = re.sub(r"\.pdf$", "", name.strip(), flags=re.I)
    name = re.sub(r"[\\/:*?\"<>|\x00-\x1f]+", "-", name)
    name = re.sub(r"\s+", " ", name).strip(" .-")
    return name[:150]
