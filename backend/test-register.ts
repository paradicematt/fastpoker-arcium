import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const conn = new Connection("http://localhost:8899", "confirmed");

// Use a fresh test keypair
const wallet = Keypair.generate();

const PROGRAM_ID = new PublicKey("BGyLYzzS5tPASGSj6BbzpLbHVwm4Csg9C1QfD8KGDe3N");
const STEEL_PROGRAM_ID = new PublicKey("9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6");
const POOL_PDA = new PublicKey("FSKrGq26FxhMUSK85ksv2AykL5Am2HS9iXJwuVoQQvLY");
const TREASURY = new PublicKey("4GaUxfVdaKz8wMryTtXGVdCnGeRMzEMW7aVw3epxwew3");

// Derive PDAs
const [playerPda] = PublicKey.findProgramAddressSync([Buffer.from("player"), wallet.publicKey.toBuffer()], PROGRAM_ID);
const [unrefinedPda] = PublicKey.findProgramAddressSync([Buffer.from("unrefined"), wallet.publicKey.toBuffer()], STEEL_PROGRAM_ID);

console.log("Wallet:", wallet.publicKey.toBase58());
console.log("Player PDA:", playerPda.toBase58());
console.log("Unrefined PDA:", unrefinedPda.toBase58());

async function main() {
  // Airdrop SOL for fees
  console.log("Airdropping 2 SOL...");
  const sig0 = await conn.requestAirdrop(wallet.publicKey, 2_000_000_000);
  await conn.confirmTransaction(sig0, "confirmed");

  const bal = await conn.getBalance(wallet.publicKey);
  console.log("Balance:", bal / 1e9, "SOL");

  // Check if already registered
  const playerInfo = await conn.getAccountInfo(playerPda);
  const unrefinedInfo = await conn.getAccountInfo(unrefinedPda);
  console.log("Player exists:", !!playerInfo);
  console.log("Unrefined exists:", !!unrefinedInfo);

  // Register discriminator
  const disc = Buffer.from([242, 146, 194, 234, 234, 145, 228, 42]);

  const tx = new Transaction().add(new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: playerPda, isSigner: false, isWritable: true },
      { pubkey: TREASURY, isSigner: false, isWritable: true },
      { pubkey: POOL_PDA, isSigner: false, isWritable: true },
      { pubkey: unrefinedPda, isSigner: false, isWritable: true },
      { pubkey: STEEL_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: disc,
  }));

  try {
    const sig = await sendAndConfirmTransaction(conn, tx, [wallet]);
    console.log("✅ Registration succeeded:", sig);

    // Verify accounts created
    const pInfo = await conn.getAccountInfo(playerPda);
    const uInfo = await conn.getAccountInfo(unrefinedPda);
    console.log("Player PDA created:", !!pInfo, "size:", pInfo?.data.length);
    console.log("Unrefined PDA created:", !!uInfo, "size:", uInfo?.data.length);
  } catch (e: any) {
    console.log("❌ Registration failed:", e.message?.slice(0, 200));
    if (e.logs) {
      console.log("\nTransaction logs:");
      e.logs.forEach((l: string) => console.log("  ", l));
    }
  }
}

main().catch(console.error);
