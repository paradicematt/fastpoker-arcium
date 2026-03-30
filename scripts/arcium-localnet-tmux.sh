#!/bin/bash
export PATH="/root/.cargo/bin:/root/.local/share/solana/install/active_release/bin:/usr/bin:/bin"
cd /tmp/poker-arc

# Kill everything
pkill -9 -f solana-test-validator 2>/dev/null
docker compose -f artifacts/docker-compose-arx-env.yml down -v 2>/dev/null
sleep 3

# Start arcium localnet in tmux
tmux kill-session -t arcium 2>/dev/null
tmux new-session -d -s arcium "export PATH=/root/.cargo/bin:/root/.local/share/solana/install/active_release/bin:/usr/bin:/bin && cd /tmp/poker-arc && arcium localnet --skip-build 2>&1 | tee /tmp/arcium-localnet.log"

# Wait for validator
for i in $(seq 1 120); do
  if curl -s http://127.0.0.1:8899 -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q ok; then
    echo "VALIDATOR_UP after ${i}s"
    break
  fi
  [ "$i" -eq 120 ] && echo "VALIDATOR_TIMEOUT"
  sleep 2
done

# Wait for MXE nodes
for i in $(seq 1 120); do
  RUNNING=$(docker ps --format "{{.Names}}" 2>/dev/null | grep -c arx-node)
  if [ "$RUNNING" -ge 4 ]; then
    echo "MXE_UP ($RUNNING nodes) after ${i}s"
    break
  fi
  [ "$i" -eq 120 ] && echo "MXE_TIMEOUT"
  sleep 2
done

# Wait for DKG
sleep 20
NODE_LINES=$(docker logs artifacts-arx-node-0-1 2>&1 | wc -l)
TD_LINES=$(docker logs artifacts-arcium-trusted-dealer-1 2>&1 | wc -l)
echo "node0_logs=$NODE_LINES td_logs=$TD_LINES"
tail -5 /tmp/arcium-localnet.log
echo "DONE"
