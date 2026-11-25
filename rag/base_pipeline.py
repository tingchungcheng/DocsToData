from __future__ import annotations

import os
import time
from pathlib import Path

from rag.chunk_metadata import stamp_chunk_metadata
from rag.chunking_strategies import DEFAULT_STRATEGY, ChunkingStrategy, chunk_document
from rag.graph.intent import _CLASSIFY_SYSTEM
from rag.graph.workflow import run_rag_graph
from rag.llm_gateway import LLMGateway
from rag.models import SearchHit, TokenUsage
from rag.pdf_parser import extract_pdf_pages
from rag.retrieval import fuse_rrf, hybrid_retrieve, keyword_search, rerank
from rag import teach_trace as tt
from rag.vector_store import FaissStore


def _default_chunking_strategy() -> ChunkingStrategy:
    value = os.getenv("CHUNK_STRATEGY", DEFAULT_STRATEGY).strip().lower()
    return value  # type: ignore[return-value]  # validated inside chunk_document()


class BaseRagPipeline:
    """Provider-agnostic RAG pipeline built on top of an `LLMGateway`.

    English: This is the shared implementation used by `RagPipeline`
    (OpenAI), `LocalRagPipeline` (Ollama), and `BedrockRagPipeline` (AWS) —
    architecturev2.txt section 5's "LLM Gateway" pattern applied to the
    ingestion/retrieval/generation pipeline so all three providers share one
    code path instead of three near-duplicate ones. Subclasses only need to
    construct the right `LLMGateway` and pass provider-specific defaults
    (vector dimension, embedding model name, default index directory).
    中文: 這是 `RagPipeline`（OpenAI）、`LocalRagPipeline`（Ollama）、
    `BedrockRagPipeline`（AWS）共用的實作——把 architecturev2.txt 第 5 節的
    「LLM Gateway」模式套用到 ingestion/檢索/生成流程，讓三個 provider 共用
    同一份程式碼，而不是各自維護三份幾乎相同的版本。子類別只需要建立對應的
    `LLMGateway`，並傳入各自的預設值（向量維度、embedding 模型名稱、預設索引
    目錄）即可。
    """

    def __init__(
        self,
        gateway: LLMGateway,
        vector_dim: int,
        embedding_model_name: str,
        default_index_dir: str,
        chat_model_name: str = "",
        chunking_strategy: ChunkingStrategy | None = None,
    ) -> None:
        self.gateway = gateway
        self.vector_dim = vector_dim
        self.embedding_model_name = embedding_model_name
        self.chat_model_name = chat_model_name
        self.default_index_dir = default_index_dir
        self.chunking_strategy = chunking_strategy or _default_chunking_strategy()
        self._usage_accumulator = TokenUsage()
        # Teach mode: set per `answer(teach=True)` call; None means "don't record".
        self._teach: dict[str, list] | None = None

    def _load_or_create_store(self, out_dir: str) -> FaissStore:
        index_path = Path(out_dir) / "index.faiss"
        if index_path.exists():
            return FaissStore.load(in_dir=out_dir, dim=self.vector_dim)
        return FaissStore(dim=self.vector_dim)

    def ingest_pdf(
        self,
        pdf_path: str,
        out_dir: str | None = None,
        chunk_size: int = 700,
        chunk_overlap: int = 120,
        replace_existing: bool = True,
        chunking_strategy: ChunkingStrategy | None = None,
        teach: bool = False,
    ) -> dict[str, object]:
        """End-to-end ingestion: parse -> chunk -> embed -> append to index.

        English: `chunking_strategy` defaults to the pipeline's configured
        strategy (env `CHUNK_STRATEGY`, default "page" — the pre-v2
        behavior) but can be overridden per call, e.g. from an API request,
        to support the experiment framework in architecturev2.txt section 8.
        中文: `chunking_strategy` 預設使用 pipeline 設定的策略（環境變數
        `CHUNK_STRATEGY`，預設為 "page"，即 v2 之前的行為），但可依呼叫（例如
        API 請求）逐次覆寫，以支援 architecturev2.txt 第 8 節的實驗框架。
        """

        out_dir = out_dir or self.default_index_dir
        strategy = chunking_strategy or self.chunking_strategy
        trace = tt.TeachTrace("ingest") if teach else None

        t0 = time.perf_counter()
        pages = extract_pdf_pages(pdf_path)
        source_name = Path(pdf_path).stem
        if trace:
            trace.meta["source"] = source_name
            trace.add(
                "parse",
                ms=(time.perf_counter() - t0) * 1000,
                pages=len(pages),
                chars=sum(len(text) for _, text in pages),
                page_chars=[len(text) for _, text in pages[:40]],
                first_page=pages[0][0] if pages else None,
                first_page_text=tt.preview(pages[0][1], 320) if pages else "",
            )
            # Chunk sizes are measured in tokens, so tokenization happens
            # before chunking. This repeats the encode only in teach mode so
            # the step gets its own timing and sample.
            with trace.step("tokenize", encoding="cl100k_base") as d:
                per_page = [tt.count_tokens(text) for _, text in pages]
                d["total_tokens"] = sum(per_page)
                d["page_tokens"] = per_page[:40]
                d["sample"] = tt.sample_tokens(pages[0][1]) if pages else []

        t0 = time.perf_counter()
        chunks = chunk_document(
            pages=pages,
            source_name=source_name,
            strategy=strategy,
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap,
        )
        stamp_chunk_metadata(
            chunks,
            source_name=source_name,
            embedding_model=self.embedding_model_name,
            chunk_size=chunk_size,
            chunking_strategy=strategy,
        )
        if trace:
            trace.add(
                "chunk",
                ms=(time.perf_counter() - t0) * 1000,
                strategy=strategy,
                chunk_size=chunk_size,
                chunk_overlap=chunk_overlap,
                count=len(chunks),
                chunk_tokens=[tt.count_tokens(c.text) for c in chunks[:60]],
                chunk_pages=[c.page for c in chunks[:60]],
                samples=[tt.chunk_summary(c) for c in chunks[: tt.MAX_SAMPLE_CHUNKS]],
            )

        t0 = time.perf_counter()
        embeddings = self.gateway.embed([c.text for c in chunks])
        if trace:
            trace.add(
                "embed",
                ms=(time.perf_counter() - t0) * 1000,
                model=self.embedding_model_name,
                count=len(embeddings),
                dim=len(embeddings[0]) if embeddings else self.vector_dim,
                vectors=[
                    {"chunk_id": c.chunk_id, "values": tt.vector_preview(v)}
                    for c, v in list(zip(chunks, embeddings))[: tt.MAX_SAMPLE_CHUNKS]
                ],
            )

        t0 = time.perf_counter()
        store = self._load_or_create_store(out_dir)
        before = int(store.index.ntotal)
        removed = store.remove_source(source_name) if replace_existing else 0
        store.add(embeddings=embeddings, chunks=chunks)
        store.save(out_dir=out_dir)
        if trace:
            trace.add(
                "store",
                ms=(time.perf_counter() - t0) * 1000,
                index_type=type(store.index).__name__,
                metric="inner product on L2-normalized vectors (cosine similarity)",
                before=before,
                removed=removed,
                added=len(embeddings),
                total=int(store.index.ntotal),
                documents=len(store.list_sources()),
            )

        stats: dict[str, object] = {
            "source": source_name,
            "pages": len(pages),
            "chunks": len(chunks),
            "vectors": len(embeddings),
            "replaced_chunks": removed,
            "total_documents": len(store.list_sources()),
            "chunking_strategy": strategy,
        }
        if trace:
            stats["teach"] = trace.to_dict()
        return stats

    def list_sources(self, in_dir: str | None = None) -> list[str]:
        store = FaissStore.load(in_dir=in_dir or self.default_index_dir, dim=self.vector_dim)
        return store.list_sources()

    def retrieve(
        self,
        question: str,
        in_dir: str | None = None,
        top_k: int = 5,
        source_filter: set[str] | None = None,
        use_hybrid: bool = True,
        candidate_k: int = 20,
    ) -> list[SearchHit]:
        """Retrieve top-k chunks relevant to a question.

        English: `use_hybrid=True` (default) runs the full vector + keyword
        + rerank pipeline from architecturev2.txt section 4
        (`rag/retrieval.py`); set it to False to fall back to plain vector
        search (useful for A/B comparisons in the evaluation framework).
        中文: `use_hybrid=True`（預設）會執行完整的向量 + 關鍵字 + 重排序流程
        （對應 architecturev2.txt 第 4 節，實作於 `rag/retrieval.py`）；設為
        False 則會退回單純向量搜尋（方便評估框架做 A/B 比較）。
        """

        store = FaissStore.load(in_dir=in_dir or self.default_index_dir, dim=self.vector_dim)
        t0 = time.perf_counter()
        query_vec = self.gateway.embed_one(question)
        embed_ms = (time.perf_counter() - t0) * 1000

        if self._teach is not None:
            return self._traced_retrieve(
                store, question, query_vec, embed_ms, top_k, candidate_k, source_filter, use_hybrid
            )

        if not use_hybrid:
            return store.search(query_vec, top_k=top_k, source_filter=source_filter)

        return hybrid_retrieve(
            store=store,
            query_text=question,
            query_vector=query_vec,
            top_k=top_k,
            candidate_k=max(candidate_k, top_k),
            source_filter=source_filter,
        )

    def _traced_retrieve(
        self,
        store: FaissStore,
        question: str,
        query_vec: list[float],
        embed_ms: float,
        top_k: int,
        candidate_k: int,
        source_filter: set[str] | None,
        use_hybrid: bool,
    ) -> list[SearchHit]:
        """Same stages as `hybrid_retrieve`, run one by one so each is recorded."""

        assert self._teach is not None
        candidate_k = max(candidate_k, top_k)
        t0 = time.perf_counter()
        if use_hybrid:
            vector_hits = store.search(query_vec, top_k=candidate_k, source_filter=source_filter)
            keyword_hits = keyword_search(store, question, top_k=candidate_k, source_filter=source_filter)
            fused = fuse_rrf([vector_hits, keyword_hits], top_k=candidate_k)
            final = rerank(question, fused, top_k=top_k)
        else:
            vector_hits = store.search(query_vec, top_k=top_k, source_filter=source_filter)
            keyword_hits, fused, final = [], [], vector_hits
        self._teach["retrievals"].append(
            {
                "embed_ms": round(embed_ms, 1),
                "search_ms": round((time.perf_counter() - t0) * 1000, 1),
                "dim": len(query_vec),
                "vector": tt.vector_preview(query_vec),
                "index_total": int(store.index.ntotal),
                "filter": sorted(source_filter) if source_filter else [],
                "hybrid": use_hybrid,
                "candidate_k": candidate_k,
                "top_k": top_k,
                "vector_hits": tt.hits_summary(vector_hits),
                "keyword_hits": tt.hits_summary(keyword_hits),
                "fused": tt.hits_summary(fused),
                "final": tt.hits_summary(final, limit=top_k),
            }
        )
        return final

    def chat(self, system_prompt: str, user_prompt: str) -> str:
        t0 = time.perf_counter()
        result = self.gateway.generate(user_prompt, system=system_prompt, temperature=0.1)
        if self._teach is not None:
            usage = self.gateway.last_usage
            self._teach["llm_calls"].append(
                {
                    "purpose": "classify" if system_prompt == _CLASSIFY_SYSTEM else "answer",
                    "ms": round((time.perf_counter() - t0) * 1000, 1),
                    "model": self.chat_model_name,
                    "system": tt.preview(system_prompt, 260),
                    "prompt": tt.preview(user_prompt, 600),
                    "prompt_chars": len(system_prompt) + len(user_prompt),
                    "prompt_tokens": usage.prompt_tokens,
                    "completion_tokens": usage.completion_tokens,
                    "output": tt.preview(result, 260),
                }
            )
        self._usage_accumulator.prompt_tokens += self.gateway.last_usage.prompt_tokens
        self._usage_accumulator.completion_tokens += self.gateway.last_usage.completion_tokens
        return result

    def answer(
        self,
        question: str,
        in_dir: str | None = None,
        top_k: int = 5,
        intent: str | None = None,
        source_filter: list[str] | None = None,
        teach: bool = False,
    ) -> dict[str, object]:
        """Run LangGraph workflow with intent routing.

        English: Returns the v2 structured response shape from
        architecturev2.txt section 6: `{answer, intent, sources, citations,
        confidence}`, plus a `usage: TokenUsage` field accumulated across
        every `chat()` call made during this run (intent classification +
        generation) so the evaluation framework can compute a per-query cost
        estimate via `rag/pricing.py`.
        中文: 回傳對應 architecturev2.txt 第 6 節的 v2 結構化回應格式：
        `{answer, intent, sources, citations, confidence}`，並額外附上
        `usage: TokenUsage`，累加本次執行過程中所有 `chat()` 呼叫的 token 數
        （意圖分類 + 生成回答），讓評估框架可透過 `rag/pricing.py` 估算每次
        查詢的成本。
        """

        self._usage_accumulator = TokenUsage()
        self._teach = {"retrievals": [], "llm_calls": []} if teach else None
        started = time.perf_counter()
        try:
            result = run_rag_graph(
                backend=self,
                question=question,
                in_dir=in_dir or self.default_index_dir,
                top_k=top_k,
                intent=intent,  # type: ignore[arg-type]
                source_filter=source_filter,
            )
            if self._teach is not None:
                result["teach"] = self._build_query_trace(
                    question=question,
                    requested_intent=intent,
                    result=result,
                    total_ms=(time.perf_counter() - started) * 1000,
                )
        finally:
            self._teach = None
        # Copy, not the same object: callers may make further `chat()` calls
        # after `answer()` returns (e.g. an LLM-judge pass in the evaluation
        # framework) which must not silently mutate an already-returned result.
        result["usage"] = TokenUsage(
            prompt_tokens=self._usage_accumulator.prompt_tokens,
            completion_tokens=self._usage_accumulator.completion_tokens,
        )
        return result

    def _build_query_trace(
        self,
        question: str,
        requested_intent: str | None,
        result: dict[str, object],
        total_ms: float,
    ) -> dict[str, object]:
        """Arrange the recorded calls into the order the graph ran them."""

        assert self._teach is not None
        retrievals = self._teach["retrievals"]
        calls = self._teach["llm_calls"]
        classify = next((c for c in calls if c["purpose"] == "classify"), None)
        answers = [c for c in calls if c["purpose"] == "answer"]
        first = retrievals[0] if retrievals else None

        steps: list[dict[str, object]] = [
            {
                "id": "question",
                "ms": 0.0,
                "data": {
                    "text": tt.preview(question, 400),
                    "tokens": tt.count_tokens(question),
                    "sample": tt.sample_tokens(question),
                },
            },
            {
                "id": "intent",
                "ms": classify["ms"] if classify else 0.0,
                "data": {
                    "intent": result.get("intent", "qa"),
                    "by": "llm" if classify else "tool",
                    "llm_output": classify["output"] if classify else "",
                },
            },
        ]
        if first:
            steps.append(
                {
                    "id": "embed_query",
                    "ms": sum(r["embed_ms"] for r in retrievals),
                    "data": {
                        "model": self.embedding_model_name,
                        "dim": first["dim"],
                        "vector": first["vector"],
                        "calls": len(retrievals),
                    },
                }
            )
            steps.append(
                {
                    "id": "search",
                    "ms": sum(r["search_ms"] for r in retrievals),
                    "data": {
                        "index_total": first["index_total"],
                        "hybrid": first["hybrid"],
                        "candidate_k": first["candidate_k"],
                        "top_k": first["top_k"],
                        "runs": [
                            {k: r[k] for k in ("filter", "vector_hits", "keyword_hits", "fused", "final")}
                            for r in retrievals
                        ],
                    },
                }
            )
        for call in answers:
            steps.append(
                {
                    "id": "prompt",
                    "ms": 0.0,
                    "data": {
                        "system": call["system"],
                        "prompt": call["prompt"],
                        "prompt_chars": call["prompt_chars"],
                        "prompt_tokens": call["prompt_tokens"],
                        "chunks": sum(len(r["final"]) for r in retrievals),
                    },
                }
            )
            steps.append(
                {
                    "id": "generate",
                    "ms": call["ms"],
                    "data": {
                        "model": call["model"],
                        "completion_tokens": call["completion_tokens"],
                        "output": call["output"],
                    },
                }
            )
        steps.append(
            {
                "id": "answer",
                "ms": 0.0,
                "data": {
                    "citations": list(result.get("citations", []))[:8],
                    "confidence": result.get("confidence", 0.0),
                },
            }
        )
        return {"kind": "query", "total_ms": round(total_ms, 1), "meta": {}, "steps": steps}
