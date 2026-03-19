#!/bin/bash
source "$HOME/.cargo/env"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
mkdir -p ~/.config/solana
solana-keygen new --no-bip39-passphrase --force -o ~/.config/solana/id.json
solana config set --url http://127.0.0.1:8899
solana address
echo "Keypair generated and config set to localnet"
# Copy for E2E tests
cp ~/.config/solana/id.json /mnt/j/Poker-Arc/backend/.localnet-keypair.json
echo "Copied to backend/.localnet-keypair.json"
