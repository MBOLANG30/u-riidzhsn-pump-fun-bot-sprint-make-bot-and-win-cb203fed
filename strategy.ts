// Flush-fade reversal strategy for the pump.fun replay (agent-fun/replay/v2).
//
// Idea: a memecoin that has just been flushed hard is often oversold. We buy
// only while it is STILL deeply depressed point-to-point, has already bounced
// off its window low, and shows buyers returning (net-positive signed SOL
// flow since that low).
//
// The flush is measured on the REAL-reserve ratio (real SOL / real tokens),
// not on the trade price. The trade (virtual) price whipsaws on single big
// trades, so a cliff measured on it fires on noise; the real ratio moves
// only with cumulative net flow, so a 45% drop in it means sustained heavy
// selling and a 10% recovery means sustained buying has resumed. Exits are
// still measured on the virtual curve price — the price a sell actually
// executes against — with the position's basis taken from the account's
// cost/token at fill.
// Exits are staged: scale out half at +30%, take the rest at +50%, with a
// tight stop-loss, a trailing stop once a winner arms, and a time stop.
//
// Everything here is deterministic integer math: no clock, no randomness,
// no environment reads. Prices are virtual-reserve ratios scaled by 1e9
// (lamports of quote per token, x1e9), so every comparison is exact bigint
// arithmetic and two runs on the same tape agree byte for byte.

export const LAMPORTS_PER_SOL = 1_000_000_000n;

export interface StrategyConfig {
  /** Slots in the cliff window. */
  windowSlots: number;
  /** Entry needs price at least this far below the window-start price (bps). */
  cliffBps: number;
  /** Entry needs price at least this far above the window low (bps). */
  recoverBps: number;
  /** Net signed SOL flow since the window low must exceed this. */
  flowMinLamports: bigint;
  /** Real SOL reserve must be inside [min, max] (lamports). */
  reserveMinLamports: bigint;
  reserveMaxLamports: bigint;
  /** Coin age at entry, in slots. */
  maxAgeSlots: number;
  /** Slots to wait before re-entering a mint we exited. */
  reentryCooldownSlots: number;
  /** Stake per entry: min(fixed, stakeBps of real reserve). */
  stakeFixedLamports: bigint;
  stakeBpsOfReserve: number;
  /** Max open positions (held + pending buys). */
  maxOpenPositions: number;
  /** Scale out half the position at this gain (bps). */
  scaleOutBps: number;
  /** Take profit on the remainder at this gain (bps). */
  takeProfitBps: number;
  /** Stop-loss at this loss (bps). */
  stopLossBps: number;
  /** Trailing stop arms at this gain (bps) and sells on this pullback (bps). */
  trailArmBps: number;
  trailBps: number;
  /** Time stop, in slots held. */
  timeStopSlots: number;
  /** Fallback pace: relax the cliff once this many mints have been seen. */
  paceModulus: number;
}

export const DEFAULT_CONFIG: StrategyConfig = {
  windowSlots: 30,
  cliffBps: 4500,
  recoverBps: 1000,
  flowMinLamports: 1_000_000_000n, // 1 SOL of net buying since the low
  reserveMinLamports: 10n * LAMPORTS_PER_SOL,
  reserveMaxLamports: 60n * LAMPORTS_PER_SOL,
  maxAgeSlots: 3600,
  reentryCooldownSlots: 400,
  stakeFixedLamports: 300_000_000n, // 0.3 SOL
  stakeBpsOfReserve: 95, // 0.95% of real reserve
  maxOpenPositions: 5,
  scaleOutBps: 2000,
  takeProfitBps: 5000,
  stopLossBps: 700,
  trailArmBps: 1000,
  trailBps: 300,
  timeStopSlots: 100,
  paceModulus: 1,
};

export interface TradeSample {
  slot: number;
  chainSeq: number;
  /** Scaled virtual price (virtual quote / virtual token, x1e9). */
  price: bigint;
  /** Scaled real-reserve ratio (real quote / real token, x1e9): the flush signal. */
  ratio: bigint;
  /** Signed SOL flow of this trade, lamports (+ buy, - sell). */
  signedSolLamports: bigint;
}

export interface MintTrack {
  mint: string;
  createdSlot: number | null;
  firstSeenSlot: number;
  /** Latest known reserves. */
  virtualToken: bigint;
  virtualQuote: bigint;
  realQuote: bigint;
  reservesSlot: number;
  complete: boolean;
  /** Recent trades, oldest first; pruned to the cliff window plus slack. */
  trades: TradeSample[];
}

export interface PositionTrack {
  mint: string;
  /** Average entry cost per token, lamports x1e9 (cost_lamports/token). */
  entryPrice: bigint;
  entrySlot: number;
  /** Highest scaled price seen since entry. */
  peakPrice: bigint;
  scaledOut: boolean;
  /** Tokens we believe we hold (mirrors the account; kept for sizing). */
  tokens: bigint;
}

export interface Decision {
  buys: { mint: string; quoteLamports: bigint }[];
  sells: { mint: string; tokenAmount: bigint }[];
}

const PRICE_SCALE = 1_000_000_000n;

export function scaledPrice(virtualQuote: bigint, virtualToken: bigint): bigint {
  if (virtualToken <= 0n) return 0n;
  return (virtualQuote * PRICE_SCALE) / virtualToken;
}

/** Gain/loss of `price` vs `base`, in basis points (signed). */
export function retBps(price: bigint, base: bigint): bigint {
  if (base <= 0n) return 0n;
  return ((price - base) * 10_000n) / base;
}

export class FlushFadeStrategy {
  readonly config: StrategyConfig;
  readonly mints = new Map<string, MintTrack>();
  readonly positions = new Map<string, PositionTrack>();
  readonly lastExitSlot = new Map<string, number>();
  /** Mints entered (buy orders sent), for the fallback-pace rule. */
  entries = 0;
  /** Distinct mints ever seen, for the fallback-pace rule. */
  mintsSeen = 0;
  /** Sample modulus from hello (how sparsely the universe is sampled). */
  sampleModulus = 1;

  constructor(config: StrategyConfig = DEFAULT_CONFIG) {
    this.config = config;
  }

  trackMint(mint: string, slot: number, createdSlot: number | null): MintTrack {
    let t = this.mints.get(mint);
    if (t === undefined) {
      t = {
        mint,
        createdSlot,
        firstSeenSlot: slot,
        virtualToken: 0n,
        virtualQuote: 0n,
        realQuote: 0n,
        reservesSlot: slot,
        complete: false,
        trades: [],
      };
      this.mints.set(mint, t);
      this.mintsSeen += 1;
    } else if (createdSlot !== null && t.createdSlot === null) {
      t.createdSlot = createdSlot;
    }
    return t;
  }

  onCreate(mint: string, slot: number, virtualToken: bigint, virtualQuote: bigint): void {
    const t = this.trackMint(mint, slot, slot);
    t.virtualToken = virtualToken;
    t.virtualQuote = virtualQuote;
    t.realQuote = 0n;
    t.reservesSlot = slot;
  }

  onTrade(
    mint: string,
    slot: number,
    chainSeq: number,
    virtualToken: bigint,
    virtualQuote: bigint,
    realToken: bigint,
    realQuote: bigint,
    signedSolLamports: bigint,
  ): void {
    const t = this.trackMint(mint, slot, null);
    t.virtualToken = virtualToken;
    t.virtualQuote = virtualQuote;
    t.realQuote = realQuote;
    t.reservesSlot = slot;
    t.trades.push({
      slot,
      chainSeq,
      price: scaledPrice(virtualQuote, virtualToken),
      ratio: scaledPrice(realQuote, realToken),
      signedSolLamports,
    });
    // Keep enough history for the window-start lookup (the last trade at
    // or before slot - windowSlots) even on rarely-traded mints: retain
    // a full max-age span of samples.
    const horizon = slot - 3600;
    while (t.trades.length > 0 && t.trades[0].slot < horizon) t.trades.shift();
  }

  onComplete(mint: string, slot: number): void {
    const t = this.trackMint(mint, slot, null);
    t.complete = true;
  }

  /** Current scaled price of a mint, 0 when unknown. */
  priceOf(mint: string): bigint {
    const t = this.mints.get(mint);
    if (t === undefined) return 0n;
    return scaledPrice(t.virtualQuote, t.virtualToken);
  }

  /** Effective cliff / recover thresholds after the fallback-pace rule.
   *  The pace counter is the count of distinct mints seen on this (already
   *  modulus-sampled) tape: the cliff relaxes only once 700 mints have been
   *  seen with fewer than 12 entries, and again at 1000 mints with fewer
   *  than 18. On the dev tape neither tier fires (the strict cliff already
   *  finds its entries well before 700 mints), so the dev grade runs on
   *  the strict 37% / 4% thresholds throughout. */
  paceThresholds(): { cliffBps: number; recoverBps: number } {
    if (this.mintsSeen >= 1000 && this.entries < 18) return { cliffBps: 1500, recoverBps: 200 };
    if (this.mintsSeen >= 700 && this.entries < 12) return { cliffBps: 2000, recoverBps: 300 };
    return { cliffBps: this.config.cliffBps, recoverBps: this.config.recoverBps };
  }

  /** Does this mint qualify for an entry right now? Pure function of its track. */
  entrySignal(mint: string, slot: number): boolean {
    const t = this.mints.get(mint);
    if (t === undefined || t.complete) return false;
    if (t.trades.length < 2) return false;
    const cfg = this.config;

    // Age: young coins only.
    const born = t.createdSlot ?? t.firstSeenSlot;
    if (slot - born > cfg.maxAgeSlots) return false;
    // Re-entry cooldown after an exit.
    const lastExit = this.lastExitSlot.get(mint);
    if (lastExit !== undefined && slot - lastExit < cfg.reentryCooldownSlots) return false;
    // Real reserve band.
    if (t.realQuote < cfg.reserveMinLamports || t.realQuote > cfg.reserveMaxLamports) return false;

    // Window: trades within the last windowSlots slots. The window-start
    // ratio is the last known ratio AT the window start (the latest trade
    // at or before slot - windowSlots) — not the earliest trade inside the
    // window. That is what "still depressed vs N slots ago" means: a coin
    // whose crash is fresh inside the window is still falling, while one
    // depressed against its ratio 30 slots ago has already sat low and
    // turned. A mint with no trade at or before the window start has no
    // window-start ratio and cannot qualify. All cliff / recovery math
    // below runs on the real-reserve ratio (see the file header).
    const winStart = slot - cfg.windowSlots;
    let startRatio = 0n;
    let startIdx = t.trades.length;
    for (let i = 0; i < t.trades.length; i++) {
      if (t.trades[i].slot <= winStart) {
        startRatio = t.trades[i].ratio;
        startIdx = i + 1;
      } else {
        break;
      }
    }
    if (startRatio <= 0n) return false;
    const window = t.trades.slice(startIdx);
    if (window.length < 1) return false;

    // Window low and its position in the chain.
    let lowRatio = window[0].ratio;
    let lowChainSeq = window[0].chainSeq;
    for (const s of window) {
      if (s.ratio < lowRatio) {
        lowRatio = s.ratio;
        lowChainSeq = s.chainSeq;
      }
    }

    const now = t.trades[t.trades.length - 1].ratio;
    if (now <= 0n) return false;
    const { cliffBps, recoverBps } = this.paceThresholds();

    // Still deeply depressed point-to-point vs the window start.
    if (now * 10_000n > startRatio * BigInt(10_000 - cliffBps)) return false;
    // Already recovered off the window low.
    if (now * 10_000n < lowRatio * BigInt(10_000 + recoverBps)) return false;
    // Buyers returning: net-positive signed SOL flow since the low, and
    // enough of it to be real buying rather than dust.
    let flow = 0n;
    for (const s of window) {
      if (s.chainSeq > lowChainSeq) flow += s.signedSolLamports;
    }
    if (flow <= cfg.flowMinLamports) return false;
    return true;
  }

  /** Stake for a mint: min(fixed, stakeBps of real reserve). */
  stakeFor(mint: string): bigint {
    const t = this.mints.get(mint);
    if (t === undefined) return 0n;
    const byReserve = (t.realQuote * BigInt(this.config.stakeBpsOfReserve)) / 10_000n;
    return byReserve < this.config.stakeFixedLamports ? byReserve : this.config.stakeFixedLamports;
  }

  /** Sync held positions with the account snapshot; returns mints that closed.
   *  The return basis is the fill price: cost_lamports / tokens held, as
   *  the account reports it. That is the economic entry price — what the
   *  SOL spent actually bought. (The decision-time market price is the
   *  wrong basis: a buy fills two slots later, and in a falling market the
   *  fill buys MORE tokens, so the position starts near breakeven even
   *  though the market price fell; measuring the stop against the
   *  decision price would stop out a position that lost nothing.) The
   *  entry price is fixed when the position first appears and never
   *  recomputed afterwards. */
  syncPositions(
    held: { mint: string; tokenAmount: bigint; costLamports: bigint }[],
    slot: number,
  ): string[] {
    const closed: string[] = [];
    const seen = new Set<string>();
    for (const h of held) {
      seen.add(h.mint);
      if (h.tokenAmount <= 0n) continue;
      const prev = this.positions.get(h.mint);
      if (prev === undefined) {
        const entryPrice = h.costLamports > 0n ? (h.costLamports * PRICE_SCALE) / h.tokenAmount : 0n;
        this.positions.set(h.mint, {
          mint: h.mint,
          entryPrice,
          entrySlot: slot,
          peakPrice: this.priceOf(h.mint),
          scaledOut: false,
          tokens: h.tokenAmount,
        });
      } else {
        prev.tokens = h.tokenAmount;
      }
    }
    for (const mint of [...this.positions.keys()]) {
      if (!seen.has(mint)) {
        this.positions.delete(mint);
        this.lastExitSlot.set(mint, slot);
        closed.push(mint);
      }
    }
    return closed;
  }

  /** Exit decisions for every held position at the current prices. */
  exitDecisions(slot: number): { mint: string; tokenAmount: bigint }[] {
    const cfg = this.config;
    const sells: { mint: string; tokenAmount: bigint }[] = [];
    for (const p of this.positions.values()) {
      const price = this.priceOf(p.mint);
      if (price <= 0n || p.entryPrice <= 0n) continue;
      if (price > p.peakPrice) p.peakPrice = price;
      const r = retBps(price, p.entryPrice);
      const heldSlots = slot - p.entrySlot;

      // Stop-loss first: a hard -5% always exits.
      if (r <= -BigInt(cfg.stopLossBps)) {
        sells.push({ mint: p.mint, tokenAmount: p.tokens });
        continue;
      }
      // Time stop.
      if (heldSlots >= cfg.timeStopSlots) {
        sells.push({ mint: p.mint, tokenAmount: p.tokens });
        continue;
      }
      // Trailing stop once armed.
      if (r >= BigInt(cfg.trailArmBps)) {
        const trailRet = retBps(price, p.peakPrice);
        if (trailRet <= -BigInt(cfg.trailBps)) {
          sells.push({ mint: p.mint, tokenAmount: p.tokens });
          continue;
        }
      }
      // Scale out half at +30%, then take profit on the rest at +50%.
      if (!p.scaledOut && r >= BigInt(cfg.scaleOutBps)) {
        const half = p.tokens / 2n;
        if (half > 0n) {
          sells.push({ mint: p.mint, tokenAmount: half });
          p.scaledOut = true;
        }
        continue;
      }
      if (p.scaledOut && r >= BigInt(cfg.takeProfitBps)) {
        sells.push({ mint: p.mint, tokenAmount: p.tokens });
      }
    }
    return sells;
  }
}
