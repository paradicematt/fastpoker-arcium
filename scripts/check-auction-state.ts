import { Connection, PublicKey } from '@solana/web3.js';

const L1_RPC = 'https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df';
const PROGRAM_ID = new PublicKey('FTuksCXGvdrYe9uP2X9S12KLHhRZHJNsrzpxP2wk2ckR');
const AUCTION_SEED = Buffer.from('auction');
const CONFIG_SEED = Buffer.from('auction_config');
const LISTED_TOKEN_SEED = Buffer.from('listed_token');
const GLOBAL_BID_SEED = Buffer.from('global_bid');

async function main() {
  const conn = new Connection(L1_RPC, 'confirmed');
  const now = Math.floor(Date.now() / 1000);

  // 1. Read AuctionConfig
  const [configPda] = PublicKey.findProgramAddressSync([CONFIG_SEED], PROGRAM_ID);
  const configInfo = await conn.getAccountInfo(configPda);
  console.log('=== AuctionConfig ===');
  if (!configInfo) {
    console.log('AuctionConfig NOT FOUND — needs initialization');
    return;
  }
  const cd = Buffer.from(configInfo.data);
  const configEpoch = Number(cd.readBigUInt64LE(8));
  const configStart = Number(cd.readBigInt64LE(16));
  const configDuration = Number(cd.readBigInt64LE(24));
  const configEnd = configStart + configDuration;
  const lastTotalBid = Number(cd.readBigUInt64LE(32)) / 1e9;
  const isExpired = now >= configEnd;
  console.log(`  Current epoch: ${configEpoch}`);
  console.log(`  Start: ${new Date(configStart * 1000).toISOString()}`);
  console.log(`  End:   ${new Date(configEnd * 1000).toISOString()}`);
  console.log(`  Duration: ${Math.round(configDuration / 86400)}d`);
  console.log(`  Now:   ${new Date(now * 1000).toISOString()}`);
  console.log(`  Expired: ${isExpired ? 'YES — NEEDS RESOLVE' : 'No (still active)'}`);
  console.log(`  Last total bid: ${lastTotalBid.toFixed(4)} SOL`);

  // 2. Check AuctionState for current + past epochs
  console.log('\n=== Auction Epochs ===');
  for (let i = 0; i <= 10; i++) {
    const epoch = configEpoch - i;
    if (epoch < 1) break;
    const epochBuf = Buffer.alloc(8);
    epochBuf.writeBigUInt64LE(BigInt(epoch));
    const [auctionPda] = PublicKey.findProgramAddressSync([AUCTION_SEED, epochBuf], PROGRAM_ID);
    const info = await conn.getAccountInfo(auctionPda);
    if (!info) { console.log(`  Epoch ${epoch}: no AuctionState PDA`); continue; }

    const d = Buffer.from(info.data);
    const epNum = Number(d.readBigUInt64LE(8));
    const startTime = Number(d.readBigInt64LE(16));
    const endTime = Number(d.readBigInt64LE(24));
    const status = d[32]; // 0=Active, 1=Resolved
    const winningMint = new PublicKey(d.subarray(33, 65)).toBase58();
    const totalBid = Number(d.readBigUInt64LE(65)) / 1e9;
    const tokenCount = d.readUInt16LE(73);

    const statusLabel = status === 0 ? 'ACTIVE' : 'RESOLVED';
    const winLabel = winningMint === '11111111111111111111111111111111' ? 'None' : winningMint.slice(0, 16) + '...';
    console.log(`  Epoch ${epNum} | ${statusLabel} | ${tokenCount} tokens | ${totalBid.toFixed(4)} SOL | winner: ${winLabel}`);
    console.log(`    Range: ${new Date(startTime * 1000).toISOString().slice(0, 16)} → ${new Date(endTime * 1000).toISOString().slice(0, 16)}`);
  }

  // 3. Scan all ListedToken PDAs
  console.log('\n=== Listed Tokens (winners) ===');
  const listedAccounts = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [{ dataSize: 57 }], // ListedToken::SIZE = 8+32+8+8+1
  });
  if (listedAccounts.length === 0) {
    console.log('  NO listed tokens found!');
  }
  for (const { pubkey, account } of listedAccounts) {
    const d = Buffer.from(account.data);
    const mint = new PublicKey(d.subarray(8, 40)).toBase58();
    const winEpoch = Number(d.readBigUInt64LE(40));
    const listedAt = Number(d.readBigInt64LE(48));
    console.log(`  ${mint} | epoch ${winEpoch} | listed ${new Date(listedAt * 1000).toISOString().slice(0, 16)}`);
  }

  // 4. Scan all GlobalTokenBid PDAs (persistent leaderboard)
  console.log('\n=== Global Token Bids (leaderboard) ===');
  const globalBidAccounts = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [{ dataSize: 53 }], // GlobalTokenBid::SIZE = 8+32+8+4+1
  });
  const bids: { mint: string; amount: number; bidders: number }[] = [];
  for (const { account } of globalBidAccounts) {
    const d = Buffer.from(account.data);
    const mint = new PublicKey(d.subarray(8, 40)).toBase58();
    const amount = Number(d.readBigUInt64LE(40)) / 1e9;
    const bidders = d.readUInt32LE(48);
    if (amount > 0) bids.push({ mint, amount, bidders });
  }
  bids.sort((a, b) => b.amount - a.amount);
  if (bids.length === 0) {
    console.log('  No active bids on leaderboard');
  }
  for (const b of bids) {
    console.log(`  ${b.mint.slice(0, 20)}... | ${b.amount.toFixed(4)} SOL | ${b.bidders} bidders`);
  }

  // 5. Check the auctions page display
  console.log('\n=== Frontend "Listed Tokens" display ===');
  // The auctions page fetches ListedToken PDAs by dataSize filter
  // and also checks past AuctionState accounts with status=Resolved
  // The "listed tokens" tab shows ListedToken PDAs
  // If none exist, the tab will show empty
  console.log(`  ListedToken PDAs found: ${listedAccounts.length}`);
  console.log(`  GlobalTokenBid PDAs with amount > 0: ${bids.length}`);
  if (isExpired) {
    console.log(`  ⚠️  Current epoch ${configEpoch} has EXPIRED but not been resolved!`);
    console.log(`  The #1 bid needs resolve_auction called to create ListedToken PDA.`);
    if (bids.length > 0) {
      console.log(`  Winner would be: ${bids[0].mint} (${bids[0].amount.toFixed(4)} SOL)`);
    }
  }
}

main().catch(console.error);
