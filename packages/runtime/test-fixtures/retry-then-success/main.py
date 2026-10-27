#!/usr/bin/env python3
import json
import os
import sys


def main() -> int:
    attempt = int(os.getenv("SWIZZLE_ATTEMPT", "1"))
    payload = json.load(sys.stdin)

    if attempt < 3:
        print(json.dumps({"attempt": attempt, "status": "retry-me"}), file=sys.stderr)
        return 1

    print(
        json.dumps(
            {
                "attempt": attempt,
                "payload": payload,
                "status": "succeeded",
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
