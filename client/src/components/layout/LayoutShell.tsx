'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Navbar } from './Navbar';
import { Footer } from './Footer';
import { ActiveTableBar } from './ActiveTableBar';

/** Routes where the global navbar/footer should be hidden */
const BARE_ROUTES = ['/admin', '/test'];

export function LayoutShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [inIframe, setInIframe] = useState(false);

  useEffect(() => {
    try { setInIframe(window.self !== window.top); } catch { setInIframe(true); }
  }, []);

  const isBare = inIframe || BARE_ROUTES.some(r => pathname?.startsWith(r));

  return (
    <>
      {!isBare && <Navbar />}
      {!isBare && <ActiveTableBar />}
      <div className={isBare ? '' : 'flex-1 pb-14'}>{children}</div>
      {!isBare && <Footer />}
    </>
  );
}
