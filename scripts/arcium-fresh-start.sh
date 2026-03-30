#!/bin/bash
export PATH="/root/.cargo/bin:/root/.local/share/solana/install/active_release/bin:/usr/bin:/bin"
cd /tmp/poker-arc

# Kill EVERYTHING first
tmux kill-session -t arcium 2>/dev/null
pkill -9 -f solana-test-validator 2>/dev/null
docker rm -f $(docker ps -aq) 2>/dev/null
docker network rm artifacts_arx_network 2>/dev/null
sleep 3

# Start arcium localnet fresh in tmux
tmux new-session -d -s arcium "export PATH=/root/.cargo/bin:/root/.local/share/solana/install/active_release/bin:/usr/bin:/bin && cd /tmp/poker-arc && arcium localnet --skip-build 2>&1 | tee /tmp/arcium-localnet.log"

# Wait for "Primary cluster nodes are online" in log
for i in $(seq 1 180); do
  if grep -q "Primary cluster nodes are online" /tmp/arcium-localnet.log 2>/dev/null; then
    echo "NODES_ONLINE after ${i}s"
    break
  fi
  if grep -q "Error\|error\|FAIL\|panic" /tmp/arcium-localnet.log 2>/dev/null; then
    echo "ERROR_DETECTED at ${i}s"
    grep -i "error\|fail\|panic" /tmp/arcium-localnet.log | tail -3
    break
  fi
  [ "$i" -eq 180 ] && echo "TIMEOUT_360s" && tail -10 /tmp/arcium-localnet.log
  sleep 2
done

echo "---"
docker ps --format "{{.Names}} {{.Status}}" 2>/dev/null
NODE_LINES=$(docker logs artifacts-arx-node-0-1 2>&1 | wc -l)
echo "node0_logs=$NODE_LINES"
