#!/bin/bash
# Start arx nodes + TD natively with proper path mapping
set -e

WS="/tmp/poker-arc-workspace"
ARX_BIN="/tmp/arx-native/arx/arx"
TD_BIN="/tmp/arx-native/trusted-dealer"

echo "=== Kill previous ==="
pkill -f "$ARX_BIN" 2>/dev/null || true
pkill -f "$TD_BIN" 2>/dev/null || true
sleep 1

echo "=== Add loopback IPs ==="
for ip in 172.20.0.99 172.20.0.100 172.20.0.101 172.20.0.102 172.20.0.103; do
    sudo ip addr add "$ip/32" dev lo 2>/dev/null || true
done

echo "=== Fix configs: replace Docker paths with native paths ==="
# Patch TD config to use native paths
TD_CFG="$WS/artifacts/trusted_dealer_config.toml"
sed -i 's|host.docker.internal|127.0.0.1|g' "$TD_CFG"
sed -i "s|/usr/trusted-dealer/master_seed.json|$WS/artifacts/localnet/td_master_seed.json|g" "$TD_CFG"
sed -i "s|/usr/trusted-dealer/identity.json|$WS/artifacts/localnet/td_identity.pem|g" "$TD_CFG"
echo "TD config:"
cat "$TD_CFG"

# Patch node configs
for i in 0 1 2 3; do
    CFG="$WS/artifacts/node_config_$i.toml"
    sed -i 's|host.docker.internal|127.0.0.1|g' "$CFG"
done

echo ""
echo "=== Create required directories ==="
# TD needs a logs directory
sudo mkdir -p /usr/trusted-dealer/logs
sudo chmod 777 /usr/trusted-dealer/logs
# Nodes need a logs directory
sudo mkdir -p /usr/arx-node/logs
sudo chmod 777 /usr/arx-node/logs
# Nodes also need circuits dir
sudo mkdir -p /usr/arx-node/circuits
sudo cp -r /tmp/arx-native/circuits/* /usr/arx-node/circuits/ 2>/dev/null || true

mkdir -p "$WS/artifacts/arx_node_logs"
mkdir -p "$WS/artifacts/trusted_dealer_logs"

echo ""
echo "=== Start Node 0 first (test) ==="
LOG0="$WS/artifacts/arx_node_logs/native_node_0.log"
NODE_IDENTITY_FILE="$WS/artifacts/localnet/identity_0.pem" \
NODE_KEYPAIR_FILE="$WS/artifacts/localnet/node_0.json" \
OPERATOR_KEYPAIR_FILE="$WS/artifacts/localnet/node_0.json" \
CALLBACK_AUTHORITY_KEYPAIR_FILE="$WS/artifacts/localnet/node_callback_0.json" \
NODE_CONFIG_PATH="$WS/artifacts/node_config_0.toml" \
BLS_PRIVATE_KEY_FILE="$WS/artifacts/localnet/node_bls_0.json" \
X25519_PRIVATE_KEY_FILE="$WS/artifacts/localnet/node_x25519_0.json" \
ARX_METRICS_HOST="0.0.0.0" \
RUST_BACKTRACE=1 \
"$ARX_BIN" > "$LOG0" 2>&1 &
N0_PID=$!
echo "  Node 0 PID: $N0_PID"
sleep 3

echo ""
echo "=== Node 0 log (first 30 lines) ==="
head -30 "$LOG0"

echo ""
echo "=== Is Node 0 still alive? ==="
if kill -0 $N0_PID 2>/dev/null; then
    echo "  YES - Node 0 is running!"
    
    echo ""
    echo "=== Start remaining nodes + TD ==="
    for i in 1 2 3; do
        LOG="$WS/artifacts/arx_node_logs/native_node_$i.log"
        NODE_IDENTITY_FILE="$WS/artifacts/localnet/identity_$i.pem" \
        NODE_KEYPAIR_FILE="$WS/artifacts/localnet/node_$i.json" \
        OPERATOR_KEYPAIR_FILE="$WS/artifacts/localnet/node_$i.json" \
        CALLBACK_AUTHORITY_KEYPAIR_FILE="$WS/artifacts/localnet/node_callback_$i.json" \
        NODE_CONFIG_PATH="$WS/artifacts/node_config_$i.toml" \
        BLS_PRIVATE_KEY_FILE="$WS/artifacts/localnet/node_bls_$i.json" \
        X25519_PRIVATE_KEY_FILE="$WS/artifacts/localnet/node_x25519_$i.json" \
        ARX_METRICS_HOST="0.0.0.0" \
        RUST_BACKTRACE=1 \
        "$ARX_BIN" > "$LOG" 2>&1 &
        echo "  Node $i PID: $!"
    done
    
    TD_LOG="$WS/artifacts/trusted_dealer_logs/native_td.log"
    RUST_BACKTRACE=1 "$TD_BIN" > "$TD_LOG" 2>&1 &
    echo "  TD PID: $!"
    
    sleep 5
    echo ""
    echo "=== All logs status ==="
    for i in 0 1 2 3; do
        LOG="$WS/artifacts/arx_node_logs/native_node_$i.log"
        LINES=$(wc -l < "$LOG" 2>/dev/null || echo 0)
        echo "  Node $i: ${LINES}L"
        tail -3 "$LOG" | sed 's/^/    /'
    done
    echo "  TD:"
    tail -3 "$TD_LOG" | sed 's/^/    /'
    
    echo ""
    echo "=== Check health ==="
    for port in 9091 9092 9093 9094; do
        H=$(curl -s -m 1 "http://localhost:$port/health" 2>/dev/null)
        [ -n "$H" ] && echo "  localhost:$port = $H"
    done
    for ip in 172.20.0.100 172.20.0.101 172.20.0.102 172.20.0.103; do
        H=$(curl -s -m 1 "http://$ip:9091/health" 2>/dev/null)
        [ -n "$H" ] && echo "  $ip:9091 = $H"
    done
    echo "  (empty = no response)"
    
    echo ""
    echo "=== UDP ports ==="
    ss -ulnp 2>/dev/null | grep 8001 || echo "  No UDP 8001 listeners"
    
else
    echo "  NO - Node 0 crashed."
    echo "  Full log:"
    cat "$LOG0"
fi
