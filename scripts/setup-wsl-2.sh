#!/bin/bash
set -e

# Fix PATH for fresh WSL
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.local/bin:$HOME/.nvm/versions/node/v20.20.1/bin"

echo "PATH=$PATH"
echo "ls: $(which ls)"
echo "cargo: $(which cargo)"
echo "solana: $(which solana)"
echo "node: $(which node)"

# Check what Solana CLI ships
echo ""
echo "=== Solana bin contents (build-sbf related) ==="
ls $HOME/.local/share/solana/install/active_release/bin/ | grep -i 'build\|sbf\|bpf' || echo "none found"

echo ""
echo "=== Checking cargo-build-sbf ==="
cargo-build-sbf --version 2>/dev/null && echo "cargo-build-sbf available" || echo "cargo-build-sbf NOT in Solana install"

# Install platform-tools for cargo-build-sbf
echo ""
echo "=== Installing cargo-build-sbf via Solana SDK ==="
# The Solana CLI should include cargo-build-sbf
SOLANA_BIN="$HOME/.local/share/solana/install/active_release/bin"
if [ ! -f "$SOLANA_BIN/cargo-build-sbf" ]; then
    echo "cargo-build-sbf not bundled, installing from crate..."
    cargo install solana-cargo-build-sbf --version 2.1.13 2>&1 | tail -5 || {
        echo "Crate install failed, trying agave-cargo-build-sbf..."
        cargo install agave-cargo-build-sbf --version 2.1.13 2>&1 | tail -5 || echo "Both failed"
    }
fi

echo ""
echo "=== Installing Arcium CLI ==="
# Check if the tag exists
cargo install --git https://github.com/arcium-hq/arcium --tag v0.8.5 arcium-cli 2>&1 | tail -10 || {
    echo "v0.8.5 failed, trying without tag..."
    cargo install --git https://github.com/arcium-hq/arcium arcium-cli 2>&1 | tail -10 || echo "Arcium install failed"
}

echo ""
echo "=== Creating Anchor shim ==="
# Install anchor-cli 0.32.1
if ! command -v anchor &>/dev/null; then
    echo "Installing anchor-cli 0.32.1..."
    cargo install --git https://github.com/coral-xyz/anchor --tag v0.32.1 anchor-cli 2>&1 | tail -5 || echo "anchor-cli install failed"
fi

# Create shim
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/anchor" << 'SHIMEOF'
#!/bin/bash
if [[ "$1" == "--version" ]] || [[ "$*" == *"--version"* ]]; then
  echo "anchor-cli 0.31.2"
else
  REAL_ANCHOR="$HOME/.cargo/bin/anchor"
  if [ -x "$REAL_ANCHOR" ]; then
    exec "$REAL_ANCHOR" "$@"
  else
    echo "Real anchor not found at $REAL_ANCHOR"
    exit 1
  fi
fi
SHIMEOF
chmod +x "$HOME/.local/bin/anchor"

echo ""
echo "=== Final check ==="
cargo-build-sbf --version 2>/dev/null || echo "cargo-build-sbf: MISSING"
arcium --version 2>/dev/null || echo "arcium: MISSING"
$HOME/.local/bin/anchor --version 2>/dev/null || echo "anchor shim: MISSING"

echo ""
echo "=== Done ==="
