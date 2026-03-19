use anchor_lang::prelude::*;
use crate::state::*;
use crate::constants::*;

/// Award XP to a player — permissionless crank instruction.
/// Called by the crank after settle_hand or distribute_prizes.
/// 
/// XP Awards:
///   +10  Complete a hand (didn't fold preflop)
///   +25  Win a hand
///   +100 Win a Sit & Go (1st place)
///   +50  ITM finish in Sit & Go (2nd/3rd)
///   +15  Played a Sit & Go (any finish)
///   +20  Play 10 consecutive hands (streak bonus)
///   +50  First hand ever (welcome bonus)

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct AwardXpArgs {
    /// XP reason flags (bitfield):
    /// bit 0 = hand_complete (+10)
    /// bit 1 = hand_win (+25)
    /// bit 2 = sng_win (+100)
    /// bit 3 = sng_itm (+50)
    /// bit 4 = sng_play (+15)
    /// bit 5 = first_hand (+50)
    pub flags: u8,
}

#[derive(Accounts)]
pub struct AwardXp<'info> {
    /// Anyone can crank XP awards
    pub cranker: Signer<'info>,

    #[account(
        mut,
        seeds = [PLAYER_SEED, player.wallet.as_ref()],
        bump = player.bump,
    )]
    pub player: Account<'info, PlayerAccount>,
}

pub fn handler(ctx: Context<AwardXp>, args: AwardXpArgs) -> Result<()> {
    let player = &mut ctx.accounts.player;
    let flags = args.flags;
    let mut total_xp = 0u64;

    if flags & 0x01 != 0 {
        total_xp += XP_HAND_COMPLETE;
        // Tick streak for hand completion
        let streak_bonus = player.tick_streak();
        total_xp += streak_bonus;
        if streak_bonus > 0 {
            msg!("Streak bonus! {} hands → +{} XP", player.hand_streak, streak_bonus);
        }
    }
    if flags & 0x02 != 0 { total_xp += XP_HAND_WIN; }
    if flags & 0x04 != 0 { total_xp += XP_SNG_WIN; }
    if flags & 0x08 != 0 { total_xp += XP_SNG_ITM; }
    if flags & 0x10 != 0 { total_xp += XP_SNG_PLAY; }
    if flags & 0x20 != 0 && player.hands_played <= 1 { total_xp += XP_FIRST_HAND; }

    if total_xp > 0 {
        let new_xp = player.add_xp(total_xp);
        let level = player.level();
        msg!(
            "XP awarded: +{} → {} total (level {}), player {}",
            total_xp, new_xp, level, player.wallet
        );
    }

    Ok(())
}
