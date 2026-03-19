#!/bin/bash
# List available Docker image tags for arcium
echo "=== arcium/arx-node tags ==="
curl -s 'https://hub.docker.com/v2/repositories/arcium/arx-node/tags/?page_size=20' 2>/dev/null \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
for t in d.get('results', []):
    print(f\"  {t['name']:20s}  updated: {t['last_updated'][:19]}  size: {t.get('full_size',0)//1024//1024}MB\")
" 2>/dev/null || echo "  (failed to fetch)"

echo ""
echo "=== arcium/trusted-dealer tags ==="
curl -s 'https://hub.docker.com/v2/repositories/arcium/trusted-dealer/tags/?page_size=20' 2>/dev/null \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
for t in d.get('results', []):
    print(f\"  {t['name']:20s}  updated: {t['last_updated'][:19]}  size: {t.get('full_size',0)//1024//1024}MB\")
" 2>/dev/null || echo "  (failed to fetch)"
