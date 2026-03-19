#!/bin/bash
WS="/tmp/poker-arc-workspace"

echo "=== Node 0 log - first 20 lines ==="
LATEST=$(ls -t "$WS/artifacts/arx_node_logs/"*_0.log 2>/dev/null | head -1)
[ -n "$LATEST" ] && head -20 "$LATEST" | cut -c1-200

echo ""
echo "=== Node 0 log - last 20 lines ==="
[ -n "$LATEST" ] && tail -20 "$LATEST" | cut -c1-200

echo ""
echo "=== TD log - first 20 lines ==="
LATEST_TD=$(ls -t "$WS/artifacts/trusted_dealer_logs/"*.log 2>/dev/null | head -1)
[ -n "$LATEST_TD" ] && head -20 "$LATEST_TD" | cut -c1-200

echo ""
echo "=== TD log - last 20 lines ==="
[ -n "$LATEST_TD" ] && tail -20 "$LATEST_TD" | cut -c1-200

echo ""
echo "=== Grep for DKG/keygen/error/complete ==="
[ -n "$LATEST" ] && grep -i -E "dkg|keygen|error|complete|health|ready|failed|preprocessing" "$LATEST" | tail -10
[ -n "$LATEST_TD" ] && grep -i -E "dkg|keygen|error|complete|health|ready|failed|preprocessing" "$LATEST_TD" | tail -10

echo ""
echo "=== Log file sizes ==="
ls -la "$WS/artifacts/arx_node_logs/"*_0.log "$WS/artifacts/trusted_dealer_logs/"*.log 2>/dev/null | tail -5
