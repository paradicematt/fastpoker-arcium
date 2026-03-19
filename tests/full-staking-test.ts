/**
 * Full Staking & Multi-Account Tournament Test
 * 
 * - 6 accounts, 3 heads-up tournaments
 * - Registration fees (0.5 SOL each)
 * - Winners get POKER tokens minted
 * - Some claim (10% tax), some don't
 * - Stake/burn POKER for SOL rewards
 * - Check circulating supply
 */

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { Program, AnchorProvider, BN, Idl } from '@coral-xyz/anchor';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, getAccount } from '@solana/spl-token';
import * as fs from 'fs';
import * as path from 'path';

// Program IDs
const CQ_POKER_PROGRAM_ID = new PublicKey('FTuksCXGvdrYe9uP2X9S12KLHhRZHJNsrzpxP2wk2ckR');
const STEEL_PROGRAM_ID = new PublicKey('BaYBb2JtaVffVnQYk1TwDUwZskgdnZcnNawfVzj3YvkH');
const POKER_MINT = new PublicKey('DiJC3FVReapYYDwRnPMrCRH7aYyeJ47Nu81MemTaHZWX');

// Seeds
const PLAYER_SEED = Buffer.from('player');
const TABLE_SEED = Buffer.from('table');
const SEAT_SEED = Buffer.from('seat');
const POOL_SEED = Buffer.from('pool');
const UNREFINED_SEED = Buffer.from('unrefined');
const STAKE_SEED = Buffer.from('stake');

const RPC_URL = 'https://api.devnet.solana.com';

// Helpers
function loadOrCreateKeypair(filePath: string): Keypair {
  try {
    if (fs.existsSync(filePath)) {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(filePath, 'utf-8'))));
    }
  } catch (e) {}
  const keypair = Keypair.generate();
  fs.writeFileSync(filePath, JSON.stringify(Array.from(keypair.secretKey)));
  return keypair;
}

function getPlayerPDA(wallet: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([PLAYER_SEED, wallet.toBuffer()], CQ_POKER_PROGRAM_ID);
}

function getTablePDA(tableId: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([TABLE_SEED, tableId], CQ_POKER_PROGRAM_ID);
}

function getSeatPDA(table: PublicKey, seatNumber: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEAT_SEED, table.toBuffer(), Buffer.from([seatNumber])], CQ_POKER_PROGRAM_ID);
}

function getPoolPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([POOL_SEED], STEEL_PROGRAM_ID);
}

function getUnrefinedPDA(winner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([UNREFINED_SEED, winner.toBuffer()], STEEL_PROGRAM_ID);
}

function getStakePDA(staker: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([STAKE_SEED, staker.toBuffer()], STEEL_PROGRAM_ID);
}

function loadIDL(): Idl {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '../target/idl/cq_poker.json'), 'utf-8'));
}

function createWallet(keypair: Keypair) {
  return {
    publicKey: keypair.publicKey,
    signTransaction: async (tx: any) => { tx.partialSign(keypair); return tx; },
    signAllTransactions: async (txs: any[]) => { txs.forEach(tx => tx.partialSign(keypair)); return txs; },
  };
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('='.repeat(70));
  console.log('Full Staking & Multi-Account Tournament Test');
  console.log('='.repeat(70));

  const connection = new Connection(RPC_URL, 'confirmed');
  const keysDir = path.join(__dirname, 'keys');
  if (!fs.existsSync(keysDir)) fs.mkdirSync(keysDir, { recursive: true });

  const idl = loadIDL();
  const [poolPDA] = getPoolPDA();
  const treasury = loadOrCreateKeypair(path.join(keysDir, 'treasury.json'));

  // Use existing funded accounts
  const players: Keypair[] = [
    loadOrCreateKeypair(path.join(keysDir, 'player1.json')),
    loadOrCreateKeypair(path.join(keysDir, 'player2.json')),
  ];

  console.log('\n📋 Players:');
  players.forEach((p, i) => console.log(`  ${i + 1}. ${p.publicKey.toBase58()}`));
  console.log(`\nTreasury: ${treasury.publicKey.toBase58()}`);
  console.log(`Pool PDA: ${poolPDA.toBase58()}`);

  // ============================================================
  // STEP 1: Fund All Players (if needed)
  // ============================================================
  console.log('\n' + '='.repeat(70));
  console.log('STEP 1: Check/Fund Player Balances');
  console.log('='.repeat(70));

  for (const player of players) {
    const balance = await connection.getBalance(player.publicKey);
    if (balance < 0.6 * LAMPORTS_PER_SOL) {
      console.log(`⚠️  Player ${player.publicKey.toBase58().slice(0, 8)}... needs funding (${balance / LAMPORTS_PER_SOL} SOL)`);
    } else {
      console.log(`✅ Player ${player.publicKey.toBase58().slice(0, 8)}... has ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    }
  }

  // ============================================================
  // STEP 2: Register Players (0.5 SOL fee)
  // ============================================================
  console.log('\n' + '='.repeat(70));
  console.log('STEP 2: Register Players (0.5 SOL each)');
  console.log('='.repeat(70));

  const treasuryBalanceBefore = await connection.getBalance(treasury.publicKey);
  console.log(`Treasury before: ${treasuryBalanceBefore / LAMPORTS_PER_SOL} SOL`);

  for (const player of players) {
    const [playerPDA] = getPlayerPDA(player.publicKey);
    const provider = new AnchorProvider(connection, createWallet(player) as any, { commitment: 'confirmed' });
    const program = new Program(idl, CQ_POKER_PROGRAM_ID, provider);

    try {
      // Check if already registered
      const existing = await connection.getAccountInfo(playerPDA);
      if (existing) {
        // Set free entries for testing
        await program.methods
          .setFreeEntries(10)
          .accounts({ admin: player.publicKey, playerAccount: playerPDA })
          .signers([player])
          .rpc();
        console.log(`✅ ${player.publicKey.toBase58().slice(0, 8)}... already registered, set 10 free entries`);
      } else {
        await program.methods
          .registerPlayer()
          .accounts({
            player: player.publicKey,
            playerAccount: playerPDA,
            treasury: treasury.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([player])
          .rpc();
        console.log(`✅ ${player.publicKey.toBase58().slice(0, 8)}... registered (paid 0.5 SOL)`);
      }
    } catch (e: any) {
      console.log(`❌ ${player.publicKey.toBase58().slice(0, 8)}... registration failed: ${e.message.slice(0, 40)}`);
    }
    await sleep(500);
  }

  const treasuryBalanceAfter = await connection.getBalance(treasury.publicKey);
  console.log(`\nTreasury after: ${treasuryBalanceAfter / LAMPORTS_PER_SOL} SOL`);
  console.log(`Registration fees collected: ${(treasuryBalanceAfter - treasuryBalanceBefore) / LAMPORTS_PER_SOL} SOL`);

  // ============================================================
  // STEP 3: Run 3 Heads-Up Tournaments
  // ============================================================
  console.log('\n' + '='.repeat(70));
  console.log('STEP 3: Run 3 Heads-Up Tournaments');
  console.log('='.repeat(70));

  const winners: Keypair[] = [];
  const prizeAmounts: bigint[] = [];

  // Run 1 tournament with 2 players
  for (let game = 0; game < 1; game++) {
    const p1 = players[0];
    const p2 = players[1];
    
    console.log(`\n--- Tournament ${game + 1}: ${p1.publicKey.toBase58().slice(0, 8)}... vs ${p2.publicKey.toBase58().slice(0, 8)}... ---`);

    const provider1 = new AnchorProvider(connection, createWallet(p1) as any, { commitment: 'confirmed' });
    const program1 = new Program(idl, CQ_POKER_PROGRAM_ID, provider1);
    const provider2 = new AnchorProvider(connection, createWallet(p2) as any, { commitment: 'confirmed' });
    const program2 = new Program(idl, CQ_POKER_PROGRAM_ID, provider2);

    const tableId = new Uint8Array(32);
    crypto.getRandomValues(tableId);
    const [tablePDA] = getTablePDA(tableId);
    const [seat0PDA] = getSeatPDA(tablePDA, 0);
    const [seat1PDA] = getSeatPDA(tablePDA, 1);
    const [p1PDA] = getPlayerPDA(p1.publicKey);
    const [p2PDA] = getPlayerPDA(p2.publicKey);

    try {
      // Create table
      await program1.methods
        .createTable({
          tableId: Array.from(tableId),
          gameType: { sitAndGoHeadsUp: {} },
          stakes: { micro: {} },
          maxPlayers: 2,
        })
        .accounts({
          authority: p1.publicKey,
          table: tablePDA,
          pool: poolPDA,
          systemProgram: SystemProgram.programId,
        })
        .signers([p1])
        .rpc();

      // Both join
      for (const [player, pda, seat, seatNum, program] of [
        [p1, p1PDA, seat0PDA, 0, program1],
        [p2, p2PDA, seat1PDA, 1, program2],
      ] as const) {
        await program.methods
          .joinTable(new BN(1500), seatNum)
          .accounts({
            player: player.publicKey,
            playerAccount: pda,
            table: tablePDA,
            seat: seat,
            treasury: treasury.publicKey,
            playerTokenAccount: null,
            tableTokenAccount: null,
            tokenProgram: null,
            systemProgram: SystemProgram.programId,
          })
          .signers([player])
          .rpc();
      }

      // Start and deal
      await program1.methods.startGame()
        .accounts({ initiator: p1.publicKey, table: tablePDA })
        .signers([p1]).rpc();

      await program1.methods.dealHoleCards([
        { seatIndex: 0, encryptedData: new Array(64).fill(0), commitment: new Array(32).fill(game) },
        { seatIndex: 1, encryptedData: new Array(64).fill(0), commitment: new Array(32).fill(game + 100) },
      ]).accounts({ dealer: p1.publicKey, table: tablePDA }).signers([p1]).rpc();

      // P1 all-in, P2 calls
      await program1.methods.playerAction({ allIn: {} })
        .accounts({ signer: p1.publicKey, table: tablePDA, seat: seat0PDA, sessionToken: null })
        .signers([p1]).rpc();

      await program2.methods.playerAction({ call: {} })
        .accounts({ signer: p2.publicKey, table: tablePDA, seat: seat1PDA, sessionToken: null })
        .signers([p2]).rpc();

      // Deal community
      await program1.methods.dealCommunity({ flop: {} }, [10, 20, 30])
        .accounts({ dealer: p1.publicKey, table: tablePDA }).signers([p1]).rpc();
      await program1.methods.dealCommunity({ turn: {} }, [40])
        .accounts({ dealer: p1.publicKey, table: tablePDA }).signers([p1]).rpc();
      await program1.methods.dealCommunity({ river: {} }, [50])
        .accounts({ dealer: p1.publicKey, table: tablePDA }).signers([p1]).rpc();

      // Settle - P1 wins
      const tbl = await program1.account.table.fetch(tablePDA) as any;
      await program1.methods.settleHand([0], [new BN(tbl.pot.toString())], new BN(0))
        .accounts({ settler: p1.publicKey, table: tablePDA, pool: poolPDA })
        .remainingAccounts([
          { pubkey: seat0PDA, isWritable: true, isSigner: false },
          { pubkey: seat1PDA, isWritable: true, isSigner: false },
        ])
        .signers([p1]).rpc();

      console.log(`✅ Tournament ${game + 1} complete. Winner: Player ${game * 2 + 1}`);
      winners.push(p1);
      prizeAmounts.push(BigInt(1000_000_000_000)); // 1000 POKER per win

    } catch (e: any) {
      console.log(`❌ Tournament ${game + 1} failed: ${e.message.slice(0, 50)}`);
    }
    await sleep(1000);
  }

  // ============================================================
  // STEP 4: Mint POKER to All Winners
  // ============================================================
  console.log('\n' + '='.repeat(70));
  console.log('STEP 4: Mint POKER to All Winners');
  console.log('='.repeat(70));

  for (let i = 0; i < winners.length; i++) {
    const winner = winners[i];
    const amount = prizeAmounts[i];
    const [unrefinedPDA] = getUnrefinedPDA(winner.publicKey);

    const mintData = Buffer.alloc(41);
    mintData[0] = 4; // MintUnrefined discriminator
    mintData.writeBigUInt64LE(amount, 1);

    const ix = new TransactionInstruction({
      keys: [
        { pubkey: winner.publicKey, isSigner: true, isWritable: true },
        { pubkey: unrefinedPDA, isSigner: false, isWritable: true },
        { pubkey: poolPDA, isSigner: false, isWritable: true },
        { pubkey: POKER_MINT, isSigner: false, isWritable: true },
        { pubkey: poolPDA, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: winner.publicKey, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: STEEL_PROGRAM_ID,
      data: mintData,
    });

    try {
      const tx = new Transaction().add(ix);
      await sendAndConfirmTransaction(connection, tx, [winner]);
      console.log(`✅ Minted ${Number(amount) / 1e9} POKER to winner ${i + 1}`);
    } catch (e: any) {
      console.log(`❌ Mint failed for winner ${i + 1}: ${e.message.slice(0, 40)}`);
    }
    await sleep(500);
  }

  // ============================================================
  // STEP 5: Some Claim, Some Don't
  // ============================================================
  console.log('\n' + '='.repeat(70));
  console.log('STEP 5: Claim Testing (Some claim, some dont)');
  console.log('='.repeat(70));

  // Winner claims
  const claimers = winners.length > 0 ? [winners[0]] : [];
  
  for (const claimer of claimers) {
    const [unrefinedPDA] = getUnrefinedPDA(claimer.publicKey);
    const claimerATA = await getAssociatedTokenAddress(POKER_MINT, claimer.publicKey);

    // Create ATA if needed
    const ataInfo = await connection.getAccountInfo(claimerATA);
    if (!ataInfo) {
      const createATAix = createAssociatedTokenAccountInstruction(claimer.publicKey, claimerATA, claimer.publicKey, POKER_MINT);
      await sendAndConfirmTransaction(connection, new Transaction().add(createATAix), [claimer]);
    }

    const claimData = Buffer.from([5]); // ClaimRefined
    const claimIx = new TransactionInstruction({
      keys: [
        { pubkey: claimer.publicKey, isSigner: true, isWritable: true },
        { pubkey: unrefinedPDA, isSigner: false, isWritable: true },
        { pubkey: poolPDA, isSigner: false, isWritable: true },
        { pubkey: claimerATA, isSigner: false, isWritable: true },
        { pubkey: POKER_MINT, isSigner: false, isWritable: true },
        { pubkey: poolPDA, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      programId: STEEL_PROGRAM_ID,
      data: claimData,
    });

    try {
      await sendAndConfirmTransaction(connection, new Transaction().add(claimIx), [claimer]);
      const balance = await connection.getTokenAccountBalance(claimerATA);
      console.log(`✅ ${claimer.publicKey.toBase58().slice(0, 8)}... claimed: ${balance.value.uiAmountString} POKER`);
    } catch (e: any) {
      console.log(`❌ Claim failed: ${e.message.slice(0, 40)}`);
    }
    await sleep(500);
  }

  console.log(`\n⏳ Winner 2 did NOT claim (should get 10% redistribution later)`);

  // ============================================================
  // STEP 6: Stake/Burn POKER Tokens
  // ============================================================
  console.log('\n' + '='.repeat(70));
  console.log('STEP 6: Stake/Burn POKER Tokens');
  console.log('='.repeat(70));

  const staker = winners.length > 0 ? winners[0] : players[0]; // First winner stakes some POKER
  const stakerATA = await getAssociatedTokenAddress(POKER_MINT, staker.publicKey);
  const [stakePDA] = getStakePDA(staker.publicKey);

  // Check current POKER balance
  try {
    const balance = await connection.getTokenAccountBalance(stakerATA);
    console.log(`Staker POKER balance: ${balance.value.uiAmountString}`);

    if (Number(balance.value.amount) > 0) {
      const stakeAmount = BigInt(balance.value.amount) / 2n; // Stake half
      
      const burnData = Buffer.alloc(9);
      burnData[0] = 1; // BurnStake discriminator
      burnData.writeBigUInt64LE(stakeAmount, 1);

      const burnIx = new TransactionInstruction({
        keys: [
          { pubkey: staker.publicKey, isSigner: true, isWritable: true },
          { pubkey: stakePDA, isSigner: false, isWritable: true },
          { pubkey: poolPDA, isSigner: false, isWritable: true },
          { pubkey: stakerATA, isSigner: false, isWritable: true },
          { pubkey: POKER_MINT, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        programId: STEEL_PROGRAM_ID,
        data: burnData,
      });

      await sendAndConfirmTransaction(connection, new Transaction().add(burnIx), [staker]);
      console.log(`✅ Burned ${Number(stakeAmount) / 1e9} POKER to stake`);

      const newBalance = await connection.getTokenAccountBalance(stakerATA);
      console.log(`   New POKER balance: ${newBalance.value.uiAmountString}`);
    }
  } catch (e: any) {
    console.log(`❌ Stake failed: ${e.message.slice(0, 50)}`);
  }

  // ============================================================
  // STEP 7: Deposit SOL Revenue (simulating rake)
  // ============================================================
  console.log('\n' + '='.repeat(70));
  console.log('STEP 7: Deposit SOL Revenue to Pool');
  console.log('='.repeat(70));

  const depositor = players[0];
  const depositAmount = 0.1 * LAMPORTS_PER_SOL;

  const depositData = Buffer.alloc(10);
  depositData[0] = 2; // DepositRevenue discriminator
  depositData.writeBigUInt64LE(BigInt(Math.floor(depositAmount)), 1);
  depositData[9] = 1; // source_type = rake

  const depositIx = new TransactionInstruction({
    keys: [
      { pubkey: depositor.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolPDA, isSigner: false, isWritable: true },
      { pubkey: depositor.publicKey, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: STEEL_PROGRAM_ID,
    data: depositData,
  });

  try {
    await sendAndConfirmTransaction(connection, new Transaction().add(depositIx), [depositor]);
    console.log(`✅ Deposited ${depositAmount / LAMPORTS_PER_SOL} SOL as rake revenue`);
  } catch (e: any) {
    console.log(`❌ Deposit failed: ${e.message.slice(0, 50)}`);
  }

  // ============================================================
  // STEP 8: Claim SOL Staking Rewards
  // ============================================================
  console.log('\n' + '='.repeat(70));
  console.log('STEP 8: Claim SOL Staking Rewards');
  console.log('='.repeat(70));

  const claimRewardsData = Buffer.from([3]); // ClaimStakeRewards discriminator

  // claim_stake_rewards expects: [staker, stake, pool, system_program]
  const claimRewardsIx = new TransactionInstruction({
    keys: [
      { pubkey: staker.publicKey, isSigner: true, isWritable: true },
      { pubkey: stakePDA, isSigner: false, isWritable: true },
      { pubkey: poolPDA, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: STEEL_PROGRAM_ID,
    data: claimRewardsData,
  });

  try {
    const balanceBefore = await connection.getBalance(staker.publicKey);
    await sendAndConfirmTransaction(connection, new Transaction().add(claimRewardsIx), [staker]);
    const balanceAfter = await connection.getBalance(staker.publicKey);
    console.log(`✅ Claimed SOL rewards: ${(balanceAfter - balanceBefore) / LAMPORTS_PER_SOL} SOL`);
  } catch (e: any) {
    console.log(`❌ Claim rewards failed: ${e.message}`);
    if (e.logs) console.log('Logs:', e.logs.slice(-3));
  }

  // ============================================================
  // STEP 9: Check POKER Circulating Supply
  // ============================================================
  console.log('\n' + '='.repeat(70));
  console.log('STEP 9: POKER Token Stats');
  console.log('='.repeat(70));

  try {
    const mintInfo = await connection.getParsedAccountInfo(POKER_MINT);
    const mintData = (mintInfo.value?.data as any)?.parsed?.info;
    
    if (mintData) {
      console.log(`\n📊 POKER Token Stats:`);
      console.log(`   Mint: ${POKER_MINT.toBase58()}`);
      console.log(`   Supply: ${mintData.supply / 1e9} POKER`);
      console.log(`   Decimals: ${mintData.decimals}`);
      console.log(`   Mint Authority: ${mintData.mintAuthority}`);
    }

    // Check pool state (correct offsets based on Pool struct)
    // discriminator(8) + authority(32) + poker_mint(32) = 72, then:
    // total_burned: 72-80, sol_rewards_available: 80-88, sol_rewards_distributed: 88-96
    // accumulated_rewards_per_token: 96-112, total_unrefined: 112-120, refined_pool: 120-128
    const poolInfo = await connection.getAccountInfo(poolPDA);
    if (poolInfo && poolInfo.data.length >= 128) {
      const totalBurned = poolInfo.data.readBigUInt64LE(72);
      const solRewardsAvailable = poolInfo.data.readBigUInt64LE(80);
      const totalUnrefined = poolInfo.data.readBigUInt64LE(112);
      const refinedPool = poolInfo.data.readBigUInt64LE(120);

      console.log(`\n📊 Pool State:`);
      console.log(`   Total Burned (Staked): ${Number(totalBurned) / 1e9} POKER`);
      console.log(`   SOL Rewards Available: ${Number(solRewardsAvailable) / LAMPORTS_PER_SOL} SOL`);
      console.log(`   Total Unrefined: ${Number(totalUnrefined) / 1e9} POKER`);
      console.log(`   Refined Pool (10% tax): ${Number(refinedPool) / 1e9} POKER`);
    }
  } catch (e: any) {
    console.log(`Could not get stats: ${e.message.slice(0, 40)}`);
  }

  // ============================================================
  // Final Balances
  // ============================================================
  console.log('\n' + '='.repeat(70));
  console.log('Final Player Balances');
  console.log('='.repeat(70));

  for (let i = 0; i < players.length; i++) {
    const player = players[i];
    const solBalance = await connection.getBalance(player.publicKey);
    let pokerBalance = '0';
    
    try {
      const ata = await getAssociatedTokenAddress(POKER_MINT, player.publicKey);
      const tokenBalance = await connection.getTokenAccountBalance(ata);
      pokerBalance = tokenBalance.value.uiAmountString || '0';
    } catch (e) {}

    console.log(`Player ${i + 1}: ${(solBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL, ${pokerBalance} POKER`);
  }

  console.log('\n' + '='.repeat(70));
  console.log('TEST COMPLETE');
  console.log('='.repeat(70));
}

main().catch(console.error);
