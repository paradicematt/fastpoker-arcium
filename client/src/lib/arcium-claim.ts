/**
 * Frontend claim_hole_cards utility.
 *
 * Builds and sends the arcium_claim_cards_queue instruction using the player's
 * session key. This is a fallback for when the crank hasn't claimed P2+ cards
 * within a timeout. The instruction is permissionless and idempotent — both
 * crank and player can call it safely.
 */

import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getMXEAccAddress, getMempoolAccAddress, getExecutingPoolAccAddress,
  getCompDefAccAddress, getCompDefAccOffset, getComputationAccAddress,
  getClusterAccAddress, getArciumProgramId, getArciumEnv,
  getArciumAccountBaseSeed,
} from '@arcium-hq/client';
import { PROGRAM_ID, DECK_STATE_SEED, TABLE_SEED } from './constants';
import { DISCRIMINATORS } from './onchain-game';

const ARCIUM_PROG_ID = getArciumProgramId();
const SIGN_PDA_SEED = Buffer.from('ArciumSignerAccount');

function getSignPda(): PublicKey {
  return PublicKey.findProgramAddressSync([SIGN_PDA_SEED], PROGRAM_ID)[0];
}

function getArciumClockPda(): PublicKey {
  return PublicKey.findProgramAddressSync([getArciumAccountBaseSeed('ClockAccount')], ARCIUM_PROG_ID)[0];
}

function getArciumFeePoolPda(): PublicKey {
  return PublicKey.findProgramAddressSync([getArciumAccountBaseSeed('FeePool')], ARCIUM_PROG_ID)[0];
}

function getDeckStatePda(tablePda: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(DECK_STATE_SEED), tablePda.toBuffer()],
    PROGRAM_ID,
  )[0];
}

/**
 * Build and send claim_hole_cards for a single seat using the session key.
 * Returns true if TX confirmed, false on failure (logged, not thrown).
 */
export async function claimHoleCards(
  connection: Connection,
  sessionKey: Keypair,
  tablePda: PublicKey,
  seatIndex: number,
): Promise<boolean> {
  try {
    const arciumEnv = getArciumEnv();
    const clusterOffset = arciumEnv.arciumClusterOffset;

    const computationOffset = BigInt(Date.now()) * BigInt(1000) + BigInt(seatIndex);
    const compDefOffset = Buffer.from(getCompDefAccOffset('claim_hole_cards')).readUInt32LE(0);

    const compOffsetBuf = Buffer.alloc(8);
    compOffsetBuf.writeBigUInt64LE(computationOffset);
    const computationAccount = getComputationAccAddress(clusterOffset, {
      toArrayLike: (_B: any, _e: string, l: number) => {
        const b = Buffer.alloc(l); compOffsetBuf.copy(b); return b;
      },
    } as any);

    const compDefAccount = getCompDefAccAddress(PROGRAM_ID, compDefOffset);

    // IX data: disc(8) + computation_offset(u64:8) + seat_index(u8:1) = 17 bytes
    const data = Buffer.alloc(17);
    DISCRIMINATORS.arciumClaimCardsQueue.copy(data, 0);
    data.writeBigUInt64LE(computationOffset, 8);
    data.writeUInt8(seatIndex, 16);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: sessionKey.publicKey,                     isSigner: true,  isWritable: true  },
        { pubkey: getSignPda(),                             isSigner: false, isWritable: true  },
        { pubkey: getMXEAccAddress(PROGRAM_ID),             isSigner: false, isWritable: false },
        { pubkey: getMempoolAccAddress(clusterOffset),      isSigner: false, isWritable: true  },
        { pubkey: getExecutingPoolAccAddress(clusterOffset),isSigner: false, isWritable: true  },
        { pubkey: computationAccount,                       isSigner: false, isWritable: true  },
        { pubkey: compDefAccount,                           isSigner: false, isWritable: false },
        { pubkey: getClusterAccAddress(clusterOffset),      isSigner: false, isWritable: true  },
        { pubkey: getArciumFeePoolPda(),                    isSigner: false, isWritable: true  },
        { pubkey: getArciumClockPda(),                      isSigner: false, isWritable: true  },
        { pubkey: ARCIUM_PROG_ID,                           isSigner: false, isWritable: false },
        { pubkey: tablePda,                                 isSigner: false, isWritable: false },
        { pubkey: getDeckStatePda(tablePda),                isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId,                  isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(ix);
    await sendAndConfirmTransaction(connection, tx, [sessionKey], {
      commitment: 'confirmed',
      skipPreflight: true,
    });

    console.log(`[arcium-claim] claim_hole_cards queued for seat ${seatIndex}`);
    return true;
  } catch (err: any) {
    console.warn(`[arcium-claim] claim_hole_cards failed for seat ${seatIndex}:`, err.message?.slice(0, 120));
    return false;
  }
}
