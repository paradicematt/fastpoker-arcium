#!/bin/bash
# Test a single native arx node with the currently running validator
set -e

WS="/tmp/poker-arc-workspace"
ARX_BIN="/tmp/arx-native/arx/arx"
DIR="/tmp/arx-native/run_node_0"

# Verify validator
echo "=== Validator ==="
curl -s -m 2 http://localhost:8899 -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null
echo ""

# Verify workspace files exist
echo ""
echo "=== Workspace files ==="
echo "node_0.json: $(ls -la $WS/artifacts/localnet/node_0.json 2>/dev/null | awk '{print $5}') bytes"
echo "identity_0.pem: $(ls -la $WS/artifacts/localnet/identity_0.pem 2>/dev/null | awk '{print $5}') bytes"
echo "node_config_0.toml: $(ls -la $WS/artifacts/node_config_0.toml 2>/dev/null | awk '{print $5}') bytes"

# Rebuild working dir
rm -rf "$DIR"
mkdir -p "$DIR/node-keys" "$DIR/circuits" "$DIR/logs"
cp "$WS/artifacts/node_config_0.toml" "$DIR/node_config.toml"
sed -i 's|host.docker.internal|127.0.0.1|g' "$DIR/node_config.toml"
cp "$WS/artifacts/localnet/identity_0.pem" "$DIR/node-keys/node_identity.pem"
cp "$WS/artifacts/localnet/node_0.json" "$DIR/node-keys/node_keypair.json"
cp "$WS/artifacts/localnet/node_0.json" "$DIR/node-keys/operator_keypair.json"
cp "$WS/artifacts/localnet/node_callback_0.json" "$DIR/node-keys/callback_authority_keypair.json"
cp "$WS/artifacts/localnet/node_bls_0.json" "$DIR/node-keys/node_bls_keypair.json"
cp "$WS/artifacts/localnet/node_x25519_0.json" "$DIR/node-keys/node_x25519_keypair.json"
cp -r /tmp/arx-native/circuits/* "$DIR/circuits/" 2>/dev/null || true

echo ""
echo "=== Config ==="
cat "$DIR/node_config.toml"

echo ""
echo "=== Starting Node 0 ==="
cd "$DIR"
LOG="$DIR/node.log"

# Kill any previous
pkill -f "/tmp/arx-native/arx/arx" 2>/dev/null || true
sleep 1

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
PID=$!
echo "  PID: $PID"

# Wait and check multiple times
for t in 2 5 10; do
    sleep $((t - ${prev:-0}))
    prev=$t
    if kill -0 $PID 2>/dev/null; then
        BYTES=$(wc -c < "$LOG" 2>/dev/null || echo 0)
        UDP=$(ss -ulnp 2>/dev/null | grep -c 8001)
        echo "  [${t}s] ALIVE bytes=$BYTES udp=$UDP"
    else
        wait $PID 2>/dev/null
        EXIT=$?
        echo "  [${t}s] DEAD exit=$EXIT"
        echo "  Log ($BYTES bytes):"
        cat "$LOG"
        break
    fi
done

# If still alive after 10s, show log
if kill -0 $PID 2>/dev/null; then
    echo ""
    echo "=== Node 0 alive after 10s! ==="
    echo "  Log ($(wc -c < "$LOG") bytes):"
    cat "$LOG" | head -30
    echo "  UDP:"
    ss -ulnp 2>/dev/null | grep 8001
    
    # Keep running for DKG test
    echo ""
    echo "  Node 0 is running. PID=$PID"
    echo "  Kill with: kill $PID"
else
    echo ""
    echo "=== Node 0 died ==="
fi
