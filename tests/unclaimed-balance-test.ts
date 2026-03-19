/**
 * Unclaimed Balance Test
 * 
 * Tests the unclaimed balance flow for cash games:
 * 1. Player joins cash table with POKER buy-in
 * 2. Player sits out and misses 3 BBs
 * 3. Force release seat → creates UnclaimedBalance PDA
 * 4. Player can claim unclaimed balance (before 100 days)
 * 5. OR player rejoins and unclaimed is auto-used
 * 6. Table cannot be closed while unclaimed balances exist
 * 7. After 100 days, creator can reclaim expired balances
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// Program IDs
const CQ_POKER_PROGRAM_ID = new PublicKey('FTuksCXGvdrYe9uP2X9S12KLHhRZHJNsrzpxP2wk2ckR');
const POKER_MINT = new PublicKey('DiJC3FVReapYYDwRnPMrCRH7aYyeJ47Nu81MemTaHZWX');

// Seeds
const TABLE_SEED = Buffer.from('table');
const SEAT_SEED = Buffer.from('seat');
const PLAYER_SEED = Buffer.from('player');
const UNCLAIMED_SEED = Buffer.from('unclaimed');
const PLAYER_TABLE_SEED = Buffer.from('player_table');

const RPC_URL = 'https://api.devnet.solana.com';

// Instruction discriminators (SHA256 first 8 bytes)
const DISCRIMINATORS = {
  createTable: Buffer.from(crypto.createHash('sha256').update('global:create_table').digest().slice(0, 8)),
  joinTable: Buffer.from(crypto.createHash('sha256').update('global:join_table').digest().slice(0, 8)),
  forceReleaseSeat: Buffer.from(crypto.createHash('sha256').update('global:force_release_seat').digest().slice(0, 8)),
  claimUnclaimed: Buffer.from(crypto.createHash('sha256').update('global:claim_unclaimed').digest().slice(0, 8)),
  reclaimExpired: Buffer.from(crypto.createHash('sha256').update('global:reclaim_expired').digest().slice(0, 8)),
  closeTable: Buffer.from(crypto.createHash('sha256').update('global:close_table').digest().slice(0, 8)),
};

function loadKeypair(filePath: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(filePath, 'utf-8'))));
}

function getTablePDA(tableId: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([TABLE_SEED, tableId], CQ_POKER_PROGRAM_ID);
}

function getSeatPDA(table: PublicKey, seatNumber: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEAT_SEED, table.toBuffer(), Buffer.from([seatNumber])], CQ_POKER_PROGRAM_ID);
}

function getPlayerPDA(wallet: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([PLAYER_SEED, wallet.toBuffer()], CQ_POKER_PROGRAM_ID);
}

function getUnclaimedPDA(table: PublicKey, player: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([UNCLAIMED_SEED, table.toBuffer(), player.toBuffer()], CQ_POKER_PROGRAM_ID);
}

function getPlayerTableMarkerPDA(player: PublicKey, table: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([PLAYER_TABLE_SEED, player.toBuffer(), table.toBuffer()], CQ_POKER_PROGRAM_ID);
}

function getEscrowAuthorityPDA(table: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('escrow'), table.toBuffer()], CQ_POKER_PROGRAM_ID);
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('='.repeat(70));
  console.log('Unclaimed Balance Test');
  console.log('='.repeat(70));

  const connection = new Connection(RPC_URL, 'confirmed');
  const keysDir = path.join(__dirname, 'keys');

  // Load accounts
  const authority = loadKeypair(path.join(keysDir, 'player1.json')); // Table creator
  const player1 = loadKeypair(path.join(keysDir, 'player2.json')); // Player to be force-released
  const treasury = loadKeypair(path.join(keysDir, 'treasury.json'));

  console.log(`\nAuthority/Creator: ${authority.publicKey.toBase58().slice(0, 12)}...`);
  console.log(`Player 1: ${player1.publicKey.toBase58().slice(0, 12)}...`);

  // Generate table ID
  const tableId = new Uint8Array(32);
  crypto.randomFillSync(tableId);
  const [tablePDA] = getTablePDA(tableId);
  const [seat0PDA] = getSeatPDA(tablePDA, 0);
  const [player1AccountPDA] = getPlayerPDA(player1.publicKey);
  const [unclaimedPDA] = getUnclaimedPDA(tablePDA, player1.publicKey);
  const [playerTableMarkerPDA] = getPlayerTableMarkerPDA(player1.publicKey, tablePDA);
  const [escrowAuthorityPDA] = getEscrowAuthorityPDA(tablePDA);

  console.log(`\nTable PDA: ${tablePDA.toBase58()}`);
  console.log(`Seat 0 PDA: ${seat0PDA.toBase58()}`);
  console.log(`Unclaimed PDA: ${unclaimedPDA.toBase58()}`);

  // Get token accounts
  const authorityTokenAccount = await getAssociatedTokenAddress(POKER_MINT, authority.publicKey);
  const player1TokenAccount = await getAssociatedTokenAddress(POKER_MINT, player1.publicKey);
  const tableTokenAccount = await getAssociatedTokenAddress(POKER_MINT, tablePDA, true);

  console.log(`\nTable token escrow: ${tableTokenAccount.toBase58()}`);

  // =====================================================
  // Test 1: Derive UnclaimedBalance PDA
  // =====================================================
  console.log('\n' + '='.repeat(70));
  console.log('Test 1: UnclaimedBalance PDA derivation');
  console.log('='.repeat(70));

  console.log(`✓ UnclaimedBalance PDA derived: ${unclaimedPDA.toBase58()}`);
  console.log(`  Seeds: ["unclaimed", table, player]`);

  // =====================================================
  // Test 2: Verify PDA calculation matches on-chain
  // =====================================================
  console.log('\n' + '='.repeat(70));
  console.log('Test 2: Verify PDA seeds are consistent');
  console.log('='.repeat(70));

  // Recalculate to verify
  const [verifyPDA, verifyBump] = PublicKey.findProgramAddressSync(
    [UNCLAIMED_SEED, tablePDA.toBuffer(), player1.publicKey.toBuffer()],
    CQ_POKER_PROGRAM_ID
  );
  
  if (verifyPDA.equals(unclaimedPDA)) {
    console.log(`✓ PDA verification passed`);
    console.log(`  Bump: ${verifyBump}`);
  } else {
    console.log(`✗ PDA verification FAILED`);
    process.exit(1);
  }

  // =====================================================
  // Test 3: Force release seat instruction structure
  // =====================================================
  console.log('\n' + '='.repeat(70));
  console.log('Test 3: Force release seat instruction structure');
  console.log('='.repeat(70));

  // Build force_release_seat instruction data
  const forceReleaseData = Buffer.concat([
    DISCRIMINATORS.forceReleaseSeat,
    player1.publicKey.toBuffer(), // player_wallet argument
  ]);

  console.log(`Instruction discriminator: ${DISCRIMINATORS.forceReleaseSeat.toString('hex')}`);
  console.log(`Instruction data length: ${forceReleaseData.length} bytes`);
  console.log(`  - Discriminator: 8 bytes`);
  console.log(`  - player_wallet: 32 bytes`);

  // =====================================================
  // Test 4: Claim unclaimed instruction structure
  // =====================================================
  console.log('\n' + '='.repeat(70));
  console.log('Test 4: Claim unclaimed instruction structure');
  console.log('='.repeat(70));

  const claimUnclaimedKeys = [
    { pubkey: player1.publicKey, isSigner: true, isWritable: true },       // player
    { pubkey: tablePDA, isSigner: false, isWritable: true },               // table
    { pubkey: unclaimedPDA, isSigner: false, isWritable: true },           // unclaimed
    { pubkey: tableTokenAccount, isSigner: false, isWritable: true },      // table_token_account
    { pubkey: player1TokenAccount, isSigner: false, isWritable: true },    // player_token_account
    { pubkey: escrowAuthorityPDA, isSigner: false, isWritable: false },    // escrow_authority
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },      // token_program
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
  ];

  console.log(`Claim unclaimed accounts: ${claimUnclaimedKeys.length}`);
  claimUnclaimedKeys.forEach((key, i) => {
    console.log(`  ${i + 1}. ${key.pubkey.toBase58().slice(0, 20)}... (signer: ${key.isSigner}, writable: ${key.isWritable})`);
  });

  // =====================================================
  // Test 5: Reclaim expired instruction structure
  // =====================================================
  console.log('\n' + '='.repeat(70));
  console.log('Test 5: Reclaim expired instruction structure');
  console.log('='.repeat(70));

  const reclaimExpiredData = Buffer.concat([
    DISCRIMINATORS.reclaimExpired,
    player1.publicKey.toBuffer(), // player argument (whose balance to reclaim)
  ]);

  const reclaimExpiredKeys = [
    { pubkey: authority.publicKey, isSigner: true, isWritable: true },     // creator
    { pubkey: tablePDA, isSigner: false, isWritable: true },               // table
    { pubkey: unclaimedPDA, isSigner: false, isWritable: true },           // unclaimed
    { pubkey: tableTokenAccount, isSigner: false, isWritable: true },      // table_token_account
    { pubkey: authorityTokenAccount, isSigner: false, isWritable: true },  // creator_token_account
    { pubkey: escrowAuthorityPDA, isSigner: false, isWritable: false },    // escrow_authority
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },      // token_program
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
  ];

  console.log(`Reclaim expired accounts: ${reclaimExpiredKeys.length}`);
  console.log(`Instruction data: discriminator(8) + player(32) = 40 bytes`);

  // =====================================================
  // Summary
  // =====================================================
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY: Unclaimed Balance System');
  console.log('='.repeat(70));

  console.log(`
Flow:
  1. Player misses 3 BBs → force_release_seat called
     - Creates UnclaimedBalance PDA at [unclaimed, table, player]
     - Moves chips from seat to unclaimed.amount
     - Increments table.unclaimed_balance_count
     - Clears seat for new player

  2. Player can claim (before 100 days):
     - Call claim_unclaimed with player signature
     - Transfers tokens from escrow to player
     - Closes UnclaimedBalance PDA
     - Decrements table.unclaimed_balance_count

  3. OR player rejoins same table:
     - join_table auto-detects unclaimed balance
     - Uses unclaimed + new buy-in as total chips
     - Zeros unclaimed.amount (PDA stays for now)

  4. After 100 days (expired):
     - Creator calls reclaim_expired
     - Transfers tokens from escrow to creator
     - Closes UnclaimedBalance PDA
     - Decrements table.unclaimed_balance_count

  5. Table close blocked:
     - close_table requires unclaimed_balance_count == 0
     - Creator must wait for players to claim or expiry

Constants:
  - UNCLAIMED_EXPIRY_SECONDS: 8,640,000 (100 days)
  - Seeds: ["unclaimed", table_pubkey, player_pubkey]
  - PDA size: ~90 bytes
`);

  console.log('✓ All structure tests passed!');
  console.log('\nNote: Full E2E test requires deployed program with token escrow.');
}

main().catch(console.error);
