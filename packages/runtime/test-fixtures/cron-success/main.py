#!/usr/bin/env python3
import json
import sys


def main() -> int:
    payload = json.load(sys.stdin)
    print(json.dumps({"mode": "cron", "payload": payload}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
