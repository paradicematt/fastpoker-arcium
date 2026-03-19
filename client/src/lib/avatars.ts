// Shared avatar definitions used by profile page and poker table
export interface AvatarOption {
  id: string;
  label: string;
  image: string;       // path to SVG/PNG in /avatars/
  fallbackEmoji: string; // fallback if image fails
  gradient: string;     // background gradient for profile selector
}

export const AVATAR_OPTIONS: AvatarOption[] = [
  // ─── NFT / Culture ───
  { id: 'punk',        label: 'CryptoPunk',    image: '/avatars/punk.svg',        fallbackEmoji: '\uD83E\uDD16', gradient: 'from-cyan-600 to-blue-700' },
  { id: 'punk-ape',    label: 'Punk Ape',      image: '/avatars/punk-ape.svg',    fallbackEmoji: '\uD83D\uDC12', gradient: 'from-amber-600 to-orange-700' },
  { id: 'punk-zombie', label: 'Punk Zombie',   image: '/avatars/punk-zombie.svg', fallbackEmoji: '\uD83E\uDDDF', gradient: 'from-green-700 to-emerald-800' },
  { id: 'punk-alien',  label: 'Punk Alien',    image: '/avatars/punk-alien.svg',  fallbackEmoji: '\uD83D\uDC7D', gradient: 'from-teal-500 to-cyan-600' },
  { id: 'boredape',    label: 'Bored Ape',     image: '/avatars/boredape.svg',    fallbackEmoji: '\uD83D\uDC35', gradient: 'from-amber-500 to-yellow-600' },

  // ─── Solana Memes (hottest 2024-2025) ───
  { id: 'bonk',      label: 'Bonk',       image: '/avatars/bonk.svg',       fallbackEmoji: '\uD83D\uDC15', gradient: 'from-amber-500 to-orange-500' },
  { id: 'dogwifhat', label: 'Dogwifhat',   image: '/avatars/dogwifhat.svg',  fallbackEmoji: '\uD83E\uDDE2', gradient: 'from-pink-400 to-rose-500' },
  { id: 'popcat',    label: 'Popcat',      image: '/avatars/popcat.svg',     fallbackEmoji: '\uD83D\uDE40', gradient: 'from-amber-400 to-yellow-500' },
  { id: 'pepe',      label: 'Pepe',        image: '/avatars/pepe.svg',       fallbackEmoji: '\uD83D\uDC38', gradient: 'from-green-500 to-emerald-600' },
  { id: 'trump',     label: '$TRUMP',      image: '/avatars/trump.svg',      fallbackEmoji: '\uD83C\uDFB0', gradient: 'from-yellow-400 to-amber-500' },
  { id: 'pengu',     label: 'Pengu',       image: '/avatars/pengu.svg',      fallbackEmoji: '\uD83D\uDC27', gradient: 'from-sky-400 to-blue-500' },
  { id: 'fartcoin',  label: 'Fartcoin',    image: '/avatars/fartcoin.svg',   fallbackEmoji: '\uD83D\uDCA8', gradient: 'from-green-400 to-lime-500' },
  { id: 'mew',       label: 'MEW',         image: '/avatars/mew.svg',        fallbackEmoji: '\uD83D\uDC31', gradient: 'from-orange-400 to-red-500' },
  { id: 'shiba',     label: 'Shiba Inu',   image: '/avatars/shiba.svg',      fallbackEmoji: '\uD83D\uDC15', gradient: 'from-red-500 to-orange-500' },
  { id: 'dogecoin',  label: 'Dogecoin',    image: '/avatars/dogecoin.svg',   fallbackEmoji: '\uD83D\uDC36', gradient: 'from-amber-400 to-yellow-400' },

  // ─── Crypto Logos ───
  { id: 'solana',    label: 'Solana',      image: '/avatars/solana.svg',     fallbackEmoji: '\u25CE', gradient: 'from-violet-500 to-fuchsia-500' },
  { id: 'bitcoin',   label: 'Bitcoin',     image: '/avatars/bitcoin.svg',    fallbackEmoji: '\u20BF', gradient: 'from-amber-500 to-orange-600' },
  { id: 'ethereum',  label: 'Ethereum',    image: '/avatars/ethereum.svg',   fallbackEmoji: '\u039E', gradient: 'from-indigo-400 to-purple-500' },
  { id: 'jupiter',   label: 'Jupiter',     image: '/avatars/jupiter.svg',    fallbackEmoji: '\uD83E\uDE90', gradient: 'from-lime-400 to-teal-500' },
  { id: 'raydium',   label: 'Raydium',     image: '/avatars/raydium.svg',    fallbackEmoji: '\u2622', gradient: 'from-purple-500 to-indigo-500' },
  { id: 'chainlink', label: 'Chainlink',   image: '/avatars/chainlink.svg',  fallbackEmoji: '\u26D3', gradient: 'from-blue-500 to-indigo-600' },
  { id: 'sui',       label: 'Sui',         image: '/avatars/sui.svg',        fallbackEmoji: '\uD83D\uDCA7', gradient: 'from-sky-400 to-blue-600' },
  { id: 'toncoin',   label: 'Toncoin',     image: '/avatars/toncoin.svg',    fallbackEmoji: '\uD83D\uDC8E', gradient: 'from-cyan-400 to-blue-500' },

  // ─── Poker Suits (classic) ───
  { id: 'spade',     label: 'Spade',       image: '',  fallbackEmoji: '\u2660\uFE0F', gradient: 'from-cyan-500 to-blue-600' },
  { id: 'diamond',   label: 'Diamond',     image: '',  fallbackEmoji: '\u2666\uFE0F', gradient: 'from-red-500 to-pink-500' },
  { id: 'heart',     label: 'Heart',       image: '',  fallbackEmoji: '\u2665\uFE0F', gradient: 'from-pink-500 to-rose-500' },
  { id: 'club',      label: 'Club',        image: '',  fallbackEmoji: '\u2663\uFE0F', gradient: 'from-emerald-500 to-green-600' },
];

export function getAvatarById(id: string): AvatarOption | null {
  return AVATAR_OPTIONS.find(a => a.id === id) || null;
}
