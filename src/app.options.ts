import type { NestApplicationOptions } from '@nestjs/common';

/**
 * Creation options shared by `main.ts` and the e2e tests.
 * `rawBody` keeps the exact bytes of the request, required to verify the HMAC signature.
 */
export const APP_OPTIONS = {
  rawBody: true,
  bufferLogs: true,
} satisfies NestApplicationOptions;
