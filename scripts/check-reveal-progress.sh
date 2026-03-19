#!/bin/bash
WS="/tmp/poker-arc-workspace"

echo "=== Node 0 log: last 20 non-connection lines ==="
LATEST=$(ls -t "$WS/artifacts/arx_node_logs/"*_0.log 2>/dev/null | head -1)
[ -n "$LATEST" ] && grep -v "connection_handlers\|ConnectionRequest\|network_router" "$LATEST" | tail -20 | cut -c1-250

echo ""
echo "=== Node 0: computation/execution activity ==="
[ -n "$LATEST" ] && grep -i "computation\|cerberus\|circuit\|reveal\|shuffle\|exec\|mempool\|preprocessing" "$LATEST" | tail -15 | cut -c1-250

echo ""
echo "=== TD log: last 10 lines ==="
LATEST_TD=$(ls -t "$WS/artifacts/trusted_dealer_logs/"*.log 2>/dev/null | head -1)
[ -n "$LATEST_TD" ] && tail -10 "$LATEST_TD" | cut -c1-250

echo ""
echo "=== Log file sizes (are they growing?) ==="
ls -la "$WS/artifacts/arx_node_logs/"*_0.log 2>/dev/null | tail -1
[ -n "$LATEST_TD" ] && ls -la "$LATEST_TD"
