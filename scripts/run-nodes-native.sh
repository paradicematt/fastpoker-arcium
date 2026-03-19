#!/bin/bash
# Run arx-nodes natively in WSL2 (no Docker) to bypass Docker QUIC issues
# Step 1: Start validator + genesis with arcium localnet --skip-local-arx-nodes
# Step 2: Extract arx binary from Docker image
# Step 3: Run 4 node instances + TD natively on localhost with different ports
set -e

PROJECT="/mnt/j/Poker-Arc"
WORKSPACE="/tmp/poker-arc-workspace"
NATIVE_DIR="/tmp/arx-native"

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

echo "=== Step 0: Cleanup ==="
pkill -f solana-test-validator 2>/dev/null || true
pkill -f arx 2>/dev/null || true
pkill -f trusted-dealer 2>/dev/null || true
docker ps -aq --filter "name=arx" --filter "name=arcium" --filter "name=recovery" 2>/dev/null | xargs -r docker rm -f 2>/dev/null || true
sleep 1

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
echo "=== Step 1: Extract binaries from Docker images ==="
mkdir -p "$NATIVE_DIR"
# Extract arx binary
docker create --name arx-extract arcium/arx-node:v0.8.5 2>/dev/null
docker cp arx-extract:/usr/arx-node/arx "$NATIVE_DIR/arx" 2>/dev/null || true
docker rm arx-extract 2>/dev/null || true

# Extract trusted-dealer binary
docker create --name td-extract arcium/trusted-dealer:v0.8.5 2>/dev/null
docker cp td-extract:/usr/trusted-dealer/trusted-dealer "$NATIVE_DIR/trusted-dealer" 2>/dev/null || true
docker rm td-extract 2>/dev/null || true

ls -la "$NATIVE_DIR/arx" "$NATIVE_DIR/trusted-dealer" 2>/dev/null
if [ ! -f "$NATIVE_DIR/arx" ]; then
    echo "ERROR: Could not extract arx binary. Trying alternate paths..."
    # Try to find the binary
    docker create --name arx-find arcium/arx-node:v0.8.5 2>/dev/null
    docker export arx-find 2>/dev/null | tar -t 2>/dev/null | grep -E 'arx$|arx-node$' | head -5
    docker rm arx-find 2>/dev/null || true
    exit 1
fi
chmod +x "$NATIVE_DIR/arx" "$NATIVE_DIR/trusted-dealer" 2>/dev/null

echo ""
echo "=== Step 2: Start validator + genesis (--skip-local-arx-nodes) ==="
cd "$WORKSPACE"
arcium localnet --skip-build --skip-local-arx-nodes &
ARCIUM_PID=$!
echo "  PID: $ARCIUM_PID"

# Wait for validator
echo "  Waiting for validator..."
for i in $(seq 1 90); do
    if curl -s http://localhost:8899 -X POST -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q "ok"; then
        echo "  Validator healthy after ${i}s"
        break
    fi
    sleep 1
done

# Wait for genesis accounts (arcium creates them via transactions after validator starts)
echo "  Waiting for genesis accounts (30s)..."
sleep 30

echo ""
echo "=== Step 3: Verify genesis ==="
ls -la "$WORKSPACE/artifacts/localnet/node_0.json" 2>/dev/null && echo "  Node 0 keypair: OK" || echo "  ERROR: no node_0 keypair"
ls -la "$WORKSPACE/artifacts/docker-compose-arx-env.yml" 2>/dev/null && echo "  docker-compose: OK" || echo "  WARNING: no docker-compose"
ls -la "$WORKSPACE/artifacts/node_config_0.toml" 2>/dev/null && echo "  Node 0 config: OK" || echo "  ERROR: no node config"
ls -la "$WORKSPACE/artifacts/trusted_dealer_config.toml" 2>/dev/null && echo "  TD config: OK" || echo "  ERROR: no TD config"

echo ""
echo "=== Step 4: Patch configs for localhost ==="
# The node configs reference Docker IPs (172.20.0.x). We need to change them to localhost
# with different ports since all nodes run on the same host.
# Node ports: 8001, 8002, 8003, 8004
# TD port: 8012
# Metrics ports: 9091, 9092, 9093, 9094

# But we also need to patch the on-chain cluster data... which we can't do easily.
# Instead, let's add local IP aliases so the nodes can use 172.20.0.100-103 natively.

echo "  Adding local IP aliases for 172.20.0.100-103..."
sudo ip addr add 172.20.0.99/32 dev lo 2>/dev/null || echo "  172.20.0.99 already exists"
sudo ip addr add 172.20.0.100/32 dev lo 2>/dev/null || echo "  172.20.0.100 already exists"
sudo ip addr add 172.20.0.101/32 dev lo 2>/dev/null || echo "  172.20.0.101 already exists"
sudo ip addr add 172.20.0.102/32 dev lo 2>/dev/null || echo "  172.20.0.102 already exists"
sudo ip addr add 172.20.0.103/32 dev lo 2>/dev/null || echo "  172.20.0.103 already exists"

# Patch node configs to use localhost RPC
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
    cat "$TD_CFG"
fi

echo ""
echo "=== Step 5: Start nodes natively ==="
mkdir -p "$NATIVE_DIR/logs"

for i in 0 1 2 3; do
    echo "  Starting node $i..."
    export NODE_IDENTITY_FILE="$WORKSPACE/artifacts/localnet/identity_$i.pem"
    export NODE_KEYPAIR_FILE="$WORKSPACE/artifacts/localnet/node_$i.json"
    export OPERATOR_KEYPAIR_FILE="$WORKSPACE/artifacts/localnet/node_$i.json"
    export CALLBACK_AUTHORITY_KEYPAIR_FILE="$WORKSPACE/artifacts/localnet/node_callback_$i.json"
    export NODE_CONFIG_PATH="$WORKSPACE/artifacts/node_config_$i.toml"
    export BLS_PRIVATE_KEY_FILE="$WORKSPACE/artifacts/localnet/node_bls_$i.json"
    export X25519_PRIVATE_KEY_FILE="$WORKSPACE/artifacts/localnet/node_x25519_$i.json"
    export ARX_METRICS_HOST="0.0.0.0"
    
    # Create private-shares and public-inputs dirs
    mkdir -p "$WORKSPACE/artifacts/private_shares_node_$i"
    mkdir -p "$WORKSPACE/artifacts/public_inputs_node_$i"
    
    "$NATIVE_DIR/arx" > "$NATIVE_DIR/logs/node_$i.log" 2>&1 &
    echo "  Node $i PID: $!"
done

echo "  Starting TD..."
"$NATIVE_DIR/trusted-dealer" \
    --config "$WORKSPACE/artifacts/trusted_dealer_config.toml" \
    --identity "$WORKSPACE/artifacts/localnet/td_identity.pem" \
    --master-seed "$WORKSPACE/artifacts/localnet/td_master_seed.json" \
    > "$NATIVE_DIR/logs/td.log" 2>&1 &
TD_PID=$!
echo "  TD PID: $TD_PID"

echo ""
echo "=== Step 6: Monitor DKG ==="
for t in $(seq 1 120); do
    sleep 5
    ELAPSED=$((t * 5))
    
    # Check health
    HEALTH=$(curl -s -m 2 http://localhost:9091/health 2>/dev/null)
    if [ -n "$HEALTH" ]; then
        echo "  [${ELAPSED}s] Health: $HEALTH"
        if echo "$HEALTH" | grep -qi "ok"; then
            echo "  *** DKG COMPLETE! ***"
            break
        fi
    fi
    
    # Check node 0 log
    if [ -f "$NATIVE_DIR/logs/node_0.log" ]; then
        LINES=$(wc -l < "$NATIVE_DIR/logs/node_0.log")
        LAST=$(tail -1 "$NATIVE_DIR/logs/node_0.log" 2>/dev/null | head -c 200)
        echo "  [${ELAPSED}s] node0: ${LINES}L | $LAST"
    fi
    
    # Check TD log
    if [ -f "$NATIVE_DIR/logs/td.log" ]; then
        CONN=$(grep -c "Connections established" "$NATIVE_DIR/logs/td.log" 2>/dev/null || echo 0)
        if [ "$CONN" -gt 0 ]; then
            echo "  [${ELAPSED}s] TD: Connections established!"
        fi
    fi
done

echo ""
echo "=== Done ==="
echo "  arcium PID: $ARCIUM_PID"
echo "  TD PID: $TD_PID"
echo "  Logs: $NATIVE_DIR/logs/"
