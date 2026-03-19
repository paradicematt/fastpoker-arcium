#!/bin/bash
set -e
source "$HOME/.cargo/env"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$HOME/.arcium/bin:$PATH"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

# Anchor shim (reports 0.31.2 for arcium compat)
SHIM_DIR="/tmp/anchor-shim"
mkdir -p "$SHIM_DIR"
cat > "$SHIM_DIR/anchor" << 'SHIMEOF'
#!/bin/bash
REAL_ANCHOR="$HOME/.avm/bin/anchor"
[ ! -x "$REAL_ANCHOR" ] && REAL_ANCHOR="$HOME/.cargo/bin/anchor"
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

echo "=== Versions ==="
echo "Arcium: $(arcium --version)"
echo "Solana: $(solana --version)"
echo "Anchor shim: $(anchor --version)"
echo "Docker: $(docker --version)"

# Start Docker if needed
if ! pgrep -x dockerd > /dev/null; then
    dockerd > /tmp/dockerd.log 2>&1 &
    sleep 3
fi

# Cleanup
echo ""
echo "=== Cleanup ==="
pkill -f solana-test-validator 2>/dev/null || true
docker ps -aq --filter "name=arx" --filter "name=arcium" --filter "name=recovery" 2>/dev/null | xargs -r docker rm -f 2>/dev/null || true
sleep 2

# Workspace
echo ""
echo "=== Creating workspace ==="
WORKSPACE="/tmp/poker-arc-workspace"
PROJECT="/mnt/j/Poker-Arc"
if [ -d "$WORKSPACE" ]; then
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
if [ -f "$PROJECT/programs/fastpoker/src/lib.rs" ]; then
    cp "$PROJECT/programs/fastpoker/src/lib.rs" "$WORKSPACE/programs/fastpoker/src/"
else
    echo 'use anchor_lang::prelude::*; declare_id!("BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N");' > "$WORKSPACE/programs/fastpoker/src/lib.rs"
fi
sed -i "s|/mnt/j/Poker-Arc/artifacts/|artifacts/|g" "$WORKSPACE/Anchor.toml"
sed -i "s|/mnt/j/Poker-Arc/||g" "$WORKSPACE/Anchor.toml"
echo "Workspace ready."

# Start localnet
echo ""
echo "=== Starting Arcium 0.9.2 Localnet ==="
cd "$WORKSPACE"
arcium localnet --skip-build &
ARCIUM_PID=$!

# Wait for containers
echo "Waiting for Docker containers..."
for i in $(seq 1 180); do
    RUNNING=$(docker ps --filter "name=arx-node" --format "{{.Names}}" 2>/dev/null | wc -l)
    if [ "$RUNNING" -ge 4 ]; then
        echo "  All 4 node containers detected"
        break
    fi
    sleep 1
done

# Wait for TD
for i in $(seq 1 30); do
    TD_UP=$(docker ps --filter "name=trusted-dealer" --format "{{.Names}}" 2>/dev/null | wc -l)
    if [ "$TD_UP" -ge 1 ]; then
        echo "  Trusted dealer detected"
        break
    fi
    sleep 1
done

# Connect bridge
echo ""
echo "=== Connecting bridge ==="
for c in $(docker ps --format "{{.Names}}" 2>/dev/null); do
    docker network connect bridge "$c" 2>/dev/null && echo "  $c → bridge ✓" || echo "  $c → bridge (skip)"
done

# Wait for DKG
echo ""
echo "=== Waiting for DKG (node health) ==="
for i in $(seq 1 120); do
    HEALTH=$(curl -s http://localhost:9091/health 2>/dev/null || echo "not ready")
    if [ "$HEALTH" = "OK" ]; then
        echo "  Node health: OK (DKG complete after ${i}s)"
        break
    fi
    sleep 2
done

# Copy keypair
cp ~/.config/solana/id.json "$PROJECT/backend/.localnet-keypair.json"
echo "  Keypair copied"

echo ""
echo "=== Localnet ready ==="
docker ps --format '  {{.Names}}: {{.Status}}'
