#!/bin/bash
# One-time setup: allow Docker containers to reach localhost services (e.g. solana-test-validator)
# Run: wsl sudo bash /mnt/j/Poker-Arc/scripts/setup-docker-networking.sh
#
# This is needed because solana-test-validator binds to 127.0.0.1 but Docker
# containers access the host via bridge gateway IPs (172.17.0.1 / 172.20.0.1).
# These rules DNAT bridge traffic to localhost. They persist until WSL reboots.

set -e

sysctl -w net.ipv4.conf.all.route_localnet=1

iptables -t nat -C PREROUTING -p tcp -d 172.17.0.0/16 --dport 8899 -j DNAT --to-destination 127.0.0.1:8899 2>/dev/null \
  || iptables -t nat -A PREROUTING -p tcp -d 172.17.0.0/16 --dport 8899 -j DNAT --to-destination 127.0.0.1:8899

iptables -t nat -C PREROUTING -p tcp -d 172.20.0.0/16 --dport 8899 -j DNAT --to-destination 127.0.0.1:8899 2>/dev/null \
  || iptables -t nat -A PREROUTING -p tcp -d 172.20.0.0/16 --dport 8899 -j DNAT --to-destination 127.0.0.1:8899

echo "Docker→Host networking configured. Rules persist until WSL reboots."
