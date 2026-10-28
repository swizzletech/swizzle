"""Run with: just --command python3 -m unittest discover -s infra/examples/document-scanner -v"""
import json
from pathlib import Path
import subprocess
import sys
import unittest

import main as scanner


class DocumentScannerTests(unittest.TestCase):
    def test_sample_document_keeps_its_fields_and_route(self) -> None:
        payload = json.loads(Path(__file__).with_name("sample-payload.json").read_text())
        result = self.run_scanner(payload)
        self.assertEqual(result.returncode, 0, result.stderr)
        scan = json.loads(result.stdout)["scan"]
        self.assertEqual(scan["fields"], {
            "amounts": ["EUR 1,240.00"],
            "dates": ["2026-11-14"],
            "emails": ["finance@example.com"],
        })
        self.assertEqual(scan["detected_topics"], ["invoice"])
        self.assertEqual(scan["routed_to"], "finance")

    def test_extracts_addresses_and_excludes_them_from_topics(self) -> None:
        text = (
            "<invoice+tag@sub.example.co.uk>, ticket@support-team.example.org; "
            "renewal@büro.example.de. user.name-1@my-domain.example.com "
            "broken@host..example.com good@host.example..rest"
        )
        self.assertEqual(scanner.extract_fields(text)["emails"], [
            "invoice+tag@sub.example.co.uk",
            "ticket@support-team.example.org",
            "renewal@büro.example.de",
            "user.name-1@my-domain.example.com",
            "good@host.example",
        ])
        self.assertEqual(scanner.detect_topics(text), [])
        self.assertEqual(scanner.detect_topics(text + " Invoice agreement ticket"), [
            "invoice", "contract", "support",
        ])

    def test_accepts_content_at_the_limit(self) -> None:
        prefix = "invoice "
        suffix = " invoice+tag@sub.example.com"
        content = prefix + "a" * (65_536 - len(prefix) - len(suffix)) + suffix
        result = self.run_scanner({"content": content})
        self.assertEqual(result.returncode, 0, result.stderr[:1000])
        scan = json.loads(result.stdout)["scan"]
        self.assertEqual(scan["fields"]["emails"], ["invoice+tag@sub.example.com"])
        self.assertEqual(scan["detected_topics"], ["invoice"])
        self.assertEqual(scan["routed_to"], "finance")

    def test_refuses_content_over_the_limit_before_normalizing(self) -> None:
        result = self.run_scanner({"content": " " * 65_530 + "invoice"})
        self.assertEqual(result.returncode, 1, result.stderr[:1000])
        self.assertIn("content must not exceed 65536 characters", result.stderr)
        self.assertEqual(result.stdout, "")
        with self.assertRaisesRegex(ValueError, "content must not exceed 65536 characters"):
            scanner.normalize({"content": "ü" * 65_537})

    def test_refuses_a_one_mebibyte_email_free_word(self) -> None:
        with self.assertRaisesRegex(ValueError, "content must not exceed 65536 characters"):
            scanner.normalize({"content": "a" * (1024 * 1024)})

    def run_scanner(self, payload: dict) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(Path(__file__).with_name("main.py"))],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            env={"PYTHONDONTWRITEBYTECODE": "1"},
        )


if __name__ == "__main__":
    unittest.main()
