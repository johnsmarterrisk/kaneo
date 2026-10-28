import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Operon fork addition (agents-first-class Phase 3 D8, docs/fork-discipline.md row 19): while an
 * agent key's guarded card mutation runs inside its transaction, the side effects that leave the
 * database — event publication, notifications and asset cleanup — are queued here and run only
 * after the transaction commits, so a rolled-back mutation has no external effect. Outside a
 * guarded mutation nothing is queued and every caller behaves exactly as upstream.
 */
const queue = new AsyncLocalStorage<Array<() => unknown>>();

/** Queue `fn` when a guarded card transaction is open; answers whether it was queued. */
export function deferIfInCardTransaction(fn: () => unknown): boolean {
  const pending = queue.getStore();
  if (!pending) return false;
  pending.push(fn);
  return true;
}

/** Run `work` collecting deferred effects; `flush` runs them (outside the queue) after commit. */
export async function collectDeferred<T>(
  work: () => Promise<T>,
): Promise<{ result: T; flush: () => Promise<void> }> {
  const pending: Array<() => unknown> = [];
  const result = await queue.run(pending, work);
  return {
    result,
    flush: async () => {
      for (const fn of pending) await queue.exit(async () => fn());
    },
  };
}
