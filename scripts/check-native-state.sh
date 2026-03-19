#!/bin/bash
source ~/.cargo/env 2>/dev/null || true
export PATH="$HOME/.local/share/solana/install/releases/2.1.21/solana-release/bin:$HOME/.cargo/bin:$PATH"

WS="/tmp/poker-arc-workspace"

echo "=== Validator ==="
curl -s http://localhost:8899 -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null
echo ""

echo ""
echo "=== Generated files ==="
for f in node_config_0.toml node_config_1.toml trusted_dealer_config.toml docker-compose-arx-env.yml; do
    SIZE=$(stat -c%s "$WS/artifacts/$f" 2>/dev/null || echo "MISSING")
    echo "  $f: $SIZE bytes"
done

echo ""
echo "=== Keypairs ==="
ls -la "$WS/artifacts/localnet/" 2>/dev/null | grep -E '\.json|\.pem' | head -20

echo ""
echo "=== Node config 0 ==="
cat "$WS/artifacts/node_config_0.toml" 2>/dev/null || echo "NOT FOUND"

echo ""
echo "=== TD config ==="
cat "$WS/artifacts/trusted_dealer_config.toml" 2>/dev/null || echo "NOT FOUND"

echo ""
echo "=== Native logs ==="
ls -la "$WS/artifacts/arx_node_logs/native_"* 2>/dev/null || echo "No native logs"
ls -la "$WS/artifacts/trusted_dealer_logs/native_"* 2>/dev/null || echo "No native TD log"

echo ""
echo "=== Running processes ==="
ps aux | grep -E 'arx|trusted-dealer|solana-test-validator' | grep -v grep | head -10
