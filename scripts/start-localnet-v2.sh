#!/bin/bash
# Simplified localnet start — let arcium handle everything, 
# only connect bridge AFTER DKG completes.
set -e

PROJECT="/mnt/j/Poker-Arc"
WORKSPACE="/tmp/poker-arc-workspace"

# === Environment ===
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
source ~/.cargo/env 2>/dev/null || true

echo "Solana: $(solana --version)"
echo "Arcium: $(arcium --version)"
echo "Docker: $(docker --version)"

# Anchor shim
SHIM_DIR="/tmp/anchor-shim"
mkdir -p "$SHIM_DIR"
cat > "$SHIM_DIR/anchor" << 'SHIMEOF'
#!/bin/bash
REAL_ANCHOR="$HOME/.cargo/bin/anchor"
[ ! -x "$REAL_ANCHOR" ] && REAL_ANCHOR="$HOME/.avm/bin/anchor"
if [ "$1" = "--version" ] || [ "$1" = "-V" ]; then
    echo "anchor-cli 0.31.2"
elif [ "$1" = "localnet" ]; then
    if echo "$@" | grep -q -- '--skip-build'; then
        exec "$REAL_ANCHOR" "$@"
    else
        shift; exec "$REAL_ANCHOR" localnet --skip-build "$@"
    fi
else
    exec "$REAL_ANCHOR" "$@"
fi
SHIMEOF
chmod +x "$SHIM_DIR/anchor"
export PATH="$SHIM_DIR:$PATH"
echo "Anchor shim: $(anchor --version)"

# === Cleanup ===
echo ""
echo "=== Cleanup ==="
pkill -f solana-test-validator 2>/dev/null || true
docker ps -aq --filter "name=arx" --filter "name=arcium" --filter "name=recovery" 2>/dev/null | xargs -r docker rm -f 2>/dev/null || true
sleep 2

# === Workspace ===
echo ""
echo "=== Creating workspace ==="
if [ -d "$WORKSPACE" ]; then
    docker run --rm -v "$WORKSPACE":/ws alpine rm -rf /ws/artifacts /ws/build /ws/encrypted-ixs /ws/programs /ws/contracts /ws/target 2>/dev/null || true
    rm -rf "$WORKSPACE" 2>/dev/null || true
fi
mkdir -p "$WORKSPACE"

cp "$PROJECT/Anchor.toml" "$WORKSPACE/"
cp "$PROJECT/Arcium.toml" "$WORKSPACE/"
cp "$PROJECT/Cargo.toml" "$WORKSPACE/" 2>/dev/null || true
cp "$PROJECT/Cargo.lock" "$WORKSPACE/" 2>/dev/null || true
cp -r "$PROJECT/encrypted-ixs" "$WORKSPACE/"
cp -r "$PROJECT/build" "$WORKSPACE/"
mkdir -p "$WORKSPACE/artifacts/localnet" "$WORKSPACE/artifacts/arx_node_logs" "$WORKSPACE/artifacts/trusted_dealer_logs"
mkdir -p "$WORKSPACE/contracts/target/deploy" "$WORKSPACE/target/deploy"
cp "$PROJECT/contracts/target/deploy/poker_program.so" "$WORKSPACE/contracts/target/deploy/" 2>/dev/null || true
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
echo "Workspace ready."

# === Start Arcium Localnet (foreground — blocks until DKG complete) ===
echo ""
echo "=== Starting arcium localnet (blocks until DKG) ==="
cd "$WORKSPACE"
arcium localnet --skip-build &
ARCIUM_PID=$!

# Wait for DKG to complete (arcium localnet exits when DKG is done)
echo "Waiting for arcium localnet (PID=$ARCIUM_PID)..."
wait $ARCIUM_PID
DKG_EXIT=$?
echo "arcium localnet exited with code: $DKG_EXIT"

if [ $DKG_EXIT -ne 0 ]; then
    echo "ERROR: arcium localnet failed!"
    exit 1
fi

# === NOW connect bridge (after DKG, so nodes are stable) ===
echo ""
echo "=== Connecting containers to bridge ==="
for c in artifacts-arx-node-0-1 artifacts-arx-node-1-1 artifacts-arx-node-2-1 artifacts-arx-node-3-1 artifacts-arcium-trusted-dealer-1; do
    docker network connect bridge "$c" 2>/dev/null && echo "  $c → bridge ✓" || echo "  $c → bridge (skip/already)"
done

# Wait for nodes to stabilize
echo "Waiting 10s for nodes to stabilize..."
sleep 10

# === Verify ===
echo ""
echo "=== Verification ==="
echo "Validator: $(solana cluster-version 2>/dev/null || echo 'NOT RUNNING')"
echo "Containers:"
docker ps --format '  {{.Names}}: {{.Status}}'
echo "Node health:"
for port in 9091 9092 9093 9094; do
    STATUS=$(curl -s http://localhost:$port/health 2>/dev/null || echo "NOT_OK")
    echo "  Port $port: $STATUS"
done

echo ""
echo "=== Localnet ready ==="
