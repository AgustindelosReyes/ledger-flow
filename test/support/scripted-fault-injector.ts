import type { FiscalAuthorizationRequest } from '../../src/modules/invoicing/application/ports/fiscal-authority.js';
import {
  FaultInjector,
  type SimulatedFault,
} from '../../src/modules/invoicing/infrastructure/fiscal-simulator/fault-injector.js';

/**
 * Deterministic injector: each test sets, for a unique amount, the sequence of faults
 * that the requests of that invoice will suffer. Once the script is exhausted, the
 * authority responds fine.
 */
export class ScriptedFaultInjector extends FaultInjector {
  private readonly scripts = new Map<string, SimulatedFault[]>();
  private readonly calls = new Map<string, number>();

  /** Script for the invoice whose total is `totalAmount`. */
  script(totalAmount: string, faults: readonly SimulatedFault[]): void {
    this.scripts.set(totalAmount, [...faults]);
  }

  /** Number of requests the authority received for an invoice. */
  callsFor(invoiceId: string): number {
    return this.calls.get(invoiceId) ?? 0;
  }

  next(request: FiscalAuthorizationRequest): SimulatedFault {
    this.calls.set(request.invoiceId, this.callsFor(request.invoiceId) + 1);
    return this.scripts.get(request.totalAmount)?.shift() ?? 'none';
  }
}
