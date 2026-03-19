import json, sys

with open(sys.argv[1]) as f:
    idl = json.load(f)

for t in idl.get("types", []):
    name = t.get("name", "")
    kind = t.get("type", {}).get("kind", "")
    if kind == "enum":
        variants = [v["name"] for v in t["type"].get("variants", [])]
        print(f"{name}: {len(variants)} variants = {variants}")
