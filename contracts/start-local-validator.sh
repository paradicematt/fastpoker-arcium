#!/bin/bash
# Start local Solana test validator with the poker program

# Source cargo environment
source ~/.cargo/env

# Add solana to path
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Build the program first
echo "Building program..."
cd /mnt/j/Poker/contracts
cargo build-sbf --manifest-path program/Cargo.toml

# Start validator with program loaded
echo "Starting local validator..."
solana-test-validator \
  --reset \
  --bpf-program HGmQ1CEdxTBBwafj87HRQrUHS3BvQp2tr5fKZLc8Awaw /mnt/j/Poker/contracts/target/deploy/poker_program.so \
  --ledger /tmp/solana-test-ledger
