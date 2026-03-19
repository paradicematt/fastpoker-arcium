#!/bin/bash
# Test: does node 1 die from port 8001 conflict with node 0?
WS="/tmp/poker-arc-workspace"
ARX_BIN="/tmp/arx-native/arx/arx"
NATIVE="/tmp/arx-native"

echo "=== Current UDP 8001 listeners ==="
ss -ulnp 2>/dev/null | grep 8001

echo ""
echo "=== Kill all arx processes ==="
pkill -f "$ARX_BIN" 2>/dev/null || true
sleep 2

echo "=== Verify port freed ==="
ss -ulnp 2>/dev/null | grep 8001 || echo "Port 8001 free"

echo ""
echo "=== Start ONLY node 1 (no node 0 running) ==="
DIR="$NATIVE/run_node_1"
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
"$ARX_BIN" > "$DIR/node.log" 2>&1 &
PID=$!
echo "  PID: $PID"

sleep 3
if kill -0 $PID 2>/dev/null; then
    echo "  ALIVE after 3s"
    echo "  UDP:"
    ss -ulnp 2>/dev/null | grep 8001
    echo ""
    echo "  Confirmed: port conflict was the issue!"
    echo "  Each node binds 0.0.0.0:8001 — can't run multiple natively."
else
    echo "  DEAD — something else is wrong"
    cat "$DIR/node.log" 2>/dev/null
fi

# Cleanup
kill $PID 2>/dev/null || true
