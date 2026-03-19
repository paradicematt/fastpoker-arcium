#!/bin/bash
# Create symlinks from Docker container paths to actual workspace files
# so the arx and TD binaries can find their configs
set -e

WS="/tmp/poker-arc-workspace"

echo "=== Creating Docker path symlinks ==="

# For arx-node: /usr/arx-node/arx/node_config.toml
sudo mkdir -p /usr/arx-node/arx
sudo mkdir -p /usr/arx-node/node-keys
sudo mkdir -p /usr/arx-node/logs
sudo mkdir -p /usr/arx-node/circuits
sudo chmod -R 777 /usr/arx-node

# Copy circuits
cp -r /tmp/arx-native/circuits/* /usr/arx-node/circuits/ 2>/dev/null || true

# For TD: /usr/trusted-dealer/*
sudo mkdir -p /usr/trusted-dealer/logs
sudo chmod -R 777 /usr/trusted-dealer

# Symlink TD config and keys
ln -sf "$WS/artifacts/trusted_dealer_config.toml" /usr/trusted-dealer/trusted_dealer_config.toml
ln -sf "$WS/artifacts/localnet/td_identity.pem" /usr/trusted-dealer/identity.json
ln -sf "$WS/artifacts/localnet/td_master_seed.json" /usr/trusted-dealer/master_seed.json

echo "  TD symlinks created"

# For node 0 (test first)
# The Docker compose maps many files to /usr/arx-node/node-keys/ and /usr/arx-node/arx/
ln -sf "$WS/artifacts/node_config_0.toml" /usr/arx-node/arx/node_config.toml
ln -sf "$WS/artifacts/localnet/node_0.json" /usr/arx-node/node-keys/node_keypair.json
ln -sf "$WS/artifacts/localnet/node_0.json" /usr/arx-node/node-keys/operator_keypair.json
ln -sf "$WS/artifacts/localnet/node_callback_0.json" /usr/arx-node/node-keys/callback_authority_keypair.json
ln -sf "$WS/artifacts/localnet/identity_0.pem" /usr/arx-node/node-keys/node_identity.pem
ln -sf "$WS/artifacts/localnet/node_bls_0.json" /usr/arx-node/node-keys/node_bls_keypair.json
ln -sf "$WS/artifacts/localnet/node_x25519_0.json" /usr/arx-node/node-keys/node_x25519_keypair.json

echo "  Node 0 symlinks created"

# Test node 0
echo ""
echo "=== Test Node 0 ==="
NODE_IDENTITY_FILE="/usr/arx-node/node-keys/node_identity.pem" \
NODE_KEYPAIR_FILE="/usr/arx-node/node-keys/node_keypair.json" \
OPERATOR_KEYPAIR_FILE="/usr/arx-node/node-keys/operator_keypair.json" \
CALLBACK_AUTHORITY_KEYPAIR_FILE="/usr/arx-node/node-keys/callback_authority_keypair.json" \
NODE_CONFIG_PATH="/usr/arx-node/arx/node_config.toml" \
BLS_PRIVATE_KEY_FILE="/usr/arx-node/node-keys/node_bls_keypair.json" \
X25519_PRIVATE_KEY_FILE="/usr/arx-node/node-keys/node_x25519_keypair.json" \
ARX_METRICS_HOST="0.0.0.0" \
RUST_BACKTRACE=1 \
timeout 5 /tmp/arx-native/arx/arx 2>&1 | head -30 || true

echo ""
echo "=== Verify symlinks ==="
ls -la /usr/arx-node/arx/node_config.toml
ls -la /usr/arx-node/node-keys/
