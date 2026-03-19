#!/bin/bash
WS="/tmp/poker-arc-workspace"

echo "=== TD exit code and restart count ==="
docker inspect --format 'Status={{.State.Status}} ExitCode={{.State.ExitCode}} RestartCount={{.RestartCount}}' artifacts-arcium-trusted-dealer-1 2>/dev/null

echo ""
echo "=== TD config file ==="
cat "$WS/artifacts/trusted_dealer_config.toml" 2>/dev/null

echo ""
echo "=== TD log: first 5 lines ==="
LATEST_TD=$(ls -t "$WS/artifacts/trusted_dealer_logs/"*.log 2>/dev/null | head -1)
[ -n "$LATEST_TD" ] && head -5 "$LATEST_TD"

echo ""
echo "=== TD log: ONLY INFO/WARN/ERROR lines ==="
[ -n "$LATEST_TD" ] && grep -E "INFO|WARN|ERROR" "$LATEST_TD" | cut -c1-250

echo ""
echo "=== TD log: lines between 'Fetching' and 'Router dropped' ==="
[ -n "$LATEST_TD" ] && sed -n '/Fetching cluster/,/Router dropped/p' "$LATEST_TD" | grep -v "connection_handlers\|ConnectionRequest" | cut -c1-250

echo ""
echo "=== Node 0 first WARN (was RPC reachable?) ==="
LATEST_N=$(ls -t "$WS/artifacts/arx_node_logs/"*_0.log 2>/dev/null | head -1)
[ -n "$LATEST_N" ] && grep "WARN" "$LATEST_N" | head -3 | cut -c1-250
