import { describe, expect, it } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import {
  IdempotencyPayloadMismatchError,
  InvalidWebhookSignatureError,
  PaymentAlreadyRecordedError,
} from '../../modules/webhooks/application/errors.js';
import { DomainError } from '../domain/domain-error.js';
import { toProblem } from './problem-details.js';
import { ValidationFailedException } from './validation.js';

describe('toProblem', () => {
  it.each([
    [
      new InvalidWebhookSignatureError('signature_mismatch'),
      401,
      '/problems/invalid-webhook-signature',
    ],
    [
      new IdempotencyPayloadMismatchError('STRIPE', 'evt_1'),
      422,
      '/problems/idempotency-payload-mismatch',
    ],
    [new PaymentAlreadyRecordedError('STRIPE', 'pay_1'), 409, '/problems/payment-already-recorded'],
  ])('maps %o to its HTTP status and problem type', (error, status, type) => {
    expect(toProblem(error)).toMatchObject({ status, type, detail: error.message });
  });

  it('does not reveal why a signature was rejected', () => {
    const problem = toProblem(new InvalidWebhookSignatureError('timestamp_out_of_tolerance'));

    expect(JSON.stringify(problem)).not.toContain('timestamp');
  });

  it('maps an unregistered domain error to 422', () => {
    class NewRuleError extends DomainError {
      readonly code = 'SOME_NEW_RULE';
    }

    expect(toProblem(new NewRuleError('rule broken'))).toEqual({
      type: '/problems/some-new-rule',
      title: 'Business rule violation',
      status: 422,
      detail: 'rule broken',
    });
  });

  it('exposes field errors on validation failures', () => {
    const errors = [{ field: 'data.amount', messages: ['must be a decimal string'] }];

    expect(toProblem(new ValidationFailedException(errors))).toMatchObject({
      type: '/problems/validation-failed',
      status: 400,
      errors,
    });
  });

  it('maps framework HTTP exceptions with type about:blank', () => {
    expect(toProblem(new NotFoundException('Cannot GET /nope'))).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'Cannot GET /nope',
    });
  });

  it('maps body-parser style client errors without echoing their message', () => {
    const parseError = Object.assign(new SyntaxError('Unexpected token } in JSON'), {
      statusCode: 400,
    });

    expect(toProblem(parseError)).toEqual({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: 'The request could not be parsed',
    });
  });

  it.each([
    ['an Error', new Error('connection to 10.0.0.5:5432 refused')],
    ['a thrown string', 'boom'],
    ['an object claiming a 5xx status', { statusCode: 503, message: 'internal detail' }],
  ])('hides internal details of %s behind a generic 500', (_case, thrown) => {
    expect(toProblem(thrown)).toEqual({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      detail: 'An unexpected error occurred',
    });
  });
});
