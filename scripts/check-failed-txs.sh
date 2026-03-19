#!/bin/bash
echo "=== Recent failed TXs on FastPoker program ==="
curl -s http://localhost:8899 -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getSignaturesForAddress","params":["BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N",{"limit":20}]}' 2>/dev/null | python3 -c "
import json, sys
data = json.load(sys.stdin)
for sig in data.get('result', []):
    err = sig.get('err')
    if err:
        print(f'FAILED: {sig[\"signature\"][:30]}... err={err}')
"

echo ""
echo "=== Recent failed TXs on Arcium program ==="
curl -s http://localhost:8899 -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getSignaturesForAddress","params":["Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ",{"limit":20}]}' 2>/dev/null | python3 -c "
import json, sys
data = json.load(sys.stdin)
for sig in data.get('result', []):
    err = sig.get('err')
    slot = sig.get('slot', '?')
    if err:
        print(f'FAILED slot={slot}: {sig[\"signature\"][:30]}... err={err}')
    else:
        print(f'OK     slot={slot}: {sig[\"signature\"][:30]}...')
"

echo ""
echo "=== Get detailed logs for last failed TX ==="
# Find first failed TX sig
FAILED_SIG=$(curl -s http://localhost:8899 -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getSignaturesForAddress","params":["Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ",{"limit":20}]}' 2>/dev/null | python3 -c "
import json, sys
data = json.load(sys.stdin)
for sig in data.get('result', []):
    if sig.get('err'):
        print(sig['signature'])
        break
" 2>/dev/null)

if [ -n "$FAILED_SIG" ]; then
    echo "Failed TX: $FAILED_SIG"
    curl -s http://localhost:8899 -X POST -H "Content-Type: application/json" \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getTransaction\",\"params\":[\"$FAILED_SIG\",{\"encoding\":\"json\",\"maxSupportedTransactionVersion\":0}]}" 2>/dev/null | python3 -c "
import json, sys
data = json.load(sys.stdin)
result = data.get('result')
if result:
    meta = result.get('meta', {})
    print(f'err: {meta.get(\"err\")}')
    print(f'logs:')
    for log in meta.get('logMessages', []):
        print(f'  {log}')
    tx = result.get('transaction', {})
    msg = tx.get('message', {})
    print(f'instructions: {len(msg.get(\"instructions\", []))}')
    for i, ix in enumerate(msg.get('instructions', [])):
        print(f'  ix[{i}]: programIdIndex={ix.get(\"programIdIndex\")} accounts={ix.get(\"accounts\")}')
    print(f'accountKeys: {msg.get(\"accountKeys\", [])}')
else:
    print('No result (TX not found — might be simulated only, never landed)')
" 2>/dev/null
else
    echo "No failed TXs found"
fi
