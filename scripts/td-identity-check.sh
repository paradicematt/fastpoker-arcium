#!/bin/bash
WS="/tmp/poker-arc-workspace"

echo "=== All TD-related files ==="
ls -la "$WS/artifacts/localnet/td_"* 2>/dev/null

echo ""
echo "=== td_identity.pem content (first 5 lines) ==="
head -5 "$WS/artifacts/localnet/td_identity.pem" 2>/dev/null

echo ""
echo "=== td_master_seed.json content ==="
cat "$WS/artifacts/localnet/td_master_seed.json" 2>/dev/null | head -3

echo ""
echo "=== Compare: node identity_0.pem (first 5 lines) ==="
head -5 "$WS/artifacts/localnet/identity_0.pem" 2>/dev/null

echo ""
echo "=== Docker compose TD mount paths ==="
grep -A5 'td_identity\|td_master' "$WS/artifacts/docker-compose-arx-env.yml" 2>/dev/null

echo ""
echo "=== All files in artifacts/localnet/ ==="
ls "$WS/artifacts/localnet/" 2>/dev/null

echo ""
echo "=== Check: is there a separate TD peer ID file? ==="
grep -r "5438eb\|peer_id\|td_peer" "$WS/artifacts/localnet/" 2>/dev/null | head -5
grep -r "5438eb" "$WS/artifacts/" 2>/dev/null | head -5
