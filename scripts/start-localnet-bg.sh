#!/bin/bash
# Start arcium localnet as a persistent background process
source "$HOME/.cargo/env"
export PATH="/tmp/anchor-shim:$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$HOME/.arcium/bin:$PATH"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

# Start Docker if needed
if ! pgrep -x dockerd > /dev/null; then
    nohup dockerd > /tmp/dockerd.log 2>&1 &
    sleep 3
fi

# Setup anchor shim
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

# Cleanup old state
pkill -f solana-test-validator 2>/dev/null || true
docker ps -aq --filter "name=arx" --filter "name=arcium" --filter "name=recovery" 2>/dev/null | xargs -r docker rm -f 2>/dev/null || true
sleep 2

# Prepare workspace
WORKSPACE="/tmp/poker-arc-workspace"
PROJECT="/mnt/j/Poker-Arc"
rm -rf "$WORKSPACE" 2>/dev/null || true
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
fi
sed -i "s|/mnt/j/Poker-Arc/artifacts/|artifacts/|g" "$WORKSPACE/Anchor.toml"
sed -i "s|/mnt/j/Poker-Arc/||g" "$WORKSPACE/Anchor.toml"

echo "Arcium: $(arcium --version)"
echo "Starting localnet..."

cd "$WORKSPACE"
arcium localnet --skip-build &
ARCIUM_PID=$!
echo "Arcium PID: $ARCIUM_PID"

# Wait for containers
echo "Waiting for containers..."
for i in $(seq 1 180); do
    RUNNING=$(docker ps --filter "name=arx-node" --format "{{.Names}}" 2>/dev/null | wc -l)
    if [ "$RUNNING" -ge 4 ]; then
        echo "All 4 node containers UP"
        break
    fi
    sleep 1
done

# Connect bridge
for c in $(docker ps --format "{{.Names}}" 2>/dev/null); do
    docker network connect bridge "$c" 2>/dev/null || true
done
echo "Bridge connected"

# Wait for health
for i in $(seq 1 120); do
    H=$(curl -s http://localhost:9091/health 2>/dev/null)
    if [ "$H" = "OK" ]; then
        echo "Node health: OK after ${i}s"
        break
    fi
    sleep 2
done

# Copy keypair
cp ~/.config/solana/id.json "$PROJECT/backend/.localnet-keypair.json"
echo "Keypair copied"

echo "Localnet ready. Keeping alive..."
# Keep the script alive so arcium stays running
wait $ARCIUM_PID
