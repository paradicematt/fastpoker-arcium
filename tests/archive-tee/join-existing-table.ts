/**
 * Join 2 test players to an existing cash game table.
 * Usage: npx ts-node tests/join-existing-table.ts <TABLE_PDA>
 * 
 * This script:
 * 1. Funds + registers 2 test players on L1
 * 2. Joins them to the specified table
 * 3. The frontend auto-start + crank handles delegation + game start
 */
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import * as fs from 'fs';
import * as crypto from 'crypto';

// ─── Config ───
const L1_RPC = 'https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df';
const PROGRAM_ID = new PublicKey('FTuksCXGvdrYe9uP2X9S12KLHhRZHJNsrzpxP2wk2ckR');
const STEEL_PROGRAM_ID = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');
const TREASURY = new PublicKey('trsry15VbFMRC3WgVkpRLBBMqsjJ3GBEHFwVkGUonVE');
const POOL_PDA = PublicKey.findProgramAddressSync([Buffer.from('pool')], STEEL_PROGRAM_ID)[0];

const disc = (name: string) => Buffer.from(crypto.createHash('sha256').update(`global:${name}`).digest().subarray(0, 8));
const DISC = {
  registerPlayer: disc('register_player'),
  joinTable: disc('join_table'),
};

const deployer = Keypair.fromSecretKey(Uint8Array.from(
  JSON.parse(fs.readFileSync('j:/critters/mini-game/deployer-keypair.json', 'utf-8'))
));

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function sendTx(conn: Connection, signers: Keypair[], ixs: TransactionInstruction[], label: string) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: 'confirmed' });
  console.log(`  ✅ ${label}: ${sig.slice(0, 20)}...`);
  return sig;
}

function getPlayerPda(wallet: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from('player'), wallet.toBuffer()], PROGRAM_ID)[0];
}
function getSeatPda(table: PublicKey, idx: number) {
  return PublicKey.findProgramAddressSync([Buffer.from('seat'), table.toBuffer(), Buffer.from([idx])], PROGRAM_ID)[0];
}
function getMarkerPda(player: PublicKey, table: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from('player_table'), player.toBuffer(), table.toBuffer()], PROGRAM_ID)[0];
}

function ixRegister(player: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(40);
  DISC.registerPlayer.copy(data, 0);
  Buffer.alloc(32).copy(data, 8); // empty username
  return new TransactionInstruction({
    programId: PROGRAM_ID, data,
    keys: [
      { pubkey: player, isSigner: true, isWritable: true },
      { pubkey: getPlayerPda(player), isSigner: false, isWritable: true },
      { pubkey: TREASURY, isSigner: false, isWritable: true },
      { pubkey: POOL_PDA, isSigner: false, isWritable: true },
      { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

function getUnclaimedPda(table: PublicKey, player: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from('unclaimed'), table.toBuffer(), player.toBuffer()], PROGRAM_ID)[0];
}

function ixJoinTable(player: PublicKey, table: PublicKey, seatIdx: number, buyIn: bigint): TransactionInstruction {
  const data = Buffer.alloc(17);
  DISC.joinTable.copy(data, 0);
  data.writeBigUInt64LE(buyIn, 8);
  data.writeUInt8(seatIdx, 16);
  return new TransactionInstruction({
    programId: PROGRAM_ID, data,
    keys: [
      { pubkey: player, isSigner: true, isWritable: true },
      { pubkey: getPlayerPda(player), isSigner: false, isWritable: true },
      { pubkey: table, isSigner: false, isWritable: true },
      { pubkey: getSeatPda(table, seatIdx), isSigner: false, isWritable: true },
      { pubkey: getMarkerPda(player, table), isSigner: false, isWritable: true },
      { pubkey: TREASURY, isSigner: false, isWritable: true },
      { pubkey: POOL_PDA, isSigner: false, isWritable: true },
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }, // playerTokenAccount placeholder (SOL)
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }, // tableTokenAccount placeholder (SOL)
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }, // unclaimed_balance placeholder
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // token_program
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

async function main() {
  const tablePda = new PublicKey(process.argv[2] || 'GTG93fecfhxunTRvFwapp48F4LJihz3PHKrPwfCvi2kw');
  const l1 = new Connection(L1_RPC, 'confirmed');

  // Read table to get blind size
  const tableAcct = await l1.getAccountInfo(tablePda);
  if (!tableAcct) { console.error('Table not found on L1'); process.exit(1); }
  const tableData = Buffer.from(tableAcct.data);
  const bigBlind = Number(tableData.readBigUInt64LE(113));
  const currentPlayers = tableData[122];
  const maxPlayers = tableData[121];
  const buyInType = tableData[417];
  const minBB = buyInType === 1 ? 50 : 20;
  const buyInBB = buyInType === 1 ? 100 : 50;
  const buyIn = BigInt(bigBlind) * BigInt(buyInBB);

  console.log(`\n═══ Joining Table ${tablePda.toBase58().slice(0, 12)}... ═══`);
  console.log(`  BB: ${bigBlind} lamports (${bigBlind / LAMPORTS_PER_SOL} SOL)`);
  console.log(`  Buy-in: ${buyInBB} BB = ${Number(buyIn) / LAMPORTS_PER_SOL} SOL`);
  console.log(`  Current: ${currentPlayers}/${maxPlayers} players`);

  // Find first 2 seats that are empty (no PDA or status=0 Empty)
  // Contract uses init_if_needed so existing empty seat PDAs can be reused
  const emptySeats: number[] = [];
  for (let i = 0; i < maxPlayers && emptySeats.length < 2; i++) {
    const seatPda = getSeatPda(tablePda, i);
    const seatAcct = await l1.getAccountInfo(seatPda);
    if (!seatAcct) {
      console.log(`  Seat ${i}: no PDA (fresh)`);
      emptySeats.push(i);
    } else {
      const status = seatAcct.data[227];
      if (status === 0) {
        console.log(`  Seat ${i}: Empty PDA (reusable)`);
        emptySeats.push(i);
      } else {
        console.log(`  Seat ${i}: occupied (status=${status})`);
      }
    }
  }
  if (emptySeats.length < 2) {
    console.error(`Only ${emptySeats.length} empty/reusable seats found. Need 2.`);
    process.exit(1);
  }
  console.log(`  Using seats: ${emptySeats.join(', ')}`);

  // Create and fund 2 test players
  const players: Keypair[] = [];
  const fundAmt = Number(buyIn) + 60_000_000; // buy-in + 0.06 SOL for registration + fees

  for (let i = 0; i < 2; i++) {
    const kp = Keypair.generate();
    players.push(kp);
    console.log(`\n  Player ${i}: ${kp.publicKey.toBase58().slice(0, 12)}...`);

    // Fund
    await sendTx(l1, [deployer], [
      SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: kp.publicKey, lamports: fundAmt }),
    ], `fund P${i}`);

    // Register (skip if already exists)
    const playerPda = getPlayerPda(kp.publicKey);
    const existing = await l1.getAccountInfo(playerPda);
    if (!existing) {
      await sendTx(l1, [kp], [ixRegister(kp.publicKey)], `register P${i}`);
    } else {
      console.log(`  P${i} already registered`);
    }

    // Join table
    await sendTx(l1, [kp], [ixJoinTable(kp.publicKey, tablePda, emptySeats[i], buyIn)], `P${i} join seat ${emptySeats[i]}`);
  }

  console.log(`\n═══ Done! ${players.length} players joined ═══`);
  console.log('  Frontend auto-start should trigger delegation + game start.');
  console.log('  Players will play via the crank (timeout → auto-actions).\n');

  // Save keypairs for later use (play actions, leave, etc.)
  const keypairData = players.map((p, i) => ({
    index: i,
    seat: emptySeats[i],
    pubkey: p.publicKey.toBase58(),
    secretKey: Array.from(p.secretKey),
  }));
  fs.writeFileSync('tests/test-players.json', JSON.stringify(keypairData, null, 2));
  console.log('  Keypairs saved to tests/test-players.json');
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
