#!/bin/bash
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
solana-keygen new --outfile /mnt/j/Poker/target/deploy/fastpoker-keypair.json --force --no-bip39-passphrase
echo "New program ID:"
solana-keygen pubkey /mnt/j/Poker/target/deploy/fastpoker-keypair.json
