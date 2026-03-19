#!/bin/bash
WS="/tmp/poker-arc-workspace"

echo "=== Node 0 log size ==="
LATEST=$(ls -t "$WS/artifacts/arx_node_logs/"*_0.log 2>/dev/null | head -1)
[ -n "$LATEST" ] && wc -c "$LATEST"

echo ""
echo "=== Node 0: last 20 non-connection lines ==="
[ -n "$LATEST" ] && grep -v "connection_handlers\|ConnectionRequest\|network_router" "$LATEST" | tail -20 | cut -c1-250

echo ""
echo "=== Node 0: preprocessing/keygen/online_phase activity ==="
[ -n "$LATEST" ] && grep -i "preprocessing\|keygen\|key_material\|triple\|beaver\|health\|ready\|complete" "$LATEST" | tail -15 | cut -c1-250

echo ""
echo "=== TD log: last 10 lines ==="
LATEST_TD=$(ls -t "$WS/artifacts/trusted_dealer_logs/"*.log 2>/dev/null | head -1)
[ -n "$LATEST_TD" ] && tail -10 "$LATEST_TD" | cut -c1-250

echo ""
echo "=== TD docker logs (last 10) ==="
docker logs --tail 10 artifacts-arcium-trusted-dealer-1 2>&1

echo ""
echo "=== Health ==="
for port in 9091 9092 9093 9094; do
    H=$(curl -s -m 1 "http://localhost:$port/health" 2>/dev/null)
    [ -n "$H" ] && echo "  :$port = $H" || echo "  :$port = none"
done
