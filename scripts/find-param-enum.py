import json, sys

with open(sys.argv[1]) as f:
    idl = json.load(f)

for t in idl.get("types", []):
    name = t.get("name", "")
    if name.lower() in ("parameter", "output"):
        print(json.dumps(t, indent=2))
