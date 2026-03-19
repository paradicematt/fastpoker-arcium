// Card utilities for display

export const SUITS = ['♠', '♥', '♦', '♣'] as const;
export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const;

export type Suit = typeof SUITS[number];
export type Rank = typeof RANKS[number];

export interface Card {
  value: number;
  rank: Rank;
  suit: Suit;
  color: 'red' | 'black';
  display: string;
}

/**
 * Convert card value (0-51) to Card object
 * Card encoding: suit * 13 + rank
 * Suits: 0=♠, 1=♥, 2=♦, 3=♣
 * Ranks: 0=2, 1=3, ..., 12=A
 */
export function parseCard(value: number): Card | null {
  if (value < 0 || value > 51) return null;
  
  const suitIndex = Math.floor(value / 13);
  const rankIndex = value % 13;
  
  const suit = SUITS[suitIndex];
  const rank = RANKS[rankIndex];
  const color = suitIndex === 1 || suitIndex === 2 ? 'red' : 'black';
  
  return {
    value,
    rank,
    suit,
    color,
    display: `${rank}${suit}`,
  };
}

/**
 * Get card display string
 */
export function cardDisplay(value: number): string {
  if (value === 255) return '??';
  const card = parseCard(value);
  return card ? card.display : `#${value}`;
}

/**
 * Get card image path
 */
export function cardImagePath(value: number): string {
  if (value === 255) return '/cards/back.svg';
  const card = parseCard(value);
  if (!card) return '/cards/back.svg';
  
  // e.g., /cards/AS.svg for Ace of Spades
  const suitChar = { '♠': 'S', '♥': 'H', '♦': 'D', '♣': 'C' }[card.suit];
  return `/cards/${card.rank}${suitChar}.svg`;
}

/**
 * Format hole cards for display
 */
export function formatHoleCards(card1: number, card2: number): string {
  return `${cardDisplay(card1)} ${cardDisplay(card2)}`;
}

/**
 * Check if cards are hidden (not dealt)
 */
export function areCardsHidden(card1: number, card2: number): boolean {
  return card1 === 255 && card2 === 255;
}

/**
 * Get hand strength description (basic)
 */
export function getHandStrengthHint(card1: number, card2: number): string {
  if (card1 === 255 || card2 === 255) return '';
  
  const c1 = parseCard(card1);
  const c2 = parseCard(card2);
  if (!c1 || !c2) return '';
  
  const isPair = c1.rank === c2.rank;
  const isSuited = c1.suit === c2.suit;
  const highRanks = ['A', 'K', 'Q', 'J', 'T'];
  const isHighCard = highRanks.includes(c1.rank) || highRanks.includes(c2.rank);
  
  if (isPair && highRanks.includes(c1.rank)) return 'Premium Pair';
  if (isPair) return 'Pocket Pair';
  if (isSuited && isHighCard) return 'Suited High Cards';
  if (isHighCard) return 'High Cards';
  if (isSuited) return 'Suited';
  return '';
}
