# Legacy Test Files

These test files reference the removed `devnet_bypass_deal` / `devnet_bypass_reveal` instructions
(plaintext mock deal — removed as a security hole). They are kept for reference but **will not run**.

To port: replace `devnet_bypass_deal` with `arcium_deal` + MPC callback polling.
See `e2e-arcium-multimax.ts` for the working pattern.

## Files

| File | Original Purpose |
|------|-----------------|
| `e2e-mock-streets.ts` | Full street flow (preflop→river) + all-in preflop |
| `e2e-full-game.ts` | SNG + Cash games + Dealer crank payments |
| `test-crank-local.ts` | Comprehensive crank lifecycle + edge cases |
| `e2e-security-tests.ts` | 10 security vectors (card privacy, gap griefing, etc.) |
| `stress-test-crank.ts` | Multi-table parallel crank stress test |
