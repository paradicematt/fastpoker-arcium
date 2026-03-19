#!/bin/bash
# Phase 3-5: Setup and start native nodes (validator already running)
set -e

WS="/tmp/poker-arc-workspace"
ARX_BIN="/tmp/arx-native/arx/arx"
TD_BIN="/tmp/arx-native/trusted-dealer"
NATIVE="/tmp/arx-native"

# Kill any previous native
pkill -f "$ARX_BIN" 2>/dev/null || true
pkill -f "$TD_BIN" 2>/dev/null || true
sleep 1

# Loopback IPs
for ip in 172.20.0.99 172.20.0.100 172.20.0.101 172.20.0.102 172.20.0.103; do
    sudo ip addr add "$ip/32" dev lo 2>/dev/null || true
done

# Per-node dirs
for i in 0 1 2 3; do
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
done

# TD dir
TD_DIR="$NATIVE/run_td"
rm -rf "$TD_DIR"
mkdir -p "$TD_DIR/logs"
cp "$WS/artifacts/trusted_dealer_config.toml" "$TD_DIR/trusted_dealer_config.toml"
cp "$WS/artifacts/localnet/td_master_seed.json" "$TD_DIR/master_seed.json"
cp "$WS/artifacts/localnet/td_identity.pem" "$TD_DIR/identity.json"
sed -i 's|host.docker.internal|127.0.0.1|g' "$TD_DIR/trusted_dealer_config.toml"
sed -i "s|/usr/trusted-dealer/master_seed.json|$TD_DIR/master_seed.json|g" "$TD_DIR/trusted_dealer_config.toml"
sed -i "s|/usr/trusted-dealer/identity.json|$TD_DIR/identity.json|g" "$TD_DIR/trusted_dealer_config.toml"

echo "=== TD config ==="
cat "$TD_DIR/trusted_dealer_config.toml"

echo ""
echo "=== Starting 4 nodes ==="
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
    echo "  Node $i PID=$!"
done

echo ""
echo "=== Starting TD ==="
TD_LOG="$TD_DIR/td.log"
cd "$TD_DIR"
RUST_LOG=info "$TD_BIN" > "$TD_LOG" 2>&1 &
echo "  TD PID=$!"

sleep 5

echo ""
echo "=== Status after 5s ==="
echo "Alive nodes: $(ps aux | grep -c "$ARX_BIN" | grep -v grep 2>/dev/null || echo 0)"
echo "UDP 8001: $(ss -ulnp 2>/dev/null | grep -c 8001)"

for i in 0 1 2 3; do
    LOG="$NATIVE/run_node_$i/node.log"
    echo "Node $i ($(wc -l < "$LOG" 2>/dev/null || echo 0)L): $(tail -1 "$LOG" 2>/dev/null | head -c 150)"
done
echo "TD ($(wc -l < "$TD_LOG" 2>/dev/null || echo 0)L): $(tail -1 "$TD_LOG" 2>/dev/null | head -c 150)"
