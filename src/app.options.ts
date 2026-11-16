import type { NestApplicationOptions } from '@nestjs/common';

/**
 * Opciones de creación compartidas por `main.ts` y los tests e2e.
 * `rawBody` conserva los bytes exactos del request, necesarios para verificar la firma HMAC.
 */
export const APP_OPTIONS = {
  rawBody: true,
  bufferLogs: true,
} satisfies NestApplicationOptions;
