// Entrypoint for the pump.fun replay bot (agent-fun/replay/v2).
//
// The harness speaks newline-delimited JSON on stdin: one `hello`, then one
// `batch` per slot that has events, then `done`. This file owns that wire
// only: it reads one line at a time, hands each batch to the strategy in
// strategy.ts, and writes exactly one `reply` per batch (echoing its seq)
// to stdout. Diagnostics go to stderr, never stdout.
//
// Determinism: the bot reads nothing but the harness messages — no clock,
// no environment, no unseeded randomness — so the two grading executions
// produce identical action logs.
import { Strategy } from './strategy.ts';
import type { BatchMsg, HelloMsg, OrderOut } from './strategy.ts';

const strategy = new Strategy();

async function main(): Promise<void> {
  let buffer = '';

  for await (const chunk of process.stdin) {
    buffer += chunk.toString('utf-8');
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim() !== '') {
        const done = handleLine(line);
        if (done) return;
      }
      nl = buffer.indexOf('\n');
    }
  }
  throw new Error('input ended before done');
}
function handleLine(line: string): boolean {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    throw new Error('input line is not JSON');
  }
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
    throw new Error('input line is not an object');
  }
  const type = (msg as { type?: unknown }).type;
  if (type === 'hello') {
    strategy.onHello(msg as HelloMsg);
    return false;
  }
  if (type === 'batch') {
    const batch = msg as BatchMsg;
    const orders: OrderOut[] = strategy.onBatch(batch);
    const reply = JSON.stringify({ type: 'reply', seq: batch.seq, orders });
    process.stdout.write(`${reply}\n`);
    return false;
  }
  if (type === 'done') {
    return true;
  }
  throw new Error(`unknown message type ${String(type)}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
