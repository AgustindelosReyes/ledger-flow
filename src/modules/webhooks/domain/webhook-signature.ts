import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Esquema de firma (mismo diseño que Stripe):
 *
 *   x-signature: t=<unix seconds>,v1=<hex(HMAC-SHA256(secret, "<t>." + rawBody))>
 *
 * El timestamp forma parte de lo firmado, por lo que no puede alterarse sin invalidar la
 * firma; combinado con la ventana de tolerancia acota los ataques de replay.
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

/** Construye el valor del header. Lo usan los emisores (y los tests) para firmar. */
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
  /** Bytes exactos recibidos por HTTP. Nunca una re-serialización del JSON parseado. */
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

  // Ambos buffers miden 32 bytes (lo garantiza el patrón del header), precondición de
  // `timingSafeEqual`. La comparación en tiempo constante evita filtrar por timing cuántos
  // bytes iniciales de la firma son correctos.
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
