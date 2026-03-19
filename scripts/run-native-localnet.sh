#!/bin/bash
# Run Arcium localnet with native arx-nodes (no Docker networking)
# This bypasses the QUIC-over-Docker-bridge issue in WSL2
set -e

PROJECT="/mnt/j/Poker-Arc"
WORKSPACE="/tmp/poker-arc-workspace"
ARX_BIN="/tmp/arx-native/arx/arx"
TD_BIN="/tmp/arx-native/trusted-dealer"

SOLANA_DIR="$HOME/.local/share/solana/install/releases/2.1.21/solana-release/bin"
AVM_DIR="$HOME/.avm/bin"
CARGO_DIR="$HOME/.cargo/bin"
export PATH="$SOLANA_DIR:$AVM_DIR:$CARGO_DIR:/usr/bin:/usr/local/bin:$PATH"
source ~/.cargo/env 2>/dev/null || true

# Anchor shim
SHIM_DIR="/tmp/anchor-shim"
mkdir -p "$SHIM_DIR"
cat > "$SHIM_DIR/anchor" << 'SHIMEOF'
#!/bin/bash
if [ "$1" = "--version" ] || [ "$1" = "-V" ]; then
    echo "anchor-cli 0.31.2"
else
    exec "$HOME/.avm/bin/anchor" "$@"
fi
SHIMEOF
chmod +x "$SHIM_DIR/anchor"
export PATH="$SHIM_DIR:$PATH"

cleanup() {
    echo ""
    echo "=== Cleanup ==="
    pkill -f "$ARX_BIN" 2>/dev/null || true
    pkill -f "$TD_BIN" 2>/dev/null || true
    # Don't kill validator — leave it for testing
}
trap cleanup EXIT

echo "=== Step 0: Kill previous processes ==="
pkill -f solana-test-validator 2>/dev/null || true
pkill -f "$ARX_BIN" 2>/dev/null || true
pkill -f "$TD_BIN" 2>/dev/null || true
docker ps -aq --filter "name=arx" --filter "name=arcium" --filter "name=recovery" 2>/dev/null | xargs -r docker rm -f 2>/dev/null || true
sleep 1

echo ""
echo "=== Step 1: Prepare workspace ==="
if [ -d "$WORKSPACE" ]; then
    docker run --rm -v "$WORKSPACE":/ws alpine rm -rf /ws/artifacts /ws/build /ws/encrypted-ixs /ws/programs /ws/contracts /ws/target 2>/dev/null || true
    rm -rf "$WORKSPACE" 2>/dev/null || true
fi
mkdir -p "$WORKSPACE"

cp "$PROJECT/Anchor.toml" "$WORKSPACE/"
cp "$PROJECT/Arcium.toml" "$WORKSPACE/"
cp "$PROJECT/Cargo.toml" "$WORKSPACE/" 2>/dev/null || true
cp -r "$PROJECT/encrypted-ixs" "$WORKSPACE/"
cp -r "$PROJECT/build" "$WORKSPACE/"
cp -r "$PROJECT/artifacts" "$WORKSPACE/"

# Clean stale keypairs
rm -f "$WORKSPACE/artifacts/localnet/node_"*.json 2>/dev/null || true
rm -f "$WORKSPACE/artifacts/localnet/node_callback_"*.json 2>/dev/null || true
rm -f "$WORKSPACE/artifacts/localnet/node_bls_"*.json 2>/dev/null || true
rm -f "$WORKSPACE/artifacts/localnet/node_x25519_"*.json 2>/dev/null || true
rm -f "$WORKSPACE/artifacts/localnet/identity_"*.pem 2>/dev/null || true
rm -f "$WORKSPACE/artifacts/localnet/td_"*.pem 2>/dev/null || true
rm -f "$WORKSPACE/artifacts/localnet/td_"*.json 2>/dev/null || true
rm -f "$WORKSPACE/artifacts/trusted_dealer_logs/"*.log 2>/dev/null || true
rm -f "$WORKSPACE/artifacts/arx_node_logs/"*.log 2>/dev/null || true

mkdir -p "$WORKSPACE/contracts/target/deploy"
cp "$PROJECT/contracts/target/deploy/poker_program.so" "$WORKSPACE/contracts/target/deploy/" 2>/dev/null || true
mkdir -p "$WORKSPACE/target/deploy"
cp "$PROJECT/target/deploy/"*.so "$WORKSPACE/target/deploy/" 2>/dev/null || true

# CRITICAL: lib.rs must exist
mkdir -p "$WORKSPACE/programs/fastpoker/src"
cp "$PROJECT/programs/fastpoker/Cargo.toml" "$WORKSPACE/programs/fastpoker/" 2>/dev/null || true
cp "$PROJECT/programs/fastpoker/Xargo.toml" "$WORKSPACE/programs/fastpoker/" 2>/dev/null || true
cp "$PROJECT/programs/fastpoker/src/lib.rs" "$WORKSPACE/programs/fastpoker/src/" 2>/dev/null || true
if [ ! -f "$WORKSPACE/programs/fastpoker/src/lib.rs" ]; then
    echo 'use anchor_lang::prelude::*; declare_id!("BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N");' > "$WORKSPACE/programs/fastpoker/src/lib.rs"
fi

sed -i "s|/mnt/j/Poker-Arc/artifacts/|artifacts/|g" "$WORKSPACE/Anchor.toml"
sed -i "s|/mnt/j/Poker-Arc/||g" "$WORKSPACE/Anchor.toml"
echo "  Workspace ready"

echo ""
echo "=== Step 2: Start validator + genesis (skip arx nodes) ==="
cd "$WORKSPACE"
arcium localnet --skip-build --skip-local-arx-nodes &
ARCIUM_PID=$!
echo "  arcium localnet PID: $ARCIUM_PID"

# Wait for validator
echo "  Waiting for validator..."
for i in $(seq 1 120); do
    if curl -s http://localhost:8899 -X POST -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q "ok"; then
        echo "  Validator healthy after ${i}s"
        break
    fi
    sleep 1
done

# Wait for genesis TXs to be confirmed
echo "  Waiting 30s for genesis transactions..."
sleep 30

echo ""
echo "=== Step 3: Verify genesis ==="
for f in node_0.json node_config_0.toml trusted_dealer_config.toml; do
    if [ -f "$WORKSPACE/artifacts/localnet/$f" ] || [ -f "$WORKSPACE/artifacts/$f" ]; then
        echo "  $f: OK"
    else
        echo "  $f: MISSING"
    fi
done

echo ""
echo "=== Step 4: Add loopback IP aliases ==="
# On-chain cluster has IPs 172.20.0.100-103 and TD at 172.20.0.99.
# Add these as loopback aliases so native processes can bind/connect to them.
for ip in 172.20.0.99 172.20.0.100 172.20.0.101 172.20.0.102 172.20.0.103; do
    sudo ip addr add "$ip/32" dev lo 2>/dev/null && echo "  Added $ip" || echo "  $ip exists"
done

echo ""
echo "=== Step 5: Patch configs for native execution ==="
# Change host.docker.internal → 127.0.0.1 in node configs
for i in 0 1 2 3; do
    CFG="$WORKSPACE/artifacts/node_config_$i.toml"
    if [ -f "$CFG" ]; then
        sed -i 's|host.docker.internal|127.0.0.1|g' "$CFG"
        echo "  Patched node_config_$i.toml"
    fi
done

# Patch TD config
TD_CFG="$WORKSPACE/artifacts/trusted_dealer_config.toml"
if [ -f "$TD_CFG" ]; then
    sed -i 's|host.docker.internal|127.0.0.1|g' "$TD_CFG"
    echo "  Patched TD config"
    echo "  TD config contents:"
    cat "$TD_CFG"
fi

echo ""
echo "=== Step 6: Create runtime directories ==="
mkdir -p "$WORKSPACE/artifacts/arx_node_logs"
mkdir -p "$WORKSPACE/artifacts/trusted_dealer_logs"
for i in 0 1 2 3; do
    mkdir -p "$WORKSPACE/artifacts/private_shares_node_$i"
    mkdir -p "$WORKSPACE/artifacts/public_inputs_node_$i"
done

echo ""
echo "=== Step 7: Start nodes natively ==="
PIDS=()

for i in 0 1 2 3; do
    echo "  Starting node $i..."
    NODE_IDENTITY_FILE="$WORKSPACE/artifacts/localnet/identity_$i.pem" \
    NODE_KEYPAIR_FILE="$WORKSPACE/artifacts/localnet/node_$i.json" \
    OPERATOR_KEYPAIR_FILE="$WORKSPACE/artifacts/localnet/node_$i.json" \
    CALLBACK_AUTHORITY_KEYPAIR_FILE="$WORKSPACE/artifacts/localnet/node_callback_$i.json" \
    NODE_CONFIG_PATH="$WORKSPACE/artifacts/node_config_$i.toml" \
    BLS_PRIVATE_KEY_FILE="$WORKSPACE/artifacts/localnet/node_bls_$i.json" \
    X25519_PRIVATE_KEY_FILE="$WORKSPACE/artifacts/localnet/node_x25519_$i.json" \
    ARX_METRICS_HOST="0.0.0.0" \
    "$ARX_BIN" > "$WORKSPACE/artifacts/arx_node_logs/native_node_$i.log" 2>&1 &
    PIDS+=($!)
    echo "  Node $i PID: ${PIDS[-1]}"
done

echo "  Starting TD..."
"$TD_BIN" > "$WORKSPACE/artifacts/trusted_dealer_logs/native_td.log" 2>&1 &
TD_PID=$!
echo "  TD PID: $TD_PID"

echo ""
echo "=== Step 8: Monitor DKG (5 min) ==="
for t in $(seq 1 60); do
    sleep 5
    ELAPSED=$((t * 5))
    
    # Check if processes are still alive
    ALIVE=0
    for pid in "${PIDS[@]}"; do
        kill -0 "$pid" 2>/dev/null && ALIVE=$((ALIVE + 1))
    done
    
    # Check health endpoints
    HEALTH=""
    for port in 9091 9092 9093 9094; do
        H=$(curl -s -m 1 "http://localhost:$port/health" 2>/dev/null)
        if [ -n "$H" ]; then
            HEALTH="$port=$H"
            break
        fi
    done
    # Also check on the actual IPs
    for ip in 172.20.0.100 172.20.0.101; do
        H=$(curl -s -m 1 "http://$ip:9091/health" 2>/dev/null)
        if [ -n "$H" ]; then
            HEALTH="$ip:9091=$H"
            break
        fi
    done
    
    # Node 0 log status
    N0_LOG="$WORKSPACE/artifacts/arx_node_logs/native_node_0.log"
    N0_LINES=$(wc -l < "$N0_LOG" 2>/dev/null || echo 0)
    N0_LAST=$(tail -1 "$N0_LOG" 2>/dev/null | head -c 120)
    
    # TD log status
    TD_LOG="$WORKSPACE/artifacts/trusted_dealer_logs/native_td.log"
    TD_LINES=$(wc -l < "$TD_LOG" 2>/dev/null || echo 0)
    TD_CONN=$(grep -c "Connections established" "$TD_LOG" 2>/dev/null || echo 0)
    
    echo "  [${ELAPSED}s] nodes=$ALIVE/4 health=${HEALTH:-none} n0=${N0_LINES}L td=${TD_LINES}L td_conn=$TD_CONN"
    echo "    n0: $N0_LAST"
    
    if [ -n "$HEALTH" ] && echo "$HEALTH" | grep -qi "ok"; then
        echo ""
        echo "  *** DKG COMPLETE! Nodes are healthy! ***"
        echo ""
        echo "  Validator: http://localhost:8899"
        echo "  Health: $HEALTH"
        echo "  arcium PID: $ARCIUM_PID"
        # Don't exit — keep running for testing
        echo "  Press Ctrl+C to stop."
        wait
        exit 0
    fi
    
    # If all nodes died, show errors and exit
    if [ $ALIVE -eq 0 ]; then
        echo ""
        echo "  All nodes died! Checking logs..."
        for i in 0 1 2 3; do
            echo "  --- Node $i (last 5 lines) ---"
            tail -5 "$WORKSPACE/artifacts/arx_node_logs/native_node_$i.log" 2>/dev/null
        done
        echo "  --- TD (last 5 lines) ---"
        tail -5 "$TD_LOG" 2>/dev/null
        break
    fi
done

echo ""
echo "=== Final status ==="
echo "  Node logs:"
for i in 0 1 2 3; do
    echo "    node $i: $(wc -l < "$WORKSPACE/artifacts/arx_node_logs/native_node_$i.log" 2>/dev/null || echo 0) lines"
done
echo "  TD log: $(wc -l < "$WORKSPACE/artifacts/trusted_dealer_logs/native_td.log" 2>/dev/null || echo 0) lines"
echo ""
echo "  Node 0 last 10 lines:"
tail -10 "$WORKSPACE/artifacts/arx_node_logs/native_node_0.log" 2>/dev/null
echo ""
echo "  TD last 10 lines:"
tail -10 "$WORKSPACE/artifacts/trusted_dealer_logs/native_td.log" 2>/dev/null
