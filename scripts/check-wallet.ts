import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';

const L1 = new Connection('https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df', 'confirmed');
const STEEL = new PublicKey('9qHC57uFi6wz8iit1HwVq3yms81Hn4rgwtE73rh3hZY6');
const POKER_MINT = new PublicKey('DiJC3FVReapYYDwRnPMrCRH7aYyeJ47Nu81MemTaHZWX');
const POOL_PDA = new PublicKey('FSKrGq26FxhMUSK85ksv2AykL5Am2HS9iXJwuVoQQvLY');

const wallet = new PublicKey(process.argv[2] || '2KskcmUNXDoL2nD1T7DcgVYmxUYUtTyP4RTmPcJRc9xP');

async function main() {
  console.log(`\nWallet: ${wallet.toBase58()}\n`);

  // Check ATA
  const ata = await getAssociatedTokenAddress(POKER_MINT, wallet);
  const ataInfo = await L1.getAccountInfo(ata);
  console.log(`ATA: ${ata.toBase58()}`);
  console.log(`ATA exists: ${!!ataInfo}`);
  if (ataInfo) {
    const balance = Buffer.from(ataInfo.data).readBigUInt64LE(64);
    console.log(`ATA balance: ${balance} raw`);
  }

  // Check Unrefined PDA
  const [unrefinedPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('unrefined'), wallet.toBuffer()], STEEL
  );
  const unrefinedInfo = await L1.getAccountInfo(unrefinedPda);
  console.log(`\nUnrefined PDA: ${unrefinedPda.toBase58()}`);
  console.log(`Unrefined exists: ${!!unrefinedInfo}`);
  if (unrefinedInfo && unrefinedInfo.data.length >= 72) {
    const d = Buffer.from(unrefinedInfo.data);
    const unrefined = Number(d.readBigUInt64LE(40)) / 1e6;
    const stored = Number(d.readBigUInt64LE(48)) / 1e6;
    console.log(`Unrefined balance: ${unrefined} POKER`);
    console.log(`Stored refined: ${stored} POKER`);
  }

  // Check mint authority derivation
  const [mintAuth] = PublicKey.findProgramAddressSync([Buffer.from('pool')], STEEL);
  console.log(`\nMint authority PDA: ${mintAuth.toBase58()}`);
  console.log(`Pool PDA constant:  ${POOL_PDA.toBase58()}`);
  console.log(`Same? ${mintAuth.equals(POOL_PDA)}`);
}
main().catch(e => console.error(e));
