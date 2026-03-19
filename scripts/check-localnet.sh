#!/bin/bash
# Quick diagnostic for arcium localnet status
source ~/.cargo/env 2>/dev/null
export PATH="$HOME/.local/share/solana/install/releases/2.1.21/solana-release/bin:$PATH"

RPC="http://127.0.0.1:8899"

echo "=== Validator ==="
SLOT=$(curl -s "$RPC" -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' 2>/dev/null)
echo "  Slot: $SLOT"

check_account() {
  local label="$1" addr="$2"
  local resp=$(curl -s "$RPC" -X POST -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getAccountInfo\",\"params\":[\"$addr\",{\"encoding\":\"base64\"}]}" 2>/dev/null)
  local owner=$(echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); v=d.get('result',{}).get('value'); print(v['owner'] if v else 'NOT_FOUND')" 2>/dev/null)
  echo "  $label ($addr): owner=$owner"
}

echo "=== Key Accounts ==="
check_account "Arcium Program" "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
check_account "Lighthouse" "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95"
check_account "MXE Account" "7MSDfoo86WnuUKZbUCYGhzixhF7n8ANSCVjugcxg28cf"
check_account "Cluster 0" "CuTp9LKzoY9hy77TkrickLpVTUFgvnRfQHB9tnhG2ypt"
check_account "Mempool" "9rUSnh5VrMtRUrJrgAUwcyWvL9NYkscAsDFS5RjPW6Da"
check_account "STEEL Program" "9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6"
check_account "FastPoker" "BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N"

echo "=== Docker Nodes ==="
docker ps --filter "name=arx" --format "{{.Names}} {{.Status}}" 2>/dev/null || echo "NO DOCKER"

echo "=== admin.rpc ==="
ls -la /tmp/poker-arc-workspace/.anchor/test-ledger/admin.rpc 2>/dev/null && echo "  UDS OK" || echo "  NOT FOUND"

echo "=== Validator PID ==="
pgrep -la solana-test-validator 2>/dev/null || echo "VALIDATOR NOT RUNNING"
