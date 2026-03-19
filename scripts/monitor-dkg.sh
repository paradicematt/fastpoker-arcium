#!/bin/bash
# Monitor DKG progress after config patch
WS="/tmp/poker-arc-workspace"

for round in $(seq 1 20); do
    echo "=== Check $round ($(date +%H:%M:%S)) ==="
    
    # Container status
    echo "Containers:"
    docker ps --filter "name=arx" --filter "name=arcium" --format "  {{.Names}}: {{.Status}}" 2>/dev/null
    
    # Health endpoints
    HEALTHY=0
    for port in 9091 9092 9093 9094; do
        H=$(curl -s -m 1 "http://localhost:$port/health" 2>/dev/null)
        if [ -n "$H" ]; then
            echo "  Health :$port = $H"
            HEALTHY=$((HEALTHY + 1))
        fi
    done
    
    if [ "$HEALTHY" -eq 4 ]; then
        echo ""
        echo "*** ALL 4 NODES HEALTHY — DKG LIKELY COMPLETE! ***"
        break
    fi
    
    # Latest node 0 log (last 3 lines)
    LATEST=$(ls -t "$WS/artifacts/arx_node_logs/"*_0.log 2>/dev/null | head -1)
    if [ -n "$LATEST" ]; then
        echo "Node 0 log ($(wc -c < "$LATEST") bytes):"
        tail -3 "$LATEST" | cut -c1-150
    fi
    
    # Latest TD log (last 2 lines)
    LATEST_TD=$(ls -t "$WS/artifacts/trusted_dealer_logs/"*.log 2>/dev/null | head -1)
    if [ -n "$LATEST_TD" ]; then
        echo "TD log ($(wc -c < "$LATEST_TD") bytes):"
        tail -2 "$LATEST_TD" | cut -c1-150
    fi
    
    echo ""
    sleep 15
done
