// Dip-buy bot for cbBTC on 1-minute bars (agent-fun/bars-replay/v1).
//
// Idea, in one paragraph: BTC on 1-minute bars is mostly noise (about 6 bps
// of standard deviation per minute) and a full round trip costs roughly
// 30-38 bps here, so a bot that trades every crossover bleeds to death (the
// kit's plain EMA-cross baseline lost $106 on the dev window over 68 trades,
// and a breakout-plus-EMA version of this bot lost $47 over 20 trades). This
// bot trades rarely and buys fear instead of chasing strength: it buys the
// whole cash pile only when the close prints a new low of the last 240 bars
// (a new 4-hour low) while RSI(14) is under 40, then
// exits on whichever comes first — a take-profit 1.8% above the entry close,
// a stop-loss 0.8% below it, or a trailing stop 1.0% under the best close
// since entry — and waits 60 bars after any exit before it may enter again.
// One position at a time, long only, full size, no leverage, no clock, no
// randomness: every decision is a pure function of the bars seen so far, so
// two runs on the same data answer byte for byte the same.
//
// Tuning notes (dev window, 1,440 bars, BTC $64,461 -> $64,776):
//   - The window's money is in two legs: a fast +248 bps rally (bars
//     ~480-514) and a slow +210 bps climb (bars ~574-960). A dip-buy at bar
//     364 ($64,219, just before the fast leg) rides it to $65,360 for about
//     +$14.6 gross; a second dip-buy late in the window roughly breaks even.
//   - The exit levels sit on a broad plateau, not a knife edge: take-profit
//     1.5-1.8%, trail 1.0-1.3% and stop 0.8-1.2% all land within a dollar of
//     each other on this window, and the RSI threshold anywhere from 30 to 45
//     gives the same trades (the new-low condition does the work).
//   - A downtrend guard was tried and rejected: requiring the 240-bar return
//     above -50 bps blocked the one good trade (its return then was -74 bps).
//   - Late-window fallback: if the bot has sent no order at all by bar 1380
//     (a relentless up-day with no dip to buy), it buys once anyway. The race
//     guardrail needs at least one trade, and a one-hour hold at the close
//     costs little; on the dev window this never fires (the first trade comes
//     at bar 364).

import { runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- strategy parameters (bars / basis points) ------------------------------
const LOW_BARS = 240; // lookback for the lowest low
const DIP_BPS = 0; // entry: close at or below the 240-bar low (a new 4-hour low)
const RSI_BARS = 14; // RSI lookback
const RSI_MAX = 40; // entry: RSI below this (oversold)
const TP_BPS = 180; // take-profit above the entry close
const STOP_BPS = 80; // stop-loss below the entry close
const TRAIL_BPS = 100; // trailing stop below the best close since entry
const COOLDOWN_BARS = 60; // bars to wait after an exit before a new entry
const FALLBACK_SEQ = 1380; // buy once by this bar if no order has been sent yet
const MAX_SLIPPAGE_BPS = 100; // 1% past the close the order was decided on

// --- per-symbol indicator state ---------------------------------------------
interface Series {
  closes: number[]; // closes seen, oldest first
  lows: number[]; // bar lows, same order
  last: number | null; // previous close (for RSI changes)
  first: number[]; // first RSI_BARS changes, while the averages seed
  gain: number | null; // Wilder's average gain
  loss: number | null; // Wilder's average loss
}

const series = new Map<string, Series>();

function newSeries(): Series {
  return { closes: [], lows: [], last: null, first: [], gain: null, loss: null };
}

function push(bar: Bar): Series {
  let s = series.get(bar.symbol);
  if (s === undefined) series.set(bar.symbol, (s = newSeries()));
  const c = Number(bar.c);
  s.closes.push(c);
  s.lows.push(Number(bar.l));
  if (s.closes.length > LOW_BARS) s.closes.shift();
  if (s.lows.length > LOW_BARS) s.lows.shift();
  if (s.last !== null) {
    const change = c - s.last;
    if (s.gain === null || s.loss === null) {
      s.first.push(change);
      if (s.first.length === RSI_BARS) {
        s.gain = s.first.reduce((a, x) => a + (x > 0 ? x : 0), 0) / RSI_BARS;
        s.loss = s.first.reduce((a, x) => a + (x < 0 ? -x : 0), 0) / RSI_BARS;
      }
    } else {
      s.gain = (s.gain * (RSI_BARS - 1) + (change > 0 ? change : 0)) / RSI_BARS;
      s.loss = (s.loss * (RSI_BARS - 1) + (change < 0 ? -change : 0)) / RSI_BARS;
    }
  }
  s.last = c;
  return s;
}

/** Wilder's RSI(14), or null before it seeds. 50 when nothing moved. */
function rsi(s: Series): number | null {
  if (s.gain === null || s.loss === null) return null;
  const moved = s.gain + s.loss;
  return moved === 0 ? 50 : (100 * s.gain) / moved;
}

/** Lowest low of the last LOW_BARS bars (the current bar included), or null. */
function lowestLow(s: Series): number | null {
  if (s.lows.length < LOW_BARS) return null;
  let lo = Infinity;
  for (const x of s.lows) if (x < lo) lo = x;
  return lo;
}

// --- position bookkeeping ----------------------------------------------------
let entryClose: number | null = null; // close of the bar the buy was decided on
let peakSinceEntry: number | null = null; // best close since entry
let enterAfterSeq = 0; // first batch seq a new entry is allowed on
let everOrdered = false; // whether any buy order has been sent yet

await runBars({
  onBatch(state: BarsState, batch) {
    for (const bar of batch.bars) push(bar);
    if (state.warmingUp) return [];

    const s = series.get(SYMBOL);
    if (s === undefined) return [];
    const close = state.close(SYMBOL);
    if (close === null) return [];
    const c = Number(close);
    const held = state.positions.get(SYMBOL);
    const orders: (BuyInput | SellInput)[] = [];

    if (held !== undefined) {
      if (peakSinceEntry === null || c > peakSinceEntry) peakSinceEntry = c;
      const atTp = entryClose !== null && c >= entryClose * (1 + TP_BPS / 10000);
      const atStop = entryClose !== null && c <= entryClose * (1 - STOP_BPS / 10000);
      const trailed = peakSinceEntry !== null && c <= peakSinceEntry * (1 - TRAIL_BPS / 10000);
      if (atTp || atStop || trailed) {
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        entryClose = null;
        peakSinceEntry = null;
        enterAfterSeq = batch.seq + COOLDOWN_BARS;
      }
      return orders;
    }

    // Flat: the dip-buy entry, past the cooldown.
    if (batch.seq >= enterAfterSeq) {
      const lo = lowestLow(s);
      const r = rsi(s);
      if (lo !== null && r !== null && r < RSI_MAX && c <= lo * (1 + DIP_BPS / 10000)) {
        const room = state.weightRoom(SYMBOL);
        const notional = state.cash < room ? state.cash : room;
        if (notional >= BigInt(state.hello.fees.min_notional_quote_units) && notional > 0n) {
          orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS });
          entryClose = c;
          peakSinceEntry = c;
          everOrdered = true;
          return orders;
        }
      }
    }

    // Late-window fallback: never traded all day — buy once so the race
    // guardrail (at least one trade) is met. Never fires on the dev window.
    if (!everOrdered && batch.seq >= FALLBACK_SEQ) {
      const room = state.weightRoom(SYMBOL);
      const notional = state.cash < room ? state.cash : room;
      if (notional >= BigInt(state.hello.fees.min_notional_quote_units) && notional > 0n) {
        orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS });
        entryClose = c;
        peakSinceEntry = c;
        everOrdered = true;
      }
    }
    return orders;
  },
});
