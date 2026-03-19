const {Connection, PublicKey} = require('@solana/web3.js');
(async()=>{
  const c = new Connection('https://devnet.helius-rpc.com/?api-key=0a2b697e-8118-455d-8c52-a498ec2d81df','confirmed');
  const t = new PublicKey('GdsSc2dsPNoPzRXBvVS8NWjwfaxf8xCKPTH3pzGXWY2v');
  const i = await c.getAccountInfo(t);
  if(!i){console.log('NULL');return;}
  const d = Buffer.from(i.data);
  console.log(d.slice(8,40).toString('hex'));
})();
