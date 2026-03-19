use anchor_lang::prelude::*;

/// Maximum number of side pots (one per all-in player + main pot)
pub const MAX_SIDE_POTS: usize = 9;

/// A single pot with eligible players
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default)]
pub struct SidePot {
    /// Amount in this pot
    pub amount: u64,
    /// Contribution level to be eligible for this pot
    pub contribution_level: u64,
    /// Bitmask of eligible seat indices (bit N = seat N is eligible)
    pub eligible_seats: u16,
}

/// All pots for a hand
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct PotStructure {
    /// Main pot (everyone eligible)
    pub main_pot: u64,
    /// Side pots (created when players go all-in)
    pub side_pots: Vec<SidePot>,
    /// Total amount across all pots
    pub total: u64,
}

impl Default for PotStructure {
    fn default() -> Self {
        Self {
            main_pot: 0,
            side_pots: Vec::new(),
            total: 0,
        }
    }
}

/// Player contribution for pot calculation
#[derive(Clone, Copy, Debug)]
pub struct PlayerContribution {
    pub seat_index: u8,
    pub total_bet: u64,
    pub is_all_in: bool,
    pub is_folded: bool,
}

/// Calculate side pots from player contributions
/// Returns a list of (pot_amount, eligible_seat_indices)
pub fn calculate_side_pots(contributions: &[PlayerContribution]) -> Vec<(u64, Vec<u8>)> {
    // Filter out folded players for pot eligibility, but keep their contributions
    let active: Vec<PlayerContribution> = contributions
        .iter()
        .filter(|c| !c.is_folded)
        .copied()
        .collect();
    
    if active.is_empty() {
        return vec![];
    }
    
    // Get all unique contribution levels (all-in amounts create new levels)
    let mut levels: Vec<u64> = active
        .iter()
        .filter(|c| c.is_all_in)
        .map(|c| c.total_bet)
        .collect();
    levels.sort();
    levels.dedup();
    
    // Add the maximum contribution as final level — use ALL contributions
    // (including folded) so that folded players' excess bets are captured
    let max_contribution = contributions.iter().map(|c| c.total_bet).max().unwrap_or(0);
    if levels.is_empty() || levels.last() != Some(&max_contribution) {
        levels.push(max_contribution);
    }
    
    let mut pots: Vec<(u64, Vec<u8>)> = Vec::new();
    let mut previous_level: u64 = 0;
    
    for &level in &levels {
        if level <= previous_level {
            continue;
        }
        
        // Calculate pot at this level
        let increment = level - previous_level;
        let mut pot_amount: u64 = 0;
        let mut eligible: Vec<u8> = Vec::new();
        
        for contrib in contributions.iter() {
            // Everyone who contributed at least to the previous level adds to this pot
            let contribution_to_this_level = contrib.total_bet
                .saturating_sub(previous_level)
                .min(increment);
            
            pot_amount += contribution_to_this_level;
            
            // Player is eligible if they contributed at least to this level and aren't folded
            if contrib.total_bet >= level && !contrib.is_folded {
                eligible.push(contrib.seat_index);
            }
        }
        
        if pot_amount > 0 {
            if eligible.is_empty() {
                // No one eligible (folded players' excess) — merge into previous pot
                if let Some(last_pot) = pots.last_mut() {
                    last_pot.0 += pot_amount;
                }
            } else {
                pots.push((pot_amount, eligible));
            }
        }
        
        previous_level = level;
    }
    
    pots
}

/// Distribute winnings from multiple pots
/// Returns Vec of (seat_index, amount_won)
pub fn distribute_pots(
    pots: &[(u64, Vec<u8>)],
    winners_by_pot: &[Vec<u8>], // For each pot, which seats won (can be multiple for split)
) -> Vec<(u8, u64)> {
    let mut winnings: Vec<(u8, u64)> = Vec::new();
    
    for (i, (pot_amount, _eligible)) in pots.iter().enumerate() {
        if i >= winners_by_pot.len() {
            continue;
        }
        
        let winners = &winners_by_pot[i];
        if winners.is_empty() {
            continue;
        }
        
        // Split pot evenly among winners
        let share = pot_amount / winners.len() as u64;
        let remainder = pot_amount % winners.len() as u64;
        
        for (j, &winner_seat) in winners.iter().enumerate() {
            // First winner gets the remainder (odd chip rule)
            let win_amount = if j == 0 { share + remainder } else { share };
            
            // Add to existing winnings or create new entry
            if let Some(existing) = winnings.iter_mut().find(|(s, _)| *s == winner_seat) {
                existing.1 += win_amount;
            } else {
                winnings.push((winner_seat, win_amount));
            }
        }
    }
    
    winnings
}

/// Helper to determine winners for each pot based on hand rankings
pub fn determine_pot_winners(
    pots: &[(u64, Vec<u8>)],
    hand_rankings: &[(u8, crate::hand_eval::EvaluatedHand)], // (seat_index, hand)
) -> Vec<Vec<u8>> {
    use crate::hand_eval::determine_winners;
    
    let mut winners_by_pot: Vec<Vec<u8>> = Vec::new();
    
    for (_pot_amount, eligible) in pots.iter() {
        // Get hands of eligible players
        let eligible_hands: Vec<crate::hand_eval::EvaluatedHand> = eligible
            .iter()
            .filter_map(|&seat| {
                hand_rankings.iter().find(|(s, _)| *s == seat).map(|(_, h)| *h)
            })
            .collect();
        
        if eligible_hands.is_empty() {
            winners_by_pot.push(vec![]);
            continue;
        }
        
        // Determine winner indices within eligible hands
        let winner_indices = determine_winners(&eligible_hands);
        
        // Map back to seat indices
        let winners: Vec<u8> = winner_indices
            .iter()
            .map(|&idx| eligible[idx])
            .collect();
        
        winners_by_pot.push(winners);
    }
    
    winners_by_pot
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_no_all_in() {
        // Simple case: 2 players, equal contributions, no all-in
        let contributions = vec![
            PlayerContribution { seat_index: 0, total_bet: 100, is_all_in: false, is_folded: false },
            PlayerContribution { seat_index: 1, total_bet: 100, is_all_in: false, is_folded: false },
        ];
        
        let pots = calculate_side_pots(&contributions);
        assert_eq!(pots.len(), 1);
        assert_eq!(pots[0].0, 200); // Total pot
        assert_eq!(pots[0].1, vec![0, 1]); // Both eligible
    }

    #[test]
    fn test_one_all_in() {
        // Player 0 all-in for 50, Player 1 bets 100
        let contributions = vec![
            PlayerContribution { seat_index: 0, total_bet: 50, is_all_in: true, is_folded: false },
            PlayerContribution { seat_index: 1, total_bet: 100, is_all_in: false, is_folded: false },
        ];
        
        let pots = calculate_side_pots(&contributions);
        assert_eq!(pots.len(), 2);
        // Main pot: 50 + 50 = 100 (both eligible)
        assert_eq!(pots[0].0, 100);
        assert_eq!(pots[0].1, vec![0, 1]);
        // Side pot: 50 (only player 1 eligible)
        assert_eq!(pots[1].0, 50);
        assert_eq!(pots[1].1, vec![1]);
    }

    #[test]
    fn test_multiple_all_ins() {
        // P0: 30 all-in, P1: 70 all-in, P2: 100
        let contributions = vec![
            PlayerContribution { seat_index: 0, total_bet: 30, is_all_in: true, is_folded: false },
            PlayerContribution { seat_index: 1, total_bet: 70, is_all_in: true, is_folded: false },
            PlayerContribution { seat_index: 2, total_bet: 100, is_all_in: false, is_folded: false },
        ];
        
        let pots = calculate_side_pots(&contributions);
        assert_eq!(pots.len(), 3);
        // Main pot: 30*3 = 90 (all eligible)
        assert_eq!(pots[0].0, 90);
        assert!(pots[0].1.contains(&0) && pots[0].1.contains(&1) && pots[0].1.contains(&2));
        // Side pot 1: 40*2 = 80 (P1 and P2 eligible)
        assert_eq!(pots[1].0, 80);
        assert!(pots[1].1.contains(&1) && pots[1].1.contains(&2));
        // Side pot 2: 30 (only P2)
        assert_eq!(pots[2].0, 30);
        assert_eq!(pots[2].1, vec![2]);
    }

    #[test]
    fn test_with_fold() {
        // P0 folds with 20 bet, P1: 100, P2: 100
        let contributions = vec![
            PlayerContribution { seat_index: 0, total_bet: 20, is_all_in: false, is_folded: true },
            PlayerContribution { seat_index: 1, total_bet: 100, is_all_in: false, is_folded: false },
            PlayerContribution { seat_index: 2, total_bet: 100, is_all_in: false, is_folded: false },
        ];
        
        let pots = calculate_side_pots(&contributions);
        assert_eq!(pots.len(), 1);
        // Total: 20 + 100 + 100 = 220, only P1 and P2 eligible
        assert_eq!(pots[0].0, 220);
        assert_eq!(pots[0].1, vec![1, 2]);
    }

    #[test]
    fn test_allin_covered_by_fold() {
        // Edge case: P0 all-in for 20, P1 folded with 500 bet (blind covered the all-in)
        // P0 should win the ENTIRE pot (520) since P1 folded
        let contributions = vec![
            PlayerContribution { seat_index: 0, total_bet: 20, is_all_in: true, is_folded: false },
            PlayerContribution { seat_index: 1, total_bet: 500, is_all_in: false, is_folded: true },
        ];
        
        let pots = calculate_side_pots(&contributions);
        assert_eq!(pots.len(), 1);
        // Main pot: 20 + 20 = 40, plus folded excess 480 merged in = 520
        assert_eq!(pots[0].0, 520);
        assert_eq!(pots[0].1, vec![0]);
    }

    #[test]
    fn test_allin_with_multiple_folds() {
        // P0 all-in 50, P1 folded 200, P2 active 200
        // Pot = 50 + 200 + 200 = 450
        // Main pot (level 50): 50*3 = 150, eligible [0, 2]
        // Side pot (level 200): 150+150 = 300, eligible [2] (P1 folded)
        // But P1's excess above 50 is 150, which goes to side pot
        let contributions = vec![
            PlayerContribution { seat_index: 0, total_bet: 50, is_all_in: true, is_folded: false },
            PlayerContribution { seat_index: 1, total_bet: 200, is_all_in: false, is_folded: true },
            PlayerContribution { seat_index: 2, total_bet: 200, is_all_in: false, is_folded: false },
        ];
        
        let pots = calculate_side_pots(&contributions);
        assert_eq!(pots.len(), 2);
        // Main pot: 50*3 = 150, both P0 and P2 eligible
        assert_eq!(pots[0].0, 150);
        assert!(pots[0].1.contains(&0) && pots[0].1.contains(&2));
        // Side pot: (200-50)*2 = 300, only P2 eligible (P1 folded excess merged here)
        assert_eq!(pots[1].0, 300);
        assert_eq!(pots[1].1, vec![2]);
    }
}
