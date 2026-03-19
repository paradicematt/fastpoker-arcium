#!/bin/bash
WS="/tmp/poker-arc-workspace"
LATEST=$(ls -t "$WS/artifacts/arx_node_logs/"*_0.log 2>/dev/null | head -1)

echo "=== Lines 345-520 of node 0 log (full callback section) ==="
sed -n '345,520p' "$LATEST" | cut -c1-400

echo ""
echo "=== All nodes: grep for 'authority\|Authority\|invalid\|Invalid\|program log\|Program log' ==="
for i in 0 1 2 3; do
    LOG=$(ls -t "$WS/artifacts/arx_node_logs/"*_${i}.log 2>/dev/null | head -1)
    if [ -n "$LOG" ]; then
        hits=$(grep -c "authority\|Authority\|invalid\|Invalid" "$LOG" 2>/dev/null)
        echo "  Node $i: $hits matches"
        grep "authority\|Authority\|invalid\|Invalid" "$LOG" 2>/dev/null | head -5 | cut -c1-300
    fi
done

echo ""
echo "=== Simulation detail (node 0) ==="
grep -A 5 "simulation\|Simulation" "$LATEST" 2>/dev/null | head -20 | cut -c1-300
