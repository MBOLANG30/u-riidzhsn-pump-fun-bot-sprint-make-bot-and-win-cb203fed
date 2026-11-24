// Flush-fade reversal bot for the pump.fun replay (agent-fun/replay/v2).
//
// Idea (my own design): memecoin curves flush hard and fast, then often
// bounce. Instead of chasing coins that already ran up (most give the gains
// back), this bot waits for a sharp flush inside a coin's own recent trades,
// then buys only once fresh buy flow shows the flush is turning — a bounce
// entry, not a momentum chase. Exits are staged: half the position is sold
// into the first +15% so a winner banks something even if it rolls over, and
// the rest runs with a take-profit, a stop and a trailing stop, plus a short
// time stop so dead coins do not sit in the book.
//
// Everything is deterministic: no clock, no environment, no unseeded
// randomness. All decisions come from the hello + the batches the harness
// sends. Amounts are bigint lamports; prices are SOL per token as floats.

export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const BPS = 10_000n;

// ---------------------------------------------------------------- parameters
// Tuned on the dev window with the real grader (grade-local), not a backtest.
export const PARAMS = {
  // Entry: the flush is measured over the coin's own last WINDOW_TRADES trades.
  windowTrades: 12,
  flushPct: 0.28, // min price in the window <= (1 - flushPct) * max price
  recoverPct: 0.05, // current price >= (1 + recoverPct) * window min price
  flowTrades: 6, // net buy SOL over the last N trades must be positive
  minTrades: 8,
  maxAgeSlots: 2400, // slots after the coin's first trade
  minReserveSol: 4,
  maxReserveSol: 100,
  stakeSol: 0.1, // target stake
  stakeBpsOfReserve: 80, // stake is at most 0.8% of the real SOL reserve
  minStakeSol: 0.02,
  // Exits.
  scaleOutAt: 0.15, // sell half the tokens here
  takeProfit: 0.28, // sell the rest here
  stopLoss: 0.09,
  trailArm: 0.15, // arm the trailing stop once the peak is this high
  trailPct: 0.07, // sell once the price falls this far below the peak
  timeStopSlots: 240,
  cooldownSlots: 400, // per mint, between entries
  // Fallback pace: if the bot is behind on coins once it has seen a good
  // share of the window's mints, loosen the entry. Thresholds are counts of
  // distinct mints seen, scaled by the universe sampling rate (1/modulus of
  // all mints reach the bot), so they work on any window length.
  fallbackStage1Mints: 700, // scaled by 1/sample modulus
  fallbackStage1Coins: 12,
  fallbackStage1Flush: 0.2,
  fallbackStage1Recover: 0.03,
  fallbackStage2Mints: 1000, // scaled by 1/sample modulus
  fallbackStage2Coins: 18,
  fallbackStage2Flush: 0.15,
  fallbackStage2Recover: 0.02,
  slippageBps: 1000,
  maxPositions: 5,
};

// ---------------------------------------------------------------- wire types
export interface HelloMsg {
  type: 'hello';
  protocol: string;
  seed: string;
  universe: { sample: { hash: string; modulus: number; residue: number } };
  capital: { lamports: string };
  caps: {
    max_open_positions: number;
    max_order_bps_of_real_reserve: number;
    max_orders_per_batch: number;
    shorts: boolean;
    leverage: boolean;
  };
  latency_slots: number;
  fees: {
    protocol_bps_fallback: number;
    creator_bps_fallback: number;
    base_fee_lamports: string;
    priority_fee_lamports: string;
    failed_tx_bps: number;
  };
}

export interface FillMsg {
  client_id: string;
  mint: string;
  side: 'buy' | 'sell';
  status: 'filled' | 'rejected' | 'failed';
  reason: string | null;
  decided_slot: number;
  slot: number;
  quote_lamports: string;
  token_amount: string;
  fee_lamports: string;
  tx_fee_lamports: string;
  fee_fallback: boolean;
}

export interface BatchMsg {
  type: 'batch';
  seq: number;
  slot: number;
  events: any[];
  marks: any[];
  fills: FillMsg[];
  account: { cash_lamports: string; positions: { mint: string; token_amount: string; cost_lamports: string }[] };
}

// ---------------------------------------------------------------- internals
interface Trade {
  slot: number;
  price: number; // SOL per token
  isBuy: boolean;
  sol: number; // SOL moved by this trade
}

interface Curve {
  mint: string;
  createdSlot: number | null;
  firstSlot: number;
  firstPrice: number;
  lastPrice: number;
  realSol: number; // real quote reserves, SOL
  trades: number;
  complete: boolean;
  history: Trade[]; // last PARAMS.windowTrades trades (oldest first)
  lastEntrySlot: number;
  seen: boolean;
}

interface Position {
  mint: string;
  tokens: bigint;
  cost: bigint;
  entryPrice: number;
  entrySlot: number;
  peak: number;
  scaledOut: boolean;
}

interface Pending {
  clientId: string;
  side: 'buy' | 'sell';
  mint: string;
  quoteLamports: bigint; // buy: SOL to spend
  tokenAmount: bigint; // sell: tokens to sell
}

export interface OrderOut {
  side: 'buy' | 'sell';
  client_id: string;
  mint: string;
  quote_lamports?: string;
  token_amount?: string;
  max_slippage_bps: number;
}

export class Strategy {
  private hello: HelloMsg | null = null;
  private cash = 0n;
  private txFee = 0n;
  private curves = new Map<string, Curve>();
  private positions = new Map<string, Position>();
  private pending = new Map<string, Pending>();
  private nextId = 1;
  private coinsEntered = 0;
  private mintsSeen = 0;
  private sampleModulus = 10;

  onHello(hello: HelloMsg): void {
    this.hello = hello;
    this.cash = BigInt(hello.capital.lamports);
    this.txFee = BigInt(hello.fees.base_fee_lamports) + BigInt(hello.fees.priority_fee_lamports);
    if (hello.universe && hello.universe.sample && hello.universe.sample.modulus >= 1) {
      this.sampleModulus = hello.universe.sample.modulus;
    }
  }

  private clientId(): string {
    return `o${this.nextId++}`;
  }

  /** Cash minus what pending orders will take if they fill. */
  private freeCash(): bigint {
    let free = this.cash;
    for (const p of this.pending.values()) {
      free -= this.txFee;
      if (p.side === 'buy') free -= p.quoteLamports;
    }
    return free;
  }

  /** Mints held plus mints with a buy pending: what counts against the cap. */
  private openCount(): number {
    const s = new Set<string>(this.positions.keys());
    for (const p of this.pending.values()) if (p.side === 'buy') s.add(p.mint);
    return s.size;
  }

  /** Current entry thresholds, relaxed by the fallback pace when behind. */
  private thresholds(): { flush: number; recover: number } {
    const p = PARAMS;
    const s1 = Math.max(25, Math.floor(p.fallbackStage1Mints / this.sampleModulus));
    const s2 = Math.max(40, Math.floor(p.fallbackStage2Mints / this.sampleModulus));
    if (this.mintsSeen >= s2 && this.coinsEntered < p.fallbackStage2Coins) {
      return { flush: p.fallbackStage2Flush, recover: p.fallbackStage2Recover };
    }
    if (this.mintsSeen >= s1 && this.coinsEntered < p.fallbackStage1Coins) {
      return { flush: p.fallbackStage1Flush, recover: p.fallbackStage1Recover };
    }
    return { flush: p.flushPct, recover: p.recoverPct };
  }

  private curveFor(mint: string, slot: number): Curve {
    let c = this.curves.get(mint);
    if (c === undefined) {
      c = {
        mint,
        createdSlot: null,
        firstSlot: slot,
        firstPrice: 0,
        lastPrice: 0,
        realSol: 0,
        trades: 0,
        complete: false,
        history: [],
        lastEntrySlot: -1_000_000_000,
        seen: false,
      };
      this.curves.set(mint, c);
    }
    return c;
  }

  onBatch(batch: BatchMsg): OrderOut[] {
    if (this.hello === null) return [];
    const slot = batch.slot;
    // 1. Fills: drop pending, learn entry prices and position changes.
    for (const f of batch.fills) {
      const pend = this.pending.get(f.client_id);
      if (pend !== undefined) this.pending.delete(f.client_id);
      if (f.status !== 'filled') continue;
      const c = this.curves.get(f.mint);
      if (f.side === 'buy') {
        const tokens = BigInt(f.token_amount);
        if (tokens > 0n) {
          const existing = this.positions.get(f.mint);
          const price = c !== undefined && c.lastPrice > 0 ? c.lastPrice : 0;
          if (existing !== undefined) {
            existing.tokens += tokens;
            existing.cost += BigInt(f.quote_lamports);
          } else {
            this.positions.set(f.mint, {
              mint: f.mint,
              tokens,
              cost: BigInt(f.quote_lamports),
              entryPrice: price,
              entrySlot: f.slot,
              peak: price,
              scaledOut: false,
            });
          }
        }
      } else {
        const pos = this.positions.get(f.mint);
        if (pos !== undefined) {
          const sold = BigInt(f.token_amount);
          pos.tokens -= sold;
          if (pos.tokens <= 0n) this.positions.delete(f.mint);
        }
      }
    }
    // 2. Account (authoritative cash + positions).
    this.cash = BigInt(batch.account.cash_lamports);
    const held = new Set<string>();
    for (const ap of batch.account.positions) {
      held.add(ap.mint);
      const pos = this.positions.get(ap.mint);
      if (pos !== undefined) {
        pos.tokens = BigInt(ap.token_amount);
        pos.cost = BigInt(ap.cost_lamports);
        if (pos.tokens <= 0n) this.positions.delete(ap.mint);
      }
    }
    // A position the account no longer lists is gone (flattened / completed).
    for (const mint of [...this.positions.keys()]) {
      if (!held.has(mint)) this.positions.delete(mint);
    }
    // 3. Marks: latest reserves for held / pending mints.
    for (const mk of batch.marks) {
      const c = this.curves.get(mk.mint as string);
      if (c === undefined) continue;
      c.realSol = Number(BigInt(mk.real_quote_reserves as string)) / 1e9;
      const vq = Number(BigInt(mk.virtual_quote_reserves as string));
      const vt = Number(BigInt(mk.virtual_token_reserves as string));
      if (vt > 0) c.lastPrice = vq / vt;
    }
    // 4. Events: update curves and per-mint trade history.
    const touched = new Set<string>();
    for (const e of batch.events) {
      const mint = e.mint as string;
      const c = this.curveFor(mint, slot);
      touched.add(mint);
      if (e.event === 'CreateEvent') {
        if (!c.seen) {
          c.seen = true;
          this.mintsSeen++;
        }
        if (c.createdSlot === null) c.createdSlot = e.slot as number;
        c.firstSlot = e.slot as number;
      } else if (e.event === 'TradeEvent') {
        const vq = Number(BigInt(e.virtual_quote_reserves as string));
        const vt = Number(BigInt(e.virtual_token_reserves as string));
        const price = vt > 0 ? vq / vt : 0;
        if (price > 0) {
          if (c.trades === 0) {
            c.firstPrice = price;
            c.firstSlot = e.slot as number;
          }
          c.lastPrice = price;
          c.realSol = Number(BigInt(e.real_quote_reserves as string)) / 1e9;
          c.trades++;
          c.history.push({
            slot: e.slot as number,
            price,
            isBuy: e.is_buy as boolean,
            sol: Number(BigInt(e.sol_amount as string)) / 1e9,
          });
          if (c.history.length > PARAMS.windowTrades) {
            c.history.splice(0, c.history.length - PARAMS.windowTrades);
          }
        }
      } else if (e.event === 'CompleteEvent') {
        c.complete = true;
      }
    }

    const orders: OrderOut[] = [];
    const maxOrders = this.hello.caps.max_orders_per_batch;

    // 5. Exits first: for every held position whose mint moved this batch.
    for (const mint of touched) {
      if (orders.length >= maxOrders) break;
      const pos = this.positions.get(mint);
      if (pos === undefined) continue;
      const c = this.curves.get(mint);
      if (c === undefined || c.lastPrice <= 0 || pos.entryPrice <= 0) continue;
      if (c.complete) continue; // the harness closes completed curves itself
      if (this.pendingHasSell(mint)) continue;
      const price = c.lastPrice;
      if (price > pos.peak) pos.peak = price;
      const ret = price / pos.entryPrice - 1;
      const peakRet = pos.peak / pos.entryPrice - 1;
      let sellTokens = 0n;
      if (ret >= PARAMS.takeProfit) {
        sellTokens = pos.tokens;
      } else if (ret <= -PARAMS.stopLoss) {
        sellTokens = pos.tokens;
      } else if (peakRet >= PARAMS.trailArm && ret <= peakRet - PARAMS.trailPct) {
        sellTokens = pos.tokens;
      } else if (slot - pos.entrySlot >= PARAMS.timeStopSlots) {
        sellTokens = pos.tokens;
      } else if (!pos.scaledOut && ret >= PARAMS.scaleOutAt) {
        sellTokens = pos.tokens / 2n;
        pos.scaledOut = true;
      }
      if (sellTokens > 0n) {
        const id = this.clientId();
        orders.push({
          side: 'sell',
          client_id: id,
          mint,
          token_amount: sellTokens.toString(),
          max_slippage_bps: PARAMS.slippageBps,
        });
        this.pending.set(id, { clientId: id, side: 'sell', mint, quoteLamports: 0n, tokenAmount: sellTokens });
      }
    }

    // 6. Entries: only for mints that traded this batch.
    const th = this.thresholds();
    for (const mint of touched) {
      if (orders.length >= maxOrders) break;
      if (this.positions.has(mint)) continue;
      if (this.pendingHasBuy(mint)) continue;
      const c = this.curves.get(mint);
      if (c === undefined || c.complete) continue;
      if (c.trades < PARAMS.minTrades || c.firstPrice <= 0 || c.lastPrice <= 0) continue;
      if (slot - c.firstSlot > PARAMS.maxAgeSlots) continue;
      if (slot - c.lastEntrySlot < PARAMS.cooldownSlots) continue;
      if (c.realSol < PARAMS.minReserveSol || c.realSol > PARAMS.maxReserveSol) continue;
      if (this.openCount() >= this.hello.caps.max_open_positions) continue;
      // Flush over the coin's own recent trades.
      let hi = 0;
      let lo = Infinity;
      for (const t of c.history) {
        if (t.price > hi) hi = t.price;
        if (t.price < lo) lo = t.price;
      }
      if (hi <= 0 || lo === Infinity) continue;
      if (lo / hi - 1 > -th.flush) continue; // no flush deep enough
      if (c.lastPrice / lo - 1 < th.recover) continue; // not bouncing off the low
      // Fresh buy flow: the latest trade is a buy and net buy SOL over the
      // last few trades is positive.
      const h = c.history;
      if (h.length === 0 || !h[h.length - 1]!.isBuy) continue;
      let buySol = 0;
      let sellSol = 0;
      const start = Math.max(0, h.length - PARAMS.flowTrades);
      for (let i = start; i < h.length; i++) {
        const t = h[i]!;
        if (t.isBuy) buySol += t.sol;
        else sellSol += t.sol;
      }
      if (buySol - sellSol <= 0) continue;
      // Size: the smaller of the target stake and 0.8% of the real reserve
      // (the harness caps buys at 1% of real reserve per reply per mint).
      const capLamports = (BigInt(Math.floor(c.realSol * 1e9)) * BigInt(PARAMS.stakeBpsOfReserve)) / BPS;
      const targetLamports = BigInt(Math.floor(PARAMS.stakeSol * 1e9));
      const stake = targetLamports < capLamports ? targetLamports : capLamports;
      if (stake < BigInt(Math.floor(PARAMS.minStakeSol * 1e9))) continue;
      if (this.freeCash() < stake + this.txFee) continue;
      const id = this.clientId();
      orders.push({
        side: 'buy',
        client_id: id,
        mint,
        quote_lamports: stake.toString(),
        max_slippage_bps: PARAMS.slippageBps,
      });
      this.pending.set(id, { clientId: id, side: 'buy', mint, quoteLamports: stake, tokenAmount: 0n });
      c.lastEntrySlot = slot;
      this.coinsEntered++;
    }

    return orders;
  }

  private pendingHasBuy(mint: string): boolean {
    for (const p of this.pending.values()) if (p.side === 'buy' && p.mint === mint) return true;
    return false;
  }

  private pendingHasSell(mint: string): boolean {
    for (const p of this.pending.values()) if (p.side === 'sell' && p.mint === mint) return true;
    return false;
  }
}
