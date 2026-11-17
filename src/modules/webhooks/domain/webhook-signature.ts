import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signature scheme (same design as Stripe):
 *
 *   x-signature: t=<unix seconds>,v1=<hex(HMAC-SHA256(secret, "<t>." + rawBody))>
 *
 * The timestamp is part of the signed content, so it cannot be altered without
 * invalidating the signature; combined with the tolerance window it bounds replay attacks.
 */
export const SIGNATURE_HEADER = 'x-signature';

const TIMESTAMP_PATTERN = /^\d{1,12}$/;
const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/i;

export type SignatureFailureReason =
  'missing_header' | 'malformed_header' | 'signature_mismatch' | 'timestamp_out_of_tolerance';

export type SignatureVerification =
  { readonly valid: true } | { readonly valid: false; readonly reason: SignatureFailureReason };

function computeDigest(secret: string, timestamp: string, rawBody: Buffer): Buffer {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();
}

/** Builds the header value. Senders (and the tests) use it to sign. */
export function signWebhookPayload(
  secret: string,
  timestampSeconds: number,
  rawBody: Buffer,
): string {
  const timestamp = String(timestampSeconds);
  return `t=${timestamp},v1=${computeDigest(secret, timestamp, rawBody).toString('hex')}`;
}

function parseHeader(header: string): { timestamp: string; signature: string } | undefined {
  const fields = new Map<string, string>();
  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator > 0) {
      fields.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
    }
  }
  const timestamp = fields.get('t');
  const signature = fields.get('v1');
  if (
    timestamp === undefined ||
    signature === undefined ||
    !TIMESTAMP_PATTERN.test(timestamp) ||
    !HEX_SHA256_PATTERN.test(signature)
  ) {
    return undefined;
  }
  return { timestamp, signature };
}

interface VerifyParams {
  readonly header: string | undefined;
  /** Exact bytes received over HTTP. Never a re-serialization of the parsed JSON. */
  readonly rawBody: Buffer;
  readonly secret: string;
  readonly toleranceSeconds: number;
  readonly nowSeconds: number;
}

export function verifyWebhookSignature({
  header,
  rawBody,
  secret,
  toleranceSeconds,
  nowSeconds,
}: VerifyParams): SignatureVerification {
  if (header === undefined || header === '') {
    return { valid: false, reason: 'missing_header' };
  }
  const parsed = parseHeader(header);
  if (parsed === undefined) {
    return { valid: false, reason: 'malformed_header' };
  }

  // Both buffers are 32 bytes long (guaranteed by the header pattern), a precondition of
  // `timingSafeEqual`. The constant-time comparison avoids leaking through timing how many
  // leading bytes of the signature are correct.
  const expected = computeDigest(secret, parsed.timestamp, rawBody);
  const provided = Buffer.from(parsed.signature, 'hex');
  if (!timingSafeEqual(expected, provided)) {
    return { valid: false, reason: 'signature_mismatch' };
  }

  if (Math.abs(nowSeconds - Number(parsed.timestamp)) > toleranceSeconds) {
    return { valid: false, reason: 'timestamp_out_of_tolerance' };
  }
  return { valid: true };
}
