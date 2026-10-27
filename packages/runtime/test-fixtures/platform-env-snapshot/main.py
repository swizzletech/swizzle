#!/usr/bin/env python3
import json
import os
import sys


def main() -> int:
    payload = json.load(sys.stdin)
    result = {
        "payload": payload,
        "declared_secret": os.getenv("DECLARED_SECRET"),
        "database_url": os.getenv("DATABASE_URL"),
        "encryption_key": os.getenv("SWIZZLE_ENCRYPTION_KEY"),
        "run_id": os.getenv("SWIZZLE_RUN_ID"),
        "trigger_type": os.getenv("SWIZZLE_TRIGGER_TYPE"),
    }
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
