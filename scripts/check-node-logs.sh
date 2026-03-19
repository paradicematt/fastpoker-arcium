#!/bin/bash
LOG=$(ls -t /tmp/poker-arc-workspace/artifacts/arx_node_logs/*_0.log 2>/dev/null | head -1)
if [ -n "$LOG" ]; then
    echo "=== Last 10 lines of node 0 log ==="
    tail -10 "$LOG"
    echo ""
    echo "=== Computation-related lines ==="
    grep -i "comput\|reveal\|success\|error\|fail" "$LOG" | tail -10
else
    echo "No node logs found"
fi
