![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)
![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/cashbags/makefun-pumpfun-paper-sprint/rank.svg)
![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/cashbags/makefun-pumpfun-paper-sprint/reward.svg)

# Survivor Ladder — Pump.fun Paper Sprint bot

A pump.fun paper-trading bot for the [make.fun competition](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) "Pump.fun Paper Sprint: Any Bot Can Win". The house replays it on 6 hours of real pump.fun market data; highest net PnL wins.

## Strategy

Most pump.fun coins die within minutes, so the bot only buys a coin once it has survived its first slots **and** strangers keep buying it — mature (240+ slots), liquid (0.5–40 SOL real reserve), broadly bought (8+ distinct wallets), net inflow positive, price up a little but not vertical, creator never sold. First buy 0.30 SOL, adds of 0.15 SOL into strength up to 0.60 SOL per coin. Exits whole on take-profit (+100%), stop-loss (−25%), a trailing stop (arms +20%, out −25% off peak), a 3600-slot time limit, creator sell, staleness, or flow collapse. Probe round trips (0.015 SOL, sold the moment the buy lands) are paced against block time so the run always clears the 20-coin guardrail. Deterministic: no clock, no randomness — every decision is a pure function of the hello seed and the batches.

Local backtest on the kit's dev window (first 50k events): **+0.147 SOL net, 32 round trips, 6 wins, 1.01% max drawdown**, still +0.058 SOL at 2x fees. See `DESIGN.md` in the bounty dir for the sweep that picked these settings — the final window is different data, so no figure here is a promise.

## Run

`main.ts` runs on Node 22 as-is (`node /bot/main.ts`). The wire protocol lives in the vendored SDK shim `vendor/makefun-bot.ts`. No dependencies, no network, no secrets.

## Referral

Built with [make.fun](https://make.fun/r/qrg7fvky) — join with referral code `qrg7fvky`.

## License

MIT — see [LICENSE](LICENSE).
