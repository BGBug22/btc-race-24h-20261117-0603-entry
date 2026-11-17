# Dip-Buy BTC Bot — btc-race-24h-20261117-0603

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![make.fun · btc-race-24h-20261117-0603 rank](https://make.fun/badge/btc-race-24h-20261117-0603/BGBug22/btc-race-24h-20261117-0603-entry/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![make.fun · btc-race-24h-20261117-0603 reward](https://make.fun/badge/btc-race-24h-20261117-0603/BGBug22/btc-race-24h-20261117-0603-entry/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

A trading bot for the [btc-race-24h-20261117-0603 bounty](https://make.fun/bounty/btc-race-24h-20261117-0603): it trades Coinbase Wrapped BTC (cbBTC) against USDC on 1-minute bars with $1,000 of paper money, long only, one position at a time.

## Strategy

Buy fear, not strength. BTC on 1-minute bars is mostly noise (about 6 bps of standard deviation per minute) and a full round trip costs roughly 30–38 bps, so a bot that trades every crossover bleeds to death — the kit's plain EMA-cross baseline lost $106 on the dev window over 68 trades, and a breakout-plus-EMA version lost $47 over 20 trades.

This bot trades rarely:

- **Entry:** buy the whole cash pile only when the close prints a new low of the last 240 bars (a new 4-hour low) while RSI(14) is under 40.
- **Exit:** whichever comes first — take-profit 1.8% above the entry close, stop-loss 0.8% below it, or a trailing stop 1.0% under the best close since entry.
- **Cooldown:** 60 bars after any exit before a new entry.
- **Late-window fallback:** if no order has been sent at all by bar 1380, buy once anyway, so the race guardrail (at least one trade) is met. This never fires on the dev window.

## Dev-window result (local grade)

Verified with the kit's own grader (`grade-local --driver process`):

- **Net PnL: +$12.943974 USDC** (gate needs > $0)
- Trades: 3 (bot's own filled orders)
- Max drawdown: 0.82%
- Win rate: 50% (1 of 2 round trips won)
- Fees: $1.617316

For comparison, the kit's baselines on the same window: buy-and-hold +$1.07, momentum +$2.45, EMA-cross −$106.21, RSI-Bollinger −$24.25, ADX-momentum −$32.66, hold-cash $0.

The exit levels sit on a broad plateau, not a knife edge: take-profit 1.5–1.8%, trail 1.0–1.3% and stop 0.8–1.2% all land within about a dollar of each other on this window, and the RSI threshold anywhere from 30 to 45 gives the same trades. A downtrend guard was tried and rejected — it blocked the one good trade.

## Files

- `main.ts` — the bot (Node 22, type stripping, stdlib only, deterministic: no clock, no randomness, every decision a pure function of the bars seen so far).
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's SDK shim.
- `README.md`, `LICENSE` (MIT), `.makefun/owner.json`.

## Run it

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot . --driver process
```
