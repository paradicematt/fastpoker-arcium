#!/bin/bash
set -e
TMPWS=/tmp/poker-arc-rebuild2
rm -rf $TMPWS
mkdir -p $TMPWS/programs/fastpoker/src

cp /mnt/j/Poker-Arc/Anchor.toml $TMPWS/
cp /mnt/j/Poker-Arc/Arcium.toml $TMPWS/
cp /mnt/j/Poker-Arc/Cargo.toml $TMPWS/ 2>/dev/null || true
cp -r /mnt/j/Poker-Arc/encrypted-ixs $TMPWS/
cp /mnt/j/Poker-Arc/programs/fastpoker/Cargo.toml $TMPWS/programs/fastpoker/ 2>/dev/null || true
cp /mnt/j/Poker-Arc/programs/fastpoker/Xargo.toml $TMPWS/programs/fastpoker/ 2>/dev/null || true

# Minimal lib.rs for Anchor workspace parsing
printf 'use anchor_lang::prelude::*;\ndeclare_id!("BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N");\n' > $TMPWS/programs/fastpoker/src/lib.rs

cd $TMPWS
source ~/.cargo/env 2>/dev/null || true
RUSTUP_TOOLCHAIN=nightly arcium build --skip-program 2>&1

echo "=== Copying build artifacts ==="
cp -v $TMPWS/build/reveal_player_cards.* /mnt/j/Poker-Arc/build/
echo "=== Done ==="
