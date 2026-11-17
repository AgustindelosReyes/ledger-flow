import { randomInt } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  FiscalAuthority,
  FiscalRejectionError,
  FiscalServiceUnavailableError,
  type FiscalAuthorization,
  type FiscalAuthorizationRequest,
} from '../../application/ports/fiscal-authority.js';
import { isValidCuit } from '../../domain/cuit.js';
import type { AuthorizationRegistry } from './authorization-registry.js';
import type { FaultInjector } from './fault-injector.js';

export interface SimulatorSettings {
  readonly minLatencyMs: number;
  readonly maxLatencyMs: number;
}

const CAE_VALIDITY_DAYS = 10;
const MS_PER_DAY = 86_400_000;

/**
 * Simulator of the fiscal authority (ARCA/AFIP): variable latency, injected transient
 * faults and deterministic rejections for invalid data. It can be replaced by a real
 * client of the web service without touching the rest of the system: it only implements
 * the `FiscalAuthority` port.
 */
export class SimulatedFiscalAuthority extends FiscalAuthority {
  constructor(
    private readonly registry: AuthorizationRegistry,
    private readonly faults: FaultInjector,
    private readonly settings: SimulatorSettings,
    private readonly now: () => Date = () => new Date(),
  ) {
    super();
  }

  async authorize(
    request: FiscalAuthorizationRequest,
    signal: AbortSignal,
  ): Promise<FiscalAuthorization> {
    const fault = this.faults.next(request);

    await this.simulateLatency(signal);
    if (fault === 'unavailable') {
      throw new FiscalServiceUnavailableError();
    }
    if (fault === 'timeout_before_processing') {
      return hang(signal);
    }

    this.validate(request);
    const authorization = await this.registry.authorize({
      invoiceId: request.invoiceId,
      pointOfSale: request.pointOfSale,
      type: request.type,
      cae: String(randomInt(10_000_000_000_000, 100_000_000_000_000)),
      caeExpiresAt: new Date(this.now().getTime() + CAE_VALIDITY_DAYS * MS_PER_DAY)
        .toISOString()
        .slice(0, 10),
    });

    if (fault === 'timeout_after_processing') {
      return hang(signal);
    }
    return authorization;
  }

  /** Authority-side validations: a rejection is final, retrying does not change it. */
  private validate(request: FiscalAuthorizationRequest): void {
    if (request.type === 'A' && (request.payerTaxId === null || !isValidCuit(request.payerTaxId))) {
      throw new FiscalRejectionError(
        `receiver CUIT "${request.payerTaxId ?? ''}" is invalid (check digit mismatch); ` +
          'a type A invoice requires a valid CUIT',
      );
    }
  }

  private async simulateLatency(signal: AbortSignal): Promise<void> {
    const { minLatencyMs, maxLatencyMs } = this.settings;
    const latency =
      maxLatencyMs > minLatencyMs ? randomInt(minLatencyMs, maxLatencyMs + 1) : minLatencyMs;
    try {
      await sleep(latency, undefined, { signal });
    } catch {
      // The client aborted on timeout: there is nothing left to respond.
      await hang(signal);
    }
  }
}

/** Never responds: the promise only rejects when the client aborts the request. */
function hang(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const abort = (): void => {
      reject(new Error('Request aborted by the client'));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}
