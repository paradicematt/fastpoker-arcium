'use client';

import { useMemo, useState, useEffect } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-wallets';
import { L1_RPC } from '@/lib/constants';

import '@solana/wallet-adapter-react-ui/styles.css';

export function Providers({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  const network = WalletAdapterNetwork.Devnet;

  const wallets = useMemo(
    () => [
      new SolflareWalletAdapter({ network }),
    ],
    [network]
  );

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <ConnectionProvider endpoint={L1_RPC}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          {mounted ? children : <div style={{ visibility: 'hidden' }}>{children}</div>}
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
