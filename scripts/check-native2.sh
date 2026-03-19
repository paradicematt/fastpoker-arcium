#!/bin/bash
source ~/.cargo/env 2>/dev/null || true
export PATH="$HOME/.local/share/solana/install/releases/2.1.21/solana-release/bin:$HOME/.cargo/bin:$PATH"

echo "=== Validator health ==="
curl -s http://localhost:8899 -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null
echo ""

echo ""
echo "=== Native node logs ==="
ls -la /tmp/poker-arc-workspace/artifacts/arx_node_logs/native_* 2>/dev/null || echo "No native logs"

echo ""
echo "=== Native TD log ==="
ls -la /tmp/poker-arc-workspace/artifacts/trusted_dealer_logs/native_* 2>/dev/null || echo "No native TD log"

echo ""
echo "=== Processes ==="
ps aux | grep -E '/arx|trusted-dealer|solana-test-validator|arcium' | grep -v grep

echo ""
echo "=== Node config exists? ==="
ls /tmp/poker-arc-workspace/artifacts/node_config_*.toml 2>/dev/null
ls /tmp/poker-arc-workspace/artifacts/trusted_dealer_config.toml 2>/dev/null

echo ""
echo "=== Node 0 native log (if exists) ==="
head -20 /tmp/poker-arc-workspace/artifacts/arx_node_logs/native_node_0.log 2>/dev/null || echo "Not found"

echo ""
echo "=== TD native log (if exists) ==="
head -20 /tmp/poker-arc-workspace/artifacts/trusted_dealer_logs/native_td.log 2>/dev/null || echo "Not found"
