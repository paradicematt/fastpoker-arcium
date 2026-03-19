#!/bin/bash
for i in $(seq 1 10); do
    echo "=== Check $i ($(date +%H:%M:%S)) ==="
    for port in 9091 9092 9093 9094; do
        H=$(curl -s -m 1 "http://localhost:$port/health" 2>/dev/null)
        [ -n "$H" ] && echo "  :$port = $H"
    done
    
    # TD status
    TD_STATUS=$(docker inspect --format '{{.State.Status}}' artifacts-arcium-trusted-dealer-1 2>/dev/null)
    TD_RESTARTS=$(docker inspect --format '{{.RestartCount}}' artifacts-arcium-trusted-dealer-1 2>/dev/null)
    echo "  TD: $TD_STATUS (restarts: $TD_RESTARTS)"
    
    # Any health response?
    ANY=$(curl -s -m 1 "http://localhost:9091/health" 2>/dev/null)
    if [ -n "$ANY" ]; then
        echo "  HEALTH ENDPOINT RESPONDING! DKG might be complete!"
        break
    fi
    
    sleep 15
done

echo ""
echo "=== Final node 0 log tail ==="
LATEST=$(ls -t /tmp/poker-arc-workspace/artifacts/arx_node_logs/*_0.log 2>/dev/null | head -1)
[ -n "$LATEST" ] && grep -v "connection_handlers\|ConnectionRequest\|network_router" "$LATEST" | tail -10 | cut -c1-250
