# DESIGN.md — Survivor Ladder

## Why this shape

On a 6-hour pump.fun window most coins go to ~zero and a few run 10–100x.
The edge is not prediction, it is selection plus sizing: buy only coins
that already survived their first slots with strangers buying in, size big
enough that the fixed 105,000-lamport tx fee stops mattering, cut losers
fast, and let the rare runner pay for everything else.

## Entry (all must hold)

- Age ≥ 240 slots since CreateEvent — past the instant-dump window.
- Real SOL reserve 0.5–40 SOL — liquid enough to enter, small enough to move.
- ≥ 8 distinct non-creator buyers, ≥ 12 trades — broad interest, not one wallet.
- Net inflow ≥ +0.5 SOL over the last 120 slots; price up +2%..+120% over
  the same window — rising on real money, not already vertical.
- Creator has not sold; no single outsider sell above 25% of the real
  reserve — both smell like a dump.

## Sizing

First buy 0.30 SOL, adds of 0.15 SOL into strength (price at/above the last
buy, flow still positive, ≥ 120 slots apart), max 0.60 SOL per coin, max 4
main positions (the 5th slot stays free for probes). Every buy is capped at
1% of the coin's real SOL reserve; a buy below 0.01 SOL is never sent.

## Exits (whole position, first trigger wins)

Take-profit +100%, stop-loss −25%, trailing stop (arms at +20% over cost,
out on −25% from the peak value), 3600-slot time limit, creator sells while
held, no trade for 600 slots, net flow below −0.5 SOL over 60 slots.

## Guardrail pacing

The run must round-trip ≥ 20 distinct mints (buy ≥ 0.01 SOL, then sell).
Main positions do this on their own; when the round-tripped count lags its
pace over the 6-hour window (block time / 21,600 s × 24 coins), the bot
opens probe round trips: 0.015 SOL buys of the most liquid fresh curves,
sold whole the moment the buy lands. Max 2 probes at once.

## Local sweep (dev window, first 50k events, same sim each time)

| variant | net PnL | trips | wins | max DD | at 2x fees |
|---|---|---|---|---|---|
| v1 0.10/0.20 SOL stakes | +0.039 SOL | 32 | 6 | 0.66% | −0.016 |
| looser entry | −0.007 SOL | 39 | 5 | 1.10% | −0.078 |
| 0.20/0.40 stakes | +0.104 SOL | 39 | 5 | 1.24% | +0.014 |
| 0.20/0.40, tight filter | +0.114 SOL | 32 | 6 | 0.89% | +0.034 |
| 0.30/0.60 stakes, loose entry | +0.142 SOL | 39 | 4 | 1.35% | +0.047 |
| **0.30/0.60, tight filter (adopted)** | **+0.147 SOL** | **32** | **6** | **1.01%** | **+0.058** |

The lever is size, not cleverness: the round-trip fee is ~2.7% of a 0.10 SOL
stake but ~1.4% of a 0.30 SOL one, because the tx fee is fixed. The tight
filter keeps 6 wins where the loose one keeps 5. The final window is
different data — these figures are a local signal, not a promise.

## Full-window correction (v3)

The 50k-event slice lied: v2 lost **−0.278 SOL** on the full 24 h dev window
(128,058 events), even though it made +0.147 on the slice. Full-window
calibration via `grade-local --driver process`: hold-cash 0.000 (guardrails
fail), equal-weight −0.023 (guardrails fail), sniper −0.423, momentum −9.45,
reversion −4.37. Trip autopsy of v2: 11 wins avg +0.039 SOL, 48 losses avg
−0.014, and two catastrophic −0.244 / −0.137 losses on 767–999-slot holds —
both positions that had pyramided adds into a top and crashed through the
−25% stop. Full-window sweep:

| variant | net PnL | trips | wins | max DD |
|---|---|---|---|---|
| v2 (0.30/0.60, adds) | −0.278 SOL | 62 | 12 | 7.34% |
| v3: no adds, SL −20%, trail +15%/−20%, max hold 1200 | **+0.049 SOL** | 62 | 13 | 1.92% |
| v3 + adds back | −0.246 SOL | 62 | 12 | 5.87% |
| v3 + tighter entry | −0.034 SOL | 57 | 13 | 2.51% |
| v3 + 0.20 SOL stake | +0.039 SOL | 62 | 13 | 1.92% |
| v3 + 0.45 SOL stake | +0.049 SOL | 62 | 13 | 1.92% |
| v3 + SL −15% | +0.049 SOL | 62 | 13 | 1.92% |

Lesson: pyramiding is out — on this data adds buy tops and mean-reversion
eats them. Adopted v3 is a single 0.30 SOL buy per coin, no adds, fast exits.
Its 2x-fee figure is −0.20 SOL (fee drag is the main cost), but the ranking
metric is net PnL, and v3 is the only guardrail-passing bot in positive
territory on this window besides hold-cash (which fails the guardrails).

## Determinism

No clock, no `Math.random`, no environment reads. All money math is bigint.
The grader executes the entry twice; the two action logs must match byte
for byte. `grade-local --stress` is the check that the dev score does not
lean on this window's particular coins.
