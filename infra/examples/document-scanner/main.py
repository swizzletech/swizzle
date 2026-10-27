#!/usr/bin/env python3
import re
from typing import Any

from swizzle_sdk import AutomationContext, run_automation

KEYWORDS = {
    "invoice": ["invoice", "amount due", "billing"],
    "contract": ["agreement", "term", "renewal"],
    "support": ["ticket", "incident", "severity"],
}


def summarize_document(payload: dict[str, Any]) -> dict[str, Any]:
    content = str(payload.get("content", "")).strip()
    normalized = re.sub(r"\s+", " ", content)
    lower_content = normalized.lower()
    matches = [
        label
        for label, patterns in KEYWORDS.items()
        if any(pattern in lower_content for pattern in patterns)
    ]

    return {
        "document_id": payload.get("document_id"),
        "mime_type": payload.get("mime_type", "text/plain"),
        "preview": normalized[:140],
        "word_count": len([word for word in normalized.split(" ") if word]),
        "detected_topics": matches,
        "requires_human_review": len(matches) == 0,
    }


def handle(context: AutomationContext) -> dict[str, Any]:
    if isinstance(context.payload, dict):
        context.log_step("scanning document", {"document_id": context.payload.get("document_id")})

    payload = context.payload if isinstance(context.payload, dict) else {}
    return {
        "status": "ok",
        "mode": "local-demo",
        "scan": summarize_document(payload),
    }


def main() -> int:
    return run_automation(handle)


if __name__ == "__main__":
    raise SystemExit(main())
