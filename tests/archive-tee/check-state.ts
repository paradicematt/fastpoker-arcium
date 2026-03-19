import { Connection, PublicKey } from '@solana/web3.js';

const t = new PublicKey(process.argv[2] || '2chuZGVXgJwanHHmS9Uidvrka5XNQdYyAnmWXDqBHrSD');
const c = new Connection('https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df');

(async () => {
  const a = await c.getAccountInfo(t);
  if (!a) { console.log('No table'); return; }
  
  // Table struct layout:
  // 8 disc + 32 table_id + 32 authority + 32 pool + 1 game_type + 8 sb + 8 bb + 1 max + 1 current_players
  // + 8 hand + 8 pot + 8 min_bet + 8 rake + 5 cards + 1 phase + 1 current_player + 1 actions
  // + 1 dealer_button + 1 sb_seat + 1 bb_seat
  
  const cardsOffset = 8+32+32+32+1+8+8+1+1+8+8+8+8; // = 155
  const phaseOffset = cardsOffset + 5; // = 160
  const currentPlayerOffset = phaseOffset + 1; // = 161
  const actionsOffset = currentPlayerOffset + 1; // = 162
  const dealerOffset = actionsOffset + 1; // = 163
  const sbSeatOffset = dealerOffset + 1; // = 164
  const bbSeatOffset = sbSeatOffset + 1; // = 165
  
  const cards = Array.from(a.data.slice(cardsOffset, cardsOffset+5));
  const phases = ['Waiting', 'Starting', 'Preflop', 'Flop', 'Turn', 'River', 'Showdown', 'Complete'];
  
  // More offsets after bb_seat
  const lastActionSlotOffset = bbSeatOffset + 1; // 8 bytes
  const isDelegatedOffset = lastActionSlotOffset + 8; // 1 byte
  const deckCommitmentOffset = isDelegatedOffset + 1; // 32 bytes
  const deckSeedOffset = deckCommitmentOffset + 32; // 32 bytes
  const deckIndexOffset = deckSeedOffset + 32; // 1 byte
  const stakesLevelOffset = deckIndexOffset + 1; // 1 byte
  const blindLevelOffset = stakesLevelOffset + 1; // 1 byte
  const tournamentStartOffset = blindLevelOffset + 1; // 8 bytes
  const seatsOccupiedOffset = tournamentStartOffset + 8; // 2 bytes (u16)
  const seatsAllinOffset = seatsOccupiedOffset + 2; // 2 bytes
  const seatsFoldedOffset = seatsAllinOffset + 2; // 2 bytes
  
  const seatsOccupied = a.data.readUInt16LE(seatsOccupiedOffset);
  const seatsAllin = a.data.readUInt16LE(seatsAllinOffset);
  const seatsFolded = a.data.readUInt16LE(seatsFoldedOffset);
  
  // Additional fields for debugging
  const actionsThisRound = a.data[actionsOffset];
  const pot = a.data.readBigUInt64LE(8+32+32+32+1+8+8+1+1+8); // pot offset
  const minBet = a.data.readBigUInt64LE(8+32+32+32+1+8+8+1+1+8+8); // min_bet offset
  
  console.log('Community cards:', cards);
  console.log('Phase:', a.data[phaseOffset], '=', phases[a.data[phaseOffset]]);
  console.log('Current player:', a.data[currentPlayerOffset]);
  console.log('Dealer button:', a.data[dealerOffset]);
  console.log('SB seat:', a.data[sbSeatOffset], '| BB seat:', a.data[bbSeatOffset]);
  console.log('Actions this round:', actionsThisRound);
  console.log('Pot:', pot.toString(), '| Min bet:', minBet.toString());
  console.log('Seats occupied:', seatsOccupied.toString(2).padStart(4, '0'), `(seat0=${seatsOccupied & 1}, seat1=${(seatsOccupied >> 1) & 1})`);
  console.log('Seats folded:', seatsFolded.toString(2).padStart(4, '0'));
  console.log('Seats allin:', seatsAllin.toString(2).padStart(4, '0'));
})();
