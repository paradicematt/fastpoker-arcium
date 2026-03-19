/**
 * CLI Player - Play against frontend users via Anchor program
 * Uses raw transactions to avoid Anchor SDK type issues
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

// Program IDs
const CQ_POKER_PROGRAM_ID = new PublicKey('FTuksCXGvdrYe9uP2X9S12KLHhRZHJNsrzpxP2wk2ckR');
const STEEL_PROGRAM_ID = new PublicKey('BaYBb2JtaVffVnQYk1TwDUwZskgdnZcnNawfVzj3YvkH');

// RPC
const RPC_URL = 'https://devnet.helius-rpc.com/?api-key=8801f9b3-fe0b-42b5-ba5c-67f0fed31c5e';

// Seeds
const SEAT_SEED = Buffer.from('seat');
const PLAYER_SEED = Buffer.from('player');
const POOL_SEED = Buffer.from('pool');

// Treasury
const TREASURY = new PublicKey('AyCBQPaJA5CE7Fo4fDEkMfwGH7DkSv7ocSy4TgUpszHD');

// Anchor discriminators (SHA256("global:<instruction_name>")[0..8])
const DISCRIMINATORS = {
  registerPlayer: Buffer.from([242, 146, 194, 234, 234, 145, 228, 42]),
  joinTable: Buffer.from([14, 117, 84, 51, 95, 146, 171, 70]),
  playerAction: Buffer.from([37, 85, 25, 135, 200, 116, 96, 101]),
  startGame: Buffer.from([249, 47, 252, 172, 184, 162, 245, 14]),
};

// Action types (Anchor enum serialization)
const ACTIONS = {
  fold: 0,
  check: 1,
  call: 2,
  bet: 3,
  raise: 4,
  allIn: 5,
};

// Load CLI player keypair
function loadCliKeypair(): Keypair {
  const keyPath = path.join(__dirname, 'cli-player-keypair.json');
  if (fs.existsSync(keyPath)) {
    const data = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    return Keypair.fromSecretKey(Uint8Array.from(data));
  }
  const kp = Keypair.generate();
  fs.writeFileSync(keyPath, JSON.stringify(Array.from(kp.secretKey)));
  console.log(`Created new CLI player keypair: ${kp.publicKey.toBase58()}`);
  return kp;
}

// PDA helpers
function getPlayerPDA(wallet: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [PLAYER_SEED, wallet.toBuffer()],
    CQ_POKER_PROGRAM_ID
  );
}

function getSeatPDA(table: PublicKey, seatNumber: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEAT_SEED, table.toBuffer(), Buffer.from([seatNumber])],
    CQ_POKER_PROGRAM_ID
  );
}

function getPoolPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([POOL_SEED], STEEL_PROGRAM_ID);
}

// Phase names
const PHASE_NAMES = ['Waiting', 'PreFlop', 'Flop', 'Turn', 'River', 'Showdown', 'Complete'];

// Card display
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];

function cardToString(card: number): string {
  if (card === 0 || card === 255) return '??';
  const c = card - 1;
  return RANKS[c % 13] + SUITS[Math.floor(c / 13)];
}

async function main() {
  const connection = new Connection(RPC_URL, 'confirmed');
  const cliPlayer = loadCliKeypair();
  
  console.log('🎮 CLI Poker Player');
  console.log('='.repeat(50));
  console.log(`Wallet: ${cliPlayer.publicKey.toBase58()}`);
  
  const balance = await connection.getBalance(cliPlayer.publicKey);
  console.log(`Balance: ${balance / LAMPORTS_PER_SOL} SOL`);
  
  if (balance < 0.1 * LAMPORTS_PER_SOL) {
    console.log('\n⚠️  Low balance! Fund this wallet to play.');
    console.log(`   solana airdrop 1 ${cliPlayer.publicKey.toBase58()} --url devnet`);
    return;
  }
  
  // Check registration
  const [playerPDA] = getPlayerPDA(cliPlayer.publicKey);
  const playerInfo = await connection.getAccountInfo(playerPDA);
  
  if (!playerInfo) {
    console.log('\n📝 Registering player...');
    try {
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: cliPlayer.publicKey, isSigner: true, isWritable: true },
          { pubkey: playerPDA, isSigner: false, isWritable: true },
          { pubkey: TREASURY, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        programId: CQ_POKER_PROGRAM_ID,
        data: DISCRIMINATORS.registerPlayer,
      });
      
      const tx = new Transaction().add(ix);
      const sig = await sendAndConfirmTransaction(connection, tx, [cliPlayer]);
      console.log(`✅ Registered: ${sig.slice(0, 20)}...`);
    } catch (err: any) {
      console.log(`❌ Registration failed: ${err.message}`);
      return;
    }
  } else {
    console.log('✅ Already registered');
  }
  
  // Interactive mode
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  
  let currentTable: PublicKey | null = null;
  let mySeat: number | null = null;
  
  const prompt = () => {
    rl.question('\n> ', async (input) => {
      const parts = input.trim().split(' ');
      const cmd = parts[0]?.toLowerCase();
      
      try {
        switch (cmd) {
          case 'join': {
            const tableAddr = parts[1];
            if (!tableAddr) {
              console.log('Usage: join <table-address>');
              break;
            }
            currentTable = new PublicKey(tableAddr);
            
            // Find empty seat
            let seatNum = -1;
            for (let i = 0; i < 2; i++) {
              const [seatPDA] = getSeatPDA(currentTable, i);
              const seatInfo = await connection.getAccountInfo(seatPDA);
              if (!seatInfo) {
                seatNum = i;
                break;
              }
            }
            
            if (seatNum === -1) {
              console.log('❌ No empty seats');
              break;
            }
            
            console.log(`Joining seat ${seatNum}...`);
            const [seatPDA] = getSeatPDA(currentTable, seatNum);
            
            // Build joinTable data: discriminator + buy_in(u64) + seat_number(u8)
            const data = Buffer.alloc(8 + 8 + 1);
            DISCRIMINATORS.joinTable.copy(data, 0);
            data.writeBigUInt64LE(BigInt(1500), 8);
            data.writeUInt8(seatNum, 16);
            
            const ix = new TransactionInstruction({
              keys: [
                { pubkey: cliPlayer.publicKey, isSigner: true, isWritable: true },
                { pubkey: playerPDA, isSigner: false, isWritable: true },
                { pubkey: currentTable, isSigner: false, isWritable: true },
                { pubkey: seatPDA, isSigner: false, isWritable: true },
                { pubkey: TREASURY, isSigner: false, isWritable: true },
                { pubkey: CQ_POKER_PROGRAM_ID, isSigner: false, isWritable: false }, // null playerTokenAccount
                { pubkey: CQ_POKER_PROGRAM_ID, isSigner: false, isWritable: false }, // null tableTokenAccount
                { pubkey: CQ_POKER_PROGRAM_ID, isSigner: false, isWritable: false }, // null tokenProgram
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
              ],
              programId: CQ_POKER_PROGRAM_ID,
              data,
            });
            
            const tx = new Transaction().add(ix);
            const sig = await sendAndConfirmTransaction(connection, tx, [cliPlayer]);
            
            mySeat = seatNum;
            console.log(`✅ Joined seat ${seatNum}: ${sig.slice(0, 20)}...`);
            break;
          }
          
          case 'status': {
            const tableAddr = parts[1] || currentTable?.toBase58();
            if (!tableAddr) {
              console.log('Usage: status <table-address>');
              break;
            }
            const tablePDA = new PublicKey(tableAddr);
            const tableInfo = await connection.getAccountInfo(tablePDA);
            
            if (!tableInfo) {
              console.log('❌ Table not found');
              break;
            }
            
            // Parse table data (Anchor 8-byte discriminator)
            const data = tableInfo.data;
            let offset = 8;
            offset += 32; // tableId
            offset += 32; // authority
            offset += 32; // pool
            const gameType = data[offset]; offset += 1;
            const smallBlind = Number(data.readBigUInt64LE(offset)); offset += 8;
            const bigBlind = Number(data.readBigUInt64LE(offset)); offset += 8;
            const maxPlayers = data[offset]; offset += 1;
            const currentPlayers = data[offset]; offset += 1;
            const handNumber = Number(data.readBigUInt64LE(offset)); offset += 8;
            const pot = Number(data.readBigUInt64LE(offset)); offset += 8;
            const minBet = Number(data.readBigUInt64LE(offset)); offset += 8;
            offset += 8; // rakeAccumulated
            const communityCards = Array.from(data.slice(offset, offset + 5)); offset += 5;
            const phase = data[offset]; offset += 1;
            const currentPlayer = data[offset];
            
            console.log('\n📊 Table Status:');
            console.log(`   Phase: ${PHASE_NAMES[phase] || phase}`);
            console.log(`   Players: ${currentPlayers}/${maxPlayers}`);
            console.log(`   Pot: ${pot}`);
            console.log(`   Min Bet: ${minBet}`);
            console.log(`   Current Player: Seat ${currentPlayer}`);
            console.log(`   Community: ${communityCards.map(c => cardToString(c)).join(' ')}`);
            
            // Show seats
            for (let i = 0; i < maxPlayers; i++) {
              const [seatPDA] = getSeatPDA(tablePDA, i);
              const seatInfo = await connection.getAccountInfo(seatPDA);
              if (seatInfo) {
                const sData = seatInfo.data;
                let so = 8;
                const wallet = new PublicKey(sData.slice(so, so + 32)); so += 32;
                so += 32; // sessionKey
                so += 32; // table
                const chips = Number(sData.readBigUInt64LE(so)); so += 8;
                const bet = Number(sData.readBigUInt64LE(so)); so += 8;
                so += 8; // totalBet
                so += 64; // encrypted cards
                so += 32; // commitment
                const holeCards = [sData[so], sData[so + 1]]; so += 2;
                const seatNumber = sData[so]; so += 1;
                const status = sData[so];
                
                const isMe = wallet.equals(cliPlayer.publicKey);
                const statusName = ['Empty', 'Active', 'Folded', 'AllIn', 'SittingOut'][status] || status;
                console.log(`\n   Seat ${i}${isMe ? ' (You)' : ''}:`);
                console.log(`     Wallet: ${wallet.toBase58().slice(0, 8)}...`);
                console.log(`     Chips: ${chips}, Bet: ${bet}`);
                console.log(`     Status: ${statusName}`);
                if (isMe && phase >= 1) {
                  console.log(`     Cards: ${cardToString(holeCards[0])} ${cardToString(holeCards[1])}`);
                }
              }
            }
            break;
          }
          
          case 'fold':
          case 'check':
          case 'call':
          case 'allin': {
            if (!currentTable || mySeat === null) {
              console.log('❌ Not at a table. Use: join <table-address>');
              break;
            }
            
            const actionType = ACTIONS[cmd as keyof typeof ACTIONS];
            const [seatPDA] = getSeatPDA(currentTable, mySeat);
            
            // Build action data: discriminator + action enum
            const data = Buffer.alloc(8 + 1);
            DISCRIMINATORS.playerAction.copy(data, 0);
            data.writeUInt8(actionType, 8);
            
            const ix = new TransactionInstruction({
              keys: [
                { pubkey: cliPlayer.publicKey, isSigner: true, isWritable: true },
                { pubkey: currentTable, isSigner: false, isWritable: true },
                { pubkey: seatPDA, isSigner: false, isWritable: true },
              ],
              programId: CQ_POKER_PROGRAM_ID,
              data,
            });
            
            const tx = new Transaction().add(ix);
            const sig = await sendAndConfirmTransaction(connection, tx, [cliPlayer]);
            console.log(`✅ ${cmd.toUpperCase()}: ${sig.slice(0, 20)}...`);
            break;
          }
          
          case 'bet':
          case 'raise': {
            if (!currentTable || mySeat === null) {
              console.log('❌ Not at a table');
              break;
            }
            
            const amount = parseInt(parts[1] || '0');
            if (!amount) {
              console.log(`Usage: ${cmd} <amount>`);
              break;
            }
            
            const actionType = cmd === 'bet' ? ACTIONS.bet : ACTIONS.raise;
            const [seatPDA] = getSeatPDA(currentTable, mySeat);
            
            // Build action data with amount: discriminator + enum(1) + amount(8)
            const data = Buffer.alloc(8 + 1 + 8);
            DISCRIMINATORS.playerAction.copy(data, 0);
            data.writeUInt8(actionType, 8);
            data.writeBigUInt64LE(BigInt(amount), 9);
            
            const ix = new TransactionInstruction({
              keys: [
                { pubkey: cliPlayer.publicKey, isSigner: true, isWritable: true },
                { pubkey: currentTable, isSigner: false, isWritable: true },
                { pubkey: seatPDA, isSigner: false, isWritable: true },
              ],
              programId: CQ_POKER_PROGRAM_ID,
              data,
            });
            
            const tx = new Transaction().add(ix);
            const sig = await sendAndConfirmTransaction(connection, tx, [cliPlayer]);
            console.log(`✅ ${cmd.toUpperCase()} ${amount}: ${sig.slice(0, 20)}...`);
            break;
          }
          
          case 'deal': {
            if (!currentTable) {
              console.log('❌ Not at a table');
              break;
            }
            
            const ix = new TransactionInstruction({
              keys: [
                { pubkey: cliPlayer.publicKey, isSigner: true, isWritable: true },
                { pubkey: currentTable, isSigner: false, isWritable: true },
              ],
              programId: CQ_POKER_PROGRAM_ID,
              data: DISCRIMINATORS.startGame,
            });
            
            const tx = new Transaction().add(ix);
            const sig = await sendAndConfirmTransaction(connection, tx, [cliPlayer]);
            console.log(`✅ Deal: ${sig.slice(0, 20)}...`);
            break;
          }
          
          case 'help':
            console.log('\nCommands:');
            console.log('  join <table-address>  - Join a table');
            console.log('  status [table-addr]   - Show table status');
            console.log('  fold                  - Fold');
            console.log('  check                 - Check');
            console.log('  call                  - Call');
            console.log('  bet <amount>          - Bet');
            console.log('  raise <amount>        - Raise');
            console.log('  allin                 - All-in');
            console.log('  deal                  - Start game/deal');
            console.log('  quit                  - Exit');
            break;
          
          case 'quit':
          case 'exit':
            console.log('Goodbye!');
            rl.close();
            process.exit(0);
          
          default:
            if (cmd) console.log(`Unknown command: ${cmd}. Type 'help' for commands.`);
        }
      } catch (err: any) {
        console.log(`❌ Error: ${err.message}`);
        if (err.logs) {
          console.log('Logs:', err.logs.slice(-3));
        }
      }
      
      prompt();
    });
  };
  
  console.log("\nType 'help' for commands, 'quit' to exit");
  prompt();
}

main().catch(console.error);
