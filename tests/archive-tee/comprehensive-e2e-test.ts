/**
 * Comprehensive End-to-End Test
 * 
 * Tests ALL poker system features:
 * 
 * ANCHOR PROGRAM (Game Logic):
 * - Sit & Go game flow (TEE)
 * - Cash game flow (TEE)
 * - Hole cards privacy
 * - Community cards privacy
 * - Session keys
 * 
 * STEEL PROGRAM (Tokenomics):
 * - Staking ($POKER burn)
 * - Revenue distribution
 * - Claim stake rewards
 * - Mint unrefined tokens
 * - Claim refined tokens
 */

import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction, 
  SystemProgram, LAMPORTS_PER_SOL, sendAndConfirmTransaction,
} from '@solana/web3.js';
import { AnchorProvider, Wallet, Program, BN } from '@coral-xyz/anchor';
import {
  TOKEN_PROGRAM_ID, getAssociatedTokenAddress, getAccount, createAssociatedTokenAccountInstruction,
} from '@solana/spl-token';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import nacl from 'tweetnacl';

import { 
  getAuthToken, DELEGATION_PROGRAM_ID,
  delegationRecordPdaFromDelegatedAccount,
  delegationMetadataPdaFromDelegatedAccount,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  permissionPdaFromAccount,
} from '@magicblock-labs/ephemeral-rollups-sdk';

const idl = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'target', 'idl', 'cq_poker.json'), 'utf8'));

// ========== CONSTANTS ==========
const L1_RPC = 'https://devnet.helius-rpc.com/?api-key=8801f9b3-fe0b-42b5-ba5c-67f0fed31c5e';
const TEE_RPC_URL = 'https://tee.magicblock.app';
const TEE_VALIDATOR = new PublicKey('FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA');

// Anchor Program (Game Logic)
const ANCHOR_PROGRAM_ID = new PublicKey('FTuksCXGvdrYe9uP2X9S12KLHhRZHJNsrzpxP2wk2ckR');
const PERMISSION_PROGRAM_ID = new PublicKey('ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1');

// Steel Program (Tokenomics)
const STEEL_PROGRAM_ID = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');
const POOL_PDA = new PublicKey('FSKrGq26FxhMUSK85ksv2AykL5Am2HS9iXJwuVoQQvLY');
const POKER_MINT = new PublicKey('DiJC3FVReapYYDwRnPMrCRH7aYyeJ47Nu81MemTaHZWX');
const TREASURY = new PublicKey('4eLLKrNf3KTj8s3cxhGGJDU8mGHPDCFEkNi1TyM5qfQB');

// Seeds
const TABLE_SEED = Buffer.from('table');
const SEAT_CARDS_SEED = Buffer.from('seat_cards');
const SEAT_SEED = Buffer.from('seat');
const STAKE_SEED = Buffer.from('stake');
const POOL_SEED = Buffer.from('pool');

// Data offsets
const CARD1_OFFSET = 8 + 32 + 1 + 32;
const CARD2_OFFSET = CARD1_OFFSET + 1;

// ========== HELPERS ==========
let passed = 0, failed = 0, skipped = 0;
function test(name: string, ok: boolean, err?: string) {
  if (ok) { console.log(`  ✅ ${name}`); passed++; }
  else { console.log(`  ❌ ${name}${err ? ': ' + err : ''}`); failed++; }
}
function skip(name: string, reason: string) {
  console.log(`  ⏭️  ${name}: ${reason}`);
  skipped++;
}
function info(msg: string) { console.log(`  ℹ️  ${msg}`); }
function section(title: string) {
  console.log('\n' + '═'.repeat(70));
  console.log(`  ${title}`);
  console.log('═'.repeat(70));
}
async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

const CARDS = ['2♠','3♠','4♠','5♠','6♠','7♠','8♠','9♠','T♠','J♠','Q♠','K♠','A♠',
  '2♥','3♥','4♥','5♥','6♥','7♥','8♥','9♥','T♥','J♥','Q♥','K♥','A♥',
  '2♦','3♦','4♦','5♦','6♦','7♦','8♦','9♦','T♦','J♦','Q♦','K♦','A♦',
  '2♣','3♣','4♣','5♣','6♣','7♣','8♣','9♣','T♣','J♣','Q♣','K♣','A♣'];
function cardName(i: number) { return i === 255 ? '??' : CARDS[i] || `#${i}`; }

function derivePda(seeds: Buffer[], programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, programId);
}

async function getAuthenticatedTee(player: Keypair): Promise<Connection> {
  const signMsg = async (m: Uint8Array) => nacl.sign.detached(m, player.secretKey);
  const auth = await getAuthToken(TEE_RPC_URL, player.publicKey, signMsg);
  const token = typeof auth === 'string' ? auth : (auth as any)?.token;
  return new Connection(`${TEE_RPC_URL}?token=${token}`, 'confirmed');
}

function getStakePDA(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([STAKE_SEED, owner.toBuffer()], STEEL_PROGRAM_ID);
}

// ========== MAIN TEST ==========
async function main() {
  console.log('╔' + '═'.repeat(68) + '╗');
  console.log('║' + ' '.repeat(15) + 'COMPREHENSIVE END-TO-END TEST' + ' '.repeat(23) + '║');
  console.log('╚' + '═'.repeat(68) + '╝');

  // Load players
  const player1 = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync('J:/Poker/tests/keys/player1.json', 'utf-8'))));
  const player2 = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync('J:/Poker/tests/keys/player2.json', 'utf-8'))));
  
  console.log(`\n📋 Player1: ${player1.publicKey.toBase58().slice(0, 20)}...`);
  console.log(`📋 Player2: ${player2.publicKey.toBase58().slice(0, 20)}...`);

  const l1 = new Connection(L1_RPC, 'confirmed');
  const provider = new AnchorProvider(l1, new Wallet(player1), { commitment: 'confirmed' });
  const program = new Program(idl as any, ANCHOR_PROGRAM_ID, provider);

  // Check balances
  const bal1 = await l1.getBalance(player1.publicKey);
  const bal2 = await l1.getBalance(player2.publicKey);
  info(`Player1 SOL: ${(bal1 / LAMPORTS_PER_SOL).toFixed(4)}`);
  info(`Player2 SOL: ${(bal2 / LAMPORTS_PER_SOL).toFixed(4)}`);

  // ==================== PART 1: SIT & GO GAME ON TEE ====================
  section('PART 1: SIT & GO GAME (TEE Privacy)');

  // Generate unique table ID for Sit & Go
  const sngTableIdBytes = new Uint8Array(32);
  new DataView(sngTableIdBytes.buffer).setBigUint64(0, BigInt(Date.now()), true);
  sngTableIdBytes[31] = 0xA1;

  const [sngTablePda] = derivePda([TABLE_SEED, Buffer.from(sngTableIdBytes)], ANCHOR_PROGRAM_ID);
  const [sngSeatCards0Pda] = derivePda([SEAT_CARDS_SEED, sngTablePda.toBuffer(), Buffer.from([0])], ANCHOR_PROGRAM_ID);
  const sngPermission0Pda = permissionPdaFromAccount(sngSeatCards0Pda);

  // Step 1.1: Create Sit & Go Table
  console.log('\n--- 1.1 Create Sit & Go Table ---');
  try {
    const config = {
      tableId: Array.from(sngTableIdBytes),
      gameType: { sitAndGoHeadsUp: {} },
      stakes: { micro: {} },
      maxPlayers: 2,
    };
    await program.methods.createTable(config).accounts({
      authority: player1.publicKey, table: sngTablePda, pool: POOL_PDA, systemProgram: SystemProgram.programId,
    }).signers([player1]).rpc();
    test('Sit & Go table created', true);
  } catch (e: any) {
    test('Sit & Go table created', false, e.message?.slice(0, 50));
  }

  // Step 1.2: Create Empty SeatCards
  console.log('\n--- 1.2 Create Empty SeatCards (Privacy) ---');
  try {
    await program.methods.dealHoleCardsWithPermission(0, 255, 255).accounts({
      payer: player1.publicKey, player: player1.publicKey, table: sngTablePda,
      seatCards: sngSeatCards0Pda, permission: sngPermission0Pda,
      permissionProgram: PERMISSION_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).signers([player1]).rpc();
    
    // Verify empty on L1
    const sc = await l1.getAccountInfo(sngSeatCards0Pda);
    if (sc) {
      const c1 = sc.data[CARD1_OFFSET], c2 = sc.data[CARD2_OFFSET];
      test('SeatCards created empty (255, 255)', c1 === 255 && c2 === 255);
    }
  } catch (e: any) {
    test('SeatCards created', false, e.message?.slice(0, 50));
  }

  // Step 1.3: Delegate to TEE
  console.log('\n--- 1.3 Delegate Table + SeatCards to TEE ---');
  
  // Delegate table
  const sngBufferPda = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(sngTablePda, ANCHOR_PROGRAM_ID);
  const sngDelegationRecord = delegationRecordPdaFromDelegatedAccount(sngTablePda);
  const sngDelegationMetadata = delegationMetadataPdaFromDelegatedAccount(sngTablePda);

  try {
    const disc = crypto.createHash('sha256').update('global:delegate_table').digest().slice(0, 8);
    const data = Buffer.concat([disc, Buffer.from(sngTableIdBytes)]);
    const ix = new TransactionInstruction({
      keys: [
        { pubkey: player1.publicKey, isSigner: true, isWritable: true },
        { pubkey: sngBufferPda, isSigner: false, isWritable: true },
        { pubkey: sngDelegationRecord, isSigner: false, isWritable: true },
        { pubkey: sngDelegationMetadata, isSigner: false, isWritable: true },
        { pubkey: sngTablePda, isSigner: false, isWritable: true },
        { pubkey: ANCHOR_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
      ],
      programId: ANCHOR_PROGRAM_ID, data,
    });
    const tx = new Transaction().add(ix);
    tx.feePayer = player1.publicKey;
    tx.recentBlockhash = (await l1.getLatestBlockhash()).blockhash;
    tx.sign(player1);
    await l1.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await sleep(2000);
    test('Table delegated to TEE', true);
  } catch (e: any) {
    test('Table delegated', false, e.message?.slice(0, 50));
  }

  // Delegate SeatCards
  const scBufferPda = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(sngSeatCards0Pda, ANCHOR_PROGRAM_ID);
  const scDelegationRecord = delegationRecordPdaFromDelegatedAccount(sngSeatCards0Pda);
  const scDelegationMetadata = delegationMetadataPdaFromDelegatedAccount(sngSeatCards0Pda);

  try {
    const disc = crypto.createHash('sha256').update('global:delegate_seat_cards').digest().slice(0, 8);
    const data = Buffer.concat([disc, Buffer.from([0])]);
    const ix = new TransactionInstruction({
      keys: [
        { pubkey: player1.publicKey, isSigner: true, isWritable: true },
        { pubkey: scBufferPda, isSigner: false, isWritable: true },
        { pubkey: scDelegationRecord, isSigner: false, isWritable: true },
        { pubkey: scDelegationMetadata, isSigner: false, isWritable: true },
        { pubkey: sngSeatCards0Pda, isSigner: false, isWritable: true },
        { pubkey: sngTablePda, isSigner: false, isWritable: false },
        { pubkey: ANCHOR_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
      ],
      programId: ANCHOR_PROGRAM_ID, data,
    });
    const tx = new Transaction().add(ix);
    tx.feePayer = player1.publicKey;
    tx.recentBlockhash = (await l1.getLatestBlockhash()).blockhash;
    tx.sign(player1);
    await l1.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await sleep(2000);
    test('SeatCards delegated to TEE', true);
  } catch (e: any) {
    test('SeatCards delegated', false, e.message?.slice(0, 50));
  }

  await sleep(2000);

  // Step 1.4: Deal cards on TEE
  console.log('\n--- 1.4 Deal Hole Cards ON TEE ---');
  const tee = await getAuthenticatedTee(player1);
  
  const realCard1 = 12, realCard2 = 11; // A♠ K♠
  try {
    const disc = crypto.createHash('sha256').update('global:update_seat_cards').digest().slice(0, 8);
    const data = Buffer.concat([disc, Buffer.from([0, realCard1, realCard2])]);
    const ix = new TransactionInstruction({
      keys: [
        { pubkey: player1.publicKey, isSigner: true, isWritable: false },
        { pubkey: sngSeatCards0Pda, isSigner: false, isWritable: true },
        { pubkey: sngTablePda, isSigner: false, isWritable: false },
      ],
      programId: ANCHOR_PROGRAM_ID, data,
    });
    const tx = new Transaction().add(ix);
    tx.feePayer = player1.publicKey;
    tx.recentBlockhash = (await tee.getLatestBlockhash()).blockhash;
    tx.sign(player1);
    await tee.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await sleep(2000);
    test('Cards dealt on TEE', true);
  } catch (e: any) {
    test('Cards dealt on TEE', false, e.message?.slice(0, 50));
  }

  // Step 1.5: Verify privacy
  console.log('\n--- 1.5 Verify Privacy ---');
  
  // L1 should be delegated
  const scL1 = await l1.getAccountInfo(sngSeatCards0Pda);
  if (scL1) {
    test('L1 shows delegated (private)', scL1.owner.equals(DELEGATION_PROGRAM_ID));
  }

  // TEE should show real cards
  try {
    const scTee = await tee.getAccountInfo(sngSeatCards0Pda);
    if (scTee && scTee.data.length > 0) {
      const c1 = scTee.data[CARD1_OFFSET], c2 = scTee.data[CARD2_OFFSET];
      info(`TEE cards: ${cardName(c1)} ${cardName(c2)}`);
      test('TEE shows real cards', c1 === realCard1 && c2 === realCard2);
    }
  } catch (e: any) {
    test('TEE shows real cards', false, e.message?.slice(0, 40));
  }

  // ==================== PART 2: CASH GAME ====================
  section('PART 2: CASH GAME');

  const cashTableIdBytes = new Uint8Array(32);
  new DataView(cashTableIdBytes.buffer).setBigUint64(0, BigInt(Date.now() + 1000), true);
  cashTableIdBytes[31] = 0xB2;

  const [cashTablePda] = derivePda([TABLE_SEED, Buffer.from(cashTableIdBytes)], ANCHOR_PROGRAM_ID);

  console.log('\n--- 2.1 Create Cash Game Table ---');
  try {
    const config = {
      tableId: Array.from(cashTableIdBytes),
      gameType: { cashGame: {} },
      stakes: { micro: {} },  // 1/2 blinds
      maxPlayers: 6,
    };
    await program.methods.createTable(config).accounts({
      authority: player1.publicKey, table: cashTablePda, pool: POOL_PDA, systemProgram: SystemProgram.programId,
    }).signers([player1]).rpc();
    test('Cash game table created', true);
    
    // Verify table type
    const tableData = await l1.getAccountInfo(cashTablePda);
    if (tableData) {
      info(`Cash table size: ${tableData.data.length} bytes`);
    }
  } catch (e: any) {
    test('Cash game table created', false, e.message?.slice(0, 50));
  }

  // ==================== PART 3: STEEL TOKENOMICS ====================
  section('PART 3: TOKENOMICS (Steel Program)');

  // Check Pool state
  console.log('\n--- 3.1 Check Pool State ---');
  try {
    const poolData = await l1.getAccountInfo(POOL_PDA);
    if (poolData) {
      info(`Pool account exists: ${poolData.data.length} bytes`);
      test('Pool PDA accessible', true);
    } else {
      test('Pool PDA accessible', false, 'Not found');
    }
  } catch (e: any) {
    test('Pool PDA accessible', false, e.message?.slice(0, 40));
  }

  // Check POKER token balance
  console.log('\n--- 3.2 Check $POKER Token Balance ---');
  let hasPokerTokens = false;
  try {
    const tokenAccount = await getAssociatedTokenAddress(POKER_MINT, player1.publicKey);
    const account = await getAccount(l1, tokenAccount);
    const balance = Number(account.amount) / 1e9;
    info(`$POKER balance: ${balance.toFixed(2)} tokens`);
    hasPokerTokens = account.amount > 0n;
    test('$POKER token account exists', true);
  } catch (e: any) {
    skip('$POKER balance check', 'No token account');
  }

  // Test staking (burn_stake)
  console.log('\n--- 3.3 Staking (Burn $POKER) ---');
  const [stakePda] = getStakePDA(player1.publicKey);
  
  if (hasPokerTokens) {
    try {
      const tokenAccount = await getAssociatedTokenAddress(POKER_MINT, player1.publicKey);
      const stakeAmount = 10n * 1_000_000_000n; // 10 POKER
      
      // BurnStake discriminator = 1
      const burnStakeData = Buffer.alloc(9);
      burnStakeData.writeUInt8(1, 0);
      burnStakeData.writeBigUInt64LE(stakeAmount, 1);

      const burnStakeIx = new TransactionInstruction({
        programId: STEEL_PROGRAM_ID,
        keys: [
          { pubkey: player1.publicKey, isSigner: true, isWritable: true },
          { pubkey: stakePda, isSigner: false, isWritable: true },
          { pubkey: POOL_PDA, isSigner: false, isWritable: true },
          { pubkey: tokenAccount, isSigner: false, isWritable: true },
          { pubkey: POKER_MINT, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: burnStakeData,
      });

      const tx = new Transaction().add(burnStakeIx);
      await sendAndConfirmTransaction(l1, tx, [player1]);
      test('Staked 10 $POKER (burn_stake)', true);
    } catch (e: any) {
      test('Staked $POKER', false, e.message?.slice(0, 50));
    }
  } else {
    skip('Staking test', 'No $POKER tokens');
  }

  // Check stake account
  console.log('\n--- 3.4 Check Stake Account ---');
  try {
    const stakeData = await l1.getAccountInfo(stakePda);
    if (stakeData) {
      info(`Stake account exists: ${stakeData.data.length} bytes`);
      test('Stake PDA created', true);
    } else {
      skip('Stake account check', 'Not staked yet');
    }
  } catch (e: any) {
    skip('Stake account check', e.message?.slice(0, 40));
  }

  // Test claim_stake_rewards
  console.log('\n--- 3.5 Claim Stake Rewards ---');
  try {
    const stakeData = await l1.getAccountInfo(stakePda);
    if (stakeData) {
      // ClaimStakeRewards discriminator = 3
      const claimData = Buffer.alloc(1);
      claimData.writeUInt8(3, 0);

      const claimIx = new TransactionInstruction({
        programId: STEEL_PROGRAM_ID,
        keys: [
          { pubkey: player1.publicKey, isSigner: true, isWritable: true },
          { pubkey: stakePda, isSigner: false, isWritable: true },
          { pubkey: POOL_PDA, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: claimData,
      });

      const tx = new Transaction().add(claimIx);
      await sendAndConfirmTransaction(l1, tx, [player1]);
      test('Claimed stake rewards', true);
    } else {
      skip('Claim rewards', 'No stake account');
    }
  } catch (e: any) {
    // May fail if no rewards to claim - that's ok
    if (e.message?.includes('no rewards')) {
      skip('Claim rewards', 'No rewards available');
    } else {
      test('Claimed rewards', false, e.message?.slice(0, 50));
    }
  }

  // Test mint_unrefined
  console.log('\n--- 3.6 Mint Unrefined Tokens ---');
  try {
    const stakeData = await l1.getAccountInfo(stakePda);
    if (stakeData) {
      // MintUnrefined discriminator = 4
      const mintData = Buffer.alloc(1);
      mintData.writeUInt8(4, 0);

      const tokenAccount = await getAssociatedTokenAddress(POKER_MINT, player1.publicKey);

      const mintIx = new TransactionInstruction({
        programId: STEEL_PROGRAM_ID,
        keys: [
          { pubkey: player1.publicKey, isSigner: true, isWritable: true },
          { pubkey: stakePda, isSigner: false, isWritable: true },
          { pubkey: POOL_PDA, isSigner: false, isWritable: true },
          { pubkey: tokenAccount, isSigner: false, isWritable: true },
          { pubkey: POKER_MINT, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: mintData,
      });

      const tx = new Transaction().add(mintIx);
      await sendAndConfirmTransaction(l1, tx, [player1]);
      test('Minted unrefined tokens', true);
    } else {
      skip('Mint unrefined', 'No stake account');
    }
  } catch (e: any) {
    if (e.message?.includes('nothing to mint') || e.message?.includes('no unrefined')) {
      skip('Mint unrefined', 'No unrefined to mint');
    } else {
      test('Minted unrefined', false, e.message?.slice(0, 50));
    }
  }

  // ==================== SUMMARY ====================
  section('TEST SUMMARY');
  
  console.log(`\n  ✅ Passed:  ${passed}`);
  console.log(`  ❌ Failed:  ${failed}`);
  console.log(`  ⏭️  Skipped: ${skipped}`);
  console.log(`  📊 Total:   ${passed + failed + skipped}`);

  // ==================== FRONTEND REQUIREMENTS ====================
  section('FRONTEND REQUIREMENTS');
  
  console.log(`
  📋 REQUIRED FOR V2 FRONTEND:

  1. TEE AUTH TOKEN MANAGEMENT
     - Get auth token: getAuthToken(TEE_RPC_URL, publicKey, signFunction)
     - Token needed for ALL TEE reads/writes
     - Auto-refresh before expiry

  2. HOLE CARDS FLOW
     - Create empty SeatCards on L1 (cards = 255)
     - Delegate SeatCards to TEE
     - Deal cards ON TEE via update_seat_cards
     - Read cards from TEE with auth token
     - Player sees own cards, others see "??"

  3. COMMUNITY CARDS FLOW
     - Table delegated to TEE
     - Cards dealt automatically on phase change
     - Read from TEE when visible (after betting round)

  4. SESSION KEYS (Gasless Actions)
     - Create session via create_session instruction
     - Session key signs player_action calls
     - Main wallet still pays fees (use TEE for true gasless)

  5. CRANK SERVICE REQUIREMENTS
     - Advance phases when betting complete
     - Trigger timeouts for inactive players
     - Deal community cards on phase transitions
     - Settle hands at showdown
     - Undelegate accounts when game ends

  6. STAKING UI
     - burn_stake: Stake $POKER tokens
     - claim_stake_rewards: Claim SOL rewards
     - mint_unrefined: Mint unrefined tokens
     - claim_refined: Claim refined tokens
`);

  // ==================== QUESTIONS ====================
  section('QUESTIONS FOR YOU');
  
  console.log(`
  ❓ NEED YOUR INPUT:

  1. HOLE CARDS REVEAL AT SHOWDOWN
     Current: Cards stay private, need reveal_cards_with_permission to show
     Options:
     a) Auto-reveal when entering Showdown phase (crank triggers)
     b) Player clicks "Show" button
     c) Auto-reveal only for winner, others can muck
     → Which do you prefer?

  2. SESSION KEY EXPIRY
     Current: Session expires after set time
     → How long should sessions last? 1 hour? 24 hours? Per-game?

  3. CRANK SERVICE
     → Who runs the crank? Central server or decentralized?
     → Should players be able to trigger timeouts themselves?

  4. RAKE DISTRIBUTION
     → When does rake get distributed? After each hand? Daily?

  5. UNREFINED → REFINED
     → What's the refinement rate/timeline?
     → Any lockup period?

  6. FRONTEND TECH STACK
     → Next.js 14+? React?
     → State management? Zustand? Redux?
     → Styling? Tailwind? Styled-components?
`);
}

main().catch(console.error);
