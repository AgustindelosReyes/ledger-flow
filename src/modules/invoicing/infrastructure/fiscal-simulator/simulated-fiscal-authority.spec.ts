import { describe, expect, it } from '@jest/globals';
import {
  FiscalRejectionError,
  FiscalServiceUnavailableError,
  type FiscalAuthorization,
  type FiscalAuthorizationRequest,
} from '../../application/ports/fiscal-authority.js';
import { isValidCuit } from '../../domain/cuit.js';
import { AuthorizationRegistry, type AuthorizationProposal } from './authorization-registry.js';
import { FaultInjector, RandomFaultInjector, type SimulatedFault } from './fault-injector.js';
import { SimulatedFiscalAuthority } from './simulated-fiscal-authority.js';

/** Same contract as the Redis registry: consecutive numbering and idempotency. */
class InMemoryAuthorizationRegistry extends AuthorizationRegistry {
  private readonly authorizations = new Map<string, FiscalAuthorization>();
  private readonly sequences = new Map<string, number>();

  authorize(proposal: AuthorizationProposal): Promise<FiscalAuthorization> {
    const existing = this.authorizations.get(proposal.invoiceId);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    const sequenceKey = `${proposal.pointOfSale}:${proposal.type}`;
    const number = (this.sequences.get(sequenceKey) ?? 0) + 1;
    this.sequences.set(sequenceKey, number);

    const authorization = { number, cae: proposal.cae, caeExpiresAt: proposal.caeExpiresAt };
    this.authorizations.set(proposal.invoiceId, authorization);
    return Promise.resolve(authorization);
  }
}

class FixedFaults extends FaultInjector {
  constructor(private readonly faults: SimulatedFault[]) {
    super();
  }

  next(): SimulatedFault {
    return this.faults.shift() ?? 'none';
  }
}

const request = (
  overrides: Partial<FiscalAuthorizationRequest> = {},
): FiscalAuthorizationRequest => ({
  invoiceId: 'invoice-1',
  type: 'B',
  pointOfSale: 1,
  netAmount: '100.00',
  taxAmount: '21.00',
  totalAmount: '121.00',
  currency: 'ARS',
  payerTaxId: null,
  ...overrides,
});

function build(faults: SimulatedFault[] = []): SimulatedFiscalAuthority {
  return new SimulatedFiscalAuthority(
    new InMemoryAuthorizationRegistry(),
    new FixedFaults(faults),
    { minLatencyMs: 0, maxLatencyMs: 2 },
    () => new Date('2026-11-16T15:00:00.000Z'),
  );
}

const never = new AbortController().signal;

describe('SimulatedFiscalAuthority', () => {
  it('authorizes with a 14-digit CAE that expires 10 days later', async () => {
    const authorization = await build().authorize(request(), never);

    expect(authorization.cae).toMatch(/^\d{14}$/);
    expect(authorization.caeExpiresAt).toBe('2026-11-26');
    expect(authorization.number).toBe(1);
  });

  it('numbers consecutively per point of sale and invoice type', async () => {
    const authority = build();
    const numberOf = async (overrides: Partial<FiscalAuthorizationRequest>): Promise<number> =>
      (await authority.authorize(request(overrides), never)).number;

    expect(await numberOf({ invoiceId: 'b-1' })).toBe(1);
    expect(await numberOf({ invoiceId: 'b-2' })).toBe(2);
    expect(await numberOf({ invoiceId: 'c-1', type: 'C' })).toBe(1);
    expect(await numberOf({ invoiceId: 'b-pos2', pointOfSale: 2 })).toBe(1);
    expect(await numberOf({ invoiceId: 'b-3' })).toBe(3);
  });

  it('is idempotent by invoiceId: a repeated request returns the original authorization', async () => {
    const authority = build();

    const first = await authority.authorize(request(), never);
    const second = await authority.authorize(request(), never);

    expect(second).toEqual(first);
    expect((await authority.authorize(request({ invoiceId: 'invoice-2' }), never)).number).toBe(2);
  });

  it('responds 503 without processing the request', async () => {
    const authority = build(['unavailable']);

    await expect(authority.authorize(request(), never)).rejects.toThrow(
      FiscalServiceUnavailableError,
    );
    // The numbering did not advance: the next request gets number 1.
    expect((await authority.authorize(request(), never)).number).toBe(1);
  });

  it('hangs until the client aborts, without processing the request', async () => {
    const authority = build(['timeout_before_processing']);
    const controller = new AbortController();

    const pending = authority.authorize(request(), controller.signal);
    setTimeout(() => {
      controller.abort();
    }, 20);

    await expect(pending).rejects.toThrow('aborted');
    expect((await authority.authorize(request(), never)).number).toBe(1);
  });

  it('can time out AFTER processing: the retry gets the same authorization, not a new invoice', async () => {
    const authority = build(['timeout_after_processing']);
    const controller = new AbortController();

    const lost = authority.authorize(request(), controller.signal);
    setTimeout(() => {
      controller.abort();
    }, 20);
    await expect(lost).rejects.toThrow('aborted');

    const retried = await authority.authorize(request(), never);
    expect(retried.number).toBe(1);
    // Only one number was consumed: the next invoice is number 2.
    expect((await authority.authorize(request({ invoiceId: 'invoice-2' }), never)).number).toBe(2);
  });

  describe('fiscal validation (400)', () => {
    it.each([
      ['an invalid check digit', '30712345678'],
      ['a DNI instead of a CUIT', '30111222'],
      ['no tax id', null],
    ])('rejects a type A invoice with %s', async (_case, payerTaxId) => {
      const rejection = build().authorize(request({ type: 'A', payerTaxId }), never);

      await expect(rejection).rejects.toThrow(FiscalRejectionError);
      await expect(rejection).rejects.toMatchObject({ retryable: false, httpStatus: 400 });
    });

    it('accepts a type A invoice with a valid CUIT', async () => {
      const authorization = await build().authorize(
        request({ type: 'A', payerTaxId: '30712345671' }),
        never,
      );

      expect(authorization.number).toBe(1);
    });

    it('does not require a tax id for type B (final consumer)', async () => {
      await expect(build().authorize(request({ payerTaxId: null }), never)).resolves.toBeDefined();
    });
  });
});

describe('RandomFaultInjector', () => {
  const sequence = (...values: number[]): (() => number) => {
    const queue = [...values];
    return () => queue.shift() ?? 0;
  };

  it.each([
    ['no fault when the draw is at or above the failure rate', [0.3], 'none'],
    ['503 for the lower half of failures', [0.29, 0.49], 'unavailable'],
    ['timeout before processing', [0.1, 0.5], 'timeout_before_processing'],
    ['timeout after processing', [0.1, 0.75], 'timeout_after_processing'],
  ])('yields %s', (_case, draws, expected) => {
    expect(new RandomFaultInjector(0.3, sequence(...draws)).next()).toBe(expected);
  });

  it('never fails with rate 0 and always fails with rate 1', () => {
    const draws = [0, 0.25, 0.5, 0.75, 0.999];

    expect(draws.map((d) => new RandomFaultInjector(0, () => d).next())).toEqual(
      draws.map(() => 'none'),
    );
    expect(draws.every((d) => new RandomFaultInjector(1, () => d).next() !== 'none')).toBe(true);
  });

  it('fails at roughly the configured rate over many requests', () => {
    const injector = new RandomFaultInjector(0.3);
    const total = 20_000;
    let failures = 0;
    for (let index = 0; index < total; index += 1) {
      if (injector.next() !== 'none') {
        failures += 1;
      }
    }

    expect(failures / total).toBeGreaterThan(0.27);
    expect(failures / total).toBeLessThan(0.33);
  });
});

describe('isValidCuit', () => {
  it.each(['30712345671', '20123456786', '27000000006'])('accepts %s', (cuit) => {
    expect(isValidCuit(cuit)).toBe(true);
  });

  it.each([
    ['a wrong check digit', '30712345678'],
    ['too few digits', '3071234567'],
    ['too many digits', '307123456711'],
    ['separators', '30-71234567-1'],
    ['letters', '3071234567A'],
    ['an empty string', ''],
  ])('rejects %s', (_case, cuit) => {
    expect(isValidCuit(cuit)).toBe(false);
  });
});
