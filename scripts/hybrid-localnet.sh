#!/bin/bash
# Hybrid approach:
# 1. Run normal arcium localnet --skip-build (generates ALL files + starts Docker)
# 2. Wait for files to be generated (Docker DKG will timeout - that's OK)
# 3. Kill Docker containers
# 4. Start nodes natively with the generated files
set -e

PROJECT="/mnt/j/Poker-Arc"
WORKSPACE="/tmp/poker-arc-workspace"
ARX_BIN="/tmp/arx-native/arx/arx"
TD_BIN="/tmp/arx-native/trusted-dealer"
NATIVE="/tmp/arx-native"

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

echo "=== Phase 1: Normal arcium localnet (generates all files) ==="

# Full cleanup
pkill -f solana-test-validator 2>/dev/null || true
pkill -f "$ARX_BIN" 2>/dev/null || true
pkill -f "$TD_BIN" 2>/dev/null || true
docker ps -aq --filter "name=arx" --filter "name=arcium" --filter "name=recovery" 2>/dev/null | xargs -r docker rm -f 2>/dev/null || true
sleep 2

# Clean workspace
if [ -d "$WORKSPACE" ]; then
    docker run --rm -v "$WORKSPACE":/ws alpine rm -rf /ws/artifacts /ws/build /ws/encrypted-ixs /ws/programs /ws/contracts /ws/target 2>/dev/null || true
    rm -rf "$WORKSPACE" 2>/dev/null || true
fi
mkdir -p "$WORKSPACE"

# Copy workspace files
cp "$PROJECT/Anchor.toml" "$WORKSPACE/"
cp "$PROJECT/Arcium.toml" "$WORKSPACE/"
cp "$PROJECT/Cargo.toml" "$WORKSPACE/" 2>/dev/null || true
cp -r "$PROJECT/encrypted-ixs" "$WORKSPACE/"
cp -r "$PROJECT/build" "$WORKSPACE/"
cp -r "$PROJECT/artifacts" "$WORKSPACE/"
mkdir -p "$WORKSPACE/contracts/target/deploy"
cp "$PROJECT/contracts/target/deploy/poker_program.so" "$WORKSPACE/contracts/target/deploy/" 2>/dev/null || true
mkdir -p "$WORKSPACE/target/deploy"
cp "$PROJECT/target/deploy/"*.so "$WORKSPACE/target/deploy/" 2>/dev/null || true
mkdir -p "$WORKSPACE/programs/fastpoker/src"
cp "$PROJECT/programs/fastpoker/Cargo.toml" "$WORKSPACE/programs/fastpoker/" 2>/dev/null || true
cp "$PROJECT/programs/fastpoker/Xargo.toml" "$WORKSPACE/programs/fastpoker/" 2>/dev/null || true
cp "$PROJECT/programs/fastpoker/src/lib.rs" "$WORKSPACE/programs/fastpoker/src/" 2>/dev/null || true
if [ ! -f "$WORKSPACE/programs/fastpoker/src/lib.rs" ]; then
    echo 'use anchor_lang::prelude::*; declare_id!("BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N");' > "$WORKSPACE/programs/fastpoker/src/lib.rs"
fi
sed -i "s|/mnt/j/Poker-Arc/artifacts/|artifacts/|g" "$WORKSPACE/Anchor.toml"
sed -i "s|/mnt/j/Poker-Arc/||g" "$WORKSPACE/Anchor.toml"

# Override timeout to be SHORT — we just need file generation, not DKG
# Actually keep 600s but we'll manually proceed after files are generated
cd "$WORKSPACE"

echo "  Starting arcium localnet --skip-build..."
arcium localnet --skip-build &
ARCIUM_PID=$!
echo "  PID: $ARCIUM_PID"

# Wait for TD files to be generated
echo "  Waiting for TD keypairs..."
for i in $(seq 1 120); do
    if [ -f "$WORKSPACE/artifacts/localnet/td_identity.pem" ] && \
       [ -f "$WORKSPACE/artifacts/localnet/td_master_seed.json" ]; then
        echo "  TD files generated after ${i}s!"
        break
    fi
    sleep 1
done

if [ ! -f "$WORKSPACE/artifacts/localnet/td_identity.pem" ]; then
    echo "  ERROR: TD files never generated. Checking what we have..."
    ls -la "$WORKSPACE/artifacts/localnet/"
    kill $ARCIUM_PID 2>/dev/null
    exit 1
fi

# Wait a few more seconds for Docker containers to start
echo "  Waiting for Docker containers to start..."
sleep 10

echo ""
echo "=== Phase 2: Kill Docker, keep validator ==="
# Stop Docker containers (DKG is failing anyway)
docker compose -f "$WORKSPACE/artifacts/docker-compose-arx-env.yml" down 2>/dev/null || true
docker ps -aq --filter "name=arx" --filter "name=arcium" --filter "name=recovery" 2>/dev/null | xargs -r docker rm -f 2>/dev/null || true
echo "  Docker containers stopped"

# Verify validator is still running
HEALTH=$(curl -s -m 2 http://localhost:8899 -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null)
echo "  Validator: $HEALTH"

echo ""
echo "=== Phase 3: Setup native execution ==="
# Add loopback IPs
for ip in 172.20.0.99 172.20.0.100 172.20.0.101 172.20.0.102 172.20.0.103; do
    sudo ip addr add "$ip/32" dev lo 2>/dev/null || true
done

# Create per-node working directories
for i in 0 1 2 3; do
    DIR="$NATIVE/run_node_$i"
    rm -rf "$DIR"
    mkdir -p "$DIR/node-keys" "$DIR/circuits" "$DIR/logs"
    cp "$WORKSPACE/artifacts/node_config_$i.toml" "$DIR/node_config.toml"
    sed -i 's|host.docker.internal|127.0.0.1|g' "$DIR/node_config.toml"
    cp "$WORKSPACE/artifacts/localnet/identity_$i.pem" "$DIR/node-keys/node_identity.pem"
    cp "$WORKSPACE/artifacts/localnet/node_$i.json" "$DIR/node-keys/node_keypair.json"
    cp "$WORKSPACE/artifacts/localnet/node_$i.json" "$DIR/node-keys/operator_keypair.json"
    cp "$WORKSPACE/artifacts/localnet/node_callback_$i.json" "$DIR/node-keys/callback_authority_keypair.json"
    cp "$WORKSPACE/artifacts/localnet/node_bls_$i.json" "$DIR/node-keys/node_bls_keypair.json"
    cp "$WORKSPACE/artifacts/localnet/node_x25519_$i.json" "$DIR/node-keys/node_x25519_keypair.json"
    cp -r "$NATIVE/circuits/"* "$DIR/circuits/" 2>/dev/null || true
done
echo "  Node dirs ready"

# TD working directory
TD_DIR="$NATIVE/run_td"
rm -rf "$TD_DIR"
mkdir -p "$TD_DIR/logs"
cp "$WORKSPACE/artifacts/trusted_dealer_config.toml" "$TD_DIR/trusted_dealer_config.toml"
cp "$WORKSPACE/artifacts/localnet/td_master_seed.json" "$TD_DIR/master_seed.json"
cp "$WORKSPACE/artifacts/localnet/td_identity.pem" "$TD_DIR/identity.json"
sed -i 's|host.docker.internal|127.0.0.1|g' "$TD_DIR/trusted_dealer_config.toml"
sed -i "s|/usr/trusted-dealer/master_seed.json|$TD_DIR/master_seed.json|g" "$TD_DIR/trusted_dealer_config.toml"
sed -i "s|/usr/trusted-dealer/identity.json|$TD_DIR/identity.json|g" "$TD_DIR/trusted_dealer_config.toml"
echo "  TD dir ready"
echo "  TD config:"
cat "$TD_DIR/trusted_dealer_config.toml"

echo ""
echo "=== Phase 4: Start native nodes ==="
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

TD_LOG="$TD_DIR/td.log"
cd "$TD_DIR"
RUST_LOG=info "$TD_BIN" > "$TD_LOG" 2>&1 &
TD_PID=$!
echo "  TD PID=$TD_PID"

sleep 5

echo ""
echo "=== Quick check ==="
ALIVE=0
for pid in "${PIDS[@]}"; do
    kill -0 "$pid" 2>/dev/null && ALIVE=$((ALIVE + 1))
done
TD_ALIVE=0
kill -0 $TD_PID 2>/dev/null && TD_ALIVE=1
echo "  Nodes alive: $ALIVE/4, TD alive: $TD_ALIVE"
echo "  UDP 8001: $(ss -ulnp 2>/dev/null | grep -c 8001)"

for i in 0 1 2 3; do
    LOG="$NATIVE/run_node_$i/node.log"
    LINES=$(wc -l < "$LOG" 2>/dev/null || echo 0)
    LAST=$(tail -1 "$LOG" 2>/dev/null | head -c 120)
    echo "  Node $i: ${LINES}L | $LAST"
done
echo "  TD: $(wc -l < "$TD_LOG" 2>/dev/null || echo 0)L | $(tail -1 "$TD_LOG" 2>/dev/null | head -c 120)"

if [ $ALIVE -eq 0 ]; then
    echo ""
    echo "=== All nodes dead ==="
    for i in 0 1 2 3; do
        echo "--- Node $i ---"
        cat "$NATIVE/run_node_$i/node.log" 2>/dev/null
    done
    echo "--- TD ---"
    cat "$TD_LOG" 2>/dev/null
    exit 1
fi

echo ""
echo "=== Phase 5: Monitor DKG (10 min) ==="
for t in $(seq 1 120); do
    sleep 5
    ELAPSED=$((t * 5))
    
    ALIVE=0
    for pid in "${PIDS[@]}"; do
        kill -0 "$pid" 2>/dev/null && ALIVE=$((ALIVE + 1))
    done
    
    HEALTH=""
    for ip in 172.20.0.100 127.0.0.1; do
        for port in 9091 9092 9093 9094; do
            H=$(curl -s -m 1 "http://$ip:$port/health" 2>/dev/null)
            if [ -n "$H" ]; then HEALTH="$ip:$port=$H"; break 2; fi
        done
    done
    
    N0_LINES=$(wc -l < "$NATIVE/run_node_0/node.log" 2>/dev/null || echo 0)
    N0_LAST=$(tail -1 "$NATIVE/run_node_0/node.log" 2>/dev/null | head -c 120)
    TD_CONN=$(grep -c "established" "$TD_LOG" 2>/dev/null || echo 0)
    
    echo "  [${ELAPSED}s] alive=$ALIVE/4 health=${HEALTH:-none} n0=${N0_LINES}L td_conn=$TD_CONN"
    [ "$N0_LINES" -gt 0 ] && echo "    $N0_LAST"
    
    if [ -n "$HEALTH" ] && echo "$HEALTH" | grep -qi "ok"; then
        echo ""
        echo "  *** DKG COMPLETE! Localnet ready! ***"
        echo "  Validator: http://localhost:8899"
        echo "  arcium PID: $ARCIUM_PID (keep running)"
        echo "  To stop: pkill -f arx; pkill -f trusted-dealer"
        exit 0
    fi
    
    if [ $ALIVE -eq 0 ]; then
        echo "  All nodes died!"
        for i in 0 1 2 3; do
            tail -5 "$NATIVE/run_node_$i/node.log" 2>/dev/null
        done
        exit 1
    fi
done

echo ""
echo "=== 10-min timeout ==="
for i in 0 1 2 3; do
    echo "--- Node $i (last 20) ---"
    tail -20 "$NATIVE/run_node_$i/node.log" 2>/dev/null
done
echo "--- TD (last 20) ---"
tail -20 "$TD_LOG" 2>/dev/null
