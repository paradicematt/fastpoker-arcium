import { Connection, PublicKey } from '@solana/web3.js';

const PROGRAM_ID = new PublicKey('FTuksCXGvdrYe9uP2X9S12KLHhRZHJNsrzpxP2wk2ckR');
const t = new PublicKey(process.argv[2] || '2chuZGVXgJwanHHmS9Uidvrka5XNQdYyAnmWXDqBHrSD');
const c = new Connection('https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df');

const getSeatPda = (table: PublicKey, seat: number) => 
  PublicKey.findProgramAddressSync([Buffer.from('seat'), table.toBuffer(), Buffer.from([seat])], PROGRAM_ID)[0];

const BROWSER_WALLET = 'Dies3qUWtDrB9PcZLAagXX2Rxys3AmNxvka8DPoFj93r';
const PLAYER2_WALLET = '94T22BUkpiCUXZK6y6guf7WCRXdnkeZ6oubcDZncpTiQ';

(async () => {
  for (let i = 0; i < 2; i++) {
    const seatPda = getSeatPda(t, i);
    const info = await c.getAccountInfo(seatPda);
    if (info) {
      // Seat struct: 8 disc + 32 wallet + 32 session_key + 32 table + ...
      const wallet = new PublicKey(info.data.slice(8, 8 + 32));
      const isBrowser = wallet.toBase58() === BROWSER_WALLET;
      const isPlayer2 = wallet.toBase58() === PLAYER2_WALLET;
      console.log(`Seat ${i}: ${wallet.toBase58().slice(0,8)}... ${isBrowser ? '(BROWSER/YOU)' : isPlayer2 ? '(PLAYER2/ME)' : ''}`);
    }
  }
})();
