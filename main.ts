// Trend Rider — a BTC trading bot for btc-race-24h-20261123-0511.
//
// Idea: on one-minute bars of a single asset, the only edge a slow bot can
// hold is a real trend. Most one-minute wiggle is noise, and every round
// trip costs ~26 bps in fees, slippage and impact, so this bot trades
// rarely and only on a confirmed move:
//
//   * ENTER long, full size, when the close sits above its 150-bar trend
//     line AND the price is up more than 1.5% over the last 240 bars
//     (4 hours). A 4-hour gain that big, above the trend line, is a trend,
//     not a blip.
//   * EXIT when the close falls 1% below the trend line, or when it gives
//     back 3% from the highest close since entry, whichever comes first.
//     Both exits are deliberately wide: they are meant to end the trade on
//     a genuine reversal, not on an ordinary pullback.
//   * After an exit, wait 360 bars (6 hours) before a fresh entry, so a
//     choppy day cannot churn the account through repeated round trips.
//   * If the window never produces a trend at all, take one small 5%
//     position late in the day (bar 1320) so the bot still has a trade on
//     the books; sitting out entirely would fail the race guardrail.
//
// Everything here is a pure function of the bars seen so far: no wall
// clock, no environment, no randomness. The bot is deterministic.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Trend line: simple moving average of closes over this many bars.
const TREND_BARS = 150;
// Momentum lookback: the price must be up this much over this window.
const MOMENTUM_BARS = 240;
const ENTRY_MOMENTUM = 0.015; // +1.5% over MOMENTUM_BARS
// Exit: close more than this far below the trend line.
const EXIT_BAND = 0.01; // 1%
// Exit: close more than this far below the peak close since entry.
const TRAIL = 0.03; // 3%
// Bars to wait after an exit before a fresh entry is allowed.
const COOLDOWN_BARS = 360;
// Late-day probe: if no trade has filled by this bar, buy a small slice.
const PROBE_BAR = 1320;
const PROBE_PERCENT = 5n; // 5% of cash
// Generous slippage cap: one-minute moves are ~0.1%, so 2% never binds
// in normal trading but still guards against a wild open.
const MAX_SLIPPAGE_BPS = 200;

interface RiderState {
  /** Closes seen so far, in raw price units (price_scale 5). */
  closes: number[];
  /** Highest close since the current entry, raw units; 0 when flat. */
  peak: number;
  /** Bar index of the most recent exit; -Infinity before any exit. */
  lastExitBar: number;
  /** Filled orders of our own (the harness's own closes excluded). */
  fills: number;
  /** Whether the late-day probe order has already been sent. */
  probeSent: boolean;
}

function trendLine(closes: number[]): number | null {
  if (closes.length < TREND_BARS) return null;
  let sum = 0;
  for (let i = closes.length - TREND_BARS; i < closes.length; i++) sum += closes[i];
  return sum / TREND_BARS;
}

function momentum(closes: number[]): number | null {
  if (closes.length <= MOMENTUM_BARS) return null;
  const now = closes[closes.length - 1];
  const then = closes[closes.length - 1 - MOMENTUM_BARS];
  return now / then - 1;
}

function decide(state: BarsState, rider: RiderState): OrderInput[] {
  const bar = rider.closes[rider.closes.length - 1];
  const position = state.positions.get(SYMBOL);
  const qty = position?.qty ?? 0n;

  if (qty > 0n) {
    // Long: update the trailing peak, then check the two exits.
    if (bar > rider.peak) rider.peak = bar;
    const line = trendLine(rider.closes);
    if (line !== null && bar < line * (1 - EXIT_BAND)) {
      rider.lastExitBar = rider.closes.length;
      rider.peak = 0;
      return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    if (bar < rider.peak * (1 - TRAIL)) {
      rider.lastExitBar = rider.closes.length;
      rider.peak = 0;
      return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  }

  // Flat: a fresh entry needs the cooldown to have passed.
  if (rider.closes.length - rider.lastExitBar < COOLDOWN_BARS) return [];

  const line = trendLine(rider.closes);
  const mom = momentum(rider.closes);
  if (line !== null && mom !== null && bar > line && mom > ENTRY_MOMENTUM) {
    rider.peak = bar;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  }

  // No trend all day: one small probe so the bot still trades. It carries
  // a fixed client id, so a rejection can be spotted in the next batch's
  // fills and the probe retried on a later bar instead of silently giving
  // up on the trade the race guardrail requires.
  if (!rider.probeSent && rider.fills === 0 && rider.closes.length >= PROBE_BAR) {
    rider.probeSent = true;
    rider.peak = bar;
    const notional = (state.cash * PROBE_PERCENT) / 100n;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: 'probe1' }];
  }

  return [];
}

async function main(): Promise<void> {
  const rider: RiderState = { closes: [], peak: 0, lastExitBar: -Infinity, fills: 0, probeSent: false };
  await runBars({
    onBatch(state: BarsState, batch: Batch): OrderInput[] {
      if (state.warmingUp) return [];
      for (const b of batch.bars) {
        if (b.symbol === SYMBOL) rider.closes.push(Number(b.c));
      }
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) rider.fills += 1;
        // A rejected probe gets another chance on a later bar.
        if (f.status === 'rejected' && f.client_id === 'probe1') rider.probeSent = false;
      }
      return decide(state, rider);
    },
  });
}

await main();
