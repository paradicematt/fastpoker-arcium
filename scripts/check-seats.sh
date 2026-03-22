#!/bin/bash
source ~/.nvm/nvm.sh 2>/dev/null
export PATH="$HOME/.local/share/solana/install/releases/2.1.21/solana-release/bin:$PATH"
RPC="http://127.0.0.1:8899"
PROGRAM="BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N"
TABLE="BJ7E3VoTy8H5HrMUPnL6jsTXzybr5Up9B7CD1fkWCG2h"

echo "=== Seat States for ${TABLE:0:12} ==="

for i in 0 1; do
  SEAT_PDA=$(node -e "
    const {PublicKey} = require('@solana/web3.js');
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('seat'), new PublicKey('$TABLE').toBuffer(), Buffer.from([$i])],
      new PublicKey('$PROGRAM')
    );
    console.log(pda.toBase58());
  ")
  echo ""
  echo "--- Seat $i: $SEAT_PDA ---"
  DATA=$(solana account "$SEAT_PDA" --url "$RPC" --output json 2>/dev/null)
  if [ -z "$DATA" ]; then
    echo "  NOT FOUND"
    continue
  fi
  node -e "
    const data = Buffer.from(JSON.parse(process.argv[1]).account.data[0], 'base64');
    // PlayerSeat layout: disc(8) + table(32) + player(32) + seat_index(1) + status(1) + chips(8) + ...
    const player = Buffer.from(data.slice(8, 40)).reverse();
    const playerB58 = require('@solana/web3.js').PublicKey.decode ? 'raw' : 'n/a';
    const seatIdx = data[72];
    const status = data[73];
    const chips = data.readBigUInt64LE(74);
    const sitOutTime = data.readBigInt64LE(82);
    const lastAction = data.readBigInt64LE(90);
    // x25519 pubkey at offset 98 (32 bytes)
    const x25519 = data.slice(98, 130);
    const hasX25519 = !x25519.every(b => b === 0);
    const statuses = ['Empty','Occupied','SittingOut','Leaving','Eliminated','Reserved'];
    console.log('  Player:', new (require('@solana/web3.js').PublicKey)(data.slice(8, 40)).toBase58().slice(0,12) + '..');
    console.log('  Status:', statuses[status] || status, '(' + status + ')');
    console.log('  Chips:', chips.toString());
    console.log('  SitOutTime:', sitOutTime.toString());
    console.log('  LastAction:', lastAction.toString());
    console.log('  x25519:', hasX25519 ? x25519.toString('hex').slice(0,16) + '..' : 'EMPTY');
  " "$DATA"
done
