#!/bin/bash
WS="/tmp/poker-arc-workspace"

echo "=== Check from INSIDE container ==="
docker exec artifacts-arx-node-0-1 bash -c "curl -s localhost:9091/health 2>/dev/null || wget -qO- localhost:9091/health 2>/dev/null || echo 'no curl/wget'" 2>/dev/null || echo "exec failed"

echo ""
echo "=== Container 0 ports listening inside ==="
docker exec artifacts-arx-node-0-1 bash -c "cat /proc/net/tcp | head -5; echo '---'; ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null" 2>/dev/null || echo "exec failed"

echo ""
echo "=== Any NEW log files? ==="
ls -lt "$WS/artifacts/arx_node_logs/" 2>/dev/null | head -5
ls -lt "$WS/artifacts/trusted_dealer_logs/" 2>/dev/null | head -5

echo ""
echo "=== arcium localnet output (check stderr/stdout) ==="
# Check the arcium localnet process
pgrep -a arcium
pgrep -a solana-test-val

echo ""
echo "=== Validator tx count ==="
curl -s http://localhost:8899 -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getTransactionCount"}' 2>/dev/null

echo ""
echo "=== Check if set_mxe_keys landed ==="
# The MXE account should have keys set after MxeKeygen
curl -s http://localhost:8899 -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' 2>/dev/null
