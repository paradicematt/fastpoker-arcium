#!/bin/bash
# Full clean restart with Docker-based arcium localnet
echo "=== Kill everything ==="
pkill -f solana-test-validator 2>/dev/null || true
pkill -f '/tmp/arx-native' 2>/dev/null || true
pkill -f trusted-dealer 2>/dev/null || true
docker ps -aq 2>/dev/null | xargs -r docker rm -f 2>/dev/null || true
sleep 2
echo "  Done"

echo ""
echo "=== Verify clean state ==="
echo "  Validator: $(curl -s -m 1 http://localhost:8899 -X POST -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null || echo 'stopped')"
echo "  Docker containers: $(docker ps -q 2>/dev/null | wc -l)"
echo "  UDP 8001: $(ss -ulnp 2>/dev/null | grep -c 8001)"
