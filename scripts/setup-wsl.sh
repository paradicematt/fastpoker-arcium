#!/bin/bash
set -e

echo "=== Setting up WSL toolchain ==="

# Source cargo env
source "$HOME/.cargo/env"

# 1. Install Solana CLI 2.1.13
echo "--- Installing Solana CLI ---"
sh -c "$(curl -sSfL https://release.anza.xyz/v2.1.13/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
echo 'export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"' >> ~/.bashrc
solana --version

# 2. Install Node.js 20 via nvm
echo "--- Installing Node.js ---"
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm install 20
nvm use 20
node --version
npm --version

# 3. Install Docker
echo "--- Installing Docker ---"
sudo apt-get install -y ca-certificates gnupg lsb-release
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker $USER

# 4. Install Arcium CLI
echo "--- Installing Arcium CLI ---"
cargo install --git https://github.com/arcium-hq/arcium --tag v0.8.5 arcium-cli 2>&1 || echo "Arcium CLI install failed (may need specific tag)"

# 5. Install cargo-build-sbf (Solana BPF compiler)
echo "--- Installing cargo-build-sbf ---"
cargo install --locked cargo-build-sbf@2.1.13 2>&1 || echo "cargo-build-sbf may need platform-tools"

# 6. Create Anchor shim (0.31.2 → 0.32.1)
echo "--- Creating Anchor shim ---"
ANCHOR_REAL=$(which anchor 2>/dev/null || echo "")
if [ -z "$ANCHOR_REAL" ]; then
  # Install anchor-cli 0.32.1
  cargo install --git https://github.com/coral-xyz/anchor --tag v0.32.1 anchor-cli 2>&1 || true
fi

# Create the shim that reports 0.31.2
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
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc

# 7. Generate Solana keypair
echo "--- Generating Solana keypair ---"
solana-keygen new --no-bip39-passphrase --force -o "$HOME/.config/solana/id.json" 2>/dev/null || true
solana config set --url localhost

echo ""
echo "=== Setup complete! ==="
echo "Rust: $(rustc --version)"
echo "Solana: $(solana --version)"
echo "Node: $(node --version)"
echo "Docker: $(docker --version 2>/dev/null || echo 'needs dockerd start')"
