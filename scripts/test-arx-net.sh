#!/bin/bash
# Deep diagnostic: why can't arx_network containers reach the host?

echo "=== Docker networks ==="
docker network ls

echo ""
echo "=== Remove stale arx_network and create fresh ==="
docker network rm arx_network 2>/dev/null || true
docker network create --driver bridge --subnet=172.20.0.0/16 arx_network_test
echo ""

echo "=== Start HTTP listener on 0.0.0.0:18899 ==="
python3 -c "
from http.server import HTTPServer, BaseHTTPRequestHandler
import json
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'OK')
    def do_POST(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'OK')
    def log_message(self, format, *args):
        print(f'  HIT from {self.client_address[0]}')
HTTPServer(('0.0.0.0', 18899), H).serve_forever()
" &
SRV=$!
sleep 1

echo ""
echo "=== Test from fresh arx_network_test ==="
echo -n "  172.20.0.1: "
docker run --rm --network arx_network_test curlimages/curl:latest -s -m 3 http://172.20.0.1:18899 2>/dev/null || echo "FAIL"

echo ""
echo -n "  172.17.0.1: "
docker run --rm --network arx_network_test curlimages/curl:latest -s -m 3 http://172.17.0.1:18899 2>/dev/null || echo "FAIL"

echo ""
echo -n "  172.28.77.77 (eth0): "
docker run --rm --network arx_network_test curlimages/curl:latest -s -m 3 http://172.28.77.77:18899 2>/dev/null || echo "FAIL"

echo ""
echo "=== iptables FORWARD chain ==="
iptables -L FORWARD -n -v 2>/dev/null | head -20

echo ""
echo "=== iptables DOCKER-USER chain ==="
iptables -L DOCKER-USER -n -v 2>/dev/null

echo ""
echo "=== iptables INPUT chain ==="
iptables -L INPUT -n -v 2>/dev/null | head -10

echo ""
echo "=== iptables filter for arx bridge ==="
iptables -L -n -v 2>/dev/null | grep -E 'br-|172.20'

echo ""
echo "=== Try with extra_hosts ==="
echo -n "  host-gateway: "
docker run --rm --network arx_network_test --add-host=myhost:host-gateway curlimages/curl:latest -s -m 3 http://myhost:18899 2>/dev/null || echo "FAIL"

# Cleanup
kill $SRV 2>/dev/null
docker network rm arx_network_test 2>/dev/null
echo ""
echo "=== Done ==="
