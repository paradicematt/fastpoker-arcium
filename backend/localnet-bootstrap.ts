/**
 * Localnet Bootstrap — Run ONCE before E2E tests to set up on-chain state.
 * Creates: POKER mint, Steel pool, dealer registry, test cash tables.
 * 
 * Usage: npx ts-node --transpile-only localnet-bootstrap.ts
 */
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo,
} from '@solana/spl-token';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8899';
const ANCHOR_PROGRAM_ID = new PublicKey('BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N');
const STEEL_PROGRAM_ID = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');
const TREASURY = new PublicKey('4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3');

function pda(seeds: Buffer[], prog: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, prog)[0];
}
const getPool = () => pda([Buffer.from('pool')], STEEL_PROGRAM_ID);
const getTable = (id: Buffer) => pda([Buffer.from('table'), id], ANCHOR_PROGRAM_ID);
const getSeat = (t: PublicKey, i: number) => pda([Buffer.from('seat'), t.toBuffer(), Buffer.from([i])], ANCHOR_PROGRAM_ID);
const getSeatCards = (t: PublicKey, i: number) => pda([Buffer.from('seat_cards'), t.toBuffer(), Buffer.from([i])], ANCHOR_PROGRAM_ID);
const getDeckState = (t: PublicKey) => pda([Buffer.from('deck_state'), t.toBuffer()], ANCHOR_PROGRAM_ID);
const getVault = (t: PublicKey) => pda([Buffer.from('vault'), t.toBuffer()], ANCHOR_PROGRAM_ID);
const getReceipt = (t: PublicKey, i: number) => pda([Buffer.from('receipt'), t.toBuffer(), Buffer.from([i])], ANCHOR_PROGRAM_ID);
const getTallyEr = (t: PublicKey) => pda([Buffer.from('crank_tally_er'), t.toBuffer()], ANCHOR_PROGRAM_ID);
const getTallyL1 = (t: PublicKey) => pda([Buffer.from('crank_tally_l1'), t.toBuffer()], ANCHOR_PROGRAM_ID);
const getDealerReg = () => pda([Buffer.from('dealer_registry')], ANCHOR_PROGRAM_ID);
const getPlayer = (w: PublicKey) => pda([Buffer.from('player'), w.toBuffer()], ANCHOR_PROGRAM_ID);
const getUnrefined = (w: PublicKey) => pda([Buffer.from('unrefined'), w.toBuffer()], STEEL_PROGRAM_ID);

function disc(name: string): Buffer {
  return Buffer.from(crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8));
}

const STATE_FILE = path.join(__dirname, '.localnet-state.json');
const CLIENT_ENV = path.join(__dirname, '..', 'client', '.env.local');

async function send(c: Connection, ix: TransactionInstruction, signers: Keypair[], label: string): Promise<boolean> {
  try {
    await sendAndConfirmTransaction(c, new Transaction().add(ix), signers, { commitment: 'confirmed', skipPreflight: true });
    return true;
  } catch (e: any) {
    console.log(`  ❌ ${label}: ${e.message?.slice(0, 200)}`);
    if (e.logs) e.logs.slice(-3).forEach((l: string) => console.log(`     ${l}`));
    return false;
  }
}

function serializeCfg(id: Buffer, gt: number, st: number, mp: number, tier: number) {
  const b = Buffer.alloc(36); id.copy(b); b.writeUInt8(gt, 32); b.writeUInt8(st, 33); b.writeUInt8(mp, 34); b.writeUInt8(tier, 35); return b;
}

async function main() {
  const conn = new Connection(RPC_URL, 'confirmed');
  console.log('🔧 Localnet Bootstrap');
  console.log(`  RPC: ${RPC_URL}`);

  // Check if already bootstrapped
  if (fs.existsSync(STATE_FILE)) {
    try {
      const existing = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      const poolInfo = await conn.getAccountInfo(new PublicKey(existing.poolPda));
      if (poolInfo) {
        console.log('  ✓ Already bootstrapped — skipping');
        console.log(`  POKER Mint: ${existing.pokerMint}`);
        console.log(`  Pool PDA:   ${existing.poolPda}`);
        console.log(`  Tables:     ${existing.tables.length}`);
        return;
      }
    } catch {}
    console.log('  ⚠ Stale state — re-bootstrapping');
  }

  // Admin keypair
  const admin = Keypair.generate();
  await conn.confirmTransaction(await conn.requestAirdrop(admin.publicKey, 10 * LAMPORTS_PER_SOL), 'confirmed');
  console.log(`  Admin: ${admin.publicKey.toBase58().slice(0, 12)}.. (10 SOL)`);

  // Fund treasury
  await conn.confirmTransaction(await conn.requestAirdrop(TREASURY, 1 * LAMPORTS_PER_SOL), 'confirmed');
  console.log(`  Treasury funded`);

  // ── 1. Create POKER mint ──
  console.log('\n  === Creating POKER Mint ===');
  const pokerMint = await createMint(conn, admin, admin.publicKey, null, 9);
  console.log(`  POKER Mint: ${pokerMint.toBase58()}`);

  // ── 2. Initialize Steel Pool ──
  console.log('\n  === Initializing Steel Pool ===');
  const poolPda = getPool();
  const initData = Buffer.alloc(1);
  initData.writeUInt8(0, 0); // Initialize = discriminator 0
  const ok = await send(conn, new TransactionInstruction({
    programId: STEEL_PROGRAM_ID,
    keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolPda, isSigner: false, isWritable: true },
      { pubkey: pokerMint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: initData,
  }), [admin], 'steel_initialize');
  if (!ok) throw new Error('Steel pool init failed');
  console.log(`  ✓ Pool: ${poolPda.toBase58().slice(0, 12)}..`);

  // ── 3. Init Dealer Registry ──
  console.log('\n  === Initializing Dealer Registry ===');
  await send(conn, new TransactionInstruction({
    programId: ANCHOR_PROGRAM_ID,
    keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: true },
      { pubkey: getDealerReg(), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: disc('init_dealer_registry'),
  }), [admin], 'init_dealer_registry');
  console.log('  ✓ Dealer registry initialized');

  // ── 4. Register + fund E2E test wallets ──
  console.log('\n  === Registering E2E Test Wallets ===');
  for (let i = 0; i < 4; i++) {
    const seed = crypto.createHash('sha256').update(`fastpoker-e2e-wallet-v1-${i}`).digest();
    const w = Keypair.fromSeed(seed);
    
    // Airdrop SOL
    const bal = await conn.getBalance(w.publicKey);
    if (bal < 0.5 * LAMPORTS_PER_SOL) {
      await conn.confirmTransaction(await conn.requestAirdrop(w.publicKey, 2 * LAMPORTS_PER_SOL), 'confirmed');
    }
    
    // Register player
    const playerPda = getPlayer(w.publicKey);
    const playerInfo = await conn.getAccountInfo(playerPda);
    if (!playerInfo) {
      await send(conn, new TransactionInstruction({
        programId: ANCHOR_PROGRAM_ID,
        keys: [
          { pubkey: w.publicKey, isSigner: true, isWritable: true },
          { pubkey: playerPda, isSigner: false, isWritable: true },
          { pubkey: TREASURY, isSigner: false, isWritable: true },
          { pubkey: poolPda, isSigner: false, isWritable: true },
          { pubkey: getUnrefined(w.publicKey), isSigner: false, isWritable: true },
          { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: disc('register_player'),
      }), [w], `register_player_${i}`);
    }

    // Mint POKER tokens
    try {
      const ata = await getOrCreateAssociatedTokenAccount(conn, admin, pokerMint, w.publicKey);
      await mintTo(conn, admin, pokerMint, ata.address, admin, 1_000_000_000_000n); // 1000 POKER
      console.log(`  ✓ Wallet ${i} (${w.publicKey.toBase58().slice(0, 8)}..) registered + 1000 POKER`);
    } catch (e: any) {
      console.log(`  ⚠ Wallet ${i} POKER mint failed: ${e.message?.slice(0, 80)}`);
    }
  }

  // ── 5. Create test cash tables ──
  console.log('\n  === Creating Test Cash Tables ===');
  const tables: { id: string; pda: string; type: string }[] = [];

  async function createTable(label: string, gt: number, st: number, mp: number, tier: number) {
    const tableId = crypto.randomBytes(32);
    const t = getTable(tableId);
    const ok = await send(conn, new TransactionInstruction({
      programId: ANCHOR_PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: t, isSigner: false, isWritable: true },
        { pubkey: poolPda, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([disc('create_table'), serializeCfg(tableId, gt, st, mp, tier)]),
    }), [admin], `create_table(${label})`);
    if (!ok) throw new Error(`create_table(${label}) failed`);

    for (let i = 0; i < mp; i++) {
      await send(conn, new TransactionInstruction({
        programId: ANCHOR_PROGRAM_ID,
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: true },
          { pubkey: t, isSigner: false, isWritable: false },
          { pubkey: getSeat(t, i), isSigner: false, isWritable: true },
          { pubkey: getSeatCards(t, i), isSigner: false, isWritable: true },
          { pubkey: getDeckState(t), isSigner: false, isWritable: true },
          { pubkey: getReceipt(t, i), isSigner: false, isWritable: true },
          { pubkey: getVault(t), isSigner: false, isWritable: true },
          { pubkey: getTallyEr(t), isSigner: false, isWritable: true },
          { pubkey: getTallyL1(t), isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([disc('init_table_seat'), Buffer.from([i])]),
      }), [admin], `init_seat_${i}`);
    }

    tables.push({ id: tableId.toString('hex'), pda: t.toBase58(), type: label });
    console.log(`  ✓ ${label}: ${t.toBase58().slice(0, 12)}.. (${mp} seats)`);
  }

  await createTable('Cash HU Micro', 3, 0, 2, 0);
  await createTable('Cash 6-max Micro', 3, 0, 6, 0);
  await createTable('Cash 9-max Low', 3, 1, 9, 0);

  // ── Save state ──
  const state = { pokerMint: pokerMint.toBase58(), poolPda: poolPda.toBase58(), tables, bootstrappedAt: new Date().toISOString() };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  // Update client .env.local
  let env = '';
  try { env = fs.readFileSync(CLIENT_ENV, 'utf-8'); } catch {}
  if (!env.includes('NEXT_PUBLIC_POKER_MINT')) {
    env += `\nNEXT_PUBLIC_POKER_MINT=${pokerMint.toBase58()}\n`;
    fs.writeFileSync(CLIENT_ENV, env);
  }

  console.log('\n✅ Bootstrap complete!');
  console.log(`  POKER Mint: ${pokerMint.toBase58()}`);
  console.log(`  Pool PDA:   ${poolPda.toBase58()}`);
  console.log(`  Tables:     ${tables.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
