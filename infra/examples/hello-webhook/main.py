#!/usr/bin/env python3
import json
import os
import sys


def main() -> int:
    payload = json.load(sys.stdin)

    result = {
        "status": "success",
        "message": "Hello from Swizzle",
        "run_id": os.getenv("SWIZZLE_RUN_ID"),
        "trigger_type": os.getenv("SWIZZLE_TRIGGER_TYPE"),
        "payload": payload,
    }

    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
