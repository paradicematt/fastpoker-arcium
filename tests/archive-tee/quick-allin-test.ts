/**
 * Quick All-In Test: Creates a HU game, sends All-In + Call immediately,
 * waits for crank to settle → complete → mint tokens.
 * Runs entirely server-side — no Playwright/UI latency.
 */
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import * as fs from 'fs';
import * as crypto from 'crypto';

const PROGRAM_ID = new PublicKey('FTuksCXGvdrYe9uP2X9S12KLHhRZHJNsrzpxP2wk2ckR');
const ER_RPC = 'https://devnet.magicblock.app';
const L1_RPC = 'https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df';
const STEEL_PROGRAM = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');

const PLAYER_ACTION_DISC = Buffer.from(
  crypto.createHash('sha256').update('global:player_action').digest().slice(0, 8)
);

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, 'utf-8'))));
}

function getSeatPda(table: PublicKey, idx: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('seat'), table.toBuffer(), Buffer.from([idx])],
    PROGRAM_ID
  )[0];
}

function getUnrefinedPda(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('unrefined'), owner.toBuffer()],
    STEEL_PROGRAM
  )[0];
}

async function sendAction(er: Connection, player: Keypair, table: PublicKey, seatIdx: number, action: number, amount = 0) {
  const seatPda = getSeatPda(table, seatIdx);
  const data = Buffer.alloc(17);
  PLAYER_ACTION_DISC.copy(data, 0);
  data.writeUInt8(action, 8);
  data.writeBigUInt64LE(BigInt(amount), 9);

  const tx = new Transaction().add({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: player.publicKey, isSigner: true, isWritable: true },
      { pubkey: table, isSigner: false, isWritable: true },
      { pubkey: seatPda, isSigner: false, isWritable: true },
    ],
    data,
  });
  tx.feePayer = player.publicKey;
  tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
  return sendAndConfirmTransaction(er, tx, [player], { skipPreflight: true });
}

async function main() {
  const er = new Connection(ER_RPC, 'confirmed');
  const l1 = new Connection(L1_RPC, 'confirmed');
  const deployer = loadKeypair('j:/critters/mini-game/deployer-keypair.json');
  const player2 = loadKeypair('J:/Poker/tests/keys/player2.json');

  console.log(`P1: ${deployer.publicKey.toBase58().slice(0, 12)}...`);
  console.log(`P2: ${player2.publicKey.toBase58().slice(0, 12)}...`);

  // 1. Quick Start via API (localhost:3001)
  console.log('\n=== Quick Start ===');
  const res = await fetch('http://localhost:3000/api/sitngos/quick-start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const qs = await res.json() as any;
  if (qs.error) { console.error('Quick Start failed:', qs.error); return; }
  const tablePda = new PublicKey(qs.tablePda);
  console.log(`Table: ${tablePda.toBase58()}`);

  // 2. Poll for Preflop (phase=2) — tight loop
  console.log('\n=== Waiting for Preflop ===');
  let phase = -1;
  let currentPlayer = -1;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    const info = await er.getAccountInfo(tablePda);
    if (info && info.data.length >= 256) {
      phase = info.data[160];
      currentPlayer = info.data[161];
      const pot = Number(Buffer.from(info.data).readBigUInt64LE(131));
      if (phase === 2) {
        console.log(`  Preflop detected! Current player: seat ${currentPlayer}, Pot: ${pot}`);
        break;
      }
      console.log(`  Phase: ${phase}, waiting...`);
    }
  }
  if (phase !== 2) { console.error('Never reached Preflop'); return; }

  // 3. Immediately send All-In for current player
  const actingPlayer = currentPlayer === 0 ? deployer : player2;
  const otherPlayer = currentPlayer === 0 ? player2 : deployer;
  const otherSeat = currentPlayer === 0 ? 1 : 0;

  console.log(`\n=== Seat ${currentPlayer} ALL-IN ===`);
  try {
    const sig1 = await sendAction(er, actingPlayer, tablePda, currentPlayer, 5); // AllIn
    console.log(`  All-In sig: ${sig1.slice(0, 24)}...`);
  } catch (e: any) {
    console.error(`  All-In failed: ${e.message?.slice(0, 100)}`);
    return;
  }

  // 4. Small delay, then Call for the other player
  await new Promise(r => setTimeout(r, 1000));
  console.log(`\n=== Seat ${otherSeat} CALL ===`);
  try {
    const sig2 = await sendAction(er, otherPlayer, tablePda, otherSeat, 2); // Call
    console.log(`  Call sig: ${sig2.slice(0, 24)}...`);
  } catch (e: any) {
    console.error(`  Call failed: ${e.message?.slice(0, 100)}`);
    return;
  }

  // 5. Wait for crank to settle → complete → distribute → mint
  console.log('\n=== Waiting for crank to process (settle → complete → mint) ===');
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));
    // Check ER first
    const erInfo = await er.getAccountInfo(tablePda);
    if (erInfo && erInfo.data.length >= 256) {
      const p = erInfo.data[160];
      const pot = Number(Buffer.from(erInfo.data).readBigUInt64LE(131));
      const players = erInfo.data[122];
      console.log(`  [ER] Phase: ${p} | Pot: ${pot} | Players: ${players}`);
      if (p === 7) { // Complete
        console.log('  Game COMPLETE on ER!');
        break;
      }
    }
    // Check L1 for Complete (after undelegation)
    const l1Info = await l1.getAccountInfo(tablePda);
    if (l1Info && l1Info.data.length >= 256) {
      const p = l1Info.data[160];
      if (p === 7) {
        console.log('  Game COMPLETE on L1!');
        break;
      }
    }
  }

  // 6. Wait a bit more for distribute_prizes + mint_unrefined
  console.log('\n=== Waiting 15s for prize distribution + token minting ===');
  await new Promise(r => setTimeout(r, 15000));

  // 7. Check Unrefined PDAs for both players
  console.log('\n=== Checking Unrefined PDAs ===');
  for (const [label, kp] of [['P1', deployer], ['P2', player2]] as [string, Keypair][]) {
    const pda = getUnrefinedPda(kp.publicKey);
    const info = await l1.getAccountInfo(pda);
    if (!info) {
      console.log(`  ${label} (${kp.publicKey.toBase58().slice(0, 12)}...): No Unrefined PDA`);
    } else {
      const d = Buffer.from(info.data);
      const unrefined = Number(d.readBigUInt64LE(40));
      console.log(`  ${label} (${kp.publicKey.toBase58().slice(0, 12)}...): ${unrefined / 1e6} POKER unrefined`);
    }
  }

  console.log('\n=== DONE ===');
}

main().catch(console.error);
