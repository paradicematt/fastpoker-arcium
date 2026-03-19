#!/bin/bash
# Diagnose and fix Docker→validator connectivity

echo "=== WSL2 network interfaces ==="
ip addr show | grep -E 'inet |^[0-9]' | head -20

echo ""
echo "=== host.docker.internal resolves to ==="
getent hosts host.docker.internal 2>/dev/null || echo "Not resolvable on host"

echo ""
echo "=== Can container reach bridge gateway (172.17.0.1:8899)? ==="
# Start a temp validator listener first
python3 -c "
import socket, threading, time
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('0.0.0.0', 18899))
s.listen(1)
s.settimeout(5)
try:
    conn, addr = s.accept()
    print(f'Connection from {addr}')
    conn.close()
except:
    print('No connection received')
s.close()
" &
DUMMY_PID=$!

# Test from container
docker run --rm alpine sh -c "
echo 'Testing 172.17.0.1:8899...'
timeout 3 wget -q -O- http://172.17.0.1:8899 2>&1 | head -1 || echo 'FAILED: 172.17.0.1:8899'

echo 'Testing 10.10.10.122:8899...'
timeout 3 wget -q -O- http://10.10.10.122:8899 2>&1 | head -1 || echo 'FAILED: 10.10.10.122:8899'

echo 'Testing host.docker.internal:8899...'
timeout 3 wget -q -O- http://host.docker.internal:8899 2>&1 | head -1 || echo 'FAILED: host.docker.internal:8899'

echo 'Route table:'
ip route 2>/dev/null || route -n 2>/dev/null
"

kill $DUMMY_PID 2>/dev/null

echo ""
echo "=== Current iptables NAT ==="
iptables -t nat -L PREROUTING -n 2>/dev/null
iptables -t nat -L OUTPUT -n 2>/dev/null | head -10

echo ""
echo "=== Fix: Add DNAT for host.docker.internal IP ==="
# host.docker.internal = 10.10.10.122 — add DNAT rule
iptables -t nat -C PREROUTING -p tcp -d 10.10.10.122 --dport 8899 -j DNAT --to-destination 127.0.0.1:8899 2>/dev/null \
    || iptables -t nat -A PREROUTING -p tcp -d 10.10.10.122 --dport 8899 -j DNAT --to-destination 127.0.0.1:8899
echo "Added DNAT for 10.10.10.122:8899 → 127.0.0.1:8899"

# Also for websocket port 8900
iptables -t nat -C PREROUTING -p tcp -d 10.10.10.122 --dport 8900 -j DNAT --to-destination 127.0.0.1:8900 2>/dev/null \
    || iptables -t nat -A PREROUTING -p tcp -d 10.10.10.122 --dport 8900 -j DNAT --to-destination 127.0.0.1:8900
echo "Added DNAT for 10.10.10.122:8900 → 127.0.0.1:8900"
