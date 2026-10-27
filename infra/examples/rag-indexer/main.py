#!/usr/bin/env python3
import json
import sys
from typing import Any

CHUNK_SIZE = 80


def chunk_text(text: str) -> list[str]:
    words = [word for word in text.split() if word]
    if not words:
        return []

    chunks: list[str] = []
    for start in range(0, len(words), CHUNK_SIZE):
        chunks.append(" ".join(words[start : start + CHUNK_SIZE]))
    return chunks


def build_index_plan(documents: list[dict[str, Any]]) -> list[dict[str, Any]]:
    plan: list[dict[str, Any]] = []
    for document in documents:
        chunks = chunk_text(str(document.get("content", "")))
        plan.append(
            {
                "chunk_count": len(chunks),
                "document_id": document.get("document_id"),
                "preview": chunks[0][:120] if chunks else "",
                "title": document.get("title"),
            }
        )
    return plan


def main() -> int:
    payload = json.load(sys.stdin)
    documents = payload.get("documents", [])
    result = {
        "status": "ok",
        "dry_run": True,
        "documents_received": len(documents),
        "index_plan": build_index_plan(documents),
        "next_step": "Send chunks to your real embedding/vector backend in a later phase.",
    }

    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
