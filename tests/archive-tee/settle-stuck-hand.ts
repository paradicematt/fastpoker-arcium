/**
 * Settle the stuck GTG93f hand on ER.
 * Uses schedule_settle (MagicBlock native crank) for proper ER state persistence.
 * 
 * Run: npx ts-node tests/settle-stuck-hand.ts
 */
import {
  Connection, Keypair, PublicKey, Transaction,
  TransactionInstruction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import * as fs from 'fs';
import * as crypto from 'crypto';

const ER_RPC = 'https://devnet.magicblock.app';
const PROGRAM_ID = new PublicKey('FTuksCXGvdrYe9uP2X9S12KLHhRZHJNsrzpxP2wk2ckR');
const MAGIC_PROGRAM = new PublicKey('Magic11111111111111111111111111111111111111');
const KEYPAIR_PATH = 'j:/critters/mini-game/deployer-keypair.json';

const TABLE_PDA = new PublicKey('GTG93fecfhxunTRvFwapp48F4LJihz3PHKrPwfCvi2kw');
const MAX_PLAYERS = 6;

const disc = (name: string) => Buffer.from(crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8));
const SETTLE_DISC = disc('settle_hand');
const SCHEDULE_SETTLE_DISC = disc('schedule_settle');

async function main() {
  const deployer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, 'utf-8')))
  );
  const er = new Connection(ER_RPC, 'confirmed');

  console.log(`Deployer: ${deployer.publicKey.toBase58()}`);
  console.log(`Table:    ${TABLE_PDA.toBase58()}`);

  // Verify table is in Showdown
  const tableInfo = await er.getAccountInfo(TABLE_PDA);
  if (!tableInfo) { console.log('Table not found on ER!'); return; }
  const phase = tableInfo.data[160];
  console.log(`Phase: ${phase} (6=Showdown)`);
  if (phase !== 6) {
    console.log(`Not in Showdown (phase=${phase}), cannot settle.`);
    return;
  }

  // Build seat + seat_cards PDAs — only occupied seats
  const occupiedSeats: PublicKey[] = [];
  const occupiedSeatCards: PublicKey[] = [];

  for (let i = 0; i < MAX_PLAYERS; i++) {
    const [seatPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('seat'), TABLE_PDA.toBuffer(), Buffer.from([i])],
      PROGRAM_ID,
    );
    const [scPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('seat_cards'), TABLE_PDA.toBuffer(), Buffer.from([i])],
      PROGRAM_ID,
    );

    const seatInfo = await er.getAccountInfo(seatPda);
    const status = seatInfo && seatInfo.data.length > 227 ? seatInfo.data[227] : -1;
    const chips = seatInfo && seatInfo.data.length > 112
      ? Number(seatInfo.data.readBigUInt64LE(104))
      : 0;
    console.log(`  Seat ${i}: status=${status}, chips=${chips}, lamports=${seatInfo?.lamports || 0}`);

    // Only include occupied seats (status > 0: Active, Folded, AllIn, etc.)
    if (seatInfo && seatInfo.lamports > 0 && status > 0) {
      occupiedSeats.push(seatPda);
      occupiedSeatCards.push(scPda);
    }
  }

  // remaining_accounts = [occupied_seats..., occupied_seat_cards...]
  const remainingAccounts = [...occupiedSeats, ...occupiedSeatCards];
  console.log(`\nOccupied seats: ${occupiedSeats.length}`);

  // === Try schedule_settle (MagicBlock native crank) ===
  console.log(`\nSending schedule_settle with ${remainingAccounts.length} remaining accounts via MagicBlock crank...`);

  // schedule_settle data: disc(8) + task_id(u64 LE) + delay_millis(u64 LE) = 24 bytes
  const schedData = Buffer.alloc(24);
  SCHEDULE_SETTLE_DISC.copy(schedData, 0);
  schedData.writeBigUInt64LE(BigInt(Date.now()), 8);  // unique task_id
  schedData.writeBigUInt64LE(BigInt(500), 16);         // 500ms delay

  const schedIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: MAGIC_PROGRAM, isSigner: false, isWritable: false },     // magic_program
      { pubkey: deployer.publicKey, isSigner: true, isWritable: true },  // payer
      { pubkey: TABLE_PDA, isSigner: false, isWritable: true },          // table
      ...remainingAccounts.map(pk => ({ pubkey: pk, isSigner: false, isWritable: true })),
    ],
    data: schedData,
  });

  try {
    const sig = await sendAndConfirmTransaction(er, new Transaction().add(schedIx), [deployer], {
      skipPreflight: true,
      commitment: 'confirmed',
    });
    console.log(`✅ schedule_settle sent: ${sig}`);
    
    // Wait for crank to execute
    console.log('⏳ Waiting 5s for crank execution...');
    await new Promise(r => setTimeout(r, 5000));

    // Verify phase changed
    const newInfo = await er.getAccountInfo(TABLE_PDA);
    if (newInfo) {
      const newPhase = newInfo.data[160];
      const newPot = Number(newInfo.data.readBigUInt64LE(131));
      console.log(`Phase: ${newPhase} (0=Waiting, 6=Showdown, 7=Complete)`);
      console.log(`Pot: ${newPot}`);
    }
  } catch (e: any) {
    console.log(`❌ schedule_settle failed: ${e.message?.slice(0, 200)}`);
    
    // Fallback: try direct settle with sendAndConfirmTransaction
    console.log('\nFallback: trying direct settle_hand...');
    const settleIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
        { pubkey: TABLE_PDA, isSigner: false, isWritable: true },
        ...remainingAccounts.map(pk => ({ pubkey: pk, isSigner: false, isWritable: true })),
      ],
      data: SETTLE_DISC,
    });
    try {
      const sig2 = await sendAndConfirmTransaction(er, new Transaction().add(settleIx), [deployer], {
        skipPreflight: true,
        commitment: 'confirmed',
      });
      console.log(`Direct settle sig: ${sig2}`);
      await new Promise(r => setTimeout(r, 2000));
      const info2 = await er.getAccountInfo(TABLE_PDA);
      if (info2) console.log(`Phase after direct settle: ${info2.data[160]}`);
    } catch (e2: any) {
      console.log(`Direct settle also failed: ${e2.message?.slice(0, 200)}`);
    }
  }
}

main().catch(console.error);
