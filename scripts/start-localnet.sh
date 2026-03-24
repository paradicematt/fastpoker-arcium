#!/bin/bash
export PATH="/root/.cargo/bin:/root/.local/share/solana/install/active_release/bin:/usr/bin:/bin"

# Clean up
docker rm -f $(docker ps -aq) 2>/dev/null
pkill -f solana-test-validator 2>/dev/null
tmux kill-server 2>/dev/null
sleep 2

# Start arcium localnet in tmux
cd /tmp/poker-arc
tmux new-session -d -s arcium "arcium localnet --skip-build 2>&1 | tee /tmp/arcium-localnet.log"

echo "Waiting for validator..."
for i in $(seq 1 60); do
  if solana cluster-version -u localhost >/dev/null 2>&1; then
    echo "VALIDATOR_UP after ${i}s"
    break
  fi
  sleep 2
done

echo "Waiting for MXE nodes..."
for i in $(seq 1 90); do
  CONTAINERS=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -c arx-node)
  if [ "$CONTAINERS" -ge 4 ]; then
    echo "MXE_NODES_UP ($CONTAINERS containers) after ${i}s"
    break
  fi
  sleep 2
done

# Check final state
solana cluster-version -u localhost 2>&1
docker ps --format '{{.Names}} {{.Status}}' 2>&1
echo "LOCALNET_READY"
