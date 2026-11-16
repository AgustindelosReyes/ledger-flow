import type { FiscalAuthorizationRequest } from '../../src/modules/invoicing/application/ports/fiscal-authority.js';
import {
  FaultInjector,
  type SimulatedFault,
} from '../../src/modules/invoicing/infrastructure/fiscal-simulator/fault-injector.js';

/**
 * Inyector determinista: cada test fija, para un importe único, la secuencia de fallas que
 * sufrirán las solicitudes de esa factura. Agotado el guion, el ente responde bien.
 */
export class ScriptedFaultInjector extends FaultInjector {
  private readonly scripts = new Map<string, SimulatedFault[]>();
  private readonly calls = new Map<string, number>();

  /** Guion para la factura cuyo total es `totalAmount`. */
  script(totalAmount: string, faults: readonly SimulatedFault[]): void {
    this.scripts.set(totalAmount, [...faults]);
  }

  /** Cantidad de solicitudes que el ente recibió para una factura. */
  callsFor(invoiceId: string): number {
    return this.calls.get(invoiceId) ?? 0;
  }

  next(request: FiscalAuthorizationRequest): SimulatedFault {
    this.calls.set(request.invoiceId, this.callsFor(request.invoiceId) + 1);
    return this.scripts.get(request.totalAmount)?.shift() ?? 'none';
  }
}
