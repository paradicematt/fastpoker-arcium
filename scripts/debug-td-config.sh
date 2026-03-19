#!/bin/bash
WS="/tmp/poker-arc-workspace"

echo "=== TD config ==="
cat "$WS/artifacts/trusted_dealer_config.toml"

echo ""
echo "=== TD identity PEM (first 3 lines) ==="
head -3 "$WS/artifacts/localnet/td_identity.pem"

echo ""
echo "=== TD master seed exists? ==="
ls -la "$WS/artifacts/localnet/td_master_seed.json"

echo ""
echo "=== arcium localnet output (last 30 lines) ==="
# The arcium process output goes to the terminal - check if there's a log
ps aux | grep arcium | grep -v grep

echo ""
echo "=== Node 0 log: ALL unique module paths ==="
LATEST_N=$(ls -t "$WS/artifacts/arx_node_logs/"*_0.log 2>/dev/null | head -1)
[ -n "$LATEST_N" ] && grep -oP '\w+::\w+(::\w+)*' "$LATEST_N" | sort -u | head -30

echo ""
echo "=== Node 0: lines NOT about connection/router ==="
[ -n "$LATEST_N" ] && grep -v "connection_handlers\|network_router\|ConnectionRequest\|online_phase_unit" "$LATEST_N" | cut -c1-250

echo ""
echo "=== Health check ==="
for port in 9091 9092 9093 9094; do
    H=$(curl -s -m 1 "http://localhost:$port/health" 2>/dev/null)
    echo "  :$port = ${H:-none}"
done
