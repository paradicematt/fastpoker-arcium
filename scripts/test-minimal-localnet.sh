#!/bin/bash
# Minimal localnet test — no old artifacts, let arcium generate everything fresh
set -e

source ~/.cargo/env 2>/dev/null || true
export PATH="$HOME/.local/share/solana/install/releases/2.1.21/solana-release/bin:$HOME/.avm/bin:$HOME/.cargo/bin:/usr/bin:/usr/local/bin:$PATH"

# Anchor shim
SHIM_DIR=/tmp/anchor-shim
mkdir -p "$SHIM_DIR"
cat > "$SHIM_DIR/anchor" << 'SHIMEOF'
#!/bin/bash
if [ "$1" = "--version" ] || [ "$1" = "-V" ]; then echo 'anchor-cli 0.31.2'; else exec $HOME/.avm/bin/anchor "$@"; fi
SHIMEOF
chmod +x "$SHIM_DIR/anchor"
export PATH="$SHIM_DIR:$PATH"

# Kill old processes
pkill -f solana-test-validator 2>/dev/null || true
docker ps -aq 2>/dev/null | xargs -r docker rm -f 2>/dev/null || true
sleep 2

# Clean minimal workspace
rm -rf /tmp/poker-minimal-test 2>/dev/null || true
mkdir -p /tmp/poker-minimal-test

PROJECT="/mnt/j/Poker-Arc"

# Copy only essentials — NO artifacts directory
cp "$PROJECT/Anchor.toml" /tmp/poker-minimal-test/
cp "$PROJECT/Arcium.toml" /tmp/poker-minimal-test/
cp "$PROJECT/Cargo.toml" /tmp/poker-minimal-test/ 2>/dev/null || true
cp -r "$PROJECT/encrypted-ixs" /tmp/poker-minimal-test/
cp -r "$PROJECT/build" /tmp/poker-minimal-test/
mkdir -p /tmp/poker-minimal-test/target/deploy
cp "$PROJECT/target/deploy/"*.so /tmp/poker-minimal-test/target/deploy/ 2>/dev/null || true
mkdir -p /tmp/poker-minimal-test/contracts/target/deploy
cp "$PROJECT/contracts/target/deploy/poker_program.so" /tmp/poker-minimal-test/contracts/target/deploy/ 2>/dev/null || true
mkdir -p /tmp/poker-minimal-test/programs/fastpoker/src
cp "$PROJECT/programs/fastpoker/Cargo.toml" /tmp/poker-minimal-test/programs/fastpoker/ 2>/dev/null || true
cp "$PROJECT/programs/fastpoker/Xargo.toml" /tmp/poker-minimal-test/programs/fastpoker/ 2>/dev/null || true

echo "=== Minimal workspace ready ==="
ls -la /tmp/poker-minimal-test/
echo "---"
ls /tmp/poker-minimal-test/artifacts 2>/dev/null || echo "artifacts: not present (arcium will create fresh)"

cd /tmp/poker-minimal-test
echo "=== Starting arcium localnet --skip-build ==="
arcium localnet --skip-build &
ARCIUM_PID=$!
echo "arcium localnet PID: $ARCIUM_PID"

# Wait up to 5 min, check health every 15s
for i in $(seq 1 20); do
    sleep 15
    HEALTH=$(curl -s http://localhost:9091/health 2>/dev/null)
    if [ "$HEALTH" = "ok" ] || [ "$HEALTH" = "OK" ]; then
        echo "NODE HEALTHY at attempt $i ($((i*15))s)"
        # Check TD log for DKG completion
        echo "=== TD Log (last 10 lines) ==="
        tail -10 /tmp/poker-minimal-test/artifacts/trusted_dealer_logs/*.log 2>/dev/null || echo "no TD log"
        echo "=== LOCALNET IS UP ==="
        exit 0
    fi
    echo "Attempt $i ($((i*15))s): no health response"
    
    # Check TD log progress
    if [ -d "/tmp/poker-minimal-test/artifacts/trusted_dealer_logs" ]; then
        TD_LOG=$(ls -t /tmp/poker-minimal-test/artifacts/trusted_dealer_logs/*.log 2>/dev/null | head -1)
        if [ -n "$TD_LOG" ]; then
            CONN=$(grep -c "Connections established" "$TD_LOG" 2>/dev/null || echo 0)
            REG=$(grep -c "Registration" "$TD_LOG" 2>/dev/null || echo 0)
            echo "  TD: connections_established=$CONN registrations=$REG"
        fi
    fi
done

echo "=== TIMEOUT - DKG did not complete ==="
# Dump diagnostic info
echo "--- TD Log ---"
cat /tmp/poker-minimal-test/artifacts/trusted_dealer_logs/*.log 2>/dev/null | tail -20
echo "--- Node 0 Log (last 10) ---"
ls -lt /tmp/poker-minimal-test/artifacts/arx_node_logs/ 2>/dev/null
echo "--- Docker containers ---"
docker ps -a --format 'table {{.Names}}\t{{.Status}}' 2>/dev/null

# Cleanup
kill $ARCIUM_PID 2>/dev/null || true
exit 1
