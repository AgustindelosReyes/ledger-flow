import type { FiscalAuthorizationRequest } from '../../application/ports/fiscal-authority.js';

export type SimulatedFault =
  | 'none'
  /** Responds 503 without having processed the request. */
  | 'unavailable'
  /** Does not respond and did not process the request. */
  | 'timeout_before_processing'
  /**
   * Authorizes the invoice but the response never arrives. This is the most dangerous case:
   * the client sees a timeout and retries something the authority has already issued.
   */
  | 'timeout_after_processing';

/** Decides which fault each request suffers. Tests replace it with a fixed script. */
export abstract class FaultInjector {
  abstract next(request: FiscalAuthorizationRequest): SimulatedFault;
}

export class RandomFaultInjector extends FaultInjector {
  constructor(
    private readonly failureRate: number,
    private readonly random: () => number = Math.random,
  ) {
    super();
  }

  next(): SimulatedFault {
    if (this.random() >= this.failureRate) {
      return 'none';
    }
    // Among failures: half are 503s, and timeouts are split before/after processing.
    const kind = this.random();
    if (kind < 0.5) {
      return 'unavailable';
    }
    return kind < 0.75 ? 'timeout_before_processing' : 'timeout_after_processing';
  }
}
