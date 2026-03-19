#!/bin/bash
# Setup script for Arcium + Docker in WSL
# Run: wsl bash /mnt/j/Poker-Arc/scripts/setup-wsl-env.sh
set -e

source ~/.cargo/env 2>/dev/null || true
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

echo "=== Step 1: Install Docker Engine in WSL ==="
# Add Docker's GPG key
sudo install -m 0755 -d /etc/apt/keyrings
if [ ! -f /etc/apt/keyrings/docker.asc ]; then
    sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    sudo chmod a+r /etc/apt/keyrings/docker.asc
fi

# Add Docker repo
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update -qq
sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Add current user to docker group (no sudo needed for docker commands after re-login)
sudo usermod -aG docker $USER

# Start Docker daemon in background (WSL doesn't use systemd by default)
if ! pgrep -x dockerd > /dev/null; then
    echo "Starting Docker daemon..."
    sudo dockerd &
    sleep 3
fi

# Verify Docker
docker --version && echo "Docker installed OK" || echo "Docker install FAILED"
docker compose version && echo "Docker Compose installed OK" || echo "Docker Compose FAILED"

echo ""
echo "=== Step 2: Install Arcium CLI ==="
# Download and run the arcium installer (deps now satisfied)
curl --proto '=https' --tlsv1.2 -sSfL https://install.arcium.com/ | bash

echo ""
echo "=== Step 3: Verify all tools ==="
echo "Rust:    $(rustc --version 2>/dev/null || echo 'MISSING')"
echo "Solana:  $(solana --version 2>/dev/null || echo 'MISSING')"
echo "Anchor:  $(anchor --version 2>/dev/null || echo 'MISSING')"
echo "Docker:  $(docker --version 2>/dev/null || echo 'MISSING')"
echo "Arcium:  $(arcium --version 2>/dev/null || echo 'MISSING')"
echo "Yarn:    $(yarn --version 2>/dev/null || echo 'MISSING')"

echo ""
echo "=== Setup complete ==="
echo "If arcium is missing, run: arcup install"
