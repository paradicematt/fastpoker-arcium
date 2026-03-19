/**
 * Full game test using raw TransactionInstructions (matching working client code)
 */
import { Connection, PublicKey, Keypair, SystemProgram, Transaction, sendAndConfirmTransaction, TransactionInstruction, SYSVAR_SLOT_HASHES_PUBKEY } from '@solana/web3.js';
import * as fs from 'fs';
import * as crypto from 'crypto';

const PROGRAM_ID = new PublicKey('FTuksCXGvdrYe9uP2X9S12KLHhRZHJNsrzpxP2wk2ckR');
const STEEL_PROGRAM_ID = new PublicKey('BaYBb2JtaVffVnQYk1TwDUwZskgdnZcnNawfVzj3YvkH');
const VRF_PROGRAM_ID = new PublicKey('Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz');
const VRF_EPHEMERAL_QUEUE = new PublicKey('5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc');
const RPC = 'https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df';
const TREASURY = new PublicKey('GkfdM1vqRYrU2LJ4ipwCJ3vsr2PGYLpdtdKK121ZkQZg');

// Discriminators
const DISC = {
  createTable: Buffer.from([214, 142, 131, 250, 242, 83, 135, 185]),
  joinTable: Buffer.from([14, 117, 84, 51, 95, 146, 171, 70]),
  startGame: Buffer.from([249, 47, 252, 172, 184, 162, 245, 14]),
  requestDealVrf: Buffer.from(crypto.createHash('sha256').update('global:request_deal_vrf').digest().slice(0, 8)),
  playerAction: Buffer.from([37, 85, 25, 135, 200, 116, 96, 101]),
  settle: Buffer.from([226, 143, 58, 196, 148, 75, 164, 43]),
};

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, 'utf-8'))));
}

function getTablePda(tableId: Uint8Array): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('table'), Buffer.from(tableId)], PROGRAM_ID)[0];
}
function getSeatPda(table: PublicKey, seat: number): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('seat'), table.toBuffer(), Buffer.from([seat])], PROGRAM_ID)[0];
}
function getPlayerPda(player: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('player'), player.toBuffer()], PROGRAM_ID)[0];
}
function getPlayerTableMarkerPda(player: PublicKey, table: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('player_table'), player.toBuffer(), table.toBuffer()], PROGRAM_ID)[0];
}
function getPoolPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('pool')], STEEL_PROGRAM_ID)[0];
}
function getSeatCardsPda(table: PublicKey, seat: number): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('seat_cards'), table.toBuffer(), Buffer.from([seat])], PROGRAM_ID)[0];
}
function getProgramIdentityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('identity')], PROGRAM_ID)[0];
}

async function sendTx(conn: Connection, tx: Transaction, signers: Keypair[]): Promise<string> {
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  return await sendAndConfirmTransaction(conn, tx, signers, { commitment: 'confirmed' });
}

async function main() {
  console.log('=== FULL GAME TEST ===\n');
  
  const conn = new Connection(RPC, 'confirmed');
  const deployer = loadKeypair('j:/critters/mini-game/deployer-keypair.json');
  const player1 = loadKeypair('J:/Poker/tests/keys/player1.json');
  const player2 = loadKeypair('J:/Poker/tests/keys/player2.json');
  const poolPda = getPoolPda();
  
  console.log('Deployer:', deployer.publicKey.toBase58());
  console.log('Player1:', player1.publicKey.toBase58());
  console.log('Player2:', player2.publicKey.toBase58());

  // Generate new table
  const tableId = crypto.randomBytes(32);
  const tablePda = getTablePda(tableId);
  const seat0Pda = getSeatPda(tablePda, 0);
  const seat1Pda = getSeatPda(tablePda, 1);
  
  console.log('\nTable:', tablePda.toBase58());

  try {
    // 1. Create table
    console.log('\n1. Creating table...');
    const createData = Buffer.alloc(8 + 32 + 1 + 1 + 1);
    DISC.createTable.copy(createData, 0);
    tableId.copy(createData, 8);
    createData.writeUInt8(0, 40); // SitAndGoHeadsUp
    createData.writeUInt8(0, 41); // Micro stakes
    createData.writeUInt8(2, 42); // maxPlayers

    const createIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
        { pubkey: tablePda, isSigner: false, isWritable: true },
        { pubkey: poolPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: createData,
    });
    await sendTx(conn, new Transaction().add(createIx), [deployer]);
    console.log('✓ Table created');

    // 2. Player 1 joins seat 0
    console.log('\n2. Player 1 joining seat 0...');
    const p1AccountPda = getPlayerPda(player1.publicKey);
    const p1MarkerPda = getPlayerTableMarkerPda(player1.publicKey, tablePda);
    
    const join1Data = Buffer.alloc(17);
    DISC.joinTable.copy(join1Data, 0);
    join1Data.writeBigUInt64LE(BigInt(100), 8);
    join1Data.writeUInt8(0, 16);

    const join1Ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: player1.publicKey, isSigner: true, isWritable: true },
        { pubkey: p1AccountPda, isSigner: false, isWritable: true },
        { pubkey: tablePda, isSigner: false, isWritable: true },
        { pubkey: seat0Pda, isSigner: false, isWritable: true },
        { pubkey: p1MarkerPda, isSigner: false, isWritable: true },
        { pubkey: TREASURY, isSigner: false, isWritable: true },
        { pubkey: poolPda, isSigner: false, isWritable: true },
        { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }, // playerTokenAccount (None)
        { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }, // tableTokenAccount (None)
        { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }, // unclaimed_balance (None)
        { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }, // tokenProgram (None)
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: join1Data,
    });
    await sendTx(conn, new Transaction().add(join1Ix), [player1]);
    console.log('✓ Player 1 joined');

    // 3. Player 2 joins seat 1
    console.log('\n3. Player 2 joining seat 1...');
    const p2AccountPda = getPlayerPda(player2.publicKey);
    const p2MarkerPda = getPlayerTableMarkerPda(player2.publicKey, tablePda);
    
    const join2Data = Buffer.alloc(17);
    DISC.joinTable.copy(join2Data, 0);
    join2Data.writeBigUInt64LE(BigInt(100), 8);
    join2Data.writeUInt8(1, 16);

    const join2Ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: player2.publicKey, isSigner: true, isWritable: true },
        { pubkey: p2AccountPda, isSigner: false, isWritable: true },
        { pubkey: tablePda, isSigner: false, isWritable: true },
        { pubkey: seat1Pda, isSigner: false, isWritable: true },
        { pubkey: p2MarkerPda, isSigner: false, isWritable: true },
        { pubkey: TREASURY, isSigner: false, isWritable: true },
        { pubkey: poolPda, isSigner: false, isWritable: true },
        { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }, // playerTokenAccount (None)
        { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }, // tableTokenAccount (None)
        { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }, // unclaimed_balance (None)
        { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }, // tokenProgram (None)
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: join2Data,
    });
    await sendTx(conn, new Transaction().add(join2Ix), [player2]);
    console.log('✓ Player 2 joined');

    // 4. Start game
    console.log('\n4. Starting game...');
    const startData = Buffer.alloc(8);
    DISC.startGame.copy(startData, 0);
    const startIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: deployer.publicKey, isSigner: true, isWritable: false },
        { pubkey: tablePda, isSigner: false, isWritable: true },
      ],
      data: startData,
    });
    await sendTx(conn, new Transaction().add(startIx), [deployer]);
    console.log('✓ Game started');

    // 5. Request VRF deal
    console.log('\n5. Requesting VRF deal...');
    const seatCards0Pda = getSeatCardsPda(tablePda, 0);
    const seatCards1Pda = getSeatCardsPda(tablePda, 1);
    const programIdentityPda = getProgramIdentityPda();
    
    const dealData = Buffer.alloc(8);
    DISC.requestDealVrf.copy(dealData, 0);

    const dealIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
        { pubkey: tablePda, isSigner: false, isWritable: true },
        { pubkey: programIdentityPda, isSigner: false, isWritable: false },
        { pubkey: VRF_EPHEMERAL_QUEUE, isSigner: false, isWritable: true },
        { pubkey: SYSVAR_SLOT_HASHES_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: VRF_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: seatCards0Pda, isSigner: false, isWritable: true },
        { pubkey: seatCards1Pda, isSigner: false, isWritable: true },
      ],
      data: dealData,
    });
    await sendTx(conn, new Transaction().add(dealIx), [deployer]);
    console.log('✓ VRF deal requested');

    // 6. Play - P1 folds immediately (quick game)
    console.log('\n6. Player 1 folds...');
    const foldData = Buffer.alloc(17);
    DISC.playerAction.copy(foldData, 0);
    foldData.writeUInt8(0, 8); // Fold = 0
    foldData.writeBigUInt64LE(BigInt(0), 9);

    const foldIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: player1.publicKey, isSigner: true, isWritable: true },
        { pubkey: tablePda, isSigner: false, isWritable: true },
        { pubkey: seat0Pda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: foldData,
    });
    await sendTx(conn, new Transaction().add(foldIx), [player1]);
    console.log('✓ Player 1 folded - Player 2 wins!');

    // Check final balances
    const seat0Info = await conn.getAccountInfo(seat0Pda);
    const seat1Info = await conn.getAccountInfo(seat1Pda);
    if (seat0Info && seat1Info) {
      // Chips are at offset 8 (discriminator) + 32 (wallet) + 8 (table) = 48
      const p1Chips = seat0Info.data.readBigUInt64LE(48);
      const p2Chips = seat1Info.data.readBigUInt64LE(48);
      console.log('\n=== FINAL RESULTS ===');
      console.log('Player 1 chips:', p1Chips.toString());
      console.log('Player 2 chips:', p2Chips.toString());
    }

    console.log('\n✅ FULL GAME COMPLETE!');
    console.log('Table PDA:', tablePda.toBase58());

  } catch (e: any) {
    console.error('\n❌ Error:', e.message);
    if (e.logs) console.log('Logs:', e.logs.slice(-5));
  }
}

main().catch(console.error);
