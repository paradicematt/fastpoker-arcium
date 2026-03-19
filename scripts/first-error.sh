#!/bin/bash
WS="/tmp/poker-arc-workspace"
LATEST=$(ls -t "$WS/artifacts/arx_node_logs/"*_0.log 2>/dev/null | head -1)

echo "=== First callback attempt for reveal (offset 2492392) ==="
# Get the full line around the first error (line ~467)
grep -n "InstructionError" "$LATEST" 2>/dev/null | head -20

echo ""
echo "=== Full lines around first reveal callback failure ==="
# sed out lines 460-490 to get the full error without truncation
awk 'NR>=460 && NR<=490' "$LATEST" 2>/dev/null

echo ""
echo "=== Check: what error code on first attempt vs retries ==="
grep "InstructionError" "$LATEST" 2>/dev/null | while read -r line; do
    echo "$line" | grep -oP 'InstructionError\(\d+, Custom\(\d+\)\)' 
done | sort | uniq -c
