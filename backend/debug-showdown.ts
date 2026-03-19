import { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, SystemProgram, sendAndConfirmTransaction } from '@solana/web3.js';
import * as crypto from 'crypto';
import * as fs from 'fs';
import {
  getMXEAccAddress, getMempoolAccAddress, getExecutingPoolAccAddress,
  getCompDefAccAddress, getCompDefAccOffset, getComputationAccAddress,
  getClusterAccAddress, getArciumProgramId,
} from '@arcium-hq/client';

const PROGRAM_ID = new PublicKey('BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N');
const conn = new Connection('http://127.0.0.1:8899', 'confirmed');

function disc(name: string): Buffer {
  return Buffer.from(crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8));
}

const ARCIUM_PROG_ID = getArciumProgramId();

function getSignPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('ArciumSignerAccount')], PROGRAM_ID)[0];
}
function getArciumFeePoolPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('fee_pool')], ARCIUM_PROG_ID)[0];
}
function getArciumClockPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('clock')], ARCIUM_PROG_ID)[0];
}

(async () => {
  // Load payer
  const kpPath = process.env.SOLANA_KEYPAIR || `${require('os').homedir()}/.config/solana/id.json`;
  const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(kpPath).toString())));
  
  // Find table
  const tables = await conn.getProgramAccounts(PROGRAM_ID, { filters: [{ dataSize: 437 }] });
  if (tables.length === 0) { console.log('No tables found'); return; }
  const tablePDA = tables[0].pubkey;
  const tableData = tables[0].account.data;
  const phase = tableData[160];
  console.log(`Table: ${tablePDA.toBase58()}, phase: ${phase}`);
  
  if (phase !== 7) { console.log('Table not in Showdown phase'); return; }
  
  const [deckStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from('deck_state'), tablePDA.toBuffer()], PROGRAM_ID
  );
  
  const clusterOffset = 0 as any;
  const clusterAccount = getClusterAccAddress(clusterOffset);
  const mxeAccount = getMXEAccAddress(PROGRAM_ID);
  
  const showCompDefOffset = Buffer.from(getCompDefAccOffset('reveal_player_cards')).readUInt32LE(0);
  const showCompDefAccount = getCompDefAccAddress(PROGRAM_ID, showCompDefOffset);
  
  console.log(`CompDef offset: ${showCompDefOffset}`);
  console.log(`CompDef PDA: ${showCompDefAccount.toBase58()}`);
  
  // Check comp_def exists
  const compDefInfo = await conn.getAccountInfo(showCompDefAccount);
  console.log(`CompDef account exists: ${!!compDefInfo}, size: ${compDefInfo?.data.length}`);
  
  // Check sign PDA
  const signPda = getSignPda();
  const signInfo = await conn.getAccountInfo(signPda);
  console.log(`Sign PDA exists: ${!!signInfo}, size: ${signInfo?.data.length}`);
  
  // Try the showdown queue TX with simulate
  const seatIdx = 0;
  const showCompOffset = BigInt(Date.now()) * BigInt(1000) + BigInt(seatIdx);  const clusterOffsetBig = BigInt(0);
  const showCompOffsetBuf = Buffer.alloc(8);
  showCompOffsetBuf.writeBigUInt64LE(showCompOffset);
  const showComputationAccount = getComputationAccAddress(
    clusterOffset,
    { toArrayLike: (_B: any, _e: string, l: number) => { const b = Buffer.alloc(l); showCompOffsetBuf.copy(b); return b; } } as any,
  );
  
  const showData = Buffer.alloc(17);
  disc('arcium_showdown_queue').copy(showData, 0);
  showData.writeBigUInt64LE(showCompOffset, 8);
  showData.writeUInt8(seatIdx, 16);
  
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey,          isSigner: true,  isWritable: true  },
      { pubkey: signPda,                  isSigner: false, isWritable: true  },
      { pubkey: mxeAccount,              isSigner: false, isWritable: false },
      { pubkey: getMempoolAccAddress(clusterOffset), isSigner: false, isWritable: true  },
      { pubkey: getExecutingPoolAccAddress(clusterOffset), isSigner: false, isWritable: true  },
      { pubkey: showComputationAccount,  isSigner: false, isWritable: true  },
      { pubkey: showCompDefAccount,      isSigner: false, isWritable: false },
      { pubkey: clusterAccount,          isSigner: false, isWritable: true  },
      { pubkey: getArciumFeePoolPda(),   isSigner: false, isWritable: true  },
      { pubkey: getArciumClockPda(),     isSigner: false, isWritable: true  },
      { pubkey: ARCIUM_PROG_ID,          isSigner: false, isWritable: false },
      { pubkey: tablePDA,                isSigner: false, isWritable: true  },
      { pubkey: deckStatePda,            isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: showData,
  });
  
  const tx = new Transaction().add(ix);
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.feePayer = payer.publicKey;
  
  const sim = await conn.simulateTransaction(tx, [payer]);
  console.log('\n=== Simulation Result ===');
  console.log('Error:', JSON.stringify(sim.value.err));
  console.log('Logs:');
  sim.value.logs?.forEach(l => console.log('  ', l));
})();
