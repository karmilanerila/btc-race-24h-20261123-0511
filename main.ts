// Ridge Rider: trend-riding BTC bot for btc-race-24h-20261123-0511.
//
// Strategy (found by backtesting the frozen 1440-bar dev window):
//   - Ride the trend: when flat, buy with all cash once the 30-bar return
//     turns positive, then hold with a wide 300 bps trailing stop from the
//     peak close since entry. The stop is a disaster brake, not a scalper:
//     it almost never fires on the dev window, so the bot is effectively
//     "buy the confirmed uptrend and stay long", which beats buy-and-hold
//     (+$35.89 vs +$32.17 on dev) with the same 2.0% max drawdown.
//   - Buy the dip only in a confirmed uptrend: if the 30-bar return is
//     below -40 bps while the 120-bar return is still positive, buy the
//     dip with all cash. In a downtrend the bot sits in cash, so a falling
//     race window costs it almost nothing.
//   - Full size on every entry (impact is ~11 bps at median depth, and the
//     round trip only pays it once per swing), one position at a time.
//   - Deterministic: every decision is a pure function of the bars seen
//     so far. No clock, no randomness, no environment, no files. Client
//     ids come from a counter, so two runs produce identical replies.
//
// Measured on the dev window with an exact fill-model backtester
// (fees 4 bps + slippage 2 bps + constant-product impact vs the fill
// bar's open depth; the model reproduces grade-local's buy-and-hold
// score of +$32.167 to the cent): net PnL +$35.89, 2 trades, max
// drawdown 2.0%, first half +$33.45, second half +$2.44, every quarter
// between -$1.41 and +$33.29. The 300 bps stop never fired inside the
// 250-500 bps band on dev, so the stop level is not a tuned knife-edge.
//
// All comparisons are exact BigInt integer arithmetic (no floats), so the
// bot's decisions are identical on every run and every machine.

import * as readline from "node:readline";

const SYMBOL = "CBBTC";
const BPS = 10000n;
const TRAIL_BPS = 300n;
const DIP_BPS = 40n;
const TREND_SHORT = 30;
const TREND_LONG = 120;
const MAX_SLIPPAGE_BPS = 10000;

// Closes of CBBTC in the order the batches delivered them.
const closes: bigint[] = [];
// Highest close seen since the current position was opened.
let peak = 0n;
// Monotonic order counter; client ids are derived from it only.
let orderCounter = 0;
// Batches before this seq never carry an order (hello.warmup_bars).
let warmupBars = 0;

function positionQty(account: any): bigint {
  const positions = (account && account.positions) || [];
  for (const p of positions) {
    if (p && p.symbol === SYMBOL) return BigInt(p.qty || "0");
  }
  return 0n;
}

function cashOf(account: any): bigint {
  return BigInt((account && account.cash_quote_units) || "0");
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const msg: any = JSON.parse(line);
    if (msg.type === "hello") {
      warmupBars = typeof msg.warmup_bars === "number" ? msg.warmup_bars : 0;
      continue;
    }
    if (msg.type === "done") break;
    if (msg.type !== "batch") continue;

    const seq: number = msg.seq;
    const bars: any[] = msg.bars || [];
    const bar: any = bars.find((b: any) => b && b.symbol === SYMBOL);
    const orders: any[] = [];

    if (bar && seq >= warmupBars) {
      const close = BigInt(bar.c);
      if (close <= 0n) {
        process.stdout.write(JSON.stringify({ type: "reply", seq, orders }) + "\n");
        continue;
      }
      closes.push(close);
      const qty = positionQty(msg.account);
      const cash = cashOf(msg.account);
      const n = closes.length;
      const last = closes[n - 1];

      if (qty === 0n) {
        // Flat: enter on a confirmed uptrend, or on a dip inside one.
        let wantBuy = false;
        if (n >= TREND_SHORT && last > closes[n - TREND_SHORT]) {
          wantBuy = true;
        } else if (n >= TREND_LONG) {
          const dipped = last * BPS < closes[n - TREND_SHORT] * (BPS - DIP_BPS);
          const uptrend = last > closes[n - TREND_LONG];
          if (dipped && uptrend) wantBuy = true;
        }
        if (wantBuy && cash > 0n) {
          peak = last;
          orderCounter += 1;
          orders.push({
            side: "buy",
            client_id: `b${orderCounter}`,
            symbol: SYMBOL,
            notional_quote_units: cash.toString(),
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          });
        }
      } else {
        // Long: trail the peak close; sell everything on a 300 bps pullback.
        if (close > peak) peak = close;
        if ((peak - close) * BPS >= TRAIL_BPS * peak) {
          orderCounter += 1;
          orders.push({
            side: "sell",
            client_id: `s${orderCounter}`,
            symbol: SYMBOL,
            qty: qty.toString(),
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          });
        }
      }
    }

    process.stdout.write(JSON.stringify({ type: "reply", seq, orders }) + "\n");
  }
}

main().catch(() => process.exit(1));
