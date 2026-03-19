import { useState, useEffect } from 'react';

const SOL_DEFAULT_B58 = '11111111111111111111111111111111';
const POKER_MINT_B58 = 'DiJC3FVReapYYDwRnPMrCRH7aYyeJ47Nu81MemTaHZWX';

function getTokenImageFallback(mint?: string): string {
  if (!mint || mint === SOL_DEFAULT_B58) return '/tokens/sol.svg';
  if (mint === POKER_MINT_B58) return '/tokens/poker.svg';
  return '/tokens/sol.svg';
}

const tokenLogoCache = new Map<string, string>();

export function useTokenLogo(mint?: string): string {
  const fallback = getTokenImageFallback(mint);
  const isCustom = !!mint && mint !== SOL_DEFAULT_B58 && mint !== POKER_MINT_B58;
  const [logo, setLogo] = useState(() => isCustom ? (tokenLogoCache.get(mint!) || fallback) : fallback);
  useEffect(() => {
    if (!isCustom || !mint) return;
    if (tokenLogoCache.has(mint)) { setLogo(tokenLogoCache.get(mint)!); return; }
    let active = true;
    fetch(`/api/token-meta?mints=${mint}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!active || !data?.[mint]?.logoURI) return;
        tokenLogoCache.set(mint, data[mint].logoURI);
        setLogo(data[mint].logoURI);
      })
      .catch(() => {});
    return () => { active = false; };
  }, [mint, isCustom]);
  return logo;
}
