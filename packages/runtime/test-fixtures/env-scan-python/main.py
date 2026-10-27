import json
import os

declared_secret = os.getenv("DECLARED_SECRET")
declared_var = os.environ.get("DECLARED_VAR")
platform_var = os.environ["SWIZZLE_RUN_ID"]
missing_one = os.getenv("OWN_EMAILS", "")
missing_two = os.environ["MAX_ITEMS"]
dynamic = os.getenv("PREFIX_" + "NAME")

print(json.dumps({
  "declared_secret": declared_secret,
  "declared_var": declared_var,
  "platform_var": platform_var,
  "missing_one": missing_one,
  "missing_two": missing_two,
  "dynamic": dynamic,
}))
