import { createHmac } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';
import { signWebhookPayload, verifyWebhookSignature } from './webhook-signature.js';

const SECRET = 'unit-test-secret-with-at-least-32-chars';
const NOW = 1_800_000_000;
const TOLERANCE = 300;
const body = Buffer.from('{"eventId":"evt_1","amount":"100.00"}', 'utf8');

const verify = (
  header: string | undefined,
  overrides: { rawBody?: Buffer; secret?: string; nowSeconds?: number } = {},
): ReturnType<typeof verifyWebhookSignature> =>
  verifyWebhookSignature({
    header,
    rawBody: overrides.rawBody ?? body,
    secret: overrides.secret ?? SECRET,
    toleranceSeconds: TOLERANCE,
    nowSeconds: overrides.nowSeconds ?? NOW,
  });

describe('signWebhookPayload', () => {
  it('produces t=<ts>,v1=HMAC-SHA256(secret, "<ts>." + body) in hex', () => {
    const expected = createHmac('sha256', SECRET)
      .update(`${NOW}.{"eventId":"evt_1","amount":"100.00"}`)
      .digest('hex');

    expect(signWebhookPayload(SECRET, NOW, body)).toBe(`t=${NOW},v1=${expected}`);
  });
});

describe('verifyWebhookSignature', () => {
  const validHeader = signWebhookPayload(SECRET, NOW, body);

  it('accepts a valid signature', () => {
    expect(verify(validHeader)).toEqual({ valid: true });
  });

  it('accepts header fields in any order and with surrounding spaces', () => {
    const [timestamp, signature] = validHeader.split(',');

    expect(verify(`${signature}, ${timestamp}`)).toEqual({ valid: true });
  });

  it('accepts an uppercase hex digest', () => {
    const [timestamp = '', signature = ''] = validHeader.split(',');
    const uppercased = `v1=${signature.slice('v1='.length).toUpperCase()}`;

    expect(verify(`${timestamp},${uppercased}`)).toEqual({ valid: true });
  });

  it.each([undefined, ''])('reports a missing header (%s)', (header) => {
    expect(verify(header)).toEqual({ valid: false, reason: 'missing_header' });
  });

  it.each([
    ['garbage', 'not-a-signature'],
    ['no timestamp', `v1=${'a'.repeat(64)}`],
    ['no digest', `t=${NOW}`],
    ['non-numeric timestamp', `t=abc,v1=${'a'.repeat(64)}`],
    ['digest too short', `t=${NOW},v1=abcdef`],
    ['digest too long', `t=${NOW},v1=${'a'.repeat(66)}`],
    ['non-hex digest', `t=${NOW},v1=${'z'.repeat(64)}`],
  ])('reports a malformed header: %s', (_case, header) => {
    expect(verify(header)).toEqual({ valid: false, reason: 'malformed_header' });
  });

  it('rejects when a single byte of the body changes', () => {
    const tampered = Buffer.from('{"eventId":"evt_1","amount":"900.00"}', 'utf8');

    expect(verify(validHeader, { rawBody: tampered })).toEqual({
      valid: false,
      reason: 'signature_mismatch',
    });
  });

  it('rejects semantically equal JSON with different bytes (key order, whitespace)', () => {
    const reordered = Buffer.from('{"amount":"100.00","eventId":"evt_1"}', 'utf8');
    const spaced = Buffer.from('{"eventId": "evt_1", "amount": "100.00"}', 'utf8');

    expect(verify(validHeader, { rawBody: reordered }).valid).toBe(false);
    expect(verify(validHeader, { rawBody: spaced }).valid).toBe(false);
  });

  it('rejects a signature made with another secret', () => {
    expect(verify(validHeader, { secret: 'another-secret-with-at-least-32-chars!' })).toEqual({
      valid: false,
      reason: 'signature_mismatch',
    });
  });

  it('rejects a replayed timestamp: changing `t` invalidates the signature', () => {
    const forged = validHeader.replace(`t=${NOW}`, `t=${NOW + 1}`);

    expect(verify(forged)).toEqual({ valid: false, reason: 'signature_mismatch' });
  });

  it.each([
    ['at the edge of the window (past)', NOW + TOLERANCE, true],
    ['at the edge of the window (future)', NOW - TOLERANCE, true],
    ['just past the window', NOW + TOLERANCE + 1, false],
    ['signed too far in the future', NOW - TOLERANCE - 1, false],
  ])('applies the tolerance window: %s', (_case, nowSeconds, valid) => {
    const result = verify(validHeader, { nowSeconds });

    expect(result).toEqual(
      valid ? { valid: true } : { valid: false, reason: 'timestamp_out_of_tolerance' },
    );
  });
});
