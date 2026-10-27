import json
import sys


def main() -> None:
    payload = json.load(sys.stdin)
    print(json.dumps({"accepted": True, "payload": payload}))


if __name__ == "__main__":
    main()
