#!/bin/bash
# Quick diagnostic for localnet status
echo "=== Docker Containers ==="
docker ps -a --format 'table {{.Names}}\t{{.Status}}' 2>/dev/null

echo ""
echo "=== Health Checks ==="
for port in 9091 9092 9093 9094; do
    RESP=$(curl -s http://localhost:$port/health 2>/dev/null)
    echo "  Port $port: ${RESP:-no-response}"
done

echo ""
echo "=== Validator ==="
curl -s http://localhost:8899 -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | head -1
echo ""

echo ""
echo "=== TD Logs ==="
for dir in /tmp/poker-minimal-test/artifacts/trusted_dealer_logs /tmp/poker-arc-workspace/artifacts/trusted_dealer_logs; do
    if [ -d "$dir" ]; then
        echo "  Dir: $dir"
        TD_LOG=$(ls -t "$dir"/*.log 2>/dev/null | head -1)
        if [ -n "$TD_LOG" ]; then
            echo "  File: $TD_LOG ($(wc -c < "$TD_LOG") bytes)"
            CONN=$(grep -c "Connections established with all" "$TD_LOG" 2>/dev/null || echo 0)
            REG=$(grep -c "Registration" "$TD_LOG" 2>/dev/null || echo 0)
            echo "  connections_established=$CONN registrations=$REG"
            echo "  Last 5 INFO lines:"
            grep "INFO" "$TD_LOG" | tail -5
        fi
    fi
done

echo ""
echo "=== Node Logs ==="
for dir in /tmp/poker-minimal-test/artifacts/arx_node_logs /tmp/poker-arc-workspace/artifacts/arx_node_logs; do
    if [ -d "$dir" ]; then
        echo "  Dir: $dir"
        ls -lt "$dir"/*.log 2>/dev/null | head -5
    fi
done
