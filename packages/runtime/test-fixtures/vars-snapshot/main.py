import json
import os

print(json.dumps({
  "feature_mode": os.getenv("FEATURE_MODE"),
  "max_items": os.getenv("MAX_ITEMS"),
  "enable_create": os.getenv("ENABLE_CREATE"),
}))
