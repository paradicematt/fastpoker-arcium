#!/bin/bash
# Add RUST_LOG to MPC node containers in docker-compose
FILE="/tmp/poker-arc-workspace/artifacts/docker-compose-arx-env.yml"
sed -i 's/ARX_METRICS_HOST: "0.0.0.0"/ARX_METRICS_HOST: "0.0.0.0"\n      RUST_LOG: "info"/g' "$FILE"
echo "Added RUST_LOG to docker-compose"

# Restart just the MPC node containers (not the validator)
cd /tmp/poker-arc-workspace
docker compose -f artifacts/docker-compose-arx-env.yml down
sleep 2
docker compose -f artifacts/docker-compose-arx-env.yml up -d
echo "Restarted MPC containers"
sleep 5

# Check logs
for i in 0 1 2 3; do
  echo "=== Node $i logs ==="
  docker logs "artifacts-arx-node-${i}-1" 2>&1 | tail -5
done
