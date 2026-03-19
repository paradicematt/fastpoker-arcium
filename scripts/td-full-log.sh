#!/bin/bash
WS="/tmp/poker-arc-workspace"

echo "=== TD container status ==="
docker ps -a --filter "name=trusted-dealer" --format "{{.Names}}\t{{.Status}}"

echo ""
echo "=== TD docker logs (last 100 lines) ==="
docker logs --tail 100 artifacts-arcium-trusted-dealer-1 2>&1

echo ""
echo "=== TD restart count ==="
docker inspect --format '{{.RestartCount}}' artifacts-arcium-trusted-dealer-1 2>/dev/null

echo ""
echo "=== TD latest file log (FULL, no truncation) ==="
LATEST_TD=$(ls -t "$WS/artifacts/trusted_dealer_logs/"*.log 2>/dev/null | head -1)
[ -n "$LATEST_TD" ] && wc -l "$LATEST_TD" && cat "$LATEST_TD"

echo ""
echo "=== Node 0: ONLY online_phase lines ==="
LATEST_N=$(ls -t "$WS/artifacts/arx_node_logs/"*_0.log 2>/dev/null | head -1)
[ -n "$LATEST_N" ] && grep "online_phase_unit" "$LATEST_N" | head -5 | cut -c1-300

echo ""
echo "=== Node 0: node-to-node connections (not TD) ==="
[ -n "$LATEST_N" ] && grep -v "172.20.0.99" "$LATEST_N" | grep "online_phase" | head -10 | cut -c1-300
