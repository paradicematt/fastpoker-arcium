#!/bin/bash
IDL="$HOME/.cargo/registry/src/index.crates.io-6f17d22bba15001f/arcium-client-0.8.5/idls/arcium.json"
python3 -c "
import json
with open('$IDL') as f:
    d = json.load(f)
for ix in d.get('instructions', []):
    if 'callback' in ix.get('name', '').lower():
        print(f'=== {ix[\"name\"]} ===')
        for acc in ix.get('accounts', []):
            name = acc.get('name', '?')
            writable = acc.get('writable', False)
            signer = acc.get('signer', False)
            print(f'  {name} (writable={writable}, signer={signer})')
        print()
        for arg in ix.get('args', []):
            print(f'  arg: {arg.get(\"name\", \"?\")} type={arg.get(\"type\", \"?\")}')
        print()
"
