use anchor_lang::prelude::*;

/// Card representation: 0-51
/// Rank: card % 13 (0=2, 1=3, ..., 8=T, 9=J, 10=Q, 11=K, 12=A)
/// Suit: card / 13 (0=clubs, 1=diamonds, 2=hearts, 3=spades)

pub const CARD_NOT_DEALT: u8 = 255;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Card {
    pub rank: u8,  // 0-12 (2-A)
    pub suit: u8,  // 0-3
}

impl Card {
    pub fn from_index(index: u8) -> Option<Self> {
        if index >= 52 {
            return None;
        }
        Some(Card {
            rank: index % 13,
            suit: index / 13,
        })
    }
    
    pub fn to_index(&self) -> u8 {
        self.suit * 13 + self.rank
    }
}

/// Hand rankings from lowest to highest
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, AnchorSerialize, AnchorDeserialize)]
#[repr(u8)]
pub enum HandRank {
    HighCard = 0,
    Pair = 1,
    TwoPair = 2,
    ThreeOfAKind = 3,
    Straight = 4,
    Flush = 5,
    FullHouse = 6,
    FourOfAKind = 7,
    StraightFlush = 8,
    RoyalFlush = 9,
}

impl HandRank {
    pub fn from_u8(val: u8) -> Self {
        match val {
            0 => HandRank::HighCard,
            1 => HandRank::Pair,
            2 => HandRank::TwoPair,
            3 => HandRank::ThreeOfAKind,
            4 => HandRank::Straight,
            5 => HandRank::Flush,
            6 => HandRank::FullHouse,
            7 => HandRank::FourOfAKind,
            8 => HandRank::StraightFlush,
            9 => HandRank::RoyalFlush,
            _ => HandRank::HighCard,
        }
    }
}

/// Evaluated hand with rank and kickers for comparison
#[derive(Clone, Copy, PartialEq, Eq, Debug, AnchorSerialize, AnchorDeserialize)]
pub struct EvaluatedHand {
    pub rank: HandRank,
    /// Primary value (e.g., rank of pair, high card of straight)
    pub primary: u8,
    /// Secondary value (e.g., rank of second pair in two pair)
    pub secondary: u8,
    /// Kickers for tiebreaking (sorted high to low)
    pub kickers: [u8; 5],
}

impl EvaluatedHand {
    /// Create from a simple score (for settle instruction)
    /// Score format: rank(4 bits) + primary(4 bits) + secondary(4 bits) + kicker1-5(4 bits each) = 32 bits
    pub fn from_score(score: u32) -> Self {
        Self {
            rank: HandRank::from_u8(((score >> 28) & 0xF) as u8),
            primary: ((score >> 24) & 0xF) as u8,
            secondary: ((score >> 20) & 0xF) as u8,
            kickers: [
                ((score >> 16) & 0xF) as u8,
                ((score >> 12) & 0xF) as u8,
                ((score >> 8) & 0xF) as u8,
                ((score >> 4) & 0xF) as u8,
                (score & 0xF) as u8,
            ],
        }
    }
    
    /// Convert to a numeric score for easy comparison (higher = better)
    pub fn to_score(&self) -> u32 {
        let rank_val = self.rank as u32;
        // Build score: rank (most significant) + primary + secondary + kickers
        (rank_val << 28) | 
        ((self.primary as u32) << 24) |
        ((self.secondary as u32) << 20) |
        ((self.kickers[0] as u32) << 16) |
        ((self.kickers[1] as u32) << 12) |
        ((self.kickers[2] as u32) << 8) |
        ((self.kickers[3] as u32) << 4) |
        (self.kickers[4] as u32)
    }
    
    /// Compare two hands. Returns Ordering.
    pub fn compare(&self, other: &EvaluatedHand) -> std::cmp::Ordering {
        // Compare rank first
        match self.rank.cmp(&other.rank) {
            std::cmp::Ordering::Equal => {}
            ord => return ord,
        }
        
        // Compare primary value
        match self.primary.cmp(&other.primary) {
            std::cmp::Ordering::Equal => {}
            ord => return ord,
        }
        
        // Compare secondary value
        match self.secondary.cmp(&other.secondary) {
            std::cmp::Ordering::Equal => {}
            ord => return ord,
        }
        
        // Compare kickers
        for i in 0..5 {
            match self.kickers[i].cmp(&other.kickers[i]) {
                std::cmp::Ordering::Equal => continue,
                ord => return ord,
            }
        }
        
        std::cmp::Ordering::Equal
    }
}

/// Evaluate the best 5-card hand from 7 cards (2 hole + 5 community)
pub fn evaluate_hand(hole_cards: [u8; 2], community_cards: [u8; 5]) -> EvaluatedHand {
    // Collect all valid cards
    let mut cards: Vec<Card> = Vec::with_capacity(7);
    
    for &c in hole_cards.iter() {
        if let Some(card) = Card::from_index(c) {
            cards.push(card);
        }
    }
    
    for &c in community_cards.iter() {
        if c != CARD_NOT_DEALT {
            if let Some(card) = Card::from_index(c) {
                cards.push(card);
            }
        }
    }
    
    if cards.len() < 5 {
        return EvaluatedHand {
            rank: HandRank::HighCard,
            primary: 0,
            secondary: 0,
            kickers: [0; 5],
        };
    }
    
    // Try all 21 combinations of 5 cards from 7
    let mut best_hand: Option<EvaluatedHand> = None;
    
    let n = cards.len();
    for i in 0..n {
        for j in (i + 1)..n {
            for k in (j + 1)..n {
                for l in (k + 1)..n {
                    for m in (l + 1)..n {
                        let five = [cards[i], cards[j], cards[k], cards[l], cards[m]];
                        let hand = evaluate_five_cards(five);
                        
                        match &best_hand {
                            None => best_hand = Some(hand),
                            Some(best) => {
                                if hand.compare(best) == std::cmp::Ordering::Greater {
                                    best_hand = Some(hand);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    
    best_hand.unwrap_or(EvaluatedHand {
        rank: HandRank::HighCard,
        primary: 0,
        secondary: 0,
        kickers: [0; 5],
    })
}

/// Evaluate exactly 5 cards
fn evaluate_five_cards(cards: [Card; 5]) -> EvaluatedHand {
    let mut ranks: [u8; 5] = cards.map(|c| c.rank);
    ranks.sort_by(|a, b| b.cmp(a)); // Sort descending
    
    let is_flush = cards.iter().all(|c| c.suit == cards[0].suit);
    let is_straight = check_straight(&ranks);
    let is_wheel = check_wheel(&ranks); // A-2-3-4-5
    
    // Count rank occurrences
    let mut rank_counts: [u8; 13] = [0; 13];
    for &r in &ranks {
        rank_counts[r as usize] += 1;
    }
    
    // Find pairs, trips, quads
    let mut quads: Option<u8> = None;
    let mut trips: Option<u8> = None;
    let mut pairs: Vec<u8> = Vec::new();
    
    for r in (0..13).rev() {
        match rank_counts[r] {
            4 => quads = Some(r as u8),
            3 => trips = Some(r as u8),
            2 => pairs.push(r as u8),
            _ => {}
        }
    }
    
    // Determine hand rank
    if is_flush && (is_straight || is_wheel) {
        if ranks[0] == 12 && ranks[1] == 11 { // A-K-Q-J-T
            return EvaluatedHand {
                rank: HandRank::RoyalFlush,
                primary: 12,
                secondary: 0,
                kickers: ranks,
            };
        }
        return EvaluatedHand {
            rank: HandRank::StraightFlush,
            primary: if is_wheel { 3 } else { ranks[0] }, // Wheel high card is 5 (rank 3)
            secondary: 0,
            kickers: ranks,
        };
    }
    
    if let Some(quad_rank) = quads {
        let kicker = ranks.iter().find(|&&r| r != quad_rank).copied().unwrap_or(0);
        return EvaluatedHand {
            rank: HandRank::FourOfAKind,
            primary: quad_rank,
            secondary: kicker,
            kickers: ranks,
        };
    }
    
    if let Some(trip_rank) = trips {
        if !pairs.is_empty() {
            return EvaluatedHand {
                rank: HandRank::FullHouse,
                primary: trip_rank,
                secondary: pairs[0],
                kickers: ranks,
            };
        }
    }
    
    if is_flush {
        return EvaluatedHand {
            rank: HandRank::Flush,
            primary: ranks[0],
            secondary: 0,
            kickers: ranks,
        };
    }
    
    if is_straight || is_wheel {
        return EvaluatedHand {
            rank: HandRank::Straight,
            primary: if is_wheel { 3 } else { ranks[0] },
            secondary: 0,
            kickers: ranks,
        };
    }
    
    if let Some(trip_rank) = trips {
        let kickers: Vec<u8> = ranks.iter().filter(|&&r| r != trip_rank).copied().collect();
        return EvaluatedHand {
            rank: HandRank::ThreeOfAKind,
            primary: trip_rank,
            secondary: 0,
            kickers: [trip_rank, trip_rank, trip_rank, kickers.get(0).copied().unwrap_or(0), kickers.get(1).copied().unwrap_or(0)],
        };
    }
    
    if pairs.len() >= 2 {
        let high_pair = pairs[0];
        let low_pair = pairs[1];
        let kicker = ranks.iter().find(|&&r| r != high_pair && r != low_pair).copied().unwrap_or(0);
        return EvaluatedHand {
            rank: HandRank::TwoPair,
            primary: high_pair,
            secondary: low_pair,
            kickers: [high_pair, high_pair, low_pair, low_pair, kicker],
        };
    }
    
    if pairs.len() == 1 {
        let pair_rank = pairs[0];
        let kickers: Vec<u8> = ranks.iter().filter(|&&r| r != pair_rank).copied().collect();
        return EvaluatedHand {
            rank: HandRank::Pair,
            primary: pair_rank,
            secondary: 0,
            kickers: [pair_rank, pair_rank, kickers.get(0).copied().unwrap_or(0), kickers.get(1).copied().unwrap_or(0), kickers.get(2).copied().unwrap_or(0)],
        };
    }
    
    // High card
    EvaluatedHand {
        rank: HandRank::HighCard,
        primary: ranks[0],
        secondary: 0,
        kickers: ranks,
    }
}

fn check_straight(ranks: &[u8; 5]) -> bool {
    // Ranks are sorted descending
    for i in 0..4 {
        if ranks[i] != ranks[i + 1] + 1 {
            return false;
        }
    }
    true
}

fn check_wheel(ranks: &[u8; 5]) -> bool {
    // A-2-3-4-5 (wheel) = ranks [12, 3, 2, 1, 0] when sorted desc
    ranks == &[12, 3, 2, 1, 0]
}

/// Determine winner(s) from multiple hands
/// Returns indices of winning players (can be multiple for split pot)
pub fn determine_winners(hands: &[EvaluatedHand]) -> Vec<usize> {
    if hands.is_empty() {
        return vec![];
    }
    
    let mut best_indices: Vec<usize> = vec![0];
    let mut best_hand = &hands[0];
    
    for (i, hand) in hands.iter().enumerate().skip(1) {
        match hand.compare(best_hand) {
            std::cmp::Ordering::Greater => {
                best_hand = hand;
                best_indices = vec![i];
            }
            std::cmp::Ordering::Equal => {
                best_indices.push(i);
            }
            std::cmp::Ordering::Less => {}
        }
    }
    
    best_indices
}

/// Get human-readable hand description
pub fn hand_description(hand: &EvaluatedHand) -> &'static str {
    match hand.rank {
        HandRank::RoyalFlush => "Royal Flush",
        HandRank::StraightFlush => "Straight Flush",
        HandRank::FourOfAKind => "Four of a Kind",
        HandRank::FullHouse => "Full House",
        HandRank::Flush => "Flush",
        HandRank::Straight => "Straight",
        HandRank::ThreeOfAKind => "Three of a Kind",
        HandRank::TwoPair => "Two Pair",
        HandRank::Pair => "Pair",
        HandRank::HighCard => "High Card",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_royal_flush() {
        // As Ks + Qs Js Ts 2c 3c
        let hole = [12, 11]; // As, Ks (rank 12, 11 in spades = 39+12, 39+11)
        // Actually: As = suit 3, rank 12 = 3*13+12 = 51
        // Ks = suit 3, rank 11 = 3*13+11 = 50
        let hole = [51, 50];
        let community = [49, 48, 47, 1, 2]; // Qs, Js, Ts, 3c, 4c
        let hand = evaluate_hand(hole, community);
        assert_eq!(hand.rank, HandRank::RoyalFlush);
    }
    
    #[test]
    fn test_pair() {
        // Ah Ac + Kd Qd Jd 2c 3c
        let hole = [12 + 26, 12]; // Ah, Ac
        let community = [11 + 13, 10 + 13, 9 + 13, 1, 2];
        let hand = evaluate_hand(hole, community);
        assert_eq!(hand.rank, HandRank::Pair);
        assert_eq!(hand.primary, 12); // Aces
    }
    
    #[test]
    fn test_straight() {
        // 5h 6h + 7d 8d 9c Ac Kc
        let hole = [3 + 26, 4 + 26]; // 5h, 6h
        let community = [5 + 13, 6 + 13, 7, 12, 11];
        let hand = evaluate_hand(hole, community);
        assert_eq!(hand.rank, HandRank::Straight);
    }
}
