#!/bin/bash
WS="/tmp/poker-arc-workspace"
LATEST=$(ls -t "$WS/artifacts/arx_node_logs/"*_0.log 2>/dev/null | head -1)

echo "=== Log file size ==="
wc -l "$LATEST" 2>/dev/null

echo ""
echo "=== All computation-related entries ==="
grep -n "computation\|Computation\|callback\|Callback\|TOTAL\|offset\|Failed\|Error\|error" "$LATEST" 2>/dev/null | grep -v "connection_handlers\|ConnectionRequest\|network_router" | cut -c1-300

echo ""
echo "=== How many computations were processed? ==="
grep -c "Processing Cerberus" "$LATEST" 2>/dev/null
grep "Processing Cerberus" "$LATEST" 2>/dev/null | cut -c1-200
