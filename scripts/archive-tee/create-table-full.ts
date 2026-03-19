/**
 * Full table creation: create_user_table + init_table_seat + delegate all to TEE.
 * Bypasses Phantom — uses deployer keypair directly.
 * Run: npx ts-node scripts/create-table-full.ts
 */
import {
  Connection, Keypair, PublicKey, Transaction,
  TransactionInstruction, SystemProgram, sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationRecordPdaFromDelegatedAccount,
  delegationMetadataPdaFromDelegatedAccount,
} from '@magicblock-labs/ephemeral-rollups-sdk';
import * as fs from 'fs';
import * as crypto from 'crypto';

// ═══ Config ═══
const L1_RPC = 'https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df';
const PROGRAM_ID = new PublicKey('FTuksCXGvdrYe9uP2X9S12KLHhRZHJNsrzpxP2wk2ckR');
const DELEGATION_PROGRAM_ID = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const PERMISSION_PROGRAM_ID = new PublicKey('ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1');
const TEE_VALIDATOR = new PublicKey('FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA');
const POOL_PDA = new PublicKey('FSKrGq26FxhMUSK85ksv2AykL5Am2HS9iXJwuVoQQvLY');
const TREASURY = new PublicKey('4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3');
const STEEL_PROGRAM_ID = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');
const KEYPAIR_PATH = 'j:/Poker/contracts/auth/deployers/anchor-mini-game-deployer-keypair.json';
const POKER_MINT = new PublicKey('DiJC3FVReapYYDwRnPMrCRH7aYyeJ47Nu81MemTaHZWX');
const TREASURY_POKER_ATA = new PublicKey('DHfxboVf7iZXMvSGNb4QQWNusDFwsjHfoTzLkCxPTNZa');
const POOL_POKER_ATA = new PublicKey('8x2whVJCv9M61XxMuJq51kRiS3cATo9nQjFF19zzyHbE');
const SPL_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

// ═══ Seeds ═══
const TABLE_SEED = Buffer.from('table');
const SEAT_SEED = Buffer.from('seat');
const SEAT_CARDS_SEED = Buffer.from('seat_cards');
const DECK_STATE_SEED = Buffer.from('deck_state');
const VAULT_SEED = Buffer.from('vault');

// ═══ Discriminators ═══
const DISC = {
  createUserTable: Buffer.from([238, 125, 176, 179, 242, 249, 219, 183]),
  initTableSeat:   Buffer.from([4, 2, 110, 85, 144, 112, 65, 236]),
  delegateTable:   Buffer.from([161, 66, 67, 113, 58, 219, 238, 170]),
  delegateSeat:    Buffer.from([53, 85, 50, 81, 161, 68, 71, 212]),
  delegateSeatCards: Buffer.from([79, 21, 238, 244, 141, 174, 3, 26]),
  delegateDeckState: Buffer.from([35, 80, 108, 20, 133, 115, 71, 235]),
  delegatePermission: Buffer.from([187, 192, 110, 65, 252, 88, 194, 103]),
};

// ═══ PDA helpers ═══
function getTablePda(tableId: Buffer): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([TABLE_SEED, tableId], PROGRAM_ID);
}
function getVaultPda(tablePda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([VAULT_SEED, tablePda.toBuffer()], PROGRAM_ID);
}
function getSeatPda(tablePda: PublicKey, idx: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEAT_SEED, tablePda.toBuffer(), Buffer.from([idx])], PROGRAM_ID);
}
function getSeatCardsPda(tablePda: PublicKey, idx: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEAT_CARDS_SEED, tablePda.toBuffer(), Buffer.from([idx])], PROGRAM_ID);
}
function getDeckStatePda(tablePda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([DECK_STATE_SEED, tablePda.toBuffer()], PROGRAM_ID);
}
function getReceiptPda(tablePda: PublicKey, idx: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('receipt'), tablePda.toBuffer(), Buffer.from([idx])], PROGRAM_ID);
}
function getDepositProofPda(tablePda: PublicKey, idx: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('deposit_proof'), tablePda.toBuffer(), Buffer.from([idx])], PROGRAM_ID);
}
function getPermissionPda(seatCardsPda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('permission:'), seatCardsPda.toBuffer()],
    PERMISSION_PROGRAM_ID,
  );
}

// ═══ Send helper ═══
async function sendTx(l1: Connection, tx: Transaction, signers: Keypair[], label: string) {
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = (await l1.getLatestBlockhash()).blockhash;
  const sig = await sendAndConfirmTransaction(l1, tx, signers, { commitment: 'confirmed' });
  console.log(`  ✅ ${label}: ${sig.slice(0, 20)}...`);
  return sig;
}

async function main() {
  const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, 'utf-8'))));
  const l1 = new Connection(L1_RPC, 'confirmed');

  const bal = await l1.getBalance(deployer.publicKey);
  console.log(`Deployer: ${deployer.publicKey.toBase58()} (${(bal / 1e9).toFixed(4)} SOL)\n`);

  // ═══ Table config from CLI args ═══
  const arg = process.argv[2] || 'hu-sol';
  const CONFIGS: Record<string, { maxPlayers: number; smallBlind: bigint; bigBlind: bigint; tokenMint: PublicKey; label: string }> = {
    'hu-sol':    { maxPlayers: 2, smallBlind: 50_000n,      bigBlind: 100_000n,       tokenMint: PublicKey.default, label: 'HU SOL' },
    'hu-poker':  { maxPlayers: 2, smallBlind: 500_000_000n, bigBlind: 1_000_000_000n, tokenMint: POKER_MINT, label: 'HU POKER' },
    '6max-sol':  { maxPlayers: 6, smallBlind: 50_000n,      bigBlind: 100_000n,       tokenMint: PublicKey.default, label: '6max SOL' },
    '6max-poker':{ maxPlayers: 6, smallBlind: 500_000_000n, bigBlind: 1_000_000_000n, tokenMint: POKER_MINT, label: '6max POKER' },
    '9max-sol':  { maxPlayers: 9, smallBlind: 50_000n,      bigBlind: 100_000n,       tokenMint: PublicKey.default, label: '9max SOL' },
    '9max-poker':{ maxPlayers: 9, smallBlind: 500_000_000n, bigBlind: 1_000_000_000n, tokenMint: POKER_MINT, label: '9max POKER' },
  };
  const cfg = CONFIGS[arg];
  if (!cfg) { console.log('Usage: npx ts-node create-table-full.ts <hu-sol|hu-poker|6max-sol|6max-poker|9max-sol|9max-poker>'); return; }
  const { maxPlayers, smallBlind, bigBlind, tokenMint, label } = cfg;
  const buyInType = 0;                   // Normal (20-100 BB)
  console.log(`Creating: ${label}`);

  // Random table ID
  const tableIdBuf = Buffer.alloc(32);
  crypto.randomBytes(32).copy(tableIdBuf);
  const [tablePda] = getTablePda(tableIdBuf);
  const [vaultPda] = getVaultPda(tablePda);

  console.log(`Table PDA: ${tablePda.toBase58()}`);
  console.log(`Vault PDA: ${vaultPda.toBase58()}`);
  console.log(`Blinds:    ${Number(smallBlind) / 1e9} / ${Number(bigBlind) / 1e9} SOL`);
  console.log(`Max:       ${maxPlayers} players (Heads-Up)\n`);

  // For POKER tables: get creator's ATA for denomination fee
  let creatorPokerAta: PublicKey | undefined;
  if (!tokenMint.equals(PublicKey.default)) {
    const { getAssociatedTokenAddress } = await import('@solana/spl-token');
    creatorPokerAta = await getAssociatedTokenAddress(tokenMint, deployer.publicKey);
    console.log(`Creator POKER ATA: ${creatorPokerAta.toBase58()}`);
  }

  // Check if table already exists
  const existing = await l1.getAccountInfo(tablePda);
  if (existing) {
    console.log('⚠️  Table already exists!');
    return;
  }

  // ═══ STEP 1: Create table ═══
  console.log('STEP 1: Creating table...');
  {
    const data = Buffer.alloc(8 + 32 + 1 + 8 + 8 + 32 + 1);
    DISC.createUserTable.copy(data, 0);
    tableIdBuf.copy(data, 8);
    data.writeUInt8(maxPlayers, 40);
    data.writeBigUInt64LE(smallBlind, 41);
    data.writeBigUInt64LE(bigBlind, 49);
    tokenMint.toBuffer().copy(data, 57);
    data.writeUInt8(buyInType, 89);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: deployer.publicKey, isSigner: true, isWritable: true },  // creator
        { pubkey: tablePda, isSigner: false, isWritable: true },           // table
        { pubkey: POOL_PDA, isSigner: false, isWritable: true },           // pool
        { pubkey: TREASURY, isSigner: false, isWritable: true },           // treasury
        ...(tokenMint.equals(PublicKey.default) ? [
          { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },        // creator_token_account (SOL placeholder)
          { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },        // treasury_token_account (SOL placeholder)
          { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },        // pool_token_account (SOL placeholder)
          { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },        // token_program (SOL placeholder)
        ] : [
          { pubkey: creatorPokerAta!, isSigner: false, isWritable: true },   // creator_token_account
          { pubkey: TREASURY_POKER_ATA, isSigner: false, isWritable: true }, // treasury_token_account
          { pubkey: POOL_POKER_ATA, isSigner: false, isWritable: true },     // pool_token_account
          { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // token_program
        ]),
        { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },  // steel_program
        { pubkey: vaultPda, isSigner: false, isWritable: true },           // vault
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      ],
      data,
    });

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
      ix,
    );
    await sendTx(l1, tx, [deployer], 'create_user_table');
  }

  // ═══ STEP 1.5: Create table escrow ATA (POKER tables only) ═══
  if (!tokenMint.equals(PublicKey.default)) {
    console.log('\nSTEP 1.5: Creating table escrow ATA...');
    const { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } = await import('@solana/spl-token');
    const escrowAta = await getAssociatedTokenAddress(tokenMint, tablePda, true);
    const createAtaIx = createAssociatedTokenAccountInstruction(
      deployer.publicKey, escrowAta, tablePda, tokenMint
    );
    const tx = new Transaction().add(createAtaIx);
    await sendTx(l1, tx, [deployer], `create escrow ATA ${escrowAta.toBase58().slice(0, 16)}...`);
  }

  // ═══ STEP 2: Init seats ═══
  console.log('\nSTEP 2: Initializing seats...');
  for (let i = 0; i < maxPlayers; i++) {
    const [seatPda] = getSeatPda(tablePda, i);
    const [seatCardsPda] = getSeatCardsPda(tablePda, i);
    const [deckStatePda] = getDeckStatePda(tablePda);
    const [receiptPda] = getReceiptPda(tablePda, i);
    const [depositProofPda] = getDepositProofPda(tablePda, i);
    const [permissionPda] = getPermissionPda(seatCardsPda);

    const data = Buffer.alloc(9);
    DISC.initTableSeat.copy(data, 0);
    data.writeUInt8(i, 8);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
        { pubkey: tablePda, isSigner: false, isWritable: false },
        { pubkey: seatPda, isSigner: false, isWritable: true },
        { pubkey: seatCardsPda, isSigner: false, isWritable: true },
        { pubkey: deckStatePda, isSigner: false, isWritable: true },
        { pubkey: receiptPda, isSigner: false, isWritable: true },
        { pubkey: depositProofPda, isSigner: false, isWritable: true },
        { pubkey: permissionPda, isSigner: false, isWritable: true },
        { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
      ix,
    );
    await sendTx(l1, tx, [deployer], `init_table_seat(${i})`);
  }

  // ═══ STEP 2.5: Create public permissions (TEE requires these for getAccountInfo) ═══
  console.log('\nSTEP 2.5: Creating public permissions for table, seats, deckState...');
  const DISC_TABLE_PERM = Buffer.from([194, 38, 119, 36, 146, 11, 104, 110]);
  const DISC_SEAT_PERM = Buffer.from([161, 4, 4, 164, 13, 227, 248, 60]);
  const DISC_DS_PERM = Buffer.from([217, 32, 126, 22, 180, 97, 105, 157]);

  // Table permission
  {
    const [permPda] = getPermissionPda(tablePda);
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      new TransactionInstruction({
        programId: PROGRAM_ID,
        data: DISC_TABLE_PERM,
        keys: [
          { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
          { pubkey: tablePda, isSigner: false, isWritable: false },
          { pubkey: permPda, isSigner: false, isWritable: true },
          { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
      }),
    );
    await sendTx(l1, tx, [deployer], 'create_table_permission');
  }

  // DeckState permission
  {
    const [dsPda] = getDeckStatePda(tablePda);
    const [permPda] = getPermissionPda(dsPda);
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      new TransactionInstruction({
        programId: PROGRAM_ID,
        data: DISC_DS_PERM,
        keys: [
          { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
          { pubkey: tablePda, isSigner: false, isWritable: false },
          { pubkey: dsPda, isSigner: false, isWritable: false },
          { pubkey: permPda, isSigner: false, isWritable: true },
          { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
      }),
    );
    await sendTx(l1, tx, [deployer], 'create_deck_state_permission');
  }

  // Seat permissions
  for (let i = 0; i < maxPlayers; i++) {
    const [seatPda] = getSeatPda(tablePda, i);
    const [permPda] = getPermissionPda(seatPda);
    const data = Buffer.alloc(9);
    DISC_SEAT_PERM.copy(data, 0);
    data.writeUInt8(i, 8);
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      new TransactionInstruction({
        programId: PROGRAM_ID,
        data,
        keys: [
          { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
          { pubkey: tablePda, isSigner: false, isWritable: false },
          { pubkey: seatPda, isSigner: false, isWritable: false },
          { pubkey: permPda, isSigner: false, isWritable: true },
          { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
      }),
    );
    await sendTx(l1, tx, [deployer], `create_seat_permission(${i})`);
  }

  // ═══ STEP 2.75: Delegate permission PDAs via CPI (must happen BEFORE account delegation) ═══
  console.log('\nSTEP 2.75: Delegating permission PDAs via CPI...');
  const DISC_DEL_TABLE_PERM = Buffer.from([149, 71, 189, 246, 84, 211, 143, 207]);
  const DISC_DEL_SEAT_PERM = Buffer.from([110, 176, 51, 3, 248, 220, 36, 196]);
  const DISC_DEL_DS_PERM = Buffer.from([118, 187, 69, 88, 192, 76, 153, 111]);

  function permDelegationAccounts(_pdaToSign: PublicKey, permPda: PublicKey) {
    const buf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(permPda, PERMISSION_PROGRAM_ID);
    const rec = delegationRecordPdaFromDelegatedAccount(permPda);
    const meta = delegationMetadataPdaFromDelegatedAccount(permPda);
    return { buf, rec, meta };
  }

  // Table permission delegation
  {
    const [permPda] = getPermissionPda(tablePda);
    const { buf, rec, meta } = permDelegationAccounts(tablePda, permPda);
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      new TransactionInstruction({
        programId: PROGRAM_ID,
        data: DISC_DEL_TABLE_PERM,
        keys: [
          { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
          { pubkey: tablePda, isSigner: false, isWritable: true },
          { pubkey: permPda, isSigner: false, isWritable: true },
          { pubkey: buf, isSigner: false, isWritable: true },
          { pubkey: rec, isSigner: false, isWritable: true },
          { pubkey: meta, isSigner: false, isWritable: true },
          { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
      }),
    );
    await sendTx(l1, tx, [deployer], 'delegate_table_permission');
  }

  // DeckState permission delegation
  {
    const [dsPda] = getDeckStatePda(tablePda);
    const [permPda] = getPermissionPda(dsPda);
    const { buf, rec, meta } = permDelegationAccounts(dsPda, permPda);
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      new TransactionInstruction({
        programId: PROGRAM_ID,
        data: DISC_DEL_DS_PERM,
        keys: [
          { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
          { pubkey: tablePda, isSigner: false, isWritable: false },
          { pubkey: dsPda, isSigner: false, isWritable: true },
          { pubkey: permPda, isSigner: false, isWritable: true },
          { pubkey: buf, isSigner: false, isWritable: true },
          { pubkey: rec, isSigner: false, isWritable: true },
          { pubkey: meta, isSigner: false, isWritable: true },
          { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
      }),
    );
    await sendTx(l1, tx, [deployer], 'delegate_deck_state_permission');
  }

  // Seat permission delegations
  for (let i = 0; i < maxPlayers; i++) {
    const [seatPda] = getSeatPda(tablePda, i);
    const [permPda] = getPermissionPda(seatPda);
    const { buf, rec, meta } = permDelegationAccounts(seatPda, permPda);
    const data = Buffer.alloc(9);
    DISC_DEL_SEAT_PERM.copy(data, 0);
    data.writeUInt8(i, 8);
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      new TransactionInstruction({
        programId: PROGRAM_ID,
        data,
        keys: [
          { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
          { pubkey: tablePda, isSigner: false, isWritable: false },
          { pubkey: seatPda, isSigner: false, isWritable: true },
          { pubkey: permPda, isSigner: false, isWritable: true },
          { pubkey: buf, isSigner: false, isWritable: true },
          { pubkey: rec, isSigner: false, isWritable: true },
          { pubkey: meta, isSigner: false, isWritable: true },
          { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
      }),
    );
    await sendTx(l1, tx, [deployer], `delegate_seat_permission(${i})`);
  }

  // ═══ STEP 3: Delegate to TEE ═══
  console.log('\nSTEP 3: Delegating accounts to TEE (FnE6)...');

  // 3a: Delegate table + DeckState
  {
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));

    // Table delegation
    const tBuf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(tablePda, PROGRAM_ID);
    const tRec = delegationRecordPdaFromDelegatedAccount(tablePda);
    const tMeta = delegationMetadataPdaFromDelegatedAccount(tablePda);
    const tData = Buffer.alloc(40);
    DISC.delegateTable.copy(tData, 0);
    tableIdBuf.copy(tData, 8);
    tx.add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
        { pubkey: tBuf, isSigner: false, isWritable: true },
        { pubkey: tRec, isSigner: false, isWritable: true },
        { pubkey: tMeta, isSigner: false, isWritable: true },
        { pubkey: tablePda, isSigner: false, isWritable: true },
        { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
      ],
      data: tData,
    }));

    // DeckState delegation
    const [dsPda] = getDeckStatePda(tablePda);
    const dsBuf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(dsPda, PROGRAM_ID);
    const dsRec = delegationRecordPdaFromDelegatedAccount(dsPda);
    const dsMeta = delegationMetadataPdaFromDelegatedAccount(dsPda);
    const dsData = Buffer.alloc(8);
    DISC.delegateDeckState.copy(dsData, 0);
    tx.add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
        { pubkey: dsBuf, isSigner: false, isWritable: true },
        { pubkey: dsRec, isSigner: false, isWritable: true },
        { pubkey: dsMeta, isSigner: false, isWritable: true },
        { pubkey: dsPda, isSigner: false, isWritable: true },
        { pubkey: tablePda, isSigner: false, isWritable: false },
        { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
      ],
      data: dsData,
    }));

    await sendTx(l1, tx, [deployer], 'delegate table + DeckState');
  }

  // 3b: Delegate per-seat accounts (seat + seatCards)
  // NOTE: SeatCards permission PDAs are NOT delegated — they stay on L1
  // so deposit_for_join can update them atomically with the deposit.
  // TEE reads undelegated permissions from L1 for access control.
  // See docs/TEE_ATOMIC_PERMISSION_FIX.md
  for (let i = 0; i < maxPlayers; i++) {
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 }));

    const [seatPda] = getSeatPda(tablePda, i);
    const [scPda] = getSeatCardsPda(tablePda, i);

    // Seat delegation
    const sBuf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(seatPda, PROGRAM_ID);
    const sRec = delegationRecordPdaFromDelegatedAccount(seatPda);
    const sMeta = delegationMetadataPdaFromDelegatedAccount(seatPda);
    const sData = Buffer.alloc(9);
    DISC.delegateSeat.copy(sData, 0);
    sData.writeUInt8(i, 8);
    tx.add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
        { pubkey: sBuf, isSigner: false, isWritable: true },
        { pubkey: sRec, isSigner: false, isWritable: true },
        { pubkey: sMeta, isSigner: false, isWritable: true },
        { pubkey: seatPda, isSigner: false, isWritable: true },
        { pubkey: tablePda, isSigner: false, isWritable: false },
        { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
      ],
      data: sData,
    }));

    // SeatCards delegation
    const scBuf = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(scPda, PROGRAM_ID);
    const scRec = delegationRecordPdaFromDelegatedAccount(scPda);
    const scMeta = delegationMetadataPdaFromDelegatedAccount(scPda);
    const scData = Buffer.alloc(9);
    DISC.delegateSeatCards.copy(scData, 0);
    scData.writeUInt8(i, 8);
    tx.add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
        { pubkey: scBuf, isSigner: false, isWritable: true },
        { pubkey: scRec, isSigner: false, isWritable: true },
        { pubkey: scMeta, isSigner: false, isWritable: true },
        { pubkey: scPda, isSigner: false, isWritable: true },
        { pubkey: tablePda, isSigner: false, isWritable: false },
        { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
      ],
      data: scData,
    }));

    await sendTx(l1, tx, [deployer], `delegate seat ${i} (perm + seat + seatCards)`);
  }

  // ═══ STEP 4: Wait for TEE propagation + Verify ═══
  console.log('\nSTEP 4: Waiting for TEE propagation (8s)...');
  await new Promise(r => setTimeout(r, 8000));

  const tableInfo = await l1.getAccountInfo(tablePda);
  console.log(`  Table owner: ${tableInfo?.owner.toBase58()} (should be DELeGG...)`);
  const vaultInfo = await l1.getAccountInfo(vaultPda);
  console.log(`  Vault: ${vaultInfo ? `${(vaultInfo.lamports / 1e9).toFixed(4)} SOL` : 'NOT FOUND'}`);

  // TEE read with auth
  console.log('  Testing TEE getAccountInfo with auth...');
  const nacl = await import('tweetnacl');
  function b58e(buf: Uint8Array): string {
    const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let n = BigInt('0x' + Buffer.from(buf).toString('hex'));
    let r = '';
    while (n > 0n) { r = A[Number(n % 58n)] + r; n = n / 58n; }
    for (let i = 0; i < buf.length && buf[i] === 0; i++) r = '1' + r;
    return r;
  }
  const pub = deployer.publicKey.toBase58();
  const cr = await (await fetch(`https://tee.magicblock.app/auth/challenge?pubkey=${pub}`)).json() as any;
  const sig = nacl.sign.detached(Buffer.from(cr.challenge, 'utf-8'), deployer.secretKey);
  const lr = await (await fetch('https://tee.magicblock.app/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pubkey: pub, challenge: cr.challenge, signature: b58e(sig) }),
  })).json() as any;
  const teeConn = new Connection(`https://tee.magicblock.app?token=${lr.token}`, 'confirmed');
  try {
    const tInfo = await teeConn.getAccountInfo(tablePda);
    console.log(`  TEE getAccountInfo: ${tInfo ? '✅ FOUND owner=' + tInfo.owner.toBase58() : '❌ null'}`);
  } catch (e: any) {
    console.log(`  TEE getAccountInfo: ❌ ${e.message?.slice(0, 120)}`);
  }

  console.log(`\n════════════════════════════════════════════`);
  console.log(`✅ TABLE CREATED AND DELEGATED TO TEE!`);
  console.log(`Table PDA: ${tablePda.toBase58()}`);
  console.log(`Creator:   ${deployer.publicKey.toBase58()}`);
  console.log(`════════════════════════════════════════════\n`);
}

main().catch(console.error);
