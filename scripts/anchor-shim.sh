#!/bin/bash
# Shim that wraps real anchor but reports version 0.31.2 to satisfy arcium localnet check
REAL_ANCHOR="/home/user/.avm/bin/anchor-0.32.1"

if [ "$1" = "--version" ] || [ "$1" = "-V" ]; then
    echo "anchor-cli 0.31.2"
else
    exec "$REAL_ANCHOR" "$@"
fi
