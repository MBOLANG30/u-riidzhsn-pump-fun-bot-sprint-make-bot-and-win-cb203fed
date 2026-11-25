# u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/MBOLANG30/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/MBOLANG30/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

Flush-fade reversal paper bot for make.fun's "Pump.fun Bot Sprint: Make Bot And Win" bounty.

## Strategy

Flush-fade reversal paper bot. The flush is measured on the real-reserve ratio (real SOL / real tokens), a cumulative net-flow series: the trade (virtual) price whipsaws on single big trades, so a cliff measured on it fires on noise, while the real ratio moves only with sustained net flow. Buy only while a coin's ratio is at least 45% below where it stood at the start of a 30-slot window, has already bounced at least 10% off its window low, and shows more than 1 SOL of net buying since that low. Only young coins (age ≤ 3600 slots) with a real SOL reserve of 10–60 SOL qualify, with a 400-slot re-entry cooldown and at most 5 open positions. Stake is min(0.3 SOL, 0.95% of real reserve).

Exits: scale out half at +20%, take profit on the rest at +50%, stop-loss at −7%, trailing stop (arms at +10%, trails 3%), and a 100-slot time stop. If entries run scarce late in the window, the cliff relaxes in steps (20% / 3%, then 15% / 2%) once 700 / 1000 mints have been seen with few entries.

Dev grade (kit's frozen dev window, `grade-local --driver process`): net PnL **+0.0033 SOL**, 46 coins, 58 round trips, 36% win rate, 2.5% max drawdown. The edge is thin — the 90% interval spans zero — and the final window is different data, so this is a lottery ticket, like the original entry.

## How it runs

The bot speaks the `agent-fun/replay/v2` protocol on stdin/stdout (`main.ts` owns the wire loop; `strategy.ts` holds the decision logic). It is fully deterministic — no clock, no randomness, no environment reads — so two runs on the same replay tape produce identical action logs.

## Files

- `main.ts` — protocol wire loop and order sizing
- `strategy.ts` — flush-fade reversal logic
- `package.json` — module marker (no dependencies)

## License

MIT — see `LICENSE`.
