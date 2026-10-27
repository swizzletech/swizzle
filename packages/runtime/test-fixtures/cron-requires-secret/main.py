#!/usr/bin/env python3
import json
import os

print(json.dumps({"token": os.getenv("CRON_REQUIRED_TOKEN")}))
