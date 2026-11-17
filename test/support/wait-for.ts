import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Waits for an asynchronous process (relay, worker) to reach a state. Returns the first
 * non-null value produced by `probe`; fails with a descriptive message on timeout.
 */
export async function waitFor<T>(
  description: string,
  probe: () => Promise<T | null | undefined>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs} ms waiting for: ${description}`);
    }
    await sleep(20);
  }
}
