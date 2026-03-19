#!/bin/bash
# Start nodes 1-3 + TD (node 0 already running from test-one-node.sh)
set -e

WS="/tmp/poker-arc-workspace"
ARX_BIN="/tmp/arx-native/arx/arx"
TD_BIN="/tmp/arx-native/trusted-dealer"
NATIVE="/tmp/arx-native"

# Loopback IPs
for ip in 172.20.0.99 172.20.0.100 172.20.0.101 172.20.0.102 172.20.0.103; do
    sudo ip addr add "$ip/32" dev lo 2>/dev/null || true
done

# Setup + start nodes 1-3
for i in 1 2 3; do
    DIR="$NATIVE/run_node_$i"
    rm -rf "$DIR"
    mkdir -p "$DIR/node-keys" "$DIR/circuits" "$DIR/logs"
    cp "$WS/artifacts/node_config_$i.toml" "$DIR/node_config.toml"
    sed -i 's|host.docker.internal|127.0.0.1|g' "$DIR/node_config.toml"
    cp "$WS/artifacts/localnet/identity_$i.pem" "$DIR/node-keys/node_identity.pem"
    cp "$WS/artifacts/localnet/node_$i.json" "$DIR/node-keys/node_keypair.json"
    cp "$WS/artifacts/localnet/node_$i.json" "$DIR/node-keys/operator_keypair.json"
    cp "$WS/artifacts/localnet/node_callback_$i.json" "$DIR/node-keys/callback_authority_keypair.json"
    cp "$WS/artifacts/localnet/node_bls_$i.json" "$DIR/node-keys/node_bls_keypair.json"
    cp "$WS/artifacts/localnet/node_x25519_$i.json" "$DIR/node-keys/node_x25519_keypair.json"
    cp -r "$NATIVE/circuits/"* "$DIR/circuits/" 2>/dev/null || true
    
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
    echo "Node $i PID=$!"
done

# Setup + start TD
TD_DIR="$NATIVE/run_td"
rm -rf "$TD_DIR"
mkdir -p "$TD_DIR/logs"
cp "$WS/artifacts/trusted_dealer_config.toml" "$TD_DIR/trusted_dealer_config.toml"
cp "$WS/artifacts/localnet/td_master_seed.json" "$TD_DIR/master_seed.json"
cp "$WS/artifacts/localnet/td_identity.pem" "$TD_DIR/identity.json"
sed -i 's|host.docker.internal|127.0.0.1|g' "$TD_DIR/trusted_dealer_config.toml"
sed -i "s|/usr/trusted-dealer/master_seed.json|$TD_DIR/master_seed.json|g" "$TD_DIR/trusted_dealer_config.toml"
sed -i "s|/usr/trusted-dealer/identity.json|$TD_DIR/identity.json|g" "$TD_DIR/trusted_dealer_config.toml"

echo ""
echo "TD config:"
cat "$TD_DIR/trusted_dealer_config.toml"

cd "$TD_DIR"
RUST_LOG=info "$TD_BIN" > "$TD_DIR/td.log" 2>&1 &
echo "TD PID=$!"

sleep 5

echo ""
echo "=== Status after 5s ==="
echo "arx processes: $(pgrep -f '/tmp/arx-native/arx/arx' | wc -l)"
echo "UDP 8001 listeners: $(ss -ulnp 2>/dev/null | grep -c 8001)"

for i in 0 1 2 3; do
    DIR="$NATIVE/run_node_$i"
    PID=$(pgrep -f "run_node_$i.*arx" 2>/dev/null | head -1)
    ALIVE="DEAD"
    [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null && ALIVE="ALIVE"
    BYTES=$(wc -c < "$DIR/node.log" 2>/dev/null || echo 0)
    echo "  Node $i: $ALIVE ($BYTES bytes log)"
done

TD_PID=$(pgrep -f trusted-dealer 2>/dev/null | head -1)
TD_ALIVE="DEAD"
[ -n "$TD_PID" ] && kill -0 "$TD_PID" 2>/dev/null && TD_ALIVE="ALIVE"
TD_BYTES=$(wc -c < "$TD_DIR/td.log" 2>/dev/null || echo 0)
echo "  TD: $TD_ALIVE ($TD_BYTES bytes log)"

if [ "$TD_ALIVE" = "DEAD" ]; then
    echo ""
    echo "=== TD log ==="
    cat "$TD_DIR/td.log" 2>/dev/null
fi

# Show any node that died
for i in 0 1 2 3; do
    DIR="$NATIVE/run_node_$i"
    PID=$(pgrep -f "run_node_$i.*arx" 2>/dev/null | head -1)
    if [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; then
        BYTES=$(wc -c < "$DIR/node.log" 2>/dev/null || echo 0)
        if [ "$BYTES" -gt 0 ]; then
            echo ""
            echo "=== Node $i log (died) ==="
            cat "$DIR/node.log" 2>/dev/null
        fi
    fi
done
