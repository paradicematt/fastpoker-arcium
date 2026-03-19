import { Connection, PublicKey } from '@solana/web3.js';

const TABLE_PDA = 'FA7WuvUA15fZMy65widmtPQezGWZm5vqoTeAVi4digjJ';
const PROGRAM_ID = new PublicKey('4MLbuVZzXpzWcaZaqxHDkm5JuigZzovsVd6VPNDXnyiB');
const L1_RPC = 'https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df';
const ER_RPC = 'https://devnet-us.magicblock.app';

const PHASE_NAMES = ['Waiting','Starting','Preflop','Flop','Turn','River','Showdown','Complete'];
const GAME_TYPE_NAMES = ['Heads-Up','6-Max','9-Max','Cash'];
const SEAT_STATUS_NAMES = ['Empty','Active','Folded','AllIn','SittingOut','Eliminated'];

async function checkTable() {
  const tablePubkey = new PublicKey(TABLE_PDA);
  const l1 = new Connection(L1_RPC, 'confirmed');
  const er = new Connection(ER_RPC, 'confirmed');

  for (const [label, conn] of [['L1', l1], ['ER', er]] as const) {
    console.log(`\n=== ${label} ===`);
    const info = await conn.getAccountInfo(tablePubkey);
    if (!info) {
      console.log('  Table NOT FOUND');
      continue;
    }
    const d = Buffer.from(info.data);
    console.log(`  Owner: ${info.owner.toBase58()}`);
    console.log(`  Data length: ${d.length}`);
    console.log(`  Lamports: ${info.lamports}`);

    if (d.length < 175) {
      console.log('  Data too short to parse');
      continue;
    }

    const authority = new PublicKey(d.slice(40, 72)).toBase58();
    const gameType = d[104];
    const maxPlayers = d[121];
    const currentPlayers = d[122];
    const handNumber = Number(d.readBigUInt64LE(123));
    const pot = Number(d.readBigUInt64LE(131));
    const phase = d[160];
    const currentPlayer = d[161];
    const dealerSeat = d[163];
    const lastActionSlot = Number(d.readBigUInt64LE(166));
    const isDelegated = d[174] !== 0;
    const seatsOccupied = d.length > 251 ? d.readUInt16LE(250) : 0;

    console.log(`  Authority: ${authority}`);
    console.log(`  Game Type: ${GAME_TYPE_NAMES[gameType] || gameType}`);
    console.log(`  Phase: ${PHASE_NAMES[phase] || phase} (${phase})`);
    console.log(`  Max Players: ${maxPlayers}`);
    console.log(`  Current Players: ${currentPlayers}`);
    console.log(`  Hand #: ${handNumber}`);
    console.log(`  Pot: ${pot}`);
    console.log(`  Current Player: ${currentPlayer}`);
    console.log(`  Dealer Seat: ${dealerSeat}`);
    console.log(`  Last Action Slot: ${lastActionSlot}`);
    console.log(`  Is Delegated: ${isDelegated}`);
    console.log(`  Seats Occupied Bitmask: ${seatsOccupied.toString(2).padStart(9, '0')}`);

    // Check seats
    for (let i = 0; i < maxPlayers; i++) {
      const [seatPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('seat'), tablePubkey.toBuffer(), Buffer.from([i])],
        PROGRAM_ID,
      );
      const seatInfo = await conn.getAccountInfo(seatPda);
      if (!seatInfo) {
        console.log(`  Seat ${i}: NOT FOUND`);
        continue;
      }
      const sd = Buffer.from(seatInfo.data);
      const wallet = new PublicKey(sd.slice(8, 40)).toBase58();
      const chips = sd.length >= 112 ? Number(sd.readBigUInt64LE(104)) : 0;
      const bet = sd.length >= 120 ? Number(sd.readBigUInt64LE(112)) : 0;
      const status = sd.length >= 228 ? sd[227] : -1;
      console.log(`  Seat ${i}: wallet=${wallet.slice(0,8)}... chips=${chips} bet=${bet} status=${SEAT_STATUS_NAMES[status] || status} (${status}) owner=${seatInfo.owner.toBase58().slice(0,8)}...`);
    }

    // Check delegation record
    try {
      const { delegationRecordPdaFromDelegatedAccount } = await import('@magicblock-labs/ephemeral-rollups-sdk');
      const delRecord = delegationRecordPdaFromDelegatedAccount(tablePubkey);
      const delInfo = await l1.getAccountInfo(delRecord);
      console.log(`  Delegation record: ${delInfo ? 'EXISTS' : 'NOT FOUND'}`);
    } catch (e: any) {
      console.log(`  Delegation record check failed: ${e.message?.slice(0, 40)}`);
    }
  }
}

checkTable().catch(console.error);
