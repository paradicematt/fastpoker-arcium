#!/bin/bash
export PATH="/root/.nvm/versions/node/v20.20.1/bin:/root/.cargo/bin:/root/.local/share/solana/install/active_release/bin:/usr/bin:/bin"

MODE="${1:-full}"
cd /mnt/j/Poker-Arc/backend

if [ "$MODE" = "full" ]; then
  # Init circuits (copy to backend so @arcium-hq/client resolves)
  cp ../scripts/arcium-init-circuits.ts ./_init-circuits.ts
  npx ts-node --transpile-only _init-circuits.ts 2>&1 | tail -10
  rm -f _init-circuits.ts
  echo "---CIRCUITS_DONE---"

  # Bootstrap
  npx ts-node --transpile-only localnet-bootstrap.ts 2>&1 | tail -10
  echo "---BOOTSTRAP_DONE---"
fi

# Kill old crank
pkill -f crank-service 2>/dev/null
sleep 2

# Start crank in background
LOCAL_MODE=true ARCIUM_CLUSTER_OFFSET=0 npx ts-node --transpile-only crank-service.ts > /tmp/crank.log 2>&1 &
CRANK_PID=$!
echo "Crank PID=$CRANK_PID"
sleep 5

# Run SNG E2E test
ARCIUM_CLUSTER_OFFSET=0 npx ts-node --transpile-only e2e-sng-arcium.ts 2>&1
echo "---TEST_DONE---"

# Show crank output
tail -20 /tmp/crank.log
kill $CRANK_PID 2>/dev/null
