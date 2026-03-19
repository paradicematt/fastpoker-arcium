#!/bin/bash
set -e

source ~/.cargo/env
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Configuration
PROGRAM_ID="HGmQ1CEdxTBBwafj87HRQrUHS3BvQp2tr5fKZLc8Awaw"
TOKEN_MINT="PHFU61zVDiqVREWqBZiWQ76vwteYSvTbP6mAVfDiv2n"
DEPLOYER=/mnt/j/Poker/contracts/deployer-keypair.json

echo "=== Pool Initialization ==="
echo "Program ID: $PROGRAM_ID"
echo "Token Mint: $TOKEN_MINT"
echo ""

# Set to devnet
solana config set --url devnet

# Get deployer address
DEPLOYER_ADDR=$(solana-keygen pubkey $DEPLOYER)
echo "Deployer: $DEPLOYER_ADDR"

# Check balance
echo ""
echo "Checking deployer balance..."
solana balance $DEPLOYER

# Calculate Pool PDA
echo ""
echo "Calculating Pool PDA..."
# The Pool PDA is derived from seeds ["pool"] + program_id
# We'll use a TypeScript script to calculate and initialize

echo ""
echo "To initialize the pool, run the server and call:"
echo "POST /api/tokenomics/initialize"
echo ""
echo "After initialization, transfer mint authority to Pool PDA:"
echo "spl-token authorize $TOKEN_MINT mint <POOL_PDA_ADDRESS> --fee-payer $DEPLOYER"
