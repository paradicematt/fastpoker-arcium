#!/bin/bash
# Test Docker→host connectivity with a simple HTTP listener

echo "=== Start simple HTTP listener on 0.0.0.0:18899 ==="
python3 -c "
from http.server import HTTPServer, BaseHTTPRequestHandler
import json, threading
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        self.send_response(200)
        self.send_header('Content-type','application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'result':'ok'}).encode())
    def log_message(self, format, *args):
        print(f'  Request from {self.client_address[0]}')
HTTPServer(('0.0.0.0', 18899), H).serve_forever()
" &
SRV_PID=$!
sleep 1

echo "=== From host ==="
curl -s -m 3 http://127.0.0.1:18899 -X POST -d '{}' 2>/dev/null && echo "" || echo "FAIL"
curl -s -m 3 http://172.17.0.1:18899 -X POST -d '{}' 2>/dev/null && echo "" || echo "FAIL 172.17.0.1"
curl -s -m 3 http://172.20.0.1:18899 -X POST -d '{}' 2>/dev/null && echo "" || echo "FAIL 172.20.0.1"

echo ""
echo "=== From container (default bridge) ==="
echo -n "  host.docker.internal: "
docker run --rm curlimages/curl:latest -s -m 5 http://host.docker.internal:18899 -X POST -d '{}' 2>/dev/null || echo "FAIL"
echo ""
echo -n "  172.17.0.1: "
docker run --rm curlimages/curl:latest -s -m 5 http://172.17.0.1:18899 -X POST -d '{}' 2>/dev/null || echo "FAIL"
echo ""

echo ""
echo "=== From container (arx_network 172.20.0.0/16) ==="
docker network create --subnet=172.20.0.0/16 arx_network 2>/dev/null || true
echo -n "  host.docker.internal: "
docker run --rm --network arx_network curlimages/curl:latest -s -m 5 http://host.docker.internal:18899 -X POST -d '{}' 2>/dev/null || echo "FAIL"
echo ""
echo -n "  172.20.0.1: "
docker run --rm --network arx_network curlimages/curl:latest -s -m 5 http://172.20.0.1:18899 -X POST -d '{}' 2>/dev/null || echo "FAIL"
echo ""

kill $SRV_PID 2>/dev/null
echo ""
echo "Done"
