import { Connection, PublicKey, Transaction, TransactionInstruction, Keypair } from '@solana/web3.js';
import { ANCHOR_PROGRAM_ID, L1_RPC } from './constants';

// Anchor discriminators for crank instructions
const DISCRIMINATORS = {
  deal: Buffer.from([79, 175, 150, 65, 71, 26, 234, 182]),
  advance_street: Buffer.from([190, 250, 30, 148, 167, 234, 247, 44]),
  settle: Buffer.from([172, 167, 27, 16, 201, 137, 72, 149]),
  timeout: Buffer.from([184, 51, 161, 126, 238, 135, 26, 170]),
};

interface CrankConfig {
  erRpcUrl: string;
  l1RpcUrl: string;
  crankKeypair?: Keypair;
}

/**
 * Crank Service for automating game state transitions
 * 
 * The crank monitors tables and triggers:
 * - deal: When all players are ready
 * - advance_street: After betting round completes
 * - settle: At showdown
 * - timeout: When a player times out
 */
export class CrankService {
  private erConnection: Connection;
  private l1Connection: Connection;
  private crankKeypair: Keypair | null;
  private activeTables: Set<string> = new Set();
  private intervalId: NodeJS.Timeout | null = null;

  constructor(config: CrankConfig) {
    this.erConnection = new Connection(config.erRpcUrl, 'confirmed');
    this.l1Connection = new Connection(config.l1RpcUrl, 'confirmed');
    this.crankKeypair = config.crankKeypair || null;
  }

  /**
   * Start monitoring a table
   */
  addTable(tablePda: PublicKey): void {
    this.activeTables.add(tablePda.toBase58());
  }

  /**
   * Stop monitoring a table
   */
  removeTable(tablePda: PublicKey): void {
    this.activeTables.delete(tablePda.toBase58());
  }

  /**
   * Start the crank loop
   */
  start(intervalMs: number = 1000): void {
    if (this.intervalId) return;
    
    this.intervalId = setInterval(() => this.crankTick(), intervalMs);
    console.log('Crank service started');
  }

  /**
   * Stop the crank loop
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('Crank service stopped');
    }
  }

  /**
   * Single crank tick - check all tables and trigger actions
   */
  private async crankTick(): Promise<void> {
    const tables = Array.from(this.activeTables);
    for (let i = 0; i < tables.length; i++) {
      const tableKey = tables[i];
      try {
        const tablePda = new PublicKey(tableKey);
        await this.processTable(tablePda);
      } catch (err) {
        console.error(`Crank error for table ${tableKey}:`, err);
      }
    }
  }

  /**
   * Process a single table
   */
  private async processTable(tablePda: PublicKey): Promise<void> {
    // Read table state
    const tableAccount = await this.erConnection.getAccountInfo(tablePda);
    if (!tableAccount) return;

    const tableData = tableAccount.data;
    // Parse table state
    // Layout: disc(8) + table_id(32) + authority(32) + phase(1) + ...
    const phase = tableData[72]; // Approximate offset for phase
    const currentPlayer = tableData[73]; // Current player index
    const lastActionTime = Number(tableData.readBigUInt64LE(80)); // Last action timestamp

    // Check for timeout (30 seconds)
    const now = Date.now() / 1000;
    if (lastActionTime > 0 && now - lastActionTime > 30) {
      await this.sendTimeout(tablePda, currentPlayer);
      return;
    }

    // Check phase transitions
    switch (phase) {
      case 0: // Waiting - check if ready to deal
        await this.checkDealReady(tablePda, tableData);
        break;
      case 1: // Preflop
      case 2: // Flop
      case 3: // Turn
      case 4: // River
        // Betting rounds handled by player actions
        // Check if round is complete and advance
        await this.checkAdvanceStreet(tablePda, tableData, phase);
        break;
      case 5: // Showdown
        await this.sendSettle(tablePda);
        break;
    }
  }

  /**
   * Check if table is ready to deal
   */
  private async checkDealReady(tablePda: PublicKey, tableData: Buffer): Promise<void> {
    // Check player count and ready status
    // Layout depends on exact table structure
    const playerCount = tableData[74];
    const maxPlayers = tableData[75];
    const allReady = tableData[76] === 1;

    if (playerCount >= 2 && allReady) {
      await this.sendDeal(tablePda);
    }
  }

  /**
   * Check if betting round is complete
   */
  private async checkAdvanceStreet(tablePda: PublicKey, tableData: Buffer, currentPhase: number): Promise<void> {
    // Check if all players have acted and bets are matched
    const bettingComplete = tableData[77] === 1;
    
    if (bettingComplete) {
      if (currentPhase < 4) {
        await this.sendAdvanceStreet(tablePda);
      } else {
        // River complete, go to showdown
        // This is handled by settle
      }
    }
  }

  /**
   * Send deal instruction
   */
  private async sendDeal(tablePda: PublicKey): Promise<string | null> {
    if (!this.crankKeypair) {
      console.log('Deal ready but no crank keypair configured');
      return null;
    }

    const ix = new TransactionInstruction({
      programId: ANCHOR_PROGRAM_ID,
      keys: [
        { pubkey: this.crankKeypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: tablePda, isSigner: false, isWritable: true },
      ],
      data: DISCRIMINATORS.deal,
    });

    return this.sendTransaction(ix);
  }

  /**
   * Send advance_street instruction
   */
  private async sendAdvanceStreet(tablePda: PublicKey): Promise<string | null> {
    if (!this.crankKeypair) return null;

    const ix = new TransactionInstruction({
      programId: ANCHOR_PROGRAM_ID,
      keys: [
        { pubkey: this.crankKeypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: tablePda, isSigner: false, isWritable: true },
      ],
      data: DISCRIMINATORS.advance_street,
    });

    return this.sendTransaction(ix);
  }

  /**
   * Send settle instruction
   */
  private async sendSettle(tablePda: PublicKey): Promise<string | null> {
    if (!this.crankKeypair) return null;

    const ix = new TransactionInstruction({
      programId: ANCHOR_PROGRAM_ID,
      keys: [
        { pubkey: this.crankKeypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: tablePda, isSigner: false, isWritable: true },
      ],
      data: DISCRIMINATORS.settle,
    });

    return this.sendTransaction(ix);
  }

  /**
   * Send timeout instruction
   */
  private async sendTimeout(tablePda: PublicKey, seatIndex: number): Promise<string | null> {
    if (!this.crankKeypair) return null;

    const data = Buffer.alloc(9);
    DISCRIMINATORS.timeout.copy(data, 0);
    data.writeUInt8(seatIndex, 8);

    const ix = new TransactionInstruction({
      programId: ANCHOR_PROGRAM_ID,
      keys: [
        { pubkey: this.crankKeypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: tablePda, isSigner: false, isWritable: true },
      ],
      data,
    });

    return this.sendTransaction(ix);
  }

  /**
   * Send transaction to ER
   */
  private async sendTransaction(instruction: TransactionInstruction): Promise<string | null> {
    if (!this.crankKeypair) return null;

    try {
      const tx = new Transaction().add(instruction);
      tx.feePayer = this.crankKeypair.publicKey;
      
      const { blockhash } = await this.erConnection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      
      tx.sign(this.crankKeypair);
      
      const signature = await this.erConnection.sendRawTransaction(tx.serialize());
      await this.erConnection.confirmTransaction(signature, 'confirmed');
      
      console.log('Crank tx confirmed:', signature);
      return signature;
    } catch (err) {
      console.error('Crank transaction failed:', err);
      return null;
    }
  }
}

/**
 * Create a crank service instance
 */
export function createCrankService(crankKeypair?: Keypair): CrankService {
  return new CrankService({
    erRpcUrl: L1_RPC,
    l1RpcUrl: L1_RPC,
    crankKeypair,
  });
}
