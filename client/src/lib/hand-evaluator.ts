/**
 * Poker Hand Evaluator
 * Evaluates 7-card hands (2 hole + 5 community) and returns hand rank + name.
 * Card encoding: rankIdx = cardNum % 13 (0=2..12=A), suitIdx = floor(cardNum / 13) (0=♠,1=♥,2=♦,3=♣)
 */

export enum HandRank {
  HighCard = 0,
  OnePair = 1,
  TwoPair = 2,
  ThreeOfAKind = 3,
  Straight = 4,
  Flush = 5,
  FullHouse = 6,
  FourOfAKind = 7,
  StraightFlush = 8,
  RoyalFlush = 9,
}

const RANK_NAMES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'Jack', 'Queen', 'King', 'Ace'];
const RANK_NAMES_PLURAL = ['2s', '3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s', 'Jacks', 'Queens', 'Kings', 'Aces'];

export interface HandResult {
  rank: HandRank;
  name: string;       // e.g. "Two Pair, Aces and Kings"
  shortName: string;  // e.g. "Two Pair"
  score: number;      // Comparable numeric score (higher = better)
}

function getRank(card: number): number {
  return card % 13;
}

function getSuit(card: number): number {
  return Math.floor(card / 13);
}

/**
 * Generate all 21 combinations of 5 cards from 7
 */
function combinations5from7(cards: number[]): number[][] {
  const result: number[][] = [];
  for (let i = 0; i < 7; i++)
    for (let j = i + 1; j < 7; j++)
      for (let k = j + 1; k < 7; k++)
        for (let l = k + 1; l < 7; l++)
          for (let m = l + 1; m < 7; m++)
            result.push([cards[i], cards[j], cards[k], cards[l], cards[m]]);
  return result;
}

/**
 * Evaluate a 5-card hand and return a comparable score + hand info
 */
function evaluate5(cards: number[]): { rank: HandRank; score: number; kickers: number[] } {
  const ranks = cards.map(getRank).sort((a, b) => b - a);
  const suits = cards.map(getSuit);

  // Count rank frequencies
  const freq: Record<number, number> = {};
  for (const r of ranks) freq[r] = (freq[r] || 0) + 1;

  const freqEntries = Object.entries(freq)
    .map(([r, c]) => ({ rank: Number(r), count: c }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);

  // Check flush
  const isFlush = suits.every(s => s === suits[0]);

  // Check straight
  let isStraight = false;
  let straightHigh = 0;
  const uniqueRanks = Array.from(new Set(ranks)).sort((a, b) => b - a);

  if (uniqueRanks.length >= 5) {
    // Normal straight check
    for (let i = 0; i <= uniqueRanks.length - 5; i++) {
      if (uniqueRanks[i] - uniqueRanks[i + 4] === 4) {
        isStraight = true;
        straightHigh = uniqueRanks[i];
        break;
      }
    }
    // Wheel (A-2-3-4-5)
    if (!isStraight && uniqueRanks.includes(12) && uniqueRanks.includes(0) &&
        uniqueRanks.includes(1) && uniqueRanks.includes(2) && uniqueRanks.includes(3)) {
      isStraight = true;
      straightHigh = 3; // 5-high straight
    }
  }

  // Determine hand rank
  const counts = freqEntries.map(e => e.count);

  if (isStraight && isFlush) {
    const rank = straightHigh === 12 ? HandRank.RoyalFlush : HandRank.StraightFlush;
    return { rank, score: rank * 1e10 + straightHigh, kickers: [straightHigh] };
  }

  if (counts[0] === 4) {
    const quadRank = freqEntries[0].rank;
    const kicker = freqEntries[1].rank;
    return { rank: HandRank.FourOfAKind, score: HandRank.FourOfAKind * 1e10 + quadRank * 1e6 + kicker, kickers: [quadRank, kicker] };
  }

  if (counts[0] === 3 && counts[1] === 2) {
    const tripRank = freqEntries[0].rank;
    const pairRank = freqEntries[1].rank;
    return { rank: HandRank.FullHouse, score: HandRank.FullHouse * 1e10 + tripRank * 1e6 + pairRank, kickers: [tripRank, pairRank] };
  }

  if (isFlush) {
    const s = ranks.slice(0, 5);
    const score = HandRank.Flush * 1e10 + s[0] * 1e8 + s[1] * 1e6 + s[2] * 1e4 + s[3] * 1e2 + s[4];
    return { rank: HandRank.Flush, score, kickers: s };
  }

  if (isStraight) {
    return { rank: HandRank.Straight, score: HandRank.Straight * 1e10 + straightHigh, kickers: [straightHigh] };
  }

  if (counts[0] === 3) {
    const tripRank = freqEntries[0].rank;
    const kickers = freqEntries.slice(1).map(e => e.rank).sort((a, b) => b - a);
    return { rank: HandRank.ThreeOfAKind, score: HandRank.ThreeOfAKind * 1e10 + tripRank * 1e8 + kickers[0] * 1e4 + kickers[1], kickers: [tripRank, ...kickers] };
  }

  if (counts[0] === 2 && counts[1] === 2) {
    const pairs = freqEntries.filter(e => e.count === 2).map(e => e.rank).sort((a, b) => b - a);
    const kicker = freqEntries.find(e => e.count === 1)!.rank;
    return { rank: HandRank.TwoPair, score: HandRank.TwoPair * 1e10 + pairs[0] * 1e8 + pairs[1] * 1e4 + kicker, kickers: [...pairs, kicker] };
  }

  if (counts[0] === 2) {
    const pairRank = freqEntries[0].rank;
    const kickers = freqEntries.slice(1).map(e => e.rank).sort((a, b) => b - a);
    return { rank: HandRank.OnePair, score: HandRank.OnePair * 1e10 + pairRank * 1e8 + kickers[0] * 1e6 + kickers[1] * 1e4 + kickers[2], kickers: [pairRank, ...kickers] };
  }

  // High card
  const s = ranks.slice(0, 5);
  const score = HandRank.HighCard * 1e10 + s[0] * 1e8 + s[1] * 1e6 + s[2] * 1e4 + s[3] * 1e2 + s[4];
  return { rank: HandRank.HighCard, score, kickers: s };
}

/**
 * Build a human-readable hand name
 */
function buildHandName(rank: HandRank, kickers: number[]): { name: string; shortName: string } {
  switch (rank) {
    case HandRank.RoyalFlush:
      return { name: 'Royal Flush', shortName: 'Royal Flush' };
    case HandRank.StraightFlush:
      return { name: `Straight Flush, ${RANK_NAMES[kickers[0]]}-high`, shortName: 'Straight Flush' };
    case HandRank.FourOfAKind:
      return { name: `Four ${RANK_NAMES_PLURAL[kickers[0]]}`, shortName: 'Four of a Kind' };
    case HandRank.FullHouse:
      return { name: `Full House, ${RANK_NAMES_PLURAL[kickers[0]]} over ${RANK_NAMES_PLURAL[kickers[1]]}`, shortName: 'Full House' };
    case HandRank.Flush:
      return { name: `Flush, ${RANK_NAMES[kickers[0]]}-high`, shortName: 'Flush' };
    case HandRank.Straight:
      return { name: `Straight, ${RANK_NAMES[kickers[0]]}-high`, shortName: 'Straight' };
    case HandRank.ThreeOfAKind:
      return { name: `Three ${RANK_NAMES_PLURAL[kickers[0]]}`, shortName: 'Three of a Kind' };
    case HandRank.TwoPair:
      return { name: `Two Pair, ${RANK_NAMES_PLURAL[kickers[0]]} and ${RANK_NAMES_PLURAL[kickers[1]]}`, shortName: 'Two Pair' };
    case HandRank.OnePair:
      return { name: `Pair of ${RANK_NAMES_PLURAL[kickers[0]]}`, shortName: 'Pair' };
    case HandRank.HighCard:
      return { name: `${RANK_NAMES[kickers[0]]}-high`, shortName: 'High Card' };
    default:
      return { name: 'Unknown', shortName: 'Unknown' };
  }
}

/**
 * Evaluate the best 5-card hand from 7 cards (2 hole + 5 community).
 * Returns null if not enough valid cards.
 */
export function evaluateHand(holeCards: [number, number], communityCards: number[]): HandResult | null {
  const validCommunity = communityCards.filter(c => c !== 255 && c >= 0 && c <= 51);
  if (validCommunity.length < 3) return null; // Need at least flop

  const allCards = [...holeCards, ...validCommunity];
  if (allCards.length < 5) return null;

  // If we have fewer than 7, just evaluate what we have
  let bestScore = -1;
  let bestResult: { rank: HandRank; score: number; kickers: number[] } | null = null;

  if (allCards.length >= 7) {
    const combos = combinations5from7(allCards.slice(0, 7));
    for (const combo of combos) {
      const result = evaluate5(combo);
      if (result.score > bestScore) {
        bestScore = result.score;
        bestResult = result;
      }
    }
  } else if (allCards.length >= 5) {
    // Evaluate all C(n,5) combos
    for (let i = 0; i < allCards.length; i++)
      for (let j = i + 1; j < allCards.length; j++)
        for (let k = j + 1; k < allCards.length; k++)
          for (let l = k + 1; l < allCards.length; l++)
            for (let m = l + 1; m < allCards.length; m++) {
              const result = evaluate5([allCards[i], allCards[j], allCards[k], allCards[l], allCards[m]]);
              if (result.score > bestScore) {
                bestScore = result.score;
                bestResult = result;
              }
            }
  }

  if (!bestResult) return null;

  const { name, shortName } = buildHandName(bestResult.rank, bestResult.kickers);
  return { rank: bestResult.rank, name, shortName, score: bestResult.score };
}

/**
 * Compare two hands. Returns positive if hand1 wins, negative if hand2 wins, 0 if tie.
 */
export function compareHands(result1: HandResult, result2: HandResult): number {
  return result1.score - result2.score;
}
