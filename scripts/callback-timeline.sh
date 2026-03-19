#!/bin/bash
WS="/tmp/poker-arc-workspace"
LATEST=$(ls -t "$WS/artifacts/arx_node_logs/"*_0.log 2>/dev/null | head -1)

echo "=== Full callback TX attempts (both computations) ==="
grep -n "callback\|Failed\|Attempt\|TOTAL\|sent\|error claim\|Cerberus\|offset 1482\|offset 2492\|versioned" "$LATEST" 2>/dev/null | grep -v "connection_handlers\|Connection" | tail -60 | cut -c1-300

echo ""
echo "=== Check other nodes for callback success ==="
for i in 0 1 2 3; do
    LOG=$(ls -t "$WS/artifacts/arx_node_logs/"*_${i}.log 2>/dev/null | head -1)
    if [ -n "$LOG" ]; then
        SUCCESS=$(grep -c "Versioned callback computation tx for mxe.*sent" "$LOG" 2>/dev/null)
        FAIL=$(grep -c "Failed to send versioned callback" "$LOG" 2>/dev/null)
        echo "  Node $i: success=$SUCCESS fail=$FAIL"
    fi
done

echo ""
echo "=== Node 0: lines around shuffle_and_deal callback (offset 1482022) ==="
grep -n "1482022\|shuffle" "$LATEST" 2>/dev/null | cut -c1-200

echo ""
echo "=== Successful callback sends (any node) ==="
for i in 0 1 2 3; do
    LOG=$(ls -t "$WS/artifacts/arx_node_logs/"*_${i}.log 2>/dev/null | head -1)
    [ -n "$LOG" ] && grep "Versioned callback computation tx.*already sent\|Successfully sent" "$LOG" 2>/dev/null | head -3 | cut -c1-200
done
