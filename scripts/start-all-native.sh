#!/bin/bash
# Start all 4 arx nodes + TD natively and monitor DKG
set -e

WS="/tmp/poker-arc-workspace"
ARX_BIN="/tmp/arx-native/arx/arx"
TD_BIN="/tmp/arx-native/trusted-dealer"
NATIVE="/tmp/arx-native"

echo "=== Kill previous ==="
pkill -f "$ARX_BIN" 2>/dev/null || true
pkill -f "$TD_BIN" 2>/dev/null || true
sleep 1

echo "=== Verify loopback IPs ==="
ip addr show lo | grep "172.20.0" | head -5

echo ""
echo "=== Start all 4 nodes ==="
PIDS=()
for i in 0 1 2 3; do
    DIR="$NATIVE/run_node_$i"
    LOG="$DIR/node.log"
    
    cd "$DIR"
    NODE_IDENTITY_FILE="node-keys/node_identity.pem" \
    NODE_KEYPAIR_FILE="node-keys/node_keypair.json" \
    OPERATOR_KEYPAIR_FILE="node-keys/operator_keypair.json" \
    CALLBACK_AUTHORITY_KEYPAIR_FILE="node-keys/callback_authority_keypair.json" \
    NODE_CONFIG_PATH="node_config.toml" \
    BLS_PRIVATE_KEY_FILE="node-keys/node_bls_keypair.json" \
    X25519_PRIVATE_KEY_FILE="node-keys/node_x25519_keypair.json" \
    ARX_METRICS_HOST="0.0.0.0" \
    RUST_LOG=info \
    "$ARX_BIN" > "$LOG" 2>&1 &
    PIDS+=($!)
    echo "  Node $i PID=${PIDS[-1]}"
done

echo ""
echo "=== Start TD ==="
TD_DIR="$NATIVE/run_td"
TD_LOG="$TD_DIR/td.log"
cd "$TD_DIR"
RUST_LOG=info "$TD_BIN" > "$TD_LOG" 2>&1 &
TD_PID=$!
echo "  TD PID=$TD_PID"

echo ""
echo "=== Monitor DKG (5 min) ==="
for t in $(seq 1 60); do
    sleep 5
    ELAPSED=$((t * 5))
    
    # Count alive nodes
    ALIVE=0
    for pid in "${PIDS[@]}"; do
        kill -0 "$pid" 2>/dev/null && ALIVE=$((ALIVE + 1))
    done
    TD_ALIVE=0
    kill -0 $TD_PID 2>/dev/null && TD_ALIVE=1
    
    # Check health on all IPs
    HEALTH=""
    for ip in 172.20.0.100 172.20.0.101 172.20.0.102 172.20.0.103 127.0.0.1; do
        for port in 9091 9092 9093 9094; do
            H=$(curl -s -m 1 "http://$ip:$port/health" 2>/dev/null)
            if [ -n "$H" ]; then
                HEALTH="$ip:$port=$H"
                break 2
            fi
        done
    done
    
    # Node 0 log
    N0_LOG="$NATIVE/run_node_0/node.log"
    N0_LINES=$(wc -l < "$N0_LOG" 2>/dev/null || echo 0)
    N0_LAST=$(tail -1 "$N0_LOG" 2>/dev/null | head -c 150)
    
    # TD log
    TD_LINES=$(wc -l < "$TD_LOG" 2>/dev/null || echo 0)
    TD_CONN=$(grep -c "Connections established" "$TD_LOG" 2>/dev/null || echo 0)
    
    # UDP ports
    UDP_COUNT=$(ss -ulnp 2>/dev/null | grep -c 8001 || echo 0)
    
    echo "  [${ELAPSED}s] nodes=$ALIVE/4 td=$TD_ALIVE udp=$UDP_COUNT health=${HEALTH:-none}"
    if [ "$N0_LINES" -gt 0 ]; then
        echo "    n0(${N0_LINES}L): $N0_LAST"
    fi
    if [ "$TD_LINES" -gt 0 ] && [ "$TD_CONN" -gt 0 ]; then
        echo "    TD: Connections established!"
    fi
    
    # Success?
    if [ -n "$HEALTH" ] && echo "$HEALTH" | grep -qi "ok"; then
        echo ""
        echo "  *** DKG COMPLETE! ***"
        echo "  Health: $HEALTH"
        echo "  Validator: http://localhost:8899"
        
        # Show all node logs
        for i in 0 1 2 3; do
            echo "  Node $i log (last 5):"
            tail -5 "$NATIVE/run_node_$i/node.log" 2>/dev/null | sed 's/^/    /'
        done
        echo "  TD log (last 5):"
        tail -5 "$TD_LOG" 2>/dev/null | sed 's/^/    /'
        
        echo ""
        echo "  To stop: pkill -f '$ARX_BIN'; pkill -f '$TD_BIN'"
        exit 0
    fi
    
    # All dead?
    if [ $ALIVE -eq 0 ]; then
        echo ""
        echo "  All nodes died!"
        for i in 0 1 2 3; do
            echo "  --- Node $i ---"
            tail -10 "$NATIVE/run_node_$i/node.log" 2>/dev/null
        done
        echo "  --- TD ---"
        tail -10 "$TD_LOG" 2>/dev/null
        exit 1
    fi
done

echo ""
echo "=== Timeout — DKG did not complete ==="
for i in 0 1 2 3; do
    echo "--- Node $i (last 20) ---"
    tail -20 "$NATIVE/run_node_$i/node.log" 2>/dev/null
done
echo "--- TD (last 20) ---"
tail -20 "$TD_LOG" 2>/dev/null

echo ""
echo "=== Check: any QUIC connections? ==="
grep -l "Established\|TimedOut\|connected\|handshake" "$NATIVE"/run_node_*/node.log 2>/dev/null || echo "No connection log entries"
