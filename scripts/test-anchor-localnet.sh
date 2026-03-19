#!/bin/bash
set -e
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
source "$HOME/.cargo/env" 2>/dev/null || true

echo "anchor version: $(anchor --version)"
echo "solana version: $(solana --version)"

cd /tmp/poker-arc-workspace
rm -rf test-ledger

echo ""
echo "=== Running: anchor localnet (foreground, 15s timeout) ==="
timeout 15 anchor localnet 2>&1 || true

echo ""
echo "=== Checking if validator started ==="
ps aux | grep solana-test-validator | grep -v grep || echo "No validator process"
solana cluster-version 2>/dev/null || echo "Validator not reachable"
