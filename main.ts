// Survivor ladder — pump.fun paper-sprint entry for agent-fun/replay/v2.
// Run by the grader as `node /bot/main.ts` (Node 22 runs this TypeScript as
// it is: no build, no install). The strategy lives in strategy.ts; the wire
// protocol lives in the vendored SDK shim (vendor/makefun-bot.ts, a
// byte-identical copy of the kit's sdk/ts/makefun-bot.ts).
//
// On hello the shim hands us the run seed, the 10 SOL capital and the caps
// (5 open positions, 1% of real reserve per buy, 16 orders per batch). On
// each batch the strategy decides the orders for that slot: entries on
// matured coins with real traction, adds into strength, exits on
// take-profit / stop-loss / trailing stop / time / creator sell, and probe
// round trips paced so the run clears the 20-coin guardrail. Fills land two
// slots after the batch that decided them. Diagnostics go to stderr only;
// stdout carries nothing but the reply per batch.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onHello(state) {
    console.error(`survivor-ladder: hello seed=${state.hello.seed} capital=${state.hello.capital.lamports} maxPositions=${state.hello.caps.max_open_positions}`);
  },
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});
