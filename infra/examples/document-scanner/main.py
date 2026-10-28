#!/usr/bin/env python3
"""Scan a document and route it to a team; ask a person if no topic matches."""
import re
from typing import Any

from swizzle_sdk import read_payload, request_approval, run_step, write_result


# Each step name is a node id in flow.mermaid: the dashboard follows it.
def main() -> None:
    document = read_payload()
    doc_id = document.get("document_id")

    text = run_step("parse", lambda: normalize(document))
    topics = run_step("classify", lambda: detect_topics(text))
    fields = run_step("extract", lambda: extract_fields(text))

    approved = True
    if not topics:
        review = request_approval(
            "review",
            details={"message": f"No topic in {doc_id}. Send it to the inbox?"},
        )
        approved = review["approved"]

    team = run_step("route", lambda: route(topics, approved))

    write_result(
        {
            "status": "ok",
            "scan": {
                "document_id": doc_id,
                "mime_type": document.get("mime_type", "text/plain"),
                "preview": text[:140],
                "word_count": len(text.split()),
                "detected_topics": topics,
                "fields": fields,
                "routed_to": team,
            },
        }
    )


TOPICS = {
    "invoice": ["invoice", "amount due", "billing"],
    "contract": ["agreement", "term", "renewal"],
    "support": ["ticket", "incident", "severity"],
}

TEAMS = {"invoice": "finance", "contract": "legal", "support": "helpdesk"}

MAX_CONTENT_CHARACTERS = 65_536

FIELDS = {
    "amounts": r"(?:EUR|USD|€|\$)\s?\d(?:[\d,.]*\d)?",
    "dates": r"\b\d{4}-\d{2}-\d{2}\b",
    # The start guard prevents retries inside a word; possessive repeats cannot backtrack.
    "emails": r"(?<![\w.+-])[\w.+-]++@[\w-]++\.[\w-](?:[\w-]|\.(?=[\w-]))*+",
}


def normalize(document: dict[str, Any]) -> str:
    content = document.get("content")
    if not isinstance(content, str):
        raise ValueError("The payload's content must be a string of document text.")
    if len(content) > MAX_CONTENT_CHARACTERS:
        raise ValueError(f"The payload's content must not exceed {MAX_CONTENT_CHARACTERS} characters.")
    return re.sub(r"\s+", " ", content).strip()


def detect_topics(text: str) -> list[str]:
    """Topics whose terms appear as whole words, outside email addresses."""
    prose = re.sub(FIELDS["emails"], " ", text).lower()
    return [
        topic
        for topic, words in TOPICS.items()
        if any(re.search(rf"\b{re.escape(word)}\b", prose) for word in words)
    ]


def extract_fields(text: str) -> dict[str, list[str]]:
    return {name: re.findall(pattern, text) for name, pattern in FIELDS.items()}


def route(topics: list[str], approved: bool) -> str | None:
    """The team for the first topic; the shared inbox after an approved review, else nobody."""
    if topics:
        return TEAMS[topics[0]]
    return "inbox" if approved else None


if __name__ == "__main__":
    main()
