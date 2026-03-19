/**
 * Cleanup stale tables — closes all tables + seats + seat_cards on both L1 and ER.
 * Uses admin_close_table for tables and admin_close_accounts for seats/markers.
 * Run: npx ts-node tests/cleanup-stale-tables.ts
 */

import {
  Connection, Keypair, PublicKey, Transaction,
  sendAndConfirmTransaction, SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import * as fs from 'fs';
import * as crypto from 'crypto';

// ─── Config ───
const L1_RPC = 'https://devnet.helius-rpc.com/?api-key=8801f9b3-fe0b-42b5-ba5c-67f0fed31c5e';
const ER_RPC = 'https://devnet.magicblock.app';
const PROGRAM_ID = new PublicKey('FTuksCXGvdrYe9uP2X9S12KLHhRZHJNsrzpxP2wk2ckR');
const KEYPAIR_PATH = 'j:/critters/mini-game/deployer-keypair.json';

// Anchor discriminators
const disc = (name: string) => crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8);
const ADMIN_CLOSE_TABLE_DISC = disc('admin_close_table');
const ADMIN_CLOSE_ACCOUNTS_DISC = disc('admin_close_accounts');

// Table account discriminator
const TABLE_DISC = crypto.createHash('sha256').update('account:Table').digest().slice(0, 8);

function loadKeypair(): Keypair {
  const raw = JSON.parse(fs.readFileSync(KEYPAIR_PATH, 'utf-8'));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function findAllTables(conn: Connection, label: string): Promise<{ pubkey: PublicKey; data: Buffer; lamports: number }[]> {
  console.log(`\nScanning ${label} for tables...`);
  const accounts = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: require('bs58').encode(TABLE_DISC) } }],
  });
  console.log(`  Found ${accounts.length} tables on ${label}`);
  return accounts.map(a => ({
    pubkey: a.pubkey,
    data: a.account.data as Buffer,
    lamports: a.account.lamports,
  }));
}

async function findSeatsForTable(conn: Connection, tablePubkey: PublicKey, maxPlayers: number): Promise<PublicKey[]> {
  const seats: PublicKey[] = [];
  for (let i = 0; i < maxPlayers; i++) {
    const [seatPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('seat'), tablePubkey.toBuffer(), Buffer.from([i])],
      PROGRAM_ID,
    );
    const info = await conn.getAccountInfo(seatPda);
    if (info && info.owner.equals(PROGRAM_ID)) {
      seats.push(seatPda);
    }
  }
  return seats;
}

async function findSeatCardsForTable(conn: Connection, tablePubkey: PublicKey, maxPlayers: number): Promise<PublicKey[]> {
  const cards: PublicKey[] = [];
  for (let i = 0; i < maxPlayers; i++) {
    const [scPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('seat_cards'), tablePubkey.toBuffer(), Buffer.from([i])],
      PROGRAM_ID,
    );
    const info = await conn.getAccountInfo(scPda);
    if (info && info.owner.equals(PROGRAM_ID)) {
      cards.push(scPda);
    }
  }
  return cards;
}

async function findMarkersForTable(conn: Connection, tablePubkey: PublicKey, seatWallets: PublicKey[]): Promise<PublicKey[]> {
  const markers: PublicKey[] = [];
  for (const wallet of seatWallets) {
    const [markerPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('player_table'), wallet.toBuffer(), tablePubkey.toBuffer()],
      PROGRAM_ID,
    );
    const info = await conn.getAccountInfo(markerPda);
    if (info && info.owner.equals(PROGRAM_ID)) {
      markers.push(markerPda);
    }
  }
  return markers;
}

async function closeTable(conn: Connection, authority: Keypair, tablePubkey: PublicKey, label: string): Promise<boolean> {
  try {
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: tablePubkey, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: ADMIN_CLOSE_TABLE_DISC,
    });
    const tx = new Transaction().add(ix);
    tx.feePayer = authority.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    const sig = await sendAndConfirmTransaction(conn, tx, [authority], { commitment: 'confirmed' });
    console.log(`  ✓ Closed table ${tablePubkey.toBase58().slice(0, 12)}... on ${label} (${sig.slice(0, 20)}...)`);
    return true;
  } catch (e: any) {
    console.log(`  ✗ Failed to close table ${tablePubkey.toBase58().slice(0, 12)}... on ${label}: ${e.message?.slice(0, 80)}`);
    return false;
  }
}

async function closeAccounts(conn: Connection, authority: Keypair, accounts: PublicKey[], label: string): Promise<number> {
  if (accounts.length === 0) return 0;
  // Batch up to 10 accounts per tx (remaining_accounts limit)
  let closed = 0;
  for (let i = 0; i < accounts.length; i += 10) {
    const batch = accounts.slice(i, i + 10);
    try {
      const ix = new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: authority.publicKey, isSigner: true, isWritable: true },
          ...batch.map(pk => ({ pubkey: pk, isSigner: false, isWritable: true })),
        ],
        data: ADMIN_CLOSE_ACCOUNTS_DISC,
      });
      const tx = new Transaction().add(ix);
      tx.feePayer = authority.publicKey;
      tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
      await sendAndConfirmTransaction(conn, tx, [authority], { commitment: 'confirmed' });
      closed += batch.length;
      console.log(`  ✓ Closed ${batch.length} accounts on ${label}`);
    } catch (e: any) {
      console.log(`  ✗ Failed to close batch on ${label}: ${e.message?.slice(0, 80)}`);
    }
  }
  return closed;
}

const GAME_TYPES = ['Heads-Up', '6-Max', '9-Max', 'Cash'];
const PHASES = ['Waiting', 'Starting', 'Preflop', 'Flop', 'Turn', 'River', 'Showdown', 'Complete'];

async function main() {
  const authority = loadKeypair();
  console.log(`Authority: ${authority.publicKey.toBase58()}`);

  const l1 = new Connection(L1_RPC, 'confirmed');
  const er = new Connection(ER_RPC, 'confirmed');

  // Find all tables on both networks
  const l1Tables = await findAllTables(l1, 'L1');
  const erTables = await findAllTables(er, 'ER');

  let totalRecovered = 0;

  // Process each network
  for (const [conn, tables, label] of [
    [er, erTables, 'ER'] as const,
    [l1, l1Tables, 'L1'] as const,
  ]) {
    if (tables.length === 0) continue;
    console.log(`\n═══ Processing ${label} (${tables.length} tables) ═══`);

    for (const table of tables) {
      const d = table.data;
      const maxPlayers = d[121];
      const currentPlayers = d[122];
      const phase = d[160];
      const gameType = d[104];
      const lamportsSol = table.lamports / 1e9;

      console.log(`\n  Table: ${table.pubkey.toBase58().slice(0, 12)}... | ${GAME_TYPES[gameType] || '?'} | ${PHASES[phase] || '?'} | ${currentPlayers}/${maxPlayers} | ${lamportsSol.toFixed(4)} SOL`);

      // Find and close associated accounts first
      const seats = await findSeatsForTable(conn, table.pubkey, maxPlayers);
      const seatCards = await findSeatCardsForTable(conn, table.pubkey, maxPlayers);

      // Read wallet pubkeys from seats for marker lookup
      const seatWallets: PublicKey[] = [];
      for (const seatPk of seats) {
        try {
          const seatInfo = await conn.getAccountInfo(seatPk);
          if (seatInfo && seatInfo.data.length >= 40) {
            seatWallets.push(new PublicKey(seatInfo.data.slice(8, 40)));
          }
        } catch {}
      }
      const markers = await findMarkersForTable(conn, table.pubkey, seatWallets);

      const allSubAccounts = [...seats, ...seatCards, ...markers];
      if (allSubAccounts.length > 0) {
        console.log(`    Closing ${seats.length} seats, ${seatCards.length} seat_cards, ${markers.length} markers...`);
        await closeAccounts(conn, authority, allSubAccounts, label);
      }

      // Close the table itself
      const tableClosed = await closeTable(conn, authority, table.pubkey, label);
      if (tableClosed) {
        totalRecovered += table.lamports;
      }
    }
  }

  console.log(`\n════════════════════════════════════`);
  console.log(`Total rent recovered: ~${(totalRecovered / 1e9).toFixed(4)} SOL`);
  console.log(`Done!`);
}

main().catch(console.error);
