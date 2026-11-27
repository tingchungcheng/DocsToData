from __future__ import annotations

import logging
import os
from pathlib import Path

import fitz  # PyMuPDF

logger = logging.getLogger(__name__)

# English: A page with fewer characters than this is treated as having no
# usable text layer (e.g. a PNG/JPG that was saved as a PDF).
# 中文: 文字少於此數量的頁面視為沒有可用的文字層（例如由 PNG/JPG 轉成的 PDF）。
MIN_TEXT_CHARS = 20

# English: Fraction of the page area that images must cover before an
# almost-empty page is sent to OCR.
# 中文: 幾乎沒有文字的頁面，圖片需覆蓋多少比例的頁面面積才會送去 OCR。
MIN_IMAGE_COVERAGE = 0.3

_ocr_unavailable_warned = False


def _ocr_enabled() -> bool:
    return os.getenv("OCR_ENABLED", "true").strip().lower() not in {"0", "false", "no", "off"}


def _ocr_language() -> str:
    return os.getenv("OCR_LANGUAGE", "eng").strip() or "eng"


def _image_coverage(page: fitz.Page) -> float:
    """Return the fraction of the page covered by images (0.0 to 1.0)."""

    page_area = abs(page.rect)
    if not page_area:
        return 0.0
    covered = 0.0
    for info in page.get_image_info():
        bbox = fitz.Rect(info["bbox"]) & page.rect
        if not bbox.is_empty:
            covered += abs(bbox)
    return min(covered / page_area, 1.0)


def needs_ocr(page: fitz.Page, text: str) -> bool:
    """True when a page has (almost) no text but is mostly an image.

    English: This is how scanned pages and image-to-PDF uploads are found.
    中文: 用來找出掃描頁或由圖片轉成 PDF 的頁面。
    """

    if len(text) >= MIN_TEXT_CHARS:
        return False
    return _image_coverage(page) >= MIN_IMAGE_COVERAGE


def ocr_page(page: fitz.Page) -> str:
    """Run Tesseract OCR on one page through PyMuPDF. Returns "" if unavailable."""

    global _ocr_unavailable_warned
    try:
        textpage = page.get_textpage_ocr(language=_ocr_language(), dpi=300, full=True)
        return page.get_text("text", textpage=textpage).strip()
    except Exception as exc:  # Tesseract missing, language pack missing, etc.
        if not _ocr_unavailable_warned:
            logger.warning(
                "OCR skipped: Tesseract is not available (%s). "
                "Install it (macOS: `brew install tesseract`) to read scanned PDFs.",
                exc,
            )
            _ocr_unavailable_warned = True
        return ""


def extract_pdf_pages(pdf_path: str) -> list[tuple[int, str]]:
    """Extract plain text per page from a PDF.

    English: Returns `(page_number, text)` and skips empty-text pages. Pages
    with no text layer that are mostly an image are read with Tesseract OCR
    (turn off with `OCR_ENABLED=false`, choose languages with
    `OCR_LANGUAGE`, e.g. `eng+chi_tra`).
    中文: 回傳 `(頁碼, 文字)`，並略過沒有文字內容的頁面。沒有文字層且主要是
    圖片的頁面會用 Tesseract OCR 讀取（`OCR_ENABLED=false` 可關閉，
    `OCR_LANGUAGE` 可指定語言，例如 `eng+chi_tra`）。
    """

    path = Path(pdf_path)
    if not path.exists():
        raise FileNotFoundError(f"PDF not found: {pdf_path}")

    ocr_on = _ocr_enabled()
    pages: list[tuple[int, str]] = []
    with fitz.open(path) as doc:
        for page_idx, page in enumerate(doc, start=1):
            text = page.get_text("text").strip()
            if ocr_on and needs_ocr(page, text):
                ocr_text = ocr_page(page)
                if len(ocr_text) > len(text):
                    logger.info("OCR read page %d of %s", page_idx, path.name)
                    text = ocr_text
            if text:
                pages.append((page_idx, text))
    return pages
