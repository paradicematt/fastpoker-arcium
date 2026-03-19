#!/bin/bash
set -e
source ~/.cargo/env
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

RPC="https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df"

# --- Program configs ---
ANCHOR_SO="/mnt/j/Poker/target/deploy/fastpoker.so"
ANCHOR_ID="4MLbuVZzXpzWcaZaqxHDkm5JuigZzovsVd6VPNDXnyiB"
ANCHOR_KEY="/mnt/j/Poker/contracts/auth/deployers/anchor-mini-game-deployer-keypair.json"

STEEL_SO="/mnt/j/Poker/contracts/target/deploy/poker_program.so"
STEEL_ID="9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6"
STEEL_KEY="/mnt/j/Poker/contracts/auth/deployers/steel-upgrade-authority-player1.json"

usage() {
  echo "Usage: bash deploy.sh [anchor|steel|both]"
  exit 1
}

deploy_anchor() {
  echo "=== Deploying fastpoker (Anchor) ==="
  echo "Balance: $(solana balance "$ANCHOR_KEY" -u "$RPC")"
  solana program deploy "$ANCHOR_SO" \
    --program-id "$ANCHOR_ID" \
    --keypair "$ANCHOR_KEY" \
    --url "$RPC"
  echo "fastpoker deployed!"
}

deploy_steel() {
  echo "=== Deploying Steel ==="
  echo "Balance: $(solana balance "$STEEL_KEY" -u "$RPC")"
  # Fund from anchor deployer if steel deployer is low
  solana transfer --from "$ANCHOR_KEY" \
    "$(solana address -k "$STEEL_KEY")" 2 \
    -u "$RPC" --allow-unfunded-recipient \
    --fee-payer "$ANCHOR_KEY" 2>/dev/null || true
  solana program deploy "$STEEL_SO" \
    --program-id "$STEEL_ID" \
    --keypair "$STEEL_KEY" \
    --upgrade-authority "$STEEL_KEY" \
    --url "$RPC"
  echo "Steel deployed!"
}

case "${1:-both}" in
  anchor) deploy_anchor ;;
  steel)  deploy_steel ;;
  both)   deploy_steel; deploy_anchor ;;
  *)      usage ;;
esac
