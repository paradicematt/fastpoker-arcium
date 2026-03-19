#!/bin/bash
# Install Arcium CLI with Docker daemon running
# Run: wsl sudo bash /mnt/j/Poker-Arc/scripts/install-arcium.sh
set -e

# Source environment
source /home/user/.cargo/env 2>/dev/null || true
export PATH="/home/user/.cargo/bin:/home/user/.local/share/solana/install/active_release/bin:$PATH"

# Start Docker daemon if not running
if ! docker info > /dev/null 2>&1; then
    echo "Starting Docker daemon..."
    dockerd > /tmp/dockerd.log 2>&1 &
    DOCKER_PID=$!
    
    # Wait for Docker to be ready (up to 30 seconds)
    for i in $(seq 1 30); do
        if docker info > /dev/null 2>&1; then
            echo "Docker daemon started (took ${i}s)"
            break
        fi
        sleep 1
    done
    
    if ! docker info > /dev/null 2>&1; then
        echo "ERROR: Docker daemon failed to start. Check /tmp/dockerd.log"
        exit 1
    fi
fi

echo "Docker is running: $(docker --version)"

# Run arcup install
echo "Installing Arcium CLI..."
/home/user/.cargo/bin/arcup install

echo ""
echo "Verifying..."
arcium --version 2>/dev/null && echo "Arcium CLI installed OK" || echo "Arcium CLI not found"
