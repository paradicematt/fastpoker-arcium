#!/bin/bash
WS="/tmp/poker-arc-workspace"

echo "=== Latest Node 0 log ==="
ls -t "$WS/artifacts/arx_node_logs/"*_0.log 2>/dev/null | head -1 | xargs cat

echo ""
echo "=== Latest Node 1 log ==="
ls -t "$WS/artifacts/arx_node_logs/"*_1.log 2>/dev/null | head -1 | xargs cat

echo ""
echo "=== Latest TD log ==="
ls -t "$WS/artifacts/trusted_dealer_logs/"*.log 2>/dev/null | head -1 | xargs cat

echo ""
echo "=== Node config 0 ==="
cat "$WS/artifacts/node_config_0.toml"

echo ""
echo "=== TD config ==="
cat "$WS/artifacts/trusted_dealer_config.toml"
