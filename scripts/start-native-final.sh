#!/bin/bash
# Run arx nodes natively — the binary reads node_config.toml from CWD
set -e

WS="/tmp/poker-arc-workspace"
ARX_BIN="/tmp/arx-native/arx/arx"
TD_BIN="/tmp/arx-native/trusted-dealer"
NATIVE="/tmp/arx-native"

echo "=== Kill previous ==="
pkill -f "$ARX_BIN" 2>/dev/null || true
pkill -f "$TD_BIN" 2>/dev/null || true
sleep 1

echo "=== Add loopback IPs ==="
for ip in 172.20.0.99 172.20.0.100 172.20.0.101 172.20.0.102 172.20.0.103; do
    sudo ip addr add "$ip/32" dev lo 2>/dev/null || true
done

echo "=== Create per-node working directories ==="
for i in 0 1 2 3; do
    DIR="$NATIVE/run_node_$i"
    mkdir -p "$DIR/node-keys" "$DIR/arx" "$DIR/circuits" "$DIR/logs"
    
    # The binary looks for node_config.toml in CWD
    cp "$WS/artifacts/node_config_$i.toml" "$DIR/node_config.toml"
    
    # Env vars point to these paths
    cp "$WS/artifacts/localnet/identity_$i.pem" "$DIR/node-keys/node_identity.pem"
    cp "$WS/artifacts/localnet/node_$i.json" "$DIR/node-keys/node_keypair.json"
    cp "$WS/artifacts/localnet/node_$i.json" "$DIR/node-keys/operator_keypair.json"
    cp "$WS/artifacts/localnet/node_callback_$i.json" "$DIR/node-keys/callback_authority_keypair.json"
    cp "$WS/artifacts/localnet/node_bls_$i.json" "$DIR/node-keys/node_bls_keypair.json"
    cp "$WS/artifacts/localnet/node_x25519_$i.json" "$DIR/node-keys/node_x25519_keypair.json"
    
    # Circuits
    cp -r "$NATIVE/circuits/"* "$DIR/circuits/" 2>/dev/null || true
    
    echo "  Node $i dir ready: $DIR"
done

# TD working directory
TD_DIR="$NATIVE/run_td"
mkdir -p "$TD_DIR/logs"
# TD config also loaded from CWD
cp "$WS/artifacts/trusted_dealer_config.toml" "$TD_DIR/trusted_dealer_config.toml"
# Patch TD config paths to be relative or absolute to this dir
sed -i "s|/usr/trusted-dealer/master_seed.json|$WS/artifacts/localnet/td_master_seed.json|g" "$TD_DIR/trusted_dealer_config.toml"
sed -i "s|/usr/trusted-dealer/identity.json|$WS/artifacts/localnet/td_identity.pem|g" "$TD_DIR/trusted_dealer_config.toml"
sed -i 's|host.docker.internal|127.0.0.1|g' "$TD_DIR/trusted_dealer_config.toml"
echo "  TD dir ready: $TD_DIR"
echo "  TD config:"
cat "$TD_DIR/trusted_dealer_config.toml"

echo ""
echo "=== Start Node 0 (test) ==="
cd "$NATIVE/run_node_0"
NODE_IDENTITY_FILE="node-keys/node_identity.pem" \
NODE_KEYPAIR_FILE="node-keys/node_keypair.json" \
OPERATOR_KEYPAIR_FILE="node-keys/operator_keypair.json" \
CALLBACK_AUTHORITY_KEYPAIR_FILE="node-keys/callback_authority_keypair.json" \
NODE_CONFIG_PATH="node_config.toml" \
BLS_PRIVATE_KEY_FILE="node-keys/node_bls_keypair.json" \
X25519_PRIVATE_KEY_FILE="node-keys/node_x25519_keypair.json" \
ARX_METRICS_HOST="0.0.0.0" \
timeout 8 "$ARX_BIN" 2>&1 | head -40
echo "(exit code: $?)"

echo ""
echo "=== Check if it got further ==="
ls -la "$NATIVE/run_node_0/logs/" 2>/dev/null
