#!/bin/bash
# Start arx nodes + TD natively (validator already running from arcium localnet --skip-local-arx-nodes)
set -e

WS="/tmp/poker-arc-workspace"
ARX_BIN="/tmp/arx-native/arx/arx"
TD_BIN="/tmp/arx-native/trusted-dealer"

echo "=== Kill any existing native nodes ==="
pkill -f "$ARX_BIN" 2>/dev/null || true
pkill -f "$TD_BIN" 2>/dev/null || true
sleep 1

echo "=== Add loopback IP aliases ==="
for ip in 172.20.0.99 172.20.0.100 172.20.0.101 172.20.0.102 172.20.0.103; do
    sudo ip addr add "$ip/32" dev lo 2>/dev/null && echo "  Added $ip" || echo "  $ip exists"
done

echo ""
echo "=== Patch configs for native ==="
for i in 0 1 2 3; do
    CFG="$WS/artifacts/node_config_$i.toml"
    sed -i 's|host.docker.internal|127.0.0.1|g' "$CFG" 2>/dev/null
    echo "  node_config_$i: $(cat "$CFG")"
done
TD_CFG="$WS/artifacts/trusted_dealer_config.toml"
sed -i 's|host.docker.internal|127.0.0.1|g' "$TD_CFG" 2>/dev/null
echo "  TD config: $(cat "$TD_CFG")"

echo ""
echo "=== Create runtime dirs ==="
mkdir -p "$WS/artifacts/arx_node_logs"
mkdir -p "$WS/artifacts/trusted_dealer_logs"
for i in 0 1 2 3; do
    mkdir -p "$WS/artifacts/private_shares_node_$i"
    mkdir -p "$WS/artifacts/public_inputs_node_$i"
done

echo ""
echo "=== Start nodes ==="
for i in 0 1 2 3; do
    LOG="$WS/artifacts/arx_node_logs/native_node_$i.log"
    NODE_IDENTITY_FILE="$WS/artifacts/localnet/identity_$i.pem" \
    NODE_KEYPAIR_FILE="$WS/artifacts/localnet/node_$i.json" \
    OPERATOR_KEYPAIR_FILE="$WS/artifacts/localnet/node_$i.json" \
    CALLBACK_AUTHORITY_KEYPAIR_FILE="$WS/artifacts/localnet/node_callback_$i.json" \
    NODE_CONFIG_PATH="$WS/artifacts/node_config_$i.toml" \
    BLS_PRIVATE_KEY_FILE="$WS/artifacts/localnet/node_bls_$i.json" \
    X25519_PRIVATE_KEY_FILE="$WS/artifacts/localnet/node_x25519_$i.json" \
    ARX_METRICS_HOST="0.0.0.0" \
    "$ARX_BIN" > "$LOG" 2>&1 &
    echo "  Node $i PID=$! log=$LOG"
done

echo ""
echo "=== Start TD ==="
TD_LOG="$WS/artifacts/trusted_dealer_logs/native_td.log"
"$TD_BIN" > "$TD_LOG" 2>&1 &
echo "  TD PID=$! log=$TD_LOG"

sleep 3
echo ""
echo "=== Quick status ==="
for i in 0 1 2 3; do
    LOG="$WS/artifacts/arx_node_logs/native_node_$i.log"
    LINES=$(wc -l < "$LOG" 2>/dev/null || echo 0)
    LAST=$(tail -1 "$LOG" 2>/dev/null | head -c 150)
    echo "  Node $i: ${LINES}L | $LAST"
done
TD_LOG="$WS/artifacts/trusted_dealer_logs/native_td.log"
LINES=$(wc -l < "$TD_LOG" 2>/dev/null || echo 0)
echo "  TD: ${LINES}L | $(tail -1 "$TD_LOG" 2>/dev/null | head -c 150)"
