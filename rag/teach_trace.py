"""Teach-mode trace: a small, human-sized record of what the pipeline did.

English: When the UI's Teach mode is on, the backend records each pipeline
step (parse, tokenize, chunk, embed, store / embed question, search, prompt,
generate) with its real timing and a few *samples* of real data, so the
frontend can replay the run as an animation. Everything here is deliberately
capped (a handful of chunks, the first few vector numbers, short text
previews) so a trace stays a few KB instead of shipping whole embeddings.
Nothing in here changes what the pipeline computes; it only observes.
中文: Teach 模式開啟時，後端會記錄每個 pipeline 步驟（解析、tokenize、切塊、
embedding、存入 / 問題 embedding、檢索、組 prompt、生成）的實際耗時與少量
「樣本」資料，讓前端能以動畫重播整個流程。這裡的所有資料都刻意設上限
（少數幾個 chunk、向量前幾個數字、簡短文字預覽），讓 trace 只有幾 KB，
而不是整包 embedding。這個模組只負責觀察，不會改變 pipeline 的計算結果。
"""

from __future__ import annotations

import time
from contextlib import contextmanager
from typing import Any, Iterator

import tiktoken

from rag.models import Chunk, SearchHit

MAX_SAMPLE_CHUNKS = 3
MAX_SAMPLE_TOKENS = 28
MAX_VECTOR_PREVIEW = 16
MAX_HITS = 6
PREVIEW_CHARS = 220


def preview(text: str, limit: int = PREVIEW_CHARS) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def vector_preview(vec: list[float] | None) -> list[float]:
    if not vec:
        return []
    return [round(float(v), 4) for v in vec[:MAX_VECTOR_PREVIEW]]


def sample_tokens(text: str, encoding_name: str = "cl100k_base") -> list[list[Any]]:
    """First few tokens of `text` as `[token_id, token_text]` pairs."""

    encoder = tiktoken.get_encoding(encoding_name)
    ids = encoder.encode(text or "")[:MAX_SAMPLE_TOKENS]
    return [[tid, encoder.decode([tid])] for tid in ids]


def count_tokens(text: str, encoding_name: str = "cl100k_base") -> int:
    return len(tiktoken.get_encoding(encoding_name).encode(text or ""))


def chunk_summary(chunk: Chunk) -> dict[str, Any]:
    return {
        "chunk_id": chunk.chunk_id,
        "source": chunk.source,
        "page": chunk.page,
        "tokens": count_tokens(chunk.text),
        "text": preview(chunk.text),
    }


def hits_summary(hits: list[SearchHit], limit: int = MAX_HITS) -> list[dict[str, Any]]:
    return [
        {
            "chunk_id": hit.chunk.chunk_id,
            "source": hit.chunk.source,
            "page": hit.chunk.page,
            "score": round(float(hit.score), 4),
            "text": preview(hit.chunk.text, 160),
        }
        for hit in hits[:limit]
    ]


class TeachTrace:
    """Ordered list of steps, each `{id, ms, data}`, plus top-level facts."""

    def __init__(self, kind: str) -> None:
        self.kind = kind
        self.steps: list[dict[str, Any]] = []
        self.meta: dict[str, Any] = {}
        self._started = time.perf_counter()

    @contextmanager
    def step(self, step_id: str, **data: Any) -> Iterator[dict[str, Any]]:
        """Time a block and record it; the yielded dict can be filled inside."""

        record: dict[str, Any] = {"id": step_id, "data": dict(data)}
        start = time.perf_counter()
        try:
            yield record["data"]
        finally:
            record["ms"] = round((time.perf_counter() - start) * 1000, 1)
            self.steps.append(record)

    def add(self, step_id: str, ms: float = 0.0, **data: Any) -> None:
        self.steps.append({"id": step_id, "ms": round(ms, 1), "data": data})

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "total_ms": round((time.perf_counter() - self._started) * 1000, 1),
            "meta": self.meta,
            "steps": self.steps,
        }
