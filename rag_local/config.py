from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv


@dataclass(frozen=True)
class LocalSettings:
    """Runtime settings for local Ollama RAG flow.

    English: Keeps Ollama endpoint/model settings in one place.
    中文: 集中管理 Ollama 的端點與模型設定。
    """

    ollama_base_url: str
    ollama_chat_model: str
    ollama_embed_model: str
    vector_dim: int
    # None = let the model decide. False turns off "thinking" on reasoning
    # models such as qwen3.5, which otherwise spend many tokens (and seconds)
    # before answering. Non-thinking models ignore think=false.
    ollama_think: bool | None = False


def load_local_settings() -> LocalSettings:
    """Load local RAG settings from `.env`.

    English: Uses sensible defaults matching your installed models.
    中文: 預設值對應你目前已安裝的模型。
    """

    load_dotenv()
    return LocalSettings(
        ollama_base_url=os.getenv("OLLAMA_BASE_URL", "http://localhost:11434").strip(),
        ollama_chat_model=os.getenv("OLLAMA_CHAT_MODEL", "qwen3.5:9b").strip(),
        ollama_embed_model=os.getenv("OLLAMA_EMBED_MODEL", "nomic-embed-text:latest").strip(),
        vector_dim=int(os.getenv("OLLAMA_VECTOR_DIM", "768")),
        ollama_think=_parse_think(os.getenv("OLLAMA_THINK", "false")),
    )


def _parse_think(raw: str) -> bool | None:
    """Map OLLAMA_THINK to Ollama's `think` field: true/false, or auto (omit it)."""

    value = raw.strip().lower()
    if value in ("", "auto", "default"):
        return None
    return value in ("1", "true", "yes", "on")
