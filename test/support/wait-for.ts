import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Espera a que un proceso asíncrono (relay, worker) alcance un estado. Devuelve el primer
 * valor no nulo que produzca `probe`; falla con un mensaje descriptivo si vence el plazo.
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
