#!/bin/bash
echo "=== TD container exit code ==="
docker inspect --format 'Status={{.State.Status}} ExitCode={{.State.ExitCode}} OOMKilled={{.State.OOMKilled}} RestartCount={{.RestartCount}}' artifacts-arcium-trusted-dealer-1 2>/dev/null

echo ""
echo "=== TD container command/entrypoint ==="
docker inspect --format 'Entrypoint={{.Config.Entrypoint}} Cmd={{.Config.Cmd}}' artifacts-arcium-trusted-dealer-1 2>/dev/null

echo ""
echo "=== TD Docker image info ==="
docker images --format "{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.CreatedAt}}\t{{.Size}}" 2>/dev/null | grep trusted-dealer

echo ""
echo "=== arx-node Docker image info ==="
docker images --format "{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.CreatedAt}}\t{{.Size}}" 2>/dev/null | grep arx-node

echo ""
echo "=== TD identity file (is it changing between restarts?) ==="
md5sum /tmp/poker-arc-workspace/artifacts/localnet/td_identity.pem 2>/dev/null
md5sum /tmp/poker-arc-workspace/artifacts/localnet/td_master_seed.json 2>/dev/null

echo ""
echo "=== TD container env vars ==="
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' artifacts-arcium-trusted-dealer-1 2>/dev/null

echo ""
echo "=== What files does the TD binary expect? ==="
docker exec artifacts-arcium-trusted-dealer-1 ls -la /usr/trusted-dealer/ 2>/dev/null || echo "TD not running right now"
