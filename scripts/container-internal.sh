#!/bin/bash
echo "=== Node 0: process alive? ==="
docker exec artifacts-arx-node-0-1 ps aux 2>/dev/null || echo "exec failed"

echo ""
echo "=== Node 0: health from inside ==="
docker exec artifacts-arx-node-0-1 bash -c "curl -s http://127.0.0.1:9091/health 2>/dev/null || echo 'curl not found or no response'" 2>/dev/null

echo ""
echo "=== Node 0: listening ports inside ==="
docker exec artifacts-arx-node-0-1 bash -c "cat /proc/net/tcp 2>/dev/null" 2>/dev/null | head -10

echo ""
echo "=== TD: process alive? ==="
docker exec artifacts-arcium-trusted-dealer-1 ps aux 2>/dev/null || echo "exec failed"

echo ""
echo "=== Any new log files for node 0? ==="
ls -lt /tmp/poker-arc-workspace/artifacts/arx_node_logs/ 2>/dev/null | head -5

echo ""
echo "=== Node 0 log: grep for 'health\|ready\|started\|listening\|http' ==="
LATEST=$(ls -t /tmp/poker-arc-workspace/artifacts/arx_node_logs/*_0.log 2>/dev/null | head -1)
[ -n "$LATEST" ] && grep -i "health\|ready\|started\|listening\|http\|server\|api" "$LATEST" | cut -c1-250

echo ""
echo "=== arcium localnet still waiting? ==="
pgrep -a arcium
