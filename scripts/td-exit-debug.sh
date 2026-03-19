#!/bin/bash
WS="/tmp/poker-arc-workspace"

echo "=== TD container inspect (exit code, state) ==="
docker inspect --format 'Status={{.State.Status}} ExitCode={{.State.ExitCode}} RestartCount={{.RestartCount}} StartedAt={{.State.StartedAt}}' artifacts-arcium-trusted-dealer-1 2>/dev/null

echo ""
echo "=== TD docker logs (last 50 lines, includes stderr) ==="
docker logs --tail 50 artifacts-arcium-trusted-dealer-1 2>&1

echo ""
echo "=== TD identity file (md5) ==="
md5sum "$WS/artifacts/localnet/td_identity.pem" 2>/dev/null

echo ""
echo "=== TD config ==="
cat "$WS/artifacts/trusted_dealer_config.toml" 2>/dev/null

echo ""
echo "=== Check: does TD listen on port 8012? ==="
docker exec artifacts-arcium-trusted-dealer-1 bash -c "cat /proc/net/udp 2>/dev/null; echo '---'; cat /proc/net/tcp 2>/dev/null" 2>/dev/null || echo "TD not running"

echo ""
echo "=== What port does the TD bind on? Check its startup ==="
LATEST_TD=$(ls -t "$WS/artifacts/trusted_dealer_logs/"*.log 2>/dev/null | head -1)
[ -n "$LATEST_TD" ] && grep -i "bind\|listen\|port\|8001\|8012\|addr" "$LATEST_TD"
