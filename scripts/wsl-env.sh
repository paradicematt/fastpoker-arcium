#!/bin/bash
# Source this before any WSL command to get the full environment
source ~/.cargo/env 2>/dev/null || true
# Use Solana 3.1.8 — BPF compiler has rustc 1.89.0 (compatible with Arcium SDK deps)
export SOLANA_3="/home/user/.local/share/solana/install/releases/3.1.8/solana-release/bin"
export PATH="$HOME/.cargo/bin:$SOLANA_3:$HOME/.local/share/solana/install/active_release/bin:$PATH"
