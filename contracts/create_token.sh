#!/bin/bash
set -e

source ~/.cargo/env
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Set to devnet
solana config set --url devnet

DEPLOYER=/mnt/j/Poker/contracts/deployer-keypair.json
PROGRAM_ID="HGmQ1CEdxTBBwafj87HRQrUHS3BvQp2tr5fKZLc8Awaw"

# First create the token with deployer as temp authority
echo "Creating POKER token mint..."
TOKEN_OUTPUT=$(spl-token create-token --decimals 6 --fee-payer $DEPLOYER 2>&1)
echo "$TOKEN_OUTPUT"

# Extract token address
TOKEN_MINT=$(echo "$TOKEN_OUTPUT" | grep "Creating token" | awk '{print $3}')
echo ""
echo "Token Mint: $TOKEN_MINT"
echo ""
echo "NOTE: After initializing the pool, transfer mint authority to the Pool PDA"
echo "The program will then be the only entity that can mint POKER tokens."
