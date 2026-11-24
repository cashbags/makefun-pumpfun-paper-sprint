// Survivor ladder — a pump.fun replay bot for agent-fun/replay/v2.
//
// Idea, in one line: most pump.fun coins die within minutes, so only buy a coin
// once it has survived its first slots AND strangers keep buying it, then let
// the winners run with a trailing stop and cut the rest fast.
//
// The bot watches every curve from its CreateEvent. A coin earns its first buy
// only when it is mature (age >= minAge slots), liquid enough for a meaningful
// order (real SOL inside [minRqSol, maxRqSol]), broadly bought (at least
// minBuyers distinct non-creator wallets, at least minTrades trades), still
// attracting money (net SOL inflow over the last flowWindow slots), and up a
// little but not already vertical (price up minUpBps..maxUpBps over the window).
// The creator must not have sold, and no single outsider sell may have taken
// more than maxBigSellBps of the real reserve: both smell like a dump.
//
// Size is deliberately small at first (firstBuy) and only grows into strength:
// an add (addBuy) needs the price at or above the last buy's decision price,
// positive flow still, and addDelay slots since the last buy, up to maxStake
// per coin. A position exits whole on the first of: take-profit (tpBps over
// cost), stop-loss (slBps under cost), a trailing stop (once up trailArmBps,
// out on a trailBps fall from the peak value), a time limit (maxHold slots),
// the creator selling while held, no trade for staleSlots slots, or the
// recent flow collapsing (exitFlowSol over exitFlowWindow slots).
//
// Guardrail pacing: the run must round-trip at least targetCoins distinct
// mints (a buy of at least minRoundTrip, then a sell). Main positions do this
// on their own, but when the round-tripped count lags its pace over the
// 6-hour window (paceSecs of block time), the bot opens probe round trips:
// a probeSol buy of the most liquid fresh curve, sold whole the moment the
// buy lands. Probes are capped (maxProbes at once) and never touch a coin a
// main position already holds.
//
// Deterministic by construction: no clock, no Math.random, no environment.
// Every decision is a pure function of the hello seed/caps and the batches
// fed in, iterated over insertion-ordered maps. All money math is bigint;
// floats appear nowhere in a decision.

import {
  BPS,
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

export interface Params {
  /** Slots since the CreateEvent before a first buy is allowed. */
  minAge: number;
  /** Real SOL reserve window at entry (lamports). */
  minRqLamports: number;
  maxRqLamports: number;
  /** Distinct non-creator buyers and trades seen before entry. */
  minBuyers: number;
  minTrades: number;
  /** Entry flow window (slots) and the net inflow it must show (lamports). */
  flowWindow: number;
  minFlowLamports: number;
  /** Price rise over the flow window, in bps: entry needs it inside this band. */
  minUpBps: number;
  maxUpBps: number;
  /** Largest single outsider sell, as bps of the real reserve before it. */
  maxBigSellBps: number;
  /** Skip a coin whose creator sold before entry. */
  skipDevSold: boolean;
  /** First buy, each add, and the most one coin ever holds (lamports). */
  firstBuyLamports: number;
  addBuyLamports: number;
  maxStakeLamports: number;
  /** Most adds after the first buy, and slots to wait between buys. */
  maxAdds: number;
  addDelay: number;
  /** Smallest buy worth paying the tx fee for; also the guardrail's floor. */
  minBuyLamports: number;
  /** Slippage allowed on buys / sells (bps). */
  buySlippageBps: number;
  sellSlippageBps: number;
  /** Exit: take-profit / stop-loss, as bps over / under cost. */
  tpBps: number;
  slBps: number;
  /** Trailing stop: arms at trailArmBps over cost, exits on trailBps off the peak. */
  trailArmBps: number;
  trailBps: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Exit when net flow over exitFlowWindow slots falls below this (lamports). */
  exitFlowWindow: number;
  exitFlowLamports: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Most main positions open at once (the rest of the 5-slot cap is for probes). */
  maxMain: number;
  /** Guardrail: distinct round-tripped coins to reach over paceSecs of block time. */
  targetCoins: number;
  paceSecs: number;
  /** Probe round trip size (lamports) and most probes in flight at once. */
  probeLamports: number;
  maxProbes: number;
}

/** v3 settings: v2 lost -0.278 SOL on the FULL dev window (128k events, 24 h)
 *  even though it made +0.147 on the first 50k-event slice — the slice lied.
 *  Full-window calibration: hold-cash 0.000 (guardrails fail), equal-weight
 *  -0.023 (guardrails fail), sniper -0.423, momentum -9.45, reversion -4.37.
 *  Trip autopsy of v2 (59 trips): 11 wins avg +0.039, 48 losses avg -0.014,
 *  and two catastrophic -0.244 / -0.137 losses on 767–999-slot holds — both
 *  positions that had pyramided adds into a top and then crashed through the
 *  -25% stop. Sweep on the full window: no-adds + tighter exits + 1200-slot
 *  max hold = +0.049 (13 wins, dd 1.92%); adds back = -0.246, so pyramiding
 *  is OUT — on this data adds buy tops and mean-reversion eats them. Tighter
 *  entry -0.034, 0.20 SOL stake +0.039, 0.45 SOL stake +0.049 (the 1% reserve
 *  cap binds, so wants above 0.30 change nothing), SL -15% identical. Adopted
 *  v3: single 0.30 SOL buy per coin, no adds, SL -20%, trail arms +15% /
 *  exits -20% off peak, 1200-slot max hold. Net +0.049 SOL, 13 wins, 62 trips,
 *  drawdown 1.92%, still -0.20 at 2x fees (fee drag is the main cost — the
 *  ranking metric is net PnL, and no variant here is fee-proof). The final
 *  window is different data; no figure here is a promise. */
export const DEFAULT_PARAMS: Params = {
  minAge: 240,
  minRqLamports: 500_000_000,
  maxRqLamports: 40_000_000_000,
  minBuyers: 8,
  minTrades: 12,
  flowWindow: 120,
  minFlowLamports: 500_000_000,
  minUpBps: 200,
  maxUpBps: 12000,
  maxBigSellBps: 2500,
  skipDevSold: true,
  firstBuyLamports: 300_000_000,
  addBuyLamports: 150_000_000,
  maxStakeLamports: 300_000_000,
  maxAdds: 0,
  addDelay: 120,
  minBuyLamports: 10_000_000,
  buySlippageBps: 1500,
  sellSlippageBps: 10000,
  tpBps: 10000,
  slBps: 2000,
  trailArmBps: 1500,
  trailBps: 2000,
  maxHold: 1200,
  staleSlots: 600,
  exitFlowWindow: 60,
  exitFlowLamports: -500_000_000,
  exitOnDevSell: true,
  maxMain: 4,
  targetCoins: 24,
  paceSecs: 21600,
  probeLamports: 15_000_000,
  maxProbes: 2,
};

const SOL = LAMPORTS_PER_SOL;
/** Curve fees on a trade: protocol 95 bps + creator 30 bps. */
const FEE_BPS = 125n;

interface TradeTick {
  slot: number;
  buy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface PriceSample {
  slot: number;
  vq: bigint;
  vt: bigint;
}

/** Everything remembered about one curve. */
interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** Reserves at creation: the run-up is measured against these. */
  vq0: bigint;
  vt0: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  recent: TradeTick[];
  prices: PriceSample[];
  buysSent: number;
  spentSent: bigint;
  lastBuyVq: bigint;
  lastBuyVt: bigint;
  lastBuySlot: number;
  entries: number;
  lastExitSlot: number;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  /** Lamports sent in buys for this position (quote only, fees aside). */
  invested: bigint;
  /** Best close value seen (lamports, tx fee deducted). */
  best: bigint;
  /** The creator had already sold when the position opened. */
  devSoldAtOpen: boolean;
}

/** What selling `tokens` against reserves (vq, vt) pays after curve fees. */
export function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const out = (tokens * vq) / (vt + tokens);
  return out - (out * FEE_BPS + BPS - 1n) / BPS;
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Strategy {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight: false while the buy is pending, true while selling. */
  const probes = new Map<Pubkey, boolean>();
  /** Mints whose buy filled at >= minBuyLamports and whose own sell filled after. */
  const roundTripped = new Set<Pubkey>();
  const boughtBig = new Set<Pubkey>();
  let firstTime: number | null = null;
  let nowTime = 0;

  function tapeOf(mint: Pubkey): Coin {
    let c = coins.get(mint);
    if (c === undefined) {
      c = {
        mint,
        createSlot: -1,
        creator: '',
        vq0: 0n,
        vt0: 1n,
        trades: 0,
        buyers: new Set(),
        bought: 0n,
        soldByOthers: 0n,
        bigSellBps: 0n,
        devSold: false,
        lastTradeSlot: -1,
        recent: [],
        prices: [],
        buysSent: 0,
        spentSent: 0n,
        lastBuyVq: 0n,
        lastBuyVt: 1n,
        lastBuySlot: 0,
        entries: 0,
        lastExitSlot: -1_000_000_000,
        done: false,
        complete: false,
      };
      coins.set(mint, c);
    }
    return c;
  }

  /** Fold this batch's events into the tapes. */
  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstTime === null) firstTime = e.block_time;
        if (e.block_time > nowTime) nowTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        const c = tapeOf(e.mint);
        c.createSlot = e.slot;
        c.creator = e.creator;
        c.vq0 = BigInt(e.virtual_quote_reserves);
        c.vt0 = BigInt(e.virtual_token_reserves);
        c.lastTradeSlot = e.slot;
        c.prices.push({ slot: e.slot, vq: c.vq0, vt: c.vt0 });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        c.recent.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user });
        c.prices.push({ slot: e.slot, vq: BigInt(e.virtual_quote_reserves), vt: BigInt(e.virtual_token_reserves) });
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
          const reserveBefore = BigInt(e.real_quote_reserves) + sol;
          if (reserveBefore > 0n) {
            const bps = (sol * BPS) / reserveBefore;
            if (bps > c.bigSellBps) c.bigSellBps = bps;
          }
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  /** Net lamports bought minus sold, and distinct buyers, over the last `w` slots. */
  function flow(c: Coin, slot: number, w: number): { net: bigint; buyers: number } {
    const from = slot - w;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0n;
    const buyers = new Set<Pubkey>();
    for (const t of c.recent) {
      if (t.buy) {
        net += t.sol;
        if (t.user !== c.creator) buyers.add(t.user);
      } else {
        net -= t.sol;
      }
    }
    return { net, buyers: buyers.size };
  }

  /** Price rise over the last `w` slots, in bps, from the oldest sample in range. */
  function riseBps(c: Coin, slot: number, w: number): bigint | null {
    const from = slot - w;
    let drop = 0;
    while (drop < c.prices.length && c.prices[drop]!.slot <= from) drop++;
    if (drop > 0) c.prices.splice(0, drop);
    if (c.prices.length < 2) return null;
    const first = c.prices[0]!;
    const last = c.prices[c.prices.length - 1]!;
    if (first.vq <= 0n || first.vt <= 0n || last.vt <= 0n) return null;
    // (last.vq/last.vt) / (first.vq/first.vt) - 1, in bps.
    const num = last.vq * first.vt;
    const den = last.vt * first.vq;
    if (den <= 0n) return null;
    return (num * BPS) / den - BPS;
  }

  function hasPending(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
    for (const po of state.pending.values()) {
      if (po.order.mint === mint && po.order.side === side) return true;
    }
    return false;
  }

  function entrySignal(c: Coin, slot: number, rq: bigint): boolean {
    if (c.createSlot < 0 || slot - c.createSlot < p.minAge) return false;
    if (rq < BigInt(p.minRqLamports) || rq > BigInt(p.maxRqLamports)) return false;
    if (c.buyers.size < p.minBuyers || c.trades < p.minTrades) return false;
    if (p.skipDevSold && c.devSold) return false;
    if (c.bigSellBps > BigInt(p.maxBigSellBps)) return false;
    const fl = flow(c, slot, p.flowWindow);
    if (fl.net < BigInt(p.minFlowLamports)) return false;
    const up = riseBps(c, slot, p.flowWindow);
    if (up === null) return false;
    if (up < BigInt(p.minUpBps) || up > BigInt(p.maxUpBps)) return false;
    return true;
  }

  return {
    onBatch(state, batch) {
      readEvents(batch);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint; rq: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, {
          vq: BigInt(m.virtual_quote_reserves),
          vt: BigInt(m.virtual_token_reserves),
          rq: BigInt(m.real_quote_reserves),
        });
      }

      // Fills: track round trips, drop held state the replay already closed.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          probes.delete(f.mint);
          continue;
        }
        if (f.status !== 'filled') continue;
        if (f.side === 'buy' && BigInt(f.quote_lamports) >= BigInt(p.minBuyLamports)) {
          boughtBig.add(f.mint);
        }
        if (f.side === 'sell' && boughtBig.has(f.mint)) roundTripped.add(f.mint);
      }
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !hasPending(state, mint, 'buy') && !hasPending(state, mint, 'sell')) {
          held.delete(mint);
        }
      }
      for (const mint of [...probes.keys()]) {
        if (!state.positions.has(mint) && !hasPending(state, mint, 'buy') && !hasPending(state, mint, 'sell')) {
          probes.delete(mint);
        }
      }

      const reservesOf = (mint: Pubkey): { vq: bigint; vt: bigint; rq: bigint } | null => {
        const mk = marks.get(mint);
        if (mk !== undefined) return mk;
        const cv = state.curves.get(mint);
        if (cv === undefined) return null;
        return { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves, rq: cv.real_quote_reserves };
      };

      // Exits first: every held main position, whole, on the first trigger.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (probes.has(mint)) continue;
        if (hasPending(state, mint, 'sell')) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, invested: BigInt(pos.cost_lamports), best: 0n, devSoldAtOpen: c?.devSold ?? false };
          held.set(mint, h);
        }
        const res = reservesOf(mint);
        if (res === null) continue;
        const value = sellValue(BigInt(pos.token_amount), res.vq, res.vt) - tx;
        const basis = BigInt(pos.cost_lamports);
        if (value > h.best) h.best = value;
        let exit = false;
        if (basis > 0n) {
          if (value * BPS >= basis * (BPS + BigInt(p.tpBps))) exit = true;
          if (value * BPS <= basis * (BPS - BigInt(p.slBps))) exit = true;
          if (h.best * BPS >= basis * (BPS + BigInt(p.trailArmBps)) && value * BPS <= h.best * (BPS - BigInt(p.trailBps))) exit = true;
        }
        if (state.slot - h.openedSlot >= p.maxHold) exit = true;
        if (c !== undefined) {
          if (p.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
          if (state.slot - c.lastTradeSlot >= p.staleSlots) exit = true;
          if (flow(c, state.slot, p.exitFlowWindow).net < BigInt(p.exitFlowLamports)) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlippageBps });
        if (c !== undefined) {
          c.done = true;
          c.lastExitSlot = state.slot;
        }
      }

      // Probe sells: a probe's buy has landed, sell the whole probe at once.
      for (const [mint, selling] of probes) {
        if (orders.length >= cap) break;
        if (selling) continue;
        const pos = state.positions.get(mint);
        if (pos === undefined) continue;
        if (hasPending(state, mint, 'sell')) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlippageBps });
        probes.set(mint, true);
      }

      // Entries and adds.
      let free = state.freeCashLamports();
      let mainOpen = held.size;
      for (const mint of [...coins.keys()]) {
        if (orders.length >= cap) break;
        const c = coins.get(mint)!;
        if (c.done || c.complete) continue;
        if (probes.has(mint) || hasPending(state, mint, 'buy') || hasPending(state, mint, 'sell')) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const h = held.get(mint);
        const res = reservesOf(mint);
        if (res === null) continue;
        const isAdd = h !== undefined;
        if (isAdd) {
          if (c.buysSent > p.maxAdds) continue;
          if (h.invested >= BigInt(p.maxStakeLamports) - BigInt(p.minBuyLamports)) continue;
          if (state.slot - c.lastBuySlot < p.addDelay) continue;
          // Add only into strength: price at or above the last buy's decision price.
          if (res.vq * c.lastBuyVt < c.lastBuyVq * res.vt) continue;
          if (flow(c, state.slot, p.flowWindow).net < 0n) continue;
          const room = BigInt(p.maxStakeLamports) - h.invested;
          const want = BigInt(p.addBuyLamports) < room ? BigInt(p.addBuyLamports) : room;
          const capBuy = state.maxBuyLamports(mint);
          const amount = want < capBuy ? want : capBuy;
          if (amount < BigInt(p.minBuyLamports)) continue;
          if (free < amount + tx) continue;
          orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
          free -= amount + tx;
          c.buysSent += 1;
          c.spentSent += amount;
          c.lastBuyVq = res.vq;
          c.lastBuyVt = res.vt;
          c.lastBuySlot = state.slot;
          h.invested += amount;
          continue;
        }
        // First buy.
        if (mainOpen >= p.maxMain) continue;
        if (state.committedPositionCount() >= state.hello.caps.max_open_positions) continue;
        if (c.entries >= 1) continue;
        if (!entrySignal(c, state.slot, res.rq)) continue;
        const capBuy = state.maxBuyLamports(mint);
        if (capBuy < BigInt(p.minBuyLamports) * 2n) continue;
        const want = BigInt(p.firstBuyLamports);
        const amount = want < capBuy ? want : capBuy;
        if (amount < BigInt(p.minBuyLamports)) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
        free -= amount + tx;
        c.buysSent += 1;
        c.spentSent += amount;
        c.lastBuyVq = res.vq;
        c.lastBuyVt = res.vt;
        c.lastBuySlot = state.slot;
        c.entries += 1;
        held.set(mint, { openedSlot: state.slot, invested: amount, best: 0n, devSoldAtOpen: c.devSold });
        mainOpen += 1;
      }

      // Guardrail pacing: open a probe when round-tripped coins lag the pace.
      if (probes.size < p.maxProbes && firstTime !== null) {
        const pace = Math.min(1, (nowTime - firstTime) / p.paceSecs);
        const due = Math.ceil(p.targetCoins * pace);
        if (roundTripped.size < due) {
          const need = due - roundTripped.size;
          let opened = 0;
          for (const mint of [...coins.keys()]) {
            if (orders.length >= cap || opened >= need) break;
            if (probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint)) continue;
            if (roundTripped.has(mint) || boughtBig.has(mint)) continue;
            if (hasPending(state, mint, 'buy') || hasPending(state, mint, 'sell')) continue;
            if (state.positions.has(mint)) continue;
            const c = coins.get(mint)!;
            if (c.done || c.complete) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            // Liquid enough that the 1% cap covers the probe with margin.
            if (state.maxBuyLamports(mint) < BigInt(p.probeLamports) * 2n) continue;
            if (state.committedPositionCount() >= state.hello.caps.max_open_positions) break;
            if (free < BigInt(p.probeLamports) + tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(p.probeLamports), max_slippage_bps: p.buySlippageBps });
            probes.set(mint, false);
            free -= BigInt(p.probeLamports) + tx;
            opened += 1;
          }
        }
      }

      return orders;
    },
  };
}
