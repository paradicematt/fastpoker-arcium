#!/bin/bash
# Disable iptables in Docker and flush all rules
# Safe behind WSL - no external exposure

# Stop Docker
echo "Stopping Docker..."
pkill -f dockerd 2>/dev/null
sleep 2

# Configure Docker to not manage iptables
echo "Configuring Docker daemon (iptables: false)..."
mkdir -p /etc/docker
if [ -f /etc/docker/daemon.json ]; then
    # Merge iptables:false into existing config
    if command -v python3 &>/dev/null; then
        python3 -c "
import json
with open('/etc/docker/daemon.json') as f:
    cfg = json.load(f)
cfg['iptables'] = False
with open('/etc/docker/daemon.json', 'w') as f:
    json.dump(cfg, f, indent=2)
print('Updated existing daemon.json')
"
    else
        echo '{"iptables": false}' > /etc/docker/daemon.json
        echo "Overwrote daemon.json (no python3 to merge)"
    fi
else
    echo '{"iptables": false}' > /etc/docker/daemon.json
    echo "Created daemon.json"
fi

cat /etc/docker/daemon.json

# Flush all iptables
echo "Flushing iptables..."
iptables -P FORWARD ACCEPT
iptables -P INPUT ACCEPT
iptables -P OUTPUT ACCEPT
iptables -F
iptables -X
iptables -t nat -F
iptables -t nat -X
iptables -t mangle -F
iptables -t mangle -X
echo "iptables flushed"

# Restart Docker
echo "Starting Docker..."
dockerd &>/dev/null &
sleep 3

# Verify
echo ""
echo "=== Verify ==="
echo "Docker running: $(pgrep -c dockerd)"
echo "iptables FORWARD policy: $(iptables -L FORWARD -n 2>/dev/null | head -1)"
echo "iptables rules count: $(iptables -L -n 2>/dev/null | grep -c '^[A-Z]')"
docker info 2>/dev/null | grep -i iptables
