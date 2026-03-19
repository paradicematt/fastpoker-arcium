import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import dynamic from 'next/dynamic';
import { LayoutShell } from '@/components/layout/LayoutShell';

// Dynamically import Providers to avoid hydration issues with wallet adapter
const Providers = dynamic(() => import('./providers').then(mod => ({ default: mod.Providers })), {
  ssr: false,
});

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'FAST POKER | On-Chain Texas Hold\'em',
  description: 'Lightning-fast poker on Solana. MPC-powered card privacy. Win tournaments, mint $POKER tokens.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.className} bg-gray-950 text-white min-h-screen flex flex-col`}>
        <Providers>
          <LayoutShell>{children}</LayoutShell>
        </Providers>
      </body>
    </html>
  );
}
