#!/bin/bash
# Re-sync per-node dirs with current workspace keypairs and start all nodes
set -e

WS="/tmp/poker-arc-workspace"
ARX_BIN="/tmp/arx-native/arx/arx"
TD_BIN="/tmp/arx-native/trusted-dealer"
NATIVE="/tmp/arx-native"

# Verify workspace has current keypairs
echo "=== Current workspace keypairs ==="
ls -la "$WS/artifacts/localnet/" 2>/dev/null | head -20
if [ ! -f "$WS/artifacts/localnet/node_0.json" ]; then
    echo "ERROR: No keypairs in workspace!"
    exit 1
fi

echo ""
echo "=== Kill previous native processes ==="
pkill -f "$ARX_BIN" 2>/dev/null || true
pkill -f "$TD_BIN" 2>/dev/null || true
sleep 1

echo ""
echo "=== Verify loopback IPs ==="
for ip in 172.20.0.99 172.20.0.100 172.20.0.101 172.20.0.102 172.20.0.103; do
    sudo ip addr add "$ip/32" dev lo 2>/dev/null || true
done

echo ""
echo "=== Re-create per-node working directories ==="
for i in 0 1 2 3; do
    DIR="$NATIVE/run_node_$i"
    rm -rf "$DIR"
    mkdir -p "$DIR/node-keys" "$DIR/circuits" "$DIR/logs"
    
    # Config in CWD
    cp "$WS/artifacts/node_config_$i.toml" "$DIR/node_config.toml"
    # Patch RPC
    sed -i 's|host.docker.internal|127.0.0.1|g' "$DIR/node_config.toml"
    
    # Key files
    cp "$WS/artifacts/localnet/identity_$i.pem" "$DIR/node-keys/node_identity.pem"
    cp "$WS/artifacts/localnet/node_$i.json" "$DIR/node-keys/node_keypair.json"
    cp "$WS/artifacts/localnet/node_$i.json" "$DIR/node-keys/operator_keypair.json"
    cp "$WS/artifacts/localnet/node_callback_$i.json" "$DIR/node-keys/callback_authority_keypair.json"
    cp "$WS/artifacts/localnet/node_bls_$i.json" "$DIR/node-keys/node_bls_keypair.json"
    cp "$WS/artifacts/localnet/node_x25519_$i.json" "$DIR/node-keys/node_x25519_keypair.json"
    
    # Circuits
    cp -r "$NATIVE/circuits/"* "$DIR/circuits/" 2>/dev/null || true
    
    echo "  Node $i: OK"
done

# TD
TD_DIR="$NATIVE/run_td"
rm -rf "$TD_DIR"
mkdir -p "$TD_DIR/logs"
cp "$WS/artifacts/trusted_dealer_config.toml" "$TD_DIR/trusted_dealer_config.toml"
# CRITICAL: copy TD key files INTO the TD dir and use relative paths
cp "$WS/artifacts/localnet/td_master_seed.json" "$TD_DIR/master_seed.json"
cp "$WS/artifacts/localnet/td_identity.pem" "$TD_DIR/identity.json"
# Patch config
sed -i 's|host.docker.internal|127.0.0.1|g' "$TD_DIR/trusted_dealer_config.toml"
sed -i 's|/usr/trusted-dealer/master_seed.json|master_seed.json|g' "$TD_DIR/trusted_dealer_config.toml"
sed -i 's|/usr/trusted-dealer/identity.json|identity.json|g' "$TD_DIR/trusted_dealer_config.toml"
echo "  TD: OK"
echo "  TD config:"
cat "$TD_DIR/trusted_dealer_config.toml"

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
TD_LOG="$TD_DIR/td.log"
cd "$TD_DIR"
RUST_LOG=info "$TD_BIN" > "$TD_LOG" 2>&1 &
TD_PID=$!
echo "  TD PID=$TD_PID"

sleep 3
echo ""
echo "=== Quick check (3s) ==="
# Alive?
ALIVE=0
for pid in "${PIDS[@]}"; do
    kill -0 "$pid" 2>/dev/null && ALIVE=$((ALIVE + 1))
done
echo "  Nodes alive: $ALIVE/4"
kill -0 $TD_PID 2>/dev/null && echo "  TD alive: YES" || echo "  TD alive: NO"

# UDP ports
echo "  UDP 8001 listeners: $(ss -ulnp 2>/dev/null | grep -c 8001)"

# Node logs
for i in 0 1 2 3; do
    LOG="$NATIVE/run_node_$i/node.log"
    LINES=$(wc -l < "$LOG" 2>/dev/null || echo 0)
    echo "  Node $i: ${LINES} lines"
done
echo "  TD: $(wc -l < "$TD_LOG" 2>/dev/null || echo 0) lines"

if [ $ALIVE -eq 0 ]; then
    echo ""
    echo "=== All nodes dead! Logs: ==="
    for i in 0 1 2 3; do
        echo "--- Node $i ---"
        cat "$NATIVE/run_node_$i/node.log" 2>/dev/null | tail -10
    done
    echo "--- TD ---"
    cat "$TD_LOG" 2>/dev/null | tail -10
    exit 1
fi

echo ""
echo "=== Monitor DKG (5 min) ==="
for t in $(seq 1 60); do
    sleep 5
    ELAPSED=$((t * 5))
    
    ALIVE=0
    for pid in "${PIDS[@]}"; do
        kill -0 "$pid" 2>/dev/null && ALIVE=$((ALIVE + 1))
    done
    
    HEALTH=""
    for ip in 172.20.0.100 172.20.0.101 127.0.0.1; do
        for port in 9091 9092 9093 9094; do
            H=$(curl -s -m 1 "http://$ip:$port/health" 2>/dev/null)
            if [ -n "$H" ]; then HEALTH="$ip:$port=$H"; break 2; fi
        done
    done
    
    N0_LOG="$NATIVE/run_node_0/node.log"
    N0_LINES=$(wc -l < "$N0_LOG" 2>/dev/null || echo 0)
    N0_LAST=$(tail -1 "$N0_LOG" 2>/dev/null | head -c 150)
    TD_CONN=$(grep -c "Connections established" "$TD_LOG" 2>/dev/null || echo 0)
    
    echo "  [${ELAPSED}s] alive=$ALIVE/4 health=${HEALTH:-none} n0=${N0_LINES}L td_conn=$TD_CONN"
    [ "$N0_LINES" -gt 0 ] && echo "    $N0_LAST"
    
    if [ -n "$HEALTH" ] && echo "$HEALTH" | grep -qi "ok"; then
        echo ""
        echo "  *** DKG COMPLETE! Localnet is ready! ***"
        exit 0
    fi
    
    if [ $ALIVE -eq 0 ]; then
        echo "  All nodes died!"
        for i in 0 1 2 3; do
            echo "  --- Node $i (last 5) ---"
            tail -5 "$NATIVE/run_node_$i/node.log" 2>/dev/null
        done
        echo "  --- TD (last 5) ---"
        tail -5 "$TD_LOG" 2>/dev/null
        exit 1
    fi
done

echo ""
echo "=== 5-min timeout ==="
for i in 0 1 2 3; do
    echo "--- Node $i (last 20) ---"
    tail -20 "$NATIVE/run_node_$i/node.log" 2>/dev/null
done
echo "--- TD (last 20) ---"
tail -20 "$TD_LOG" 2>/dev/null
