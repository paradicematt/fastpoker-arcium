#!/bin/bash
WS="/tmp/poker-arc-workspace"

echo "=== Node config 0 (check for patch) ==="
cat "$WS/artifacts/node_config_0.toml" 2>/dev/null || echo "NOT FOUND"

echo ""
echo "=== TD config ==="
cat "$WS/artifacts/trusted_dealer_config.toml" 2>/dev/null | head -5

echo ""
echo "=== Docker containers ==="
docker ps --format "table {{.Names}}\t{{.Status}}" 2>/dev/null

echo ""
echo "=== Latest node 0 log ==="
LATEST=$(ls -t "$WS/artifacts/arx_node_logs/"*_0.log 2>/dev/null | head -1)
if [ -n "$LATEST" ]; then
    echo "File: $LATEST ($(wc -c < "$LATEST") bytes)"
    cat "$LATEST"
else
    echo "No logs yet"
fi

echo ""
echo "=== Latest TD log ==="
LATEST=$(ls -t "$WS/artifacts/trusted_dealer_logs/"*.log 2>/dev/null | head -1)
if [ -n "$LATEST" ]; then
    echo "File: $LATEST ($(wc -c < "$LATEST") bytes)"
    cat "$LATEST"
else
    echo "No TD logs yet"
fi

echo ""
echo "=== Health endpoints ==="
for port in 9091 9092 9093 9094; do
    H=$(curl -s -m 2 "http://localhost:$port/health" 2>/dev/null)
    [ -n "$H" ] && echo "  :$port = $H"
done
echo "(empty = no health response yet)"
