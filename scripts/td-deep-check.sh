#!/bin/bash
WS="/tmp/poker-arc-workspace"

echo "=== TD container status ==="
docker ps -a --filter "name=trusted-dealer" --format "{{.Names}}\t{{.Status}}\t{{.Ports}}"

echo ""
echo "=== Latest TD log (FULL) ==="
LATEST_TD=$(ls -t "$WS/artifacts/trusted_dealer_logs/"*.log 2>/dev/null | head -1)
[ -n "$LATEST_TD" ] && cat "$LATEST_TD" | cut -c1-300

echo ""
echo "=== TD config ==="
cat "$WS/artifacts/trusted_dealer_config.toml" 2>/dev/null

echo ""
echo "=== All TD log files (count and sizes) ==="
ls -la "$WS/artifacts/trusted_dealer_logs/" 2>/dev/null

echo ""
echo "=== Node 0 log - first 30 lines ==="
LATEST_N=$(ls -t "$WS/artifacts/arx_node_logs/"*_0.log 2>/dev/null | head -1)
[ -n "$LATEST_N" ] && head -30 "$LATEST_N" | cut -c1-300

echo ""
echo "=== Node 0 - DKG-related lines ==="
[ -n "$LATEST_N" ] && grep -i -E "dkg|keygen|preprocessing|dealing|key_share|secret|phase" "$LATEST_N" | tail -20

echo ""
echo "=== Node 0 - error/warn lines ==="
[ -n "$LATEST_N" ] && grep -E "ERROR|WARN" "$LATEST_N" | tail -10 | cut -c1-300
