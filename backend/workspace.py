"""Local workspace: where the chat saves results (extractions, comparisons,
summaries) as files on this computer.

English: This is the local-first replacement for "save to a folder in S3".
Files are written under one root folder (``DOCS_WORKSPACE_DIR``, default
``data/workspace`` in the repo). Folder and file names come from the
browser, so every path is sanitized and must stay inside the root.
中文: 這是「存到 S3 某個資料夾」的本機優先版本。檔案都寫在同一個根目錄
（``DOCS_WORKSPACE_DIR``，預設為 repo 內的 ``data/workspace``）。資料夾與
檔名來自瀏覽器，因此每個路徑都會清理，並且必須留在根目錄之內。
"""

from __future__ import annotations

import os
import re
from pathlib import Path

ALLOWED_EXTENSIONS = {".json", ".md", ".txt", ".csv"}
MAX_CONTENT_BYTES = 2 * 1024 * 1024
_SEGMENT_RE = re.compile(r"[^\w\-. ()&]+", re.UNICODE)


class WorkspaceError(ValueError):
    """Raised for a folder or file name that can't be saved safely."""


def workspace_root(base_dir: Path) -> Path:
    configured = os.getenv("DOCS_WORKSPACE_DIR", "").strip()
    root = Path(configured).expanduser() if configured else base_dir / "data" / "workspace"
    if not root.is_absolute():
        root = base_dir / root
    root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


def _clean_segment(segment: str) -> str:
    cleaned = _SEGMENT_RE.sub("_", segment.strip()).strip(" .")
    if not cleaned or cleaned in {".", ".."}:
        raise WorkspaceError(f"invalid name: {segment!r}")
    return cleaned[:100]


def _clean_folder(folder: str) -> list[str]:
    parts = [p for p in re.split(r"[\\/]+", folder or "") if p.strip()]
    if len(parts) > 6:
        raise WorkspaceError("folder is nested too deeply")
    return [_clean_segment(p) for p in parts]


def save_file(root: Path, folder: str, filename: str, content: str) -> Path:
    """Write ``content`` to ``root/folder/filename`` and return the path.

    An existing file is never overwritten: a numeric suffix is added instead.
    """

    name = _clean_segment(Path(filename or "").name)
    stem, ext = os.path.splitext(name)
    ext = ext.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise WorkspaceError(f"file type not allowed: {ext or '(none)'}")
    data = content.encode("utf-8")
    if len(data) > MAX_CONTENT_BYTES:
        raise WorkspaceError("content is too large")

    target_dir = root.joinpath(*_clean_folder(folder)).resolve()
    if target_dir != root and root not in target_dir.parents:
        raise WorkspaceError("folder must stay inside the workspace")
    target_dir.mkdir(parents=True, exist_ok=True)

    target = target_dir / f"{stem}{ext}"
    counter = 2
    while target.exists():
        target = target_dir / f"{stem}-{counter}{ext}"
        counter += 1
    target.write_bytes(data)
    return target


def list_files(root: Path, limit: int = 50) -> list[dict[str, object]]:
    files = [p for p in root.rglob("*") if p.is_file() and p.suffix.lower() in ALLOWED_EXTENSIONS]
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return [
        {
            "path": p.relative_to(root).as_posix(),
            "size": p.stat().st_size,
            "modified": p.stat().st_mtime,
        }
        for p in files[:limit]
    ]
