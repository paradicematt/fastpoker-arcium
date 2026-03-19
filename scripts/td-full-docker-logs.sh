#!/bin/bash
echo "=== TD full docker logs (last 200 lines) ==="
docker logs --tail 200 artifacts-arcium-trusted-dealer-1 2>&1

echo ""
echo "=== arcium localnet still running? ==="
pgrep -a arcium

echo ""
echo "=== validator still running? ==="
pgrep -a solana-test-val
