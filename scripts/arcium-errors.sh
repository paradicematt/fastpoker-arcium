#!/bin/bash
IDL="$HOME/.cargo/registry/src/index.crates.io-6f17d22bba15001f/arcium-client-0.8.5/idls/arcium.json"
python3 -c "
import json, sys
with open('$IDL') as f:
    d = json.load(f)
for i, e in enumerate(d.get('errors', [])):
    code = 6000 + i
    name = e.get('name', '?')
    msg = e.get('msg', '')
    print(f'{code}: {name} — {msg}')
    if code > 6020:
        break
"
