import type { FiscalAuthorizationRequest } from '../../application/ports/fiscal-authority.js';

export type SimulatedFault =
  | 'none'
  /** Responde 503 sin haber procesado la solicitud. */
  | 'unavailable'
  /** No responde y no procesó la solicitud. */
  | 'timeout_before_processing'
  /**
   * Autoriza el comprobante pero la respuesta nunca llega. Es el caso más peligroso: el
   * cliente ve un timeout y reintenta algo que el ente ya emitió.
   */
  | 'timeout_after_processing';

/** Decide qué falla sufre cada solicitud. Los tests lo reemplazan por un guion fijo. */
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
    // Entre las fallas: mitad 503, y los timeouts repartidos antes/después de procesar.
    const kind = this.random();
    if (kind < 0.5) {
      return 'unavailable';
    }
    return kind < 0.75 ? 'timeout_before_processing' : 'timeout_after_processing';
  }
}
