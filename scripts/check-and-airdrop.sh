#!/bin/bash
# Check if validator is running and airdrop SOL
set -e

export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.local/share/solana/install/releases/2.1.21/solana-release/bin:$PATH"

RPC="http://127.0.0.1:8899"
TARGET="6XXSTaAANVoWiw2Byov3z26nJWX6otS9NiBo1Ey9sMZk"

echo "=== Checking validator at $RPC ==="
if curl -s "$RPC" -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' -H 'Content-Type:application/json' 2>/dev/null | grep -q 'ok\|result'; then
  echo "✓ Validator is ONLINE"
else
  echo "✗ Validator is OFFLINE"
  echo "  Start it with: wsl bash /mnt/j/Poker-Arc/scripts/start-arcium-localnet.sh"
  exit 1
fi

echo ""
echo "=== Airdropping SOL to $TARGET ==="
# Localnet allows large airdrops — do multiple 500 SOL drops
for i in 1; do
  echo "  Airdrop $i: 500 SOL..."
  solana airdrop 500 "$TARGET" --url "$RPC" 2>&1 || echo "  (airdrop may have partial limit)"
done

echo ""
echo "=== Balance check ==="
solana balance "$TARGET" --url "$RPC" 2>&1
echo "Done."
