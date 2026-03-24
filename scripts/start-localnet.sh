#!/bin/bash
# Start validator + use existing Docker MXE containers
# Usage: bash /tmp/poker-arc/scripts/start-localnet.sh
export PATH="/root/.cargo/bin:/root/.local/share/solana/install/active_release/bin:/usr/bin:/bin"

cd /tmp/poker-arc

# Kill old validator only (keep Docker containers alive)
pkill -f solana-test-validator 2>/dev/null
sleep 2

# Collect all genesis account JSONs from artifacts
ACCT_ARGS=""
for f in /tmp/poker-arc/artifacts/*.json; do
  [ -f "$f" ] || continue
  bn=$(basename "$f")
  case "$bn" in
    docker-compose*|node_config*|trusted_dealer*|circuits_hash*|recovery_node_config*) continue ;;
  esac
  ACCT_ARGS="$ACCT_ARGS --account $bn $f"
done

# Start validator with programs + genesis accounts
nohup solana-test-validator \
  --reset \
  --bpf-program BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N /tmp/poker-arc/target/deploy/fastpoker.so \
  --bpf-program 9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6 /tmp/poker-arc/contracts/target/deploy/poker_program.so \
  --bpf-program arc1E6jGDLCeX6FhkTcQ3P31GhLiB3V9oT71d7EViAe /tmp/poker-arc/artifacts/arcium_program.so \
  --bpf-program 3TV6cK1Ln9sXxcZy5pCADrGbiYGKkNp1PFKxKkGL1kg8 /tmp/poker-arc/artifacts/lighthouse.so \
  --account-dir /tmp/poker-arc/artifacts \
  > /tmp/validator.log 2>&1 &

echo "Waiting for validator..."
for i in $(seq 1 30); do
  if solana cluster-version -u localhost >/dev/null 2>&1; then
    echo "VALIDATOR_UP after ${i}s"
    break
  fi
  sleep 1
done

if ! solana cluster-version -u localhost >/dev/null 2>&1; then
  echo "VALIDATOR_TIMEOUT - last 20 lines of log:"
  tail -20 /tmp/validator.log
  exit 1
fi

# Check Docker MXE nodes
CONTAINERS=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -c arx-node)
echo "MXE containers running: $CONTAINERS"

# Check final state
solana cluster-version -u localhost 2>&1
docker ps --format '{{.Names}} {{.Status}}' 2>&1
echo "LOCALNET_READY"
