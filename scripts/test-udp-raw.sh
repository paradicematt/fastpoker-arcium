#!/bin/bash
# Test raw UDP connectivity between arx-node containers

echo "=== Check if python3 is available ==="
docker exec artifacts-arx-node-1-1 which python3 2>/dev/null || echo "No python3"
docker exec artifacts-arx-node-1-1 which python 2>/dev/null || echo "No python"

echo ""
echo "=== Start UDP listener on node 1 using python ==="
docker exec -d artifacts-arx-node-1-1 bash -c "python3 -c \"
import socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind(('0.0.0.0', 9999))
s.settimeout(10)
try:
    data, addr = s.recvfrom(1024)
    with open('/tmp/udp_ok', 'w') as f:
        f.write('GOT: ' + data.decode() + ' from ' + str(addr))
except:
    with open('/tmp/udp_ok', 'w') as f:
        f.write('TIMEOUT')
\" 2>/tmp/udp_err &"
sleep 2

echo "=== Send UDP from node 0 to node 1 ==="
docker exec artifacts-arx-node-0-1 bash -c "echo 'HELLO_UDP_TEST' > /dev/udp/172.20.0.101/9999" 2>&1
echo "Sent (exit=$?)"
sleep 3

echo ""
echo "=== Check result on node 1 ==="
docker exec artifacts-arx-node-1-1 bash -c "cat /tmp/udp_ok 2>/dev/null || echo 'No result file'; cat /tmp/udp_err 2>/dev/null"

echo ""
echo "=== Check routing table inside node 0 ==="
docker exec artifacts-arx-node-0-1 bash -c "cat /proc/net/route" 2>/dev/null

echo ""
echo "=== Check interfaces inside node 0 ==="
docker exec artifacts-arx-node-0-1 bash -c "ls /sys/class/net/; for iface in /sys/class/net/*/; do name=\$(basename \$iface); echo -n \"\$name: \"; cat \$iface/address 2>/dev/null; done" 2>/dev/null
