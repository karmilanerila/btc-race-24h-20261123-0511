# Trend Rider — BTC trading bot

[![make.fun](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)
[![Rank](https://make.fun/badge/btc-race-24h-20261123-0511/karmilanerila/btc-race-24h-20261123-0511/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)
[![Reward](https://make.fun/badge/btc-race-24h-20261123-0511/karmilanerila/btc-race-24h-20261123-0511/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)

Entry for `btc-race-24h-20261123-0511` ("Race a BTC trading bot live for 24 hours").

## Strategy

A slow trend-follower on 1-minute CBBTC/USDC bars. One-minute wiggle is
mostly noise and every round trip costs ~26 bps, so the bot trades rarely
and only on a confirmed move:

- **Enter long, full size**, when the close is above its 150-bar trend line
  (simple moving average) **and** the price is up more than 1.5% over the
  last 240 bars (4 hours).
- **Exit** when the close falls 1% below the trend line, or 3% below the
  highest close since entry — whichever comes first. Both exits are wide on
  purpose: they end the trade on a genuine reversal, not a pullback.
- **Cooldown:** after an exit, wait 360 bars (6 hours) before a fresh
  entry, so a choppy day cannot churn the account.
- **Late-day probe:** if no trade has filled by bar 1320, buy a small 5%
  position so the bot still has a trade on the books (the race guardrail
  requires at least one). The probe is retried on later bars if rejected.

The bot is a pure function of the bars seen so far: no wall clock, no
environment, no randomness — fully deterministic.

## Local verification (dev window)

```
node cli/makefun.mjs grade-local --kit <kit> --bot . --driver process --worktree
```

- Dev net PnL: **+$19.73** (1 trade, max drawdown 1.98%)
- Per-half dev PnL: first half +$17.31, second half +$2.42
- Two grade-local runs reproduce byte for byte (deterministic).

## Layout

- `main.ts` — the bot (Node 22, TypeScript, stdlib only via the kit shim)
- `vendor/makefun-bars.ts` — the kit SDK shim, copied byte for byte
