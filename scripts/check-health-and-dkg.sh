#!/bin/bash
WS="/tmp/poker-arc-workspace"

echo "=== Health endpoints ==="
for port in 9091 9092 9093 9094; do
    H=$(curl -s -m 2 "http://localhost:$port/health" 2>/dev/null)
    echo "  :$port = ${H:-none}"
done

echo ""
echo "=== Container status ==="
docker ps --format "{{.Names}}\t{{.Status}}" 2>/dev/null

echo ""
echo "=== TD restart count ==="
docker inspect --format '{{.RestartCount}}' artifacts-arcium-trusted-dealer-1 2>/dev/null

echo ""
echo "=== TD docker logs (stderr, last 30 lines) ==="
docker logs --tail 30 artifacts-arcium-trusted-dealer-1 2>&1 | head -30

echo ""
echo "=== Node 0: ALL unique message types ==="
LATEST_N=$(ls -t "$WS/artifacts/arx_node_logs/"*_0.log 2>/dev/null | head -1)
[ -n "$LATEST_N" ] && grep -oP '(INFO|WARN|ERROR|DEBUG) [a-z_:]+' "$LATEST_N" | sort -u

echo ""
echo "=== Node 0: key events (not connection_handlers) ==="
[ -n "$LATEST_N" ] && grep -v "connection_handlers\|network_router\|ConnectionRequest" "$LATEST_N" | tail -30 | cut -c1-250

echo ""
echo "=== arcium localnet still running? ==="
pgrep -a arcium
