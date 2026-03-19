#!/bin/bash
# Test running a single node natively with proper output capture
WS="/tmp/poker-arc-workspace"
ARX_BIN="/tmp/arx-native/arx/arx"
DIR="/tmp/arx-native/run_node_0"
LOG="/tmp/arx-native/node0_test.log"

cd "$DIR"

echo "=== CWD: $(pwd) ==="
echo "=== Config exists: $(ls node_config.toml 2>/dev/null && echo YES || echo NO) ==="
echo "=== Key files: ==="
ls -la node-keys/

echo ""
echo "=== Starting node 0 in background ==="
NODE_IDENTITY_FILE="node-keys/node_identity.pem" \
NODE_KEYPAIR_FILE="node-keys/node_keypair.json" \
OPERATOR_KEYPAIR_FILE="node-keys/operator_keypair.json" \
CALLBACK_AUTHORITY_KEYPAIR_FILE="node-keys/callback_authority_keypair.json" \
NODE_CONFIG_PATH="node_config.toml" \
BLS_PRIVATE_KEY_FILE="node-keys/node_bls_keypair.json" \
X25519_PRIVATE_KEY_FILE="node-keys/node_x25519_keypair.json" \
ARX_METRICS_HOST="0.0.0.0" \
RUST_LOG=debug \
"$ARX_BIN" > "$LOG" 2>&1 &
PID=$!
echo "  PID: $PID"

sleep 5

echo ""
echo "=== Process alive? ==="
if kill -0 $PID 2>/dev/null; then
    echo "  YES - still running"
else
    echo "  NO - exited (code: $(wait $PID; echo $?))"
fi

echo ""
echo "=== Log ($LOG) ==="
wc -l "$LOG"
echo "--- First 50 lines ---"
head -50 "$LOG"
echo "--- Last 10 lines ---"
tail -10 "$LOG"

echo ""
echo "=== Check ports ==="
ss -ulnp 2>/dev/null | grep -E '8001|9091' || echo "No relevant UDP/TCP listeners"
ss -tlnp 2>/dev/null | grep -E '8001|9091' || echo "No relevant TCP listeners"

# Cleanup
kill $PID 2>/dev/null || true
