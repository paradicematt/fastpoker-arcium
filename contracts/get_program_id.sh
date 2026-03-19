#!/bin/bash
source ~/.cargo/env
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
solana-keygen pubkey /mnt/j/Poker/contracts/target/deploy/poker_program-keypair.json
