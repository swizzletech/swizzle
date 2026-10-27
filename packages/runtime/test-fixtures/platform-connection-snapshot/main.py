#!/usr/bin/env python3
import json
import os
import sys


def main() -> int:
    payload = json.load(sys.stdin)
    result = {
        "payload": payload,
        "connection_token": os.getenv("SWIZZLE_CONNECTION_TEST_GOOGLE"),
        "connection_expires_at": os.getenv("SWIZZLE_CONNECTION_TEST_GOOGLE_EXPIRES_AT"),
        # A refresh token must never be exposed to automation code.
        "leaked_refresh_token": os.getenv("SWIZZLE_CONNECTION_TEST_GOOGLE_REFRESH"),
    }
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
