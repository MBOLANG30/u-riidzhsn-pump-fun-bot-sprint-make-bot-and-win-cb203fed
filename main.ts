// Flush-fade reversal paper bot for agent-fun/replay/v2.
//
// Reads the harness stream (hello, batch..., done) on stdin, one JSON line
// at a time, and writes exactly one reply per batch on stdout. The strategy
// lives in strategy.ts; this file owns the wire: parsing, account/curve
// bookkeeping, order validation and deterministic client ids.
//
// Determinism: no clock, no randomness, no environment reads. The only
// state is the event stream itself, so two runs on the same tape produce
// the same action log byte for byte.

import { FlushFadeStrategy, LAMPORTS_PER_SOL } from './strategy.ts';

const MAX_LINE_BYTES = 1_048_576;
const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9-][A-Za-z0-9_-]{0,63}$/;

type U64 = string;

interface Hello {
  type: 'hello';
  protocol: string;
  seed: U64;
  universe: { sample: { modulus: number; residue: number } };
  capital: { lamports: U64 };
  caps: { max_open_positions: number; max_order_bps_of_real_reserve: number; max_orders_per_batch: number };
  latency_slots: number;
  fees: { base_fee_lamports: U64; priority_fee_lamports: U64 };
}

interface Fill {
  client_id: string;
  mint: string;
  side: 'buy' | 'sell';
  status: 'filled' | 'rejected' | 'failed';
  decided_slot: number;
  slot: number;
  quote_lamports: U64;
  token_amount: U64;
}

interface Batch {
  type: 'batch';
  seq: number;
  slot: number;
  events: ChainEvent[];
  marks: Mark[];
  fills: Fill[];
  account: { cash_lamports: U64; positions: { mint: string; token_amount: U64; cost_lamports: U64 }[] };
}

interface ChainEvent {
  event: 'TradeEvent' | 'CreateEvent' | 'CompleteEvent';
  mint: string;
  slot: number;
  chain_seq: number;
  sol_amount?: U64;
  is_buy?: boolean;
  virtual_sol_reserves?: U64;
  virtual_token_reserves?: U64;
  real_sol_reserves?: U64;
  real_token_reserves?: U64;
  virtual_quote_reserves?: U64;
  real_quote_reserves?: U64;
}

interface Mark {
  mint: string;
  slot: number;
  virtual_token_reserves: U64;
  virtual_quote_reserves: U64;
  real_token_reserves: U64;
  real_quote_reserves: U64;
}

interface Done {
  type: 'done';
  seq: number;
  reason: string;
  account: { cash_lamports: U64; positions: unknown[] };
}

interface OrderOut {
  side: 'buy' | 'sell';
  client_id: string;
  mint: string;
  quote_lamports?: U64;
  token_amount?: U64;
  max_slippage_bps: number;
}

// 10% slippage tolerance: stops must be able to execute through a fast
// gap-down. At 5% a stop-loss sell decided after a rug cascade was rejected
// for slippage and the position rode the crash to the flatten instead.
const SLIPPAGE_BPS = 1000;
const MIN_BUY_LAMPORTS = 10_000_000n; // 0.01 SOL: the guardrail's round-trip floor

async function* readLines(input: AsyncIterable<Uint8Array | string>): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buf = '';
  for await (const chunk of input) {
    buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let nl = buf.indexOf('\n');
    while (nl !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.length > 0) yield line.endsWith('\r') ? line.slice(0, -1) : line;
      nl = buf.indexOf('\n');
    }
    if (Buffer.byteLength(buf, 'utf8') > MAX_LINE_BYTES) throw new Error('input line over limit');
  }
  if (buf.length > 0) yield buf;
}

function toU64(v: unknown): string {
  const n = typeof v === 'bigint' ? v : BigInt(v as string);
  if (n < 0n || n > 18_446_744_073_709_551_615n) throw new Error(`bad u64: ${String(v)}`);
  return n.toString();
}

async function main(): Promise<void> {
  const strategy = new FlushFadeStrategy();
  let hello: Hello | null = null;
  let nextClient = 1;
  let cash = 0n;
  let txFee = 0n;
  /** Buy amounts still in flight, by mint (for the free-cash check). */
  const pendingBuys = new Map<string, bigint>();
  /** Mints with a sell still in flight (don't stack a second sell on them). */
  const pendingSells = new Set<string>();
  const usedIds = new Set<string>();

  const freshId = (): string => {
    for (;;) {
      const id = `o${nextClient++}`;
      if (!usedIds.has(id)) {
        usedIds.add(id);
        return id;
      }
    }
  };

  for await (const line of readLines(process.stdin)) {
    if (line.trim() === '') continue;
    const msg = JSON.parse(line) as Hello | Batch | Done;
    if (msg.type === 'hello') {
      hello = msg as Hello;
      if (hello.protocol !== 'agent-fun/replay/v2') throw new Error(`unsupported protocol ${hello.protocol}`);
      cash = BigInt(hello.capital.lamports);
      txFee = BigInt(hello.fees.base_fee_lamports) + BigInt(hello.fees.priority_fee_lamports);
      strategy.sampleModulus = hello.universe.sample.modulus;
      continue;
    }
    if (msg.type === 'done') {
      return;
    }
    if (msg.type !== 'batch' || hello === null) throw new Error('batch before hello');

    const batch = msg as Batch;
    const orders: OrderOut[] = [];

    // 1. Resolve fills: pending buys/sells leave the in-flight maps.
    for (const f of batch.fills) {
      if (f.side === 'buy') {
        pendingBuys.delete(f.mint);
      } else {
        pendingSells.delete(f.mint);
      }
    }

    // 2. Account snapshot.
    cash = BigInt(batch.account.cash_lamports);
    const held = batch.account.positions.map((p) => ({
      mint: p.mint,
      tokenAmount: BigInt(p.token_amount),
      costLamports: BigInt(p.cost_lamports),
    }));
    strategy.syncPositions(held, batch.slot);

    // 3. Marks refresh reserves for mints we hold or watch.
    for (const m of batch.marks) {
      const t = strategy.mints.get(m.mint);
      if (t !== undefined && m.slot >= t.reservesSlot) {
        t.virtualToken = BigInt(m.virtual_token_reserves);
        t.virtualQuote = BigInt(m.virtual_quote_reserves);
        t.realQuote = BigInt(m.real_quote_reserves);
        t.reservesSlot = m.slot;
      }
    }

    // 4. Fold this slot's events in, in chain order.
    const traded = new Set<string>();
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        strategy.onCreate(e.mint, e.slot, BigInt(e.virtual_token_reserves ?? '0'), BigInt(e.virtual_quote_reserves ?? '0'));
      } else if (e.event === 'TradeEvent') {
        const signed = (e.is_buy ? 1n : -1n) * BigInt(e.sol_amount ?? '0');
        strategy.onTrade(
          e.mint,
          e.slot,
          e.chain_seq,
          BigInt(e.virtual_token_reserves ?? '0'),
          BigInt(e.virtual_quote_reserves ?? '0'),
          BigInt(e.real_token_reserves ?? '0'),
          BigInt(e.real_quote_reserves ?? '0'),
          signed,
        );
        traded.add(e.mint);
      } else {
        strategy.onComplete(e.mint, e.slot);
      }
    }

    // 5. Exits first: every held position is re-checked against its stops.
    // A mint with a sell already in flight waits for that fill to resolve.
    const exits = strategy.exitDecisions(batch.slot);
    const selling = new Set<string>();
    for (const s of exits) {
      if (pendingSells.has(s.mint)) continue;
      if (!PUBKEY_RE.test(s.mint) || s.tokenAmount <= 0n) continue;
      orders.push({
        side: 'sell',
        client_id: freshId(),
        mint: s.mint,
        token_amount: toU64(s.tokenAmount),
        max_slippage_bps: SLIPPAGE_BPS,
      });
      selling.add(s.mint);
      pendingSells.add(s.mint);
    }

    // 6. Entries: only mints that traded this slot, in first-seen order.
    const committed = strategy.positions.size + pendingBuys.size;
    let open = committed;
    if (open < hello.caps.max_open_positions) {
      for (const mint of traded) {
        if (open >= hello.caps.max_open_positions) break;
        if (orders.length >= hello.caps.max_orders_per_batch) break;
        if (strategy.positions.has(mint) || pendingBuys.has(mint) || selling.has(mint)) continue;
        if (!strategy.entrySignal(mint, batch.slot)) continue;
        const stake = strategy.stakeFor(mint);
        if (stake < MIN_BUY_LAMPORTS) continue;
        // Cash check: stake plus one tx fee must fit in free cash.
        let reserved = txFee;
        for (const amt of pendingBuys.values()) reserved += amt + txFee;
        if (cash - reserved < stake + txFee) continue;
        // Size cap: buys on one mint per reply may spend at most
        // max_order_bps_of_real_reserve of its real reserve.
        const track = strategy.mints.get(mint);
        const cap = track === undefined
          ? 0n
          : (track.realQuote * BigInt(hello.caps.max_order_bps_of_real_reserve)) / 10_000n;
        const sized = stake > cap ? cap : stake;
        if (sized < MIN_BUY_LAMPORTS) continue;
        const id = freshId();
        if (!CLIENT_ID_RE.test(id)) continue;
        orders.push({
          side: 'buy',
          client_id: id,
          mint,
          quote_lamports: toU64(sized),
          max_slippage_bps: SLIPPAGE_BPS,
        });
        pendingBuys.set(mint, sized);
        strategy.entries += 1;
        open += 1;
      }
    }

    process.stdout.write(JSON.stringify({ type: 'reply', seq: batch.seq, orders }) + '\n');
  }
  throw new Error('input ended before done');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
