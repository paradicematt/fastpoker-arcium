/**
 * Create a fresh SOL cash game table.
 * Run: npx ts-node scripts/create-cash-table.ts
 */
import {
  Connection, Keypair, PublicKey, Transaction,
  TransactionInstruction, SystemProgram, ComputeBudgetProgram,
} from '@solana/web3.js';
import * as fs from 'fs';
import * as crypto from 'crypto';

const L1_RPC = 'https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df';
const PROGRAM_ID = new PublicKey('FTuksCXGvdrYe9uP2X9S12KLHhRZHJNsrzpxP2wk2ckR');
const POOL_PDA = new PublicKey('FSKrGq26FxhMUSK85ksv2AykL5Am2HS9iXJwuVoQQvLY');
const TREASURY = new PublicKey('4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3');
const STEEL_PROGRAM_ID = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');
const KEYPAIR_PATH = 'j:/Poker/contracts/auth/deployers/anchor-mini-game-deployer-keypair.json';

const CREATE_USER_TABLE_DISC = Buffer.from(
  crypto.createHash('sha256').update('global:create_user_table').digest().slice(0, 8),
);
const INIT_TABLE_SEAT_DISC = Buffer.from(
  crypto.createHash('sha256').update('global:init_table_seat').digest().slice(0, 8),
);
const PERMISSION_PROGRAM_ID = new PublicKey('ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1');

function getTablePda(tableId: Buffer): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('table'), tableId],
    PROGRAM_ID,
  );
}

function getVaultPda(tablePda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), tablePda.toBuffer()],
    PROGRAM_ID,
  );
}
function getSeatPda(tablePda: PublicKey, idx: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('seat'), tablePda.toBuffer(), Buffer.from([idx])],
    PROGRAM_ID,
  );
}
function getSeatCardsPda(tablePda: PublicKey, idx: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('seat_cards'), tablePda.toBuffer(), Buffer.from([idx])],
    PROGRAM_ID,
  );
}
function getDeckStatePda(tablePda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('deck_state'), tablePda.toBuffer()],
    PROGRAM_ID,
  );
}
function getReceiptPda(tablePda: PublicKey, idx: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('receipt'), tablePda.toBuffer(), Buffer.from([idx])],
    PROGRAM_ID,
  );
}
function getDepositProofPda(tablePda: PublicKey, idx: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('deposit_proof'), tablePda.toBuffer(), Buffer.from([idx])],
    PROGRAM_ID,
  );
}
function getPermissionPda(account: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('permission:'), account.toBuffer()],
    PERMISSION_PROGRAM_ID,
  );
}

async function main() {
  const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, 'utf-8'))));
  const l1 = new Connection(L1_RPC, 'confirmed');

  // Table config — .00005/.0001 SOL cash game 6-max
  const tableIdStr = `cash6_${Date.now()}`;
  const tableIdBuf = Buffer.alloc(32);
  Buffer.from(tableIdStr).copy(tableIdBuf);

  const maxPlayers = 2;
  const smallBlind = BigInt(50_000);   // 0.00005 SOL
  const bigBlind = BigInt(100_000);    // 0.0001 SOL
  const tokenMint = PublicKey.default; // SOL
  const buyInType = 0; // Normal

  const [tablePda] = getTablePda(tableIdBuf);
  const [vaultPda] = getVaultPda(tablePda);

  console.log(`Creator:   ${deployer.publicKey.toBase58()}`);
  console.log(`Table ID:  ${tableIdStr}`);
  console.log(`Table PDA: ${tablePda.toBase58()}`);
  console.log(`Vault PDA: ${vaultPda.toBase58()}`);
  console.log(`Blinds:    ${Number(smallBlind)} / ${Number(bigBlind)} lamports`);
  console.log(`Max:       ${maxPlayers} players`);
  console.log(`Token:     SOL\n`);

  // Check if table already exists
  const existing = await l1.getAccountInfo(tablePda);
  if (existing) {
    console.log('⚠️  Table already exists! Use a different ID.');
    return;
  }

  // UserTableConfig: table_id(32) + max_players(1) + small_blind(8) + big_blind(8) + token_mint(32) + buy_in_type(1) + is_private(1)
  const data = Buffer.alloc(8 + 32 + 1 + 8 + 8 + 32 + 1 + 1);
  CREATE_USER_TABLE_DISC.copy(data, 0);
  tableIdBuf.copy(data, 8);
  data.writeUInt8(maxPlayers, 40);
  data.writeBigUInt64LE(smallBlind, 41);
  data.writeBigUInt64LE(bigBlind, 49);
  tokenMint.toBuffer().copy(data, 57);
  data.writeUInt8(buyInType, 89);
  data.writeUInt8(0, 90); // is_private = false

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
      { pubkey: tablePda, isSigner: false, isWritable: true },
      { pubkey: POOL_PDA, isSigner: false, isWritable: true },
      { pubkey: TREASURY, isSigner: false, isWritable: true },
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }, // creatorTokenAccount placeholder (SOL)
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }, // treasuryTokenAccount placeholder (SOL)
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }, // poolTokenAccount placeholder (SOL)
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }, // tokenProgram placeholder (SOL)
      { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = deployer.publicKey;
  tx.recentBlockhash = (await l1.getLatestBlockhash()).blockhash;
  tx.sign(deployer);
  const sig = await l1.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const { blockhash, lastValidBlockHeight } = await l1.getLatestBlockhash();
  await l1.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');

  console.log(`✅ Table created! Sig: ${sig}`);

  // Init all seats (creates seat + seatCards + deckState + receipt + proof + permission PDAs)
  console.log('\nInitializing seats...');
  const BATCH = 3;
  for (let batch = 0; batch < maxPlayers; batch += BATCH) {
    const end = Math.min(batch + BATCH, maxPlayers);
    const seatTx = new Transaction();
    seatTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 }));
    for (let i = batch; i < end; i++) {
      const [seatPda] = getSeatPda(tablePda, i);
      const [seatCardsPda] = getSeatCardsPda(tablePda, i);
      const [deckStatePda] = getDeckStatePda(tablePda);
      const [receiptPda] = getReceiptPda(tablePda, i);
      const [depositProofPda] = getDepositProofPda(tablePda, i);
      const [vaultPdaSeat] = getVaultPda(tablePda);
      const [crankTallyErPda] = PublicKey.findProgramAddressSync([Buffer.from('crank_tally_er'), tablePda.toBuffer()], PROGRAM_ID);
      const [crankTallyL1Pda] = PublicKey.findProgramAddressSync([Buffer.from('crank_tally_l1'), tablePda.toBuffer()], PROGRAM_ID);
      const [seatCardsPermPda] = getPermissionPda(seatCardsPda);
      const seatData = Buffer.alloc(9);
      INIT_TABLE_SEAT_DISC.copy(seatData, 0);
      seatData.writeUInt8(i, 8);
      seatTx.add(new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
          { pubkey: tablePda, isSigner: false, isWritable: false },
          { pubkey: seatPda, isSigner: false, isWritable: true },
          { pubkey: seatCardsPda, isSigner: false, isWritable: true },
          { pubkey: deckStatePda, isSigner: false, isWritable: true },
          { pubkey: receiptPda, isSigner: false, isWritable: true },
          { pubkey: depositProofPda, isSigner: false, isWritable: true },
          { pubkey: vaultPdaSeat, isSigner: false, isWritable: true },
          { pubkey: crankTallyErPda, isSigner: false, isWritable: true },
          { pubkey: crankTallyL1Pda, isSigner: false, isWritable: true },
          { pubkey: seatCardsPermPda, isSigner: false, isWritable: true },
          { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: seatData,
      }));
    }
    seatTx.feePayer = deployer.publicKey;
    seatTx.recentBlockhash = (await l1.getLatestBlockhash()).blockhash;
    seatTx.sign(deployer);
    try {
      const seatSig = await l1.sendRawTransaction(seatTx.serialize());
      const bh = await l1.getLatestBlockhash();
      await l1.confirmTransaction({ signature: seatSig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, 'confirmed');
      console.log(`  Seats ${batch}-${end - 1} initialized: ${seatSig.slice(0, 20)}...`);
    } catch (e: any) {
      console.log(`  Seats ${batch}-${end - 1} may already exist: ${e.message?.slice(0, 80)}`);
    }
  }

  console.log(`\n✅ DONE! Table PDA: ${tablePda.toBase58()}`);
  console.log(`Blinds: ${Number(smallBlind)/1e9}/${Number(bigBlind)/1e9} SOL`);
  console.log(`Max Players: ${maxPlayers}`);
  console.log(`\nTo join: http://localhost:3000/game/${tablePda.toBase58()}`);
  console.log(`Bot:     npx ts-node scripts/auto-bot.ts ${tablePda.toBase58()} 1`);
}

main().catch(console.error);
