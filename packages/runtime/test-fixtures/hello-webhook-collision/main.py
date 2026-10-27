#!/usr/bin/env python3
import json
import sys


def main() -> int:
    payload = json.load(sys.stdin)
    print(json.dumps({"message": "collision fixture", "payload": payload}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
