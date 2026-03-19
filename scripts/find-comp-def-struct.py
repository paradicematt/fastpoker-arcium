import json, sys

with open(sys.argv[1]) as f:
    idl = json.load(f)

# Find account and type definitions
for section in ['accounts', 'types']:
    for t in idl.get(section, []):
        name = t.get("name", "")
        if "computation" in name.lower() or "circuit" in name.lower() or "signature" in name.lower():
            print(f"\n[{section}] {name}:")
            print(json.dumps(t, indent=2)[:2000])
