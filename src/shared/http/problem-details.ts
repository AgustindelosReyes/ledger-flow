import { STATUS_CODES } from 'node:http';
import { HttpException, HttpStatus } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DomainError } from '../domain/domain-error.js';
import { ValidationFailedException, type FieldError } from './validation.js';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

class FieldErrorModel implements FieldError {
  @ApiProperty({ example: 'data.amount' })
  field!: string;

  @ApiProperty({ type: [String] })
  messages!: string[];
}

export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly instance?: string;
  readonly correlationId?: string;
  readonly errors?: readonly FieldError[];
}

/** RFC 7807 Problem Details, con `correlationId` y `errors` como miembros de extensión. */
export class ProblemDetails implements Problem {
  @ApiProperty({
    description: 'URI reference that identifies the problem type',
    example: '/problems/idempotency-payload-mismatch',
  })
  type!: string;

  @ApiProperty({ example: 'Idempotency key reused with a different payload' })
  title!: string;

  @ApiProperty({ example: 422 })
  status!: number;

  @ApiPropertyOptional({ description: 'Human-readable explanation of this occurrence' })
  detail?: string;

  @ApiPropertyOptional({ description: 'Path of the request that produced the problem' })
  instance?: string;

  @ApiPropertyOptional({ description: 'Extension member: correlation id of the request' })
  correlationId?: string;

  @ApiPropertyOptional({
    type: [FieldErrorModel],
    description: 'Extension member: per-field errors, present on validation failures',
  })
  errors?: readonly FieldError[];
}

interface DomainProblem {
  readonly status: HttpStatus;
  readonly title: string;
}

/**
 * Traducción de errores de dominio a HTTP. Vive en la capa de presentación para que el
 * dominio no conozca códigos de estado.
 */
const DOMAIN_PROBLEMS: Readonly<Record<string, DomainProblem>> = {
  INVALID_WEBHOOK_SIGNATURE: {
    status: HttpStatus.UNAUTHORIZED,
    title: 'Invalid webhook signature',
  },
  INVALID_WEBHOOK_PAYLOAD: { status: HttpStatus.BAD_REQUEST, title: 'Invalid webhook payload' },
  IDEMPOTENCY_PAYLOAD_MISMATCH: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Idempotency key reused with a different payload',
  },
  PAYMENT_ALREADY_RECORDED: { status: HttpStatus.CONFLICT, title: 'Payment already recorded' },
  OPERATION_NOT_FOUND: { status: HttpStatus.NOT_FOUND, title: 'Operation not found' },
  INVOICE_NOT_FOUND: { status: HttpStatus.NOT_FOUND, title: 'Invoice not found' },
  INVOICE_NOT_DEAD_LETTERED: {
    status: HttpStatus.CONFLICT,
    title: 'Invoice is not in the dead letter queue',
  },
  INVALID_FISCAL_CORRECTION: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Invalid fiscal data correction',
  },
  INVALID_MONEY: { status: HttpStatus.UNPROCESSABLE_ENTITY, title: 'Invalid monetary amount' },
  CURRENCY_MISMATCH: { status: HttpStatus.UNPROCESSABLE_ENTITY, title: 'Currency mismatch' },
  INVALID_JOURNAL_ENTRY: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Invalid journal entry',
  },
  UNBALANCED_JOURNAL_ENTRY: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unbalanced journal entry',
  },
};

const UNMAPPED_DOMAIN_PROBLEM: DomainProblem = {
  status: HttpStatus.UNPROCESSABLE_ENTITY,
  title: 'Business rule violation',
};

function titleFor(status: number): string {
  return STATUS_CODES[status] ?? 'Error';
}

/** Errores estilo `http-errors` que emite el body-parser (JSON malformado, cuerpo excesivo). */
function clientErrorStatus(exception: unknown): number | undefined {
  if (typeof exception !== 'object' || exception === null || !('statusCode' in exception)) {
    return undefined;
  }
  const { statusCode } = exception;
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500
    ? statusCode
    : undefined;
}

export function toProblem(exception: unknown): Problem {
  if (exception instanceof DomainError) {
    const { status, title } = DOMAIN_PROBLEMS[exception.code] ?? UNMAPPED_DOMAIN_PROBLEM;
    return {
      type: `/problems/${exception.code.toLowerCase().replaceAll('_', '-')}`,
      title,
      status,
      detail: exception.message,
    };
  }

  if (exception instanceof ValidationFailedException) {
    return {
      type: '/problems/validation-failed',
      title: 'Request validation failed',
      status: exception.getStatus(),
      detail: exception.message,
      errors: exception.errors,
    };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    return { type: 'about:blank', title: titleFor(status), status, detail: exception.message };
  }

  const status = clientErrorStatus(exception);
  if (status !== undefined) {
    return {
      type: 'about:blank',
      title: titleFor(status),
      status,
      detail: 'The request could not be parsed',
    };
  }

  // Nunca se filtran detalles internos (mensajes de la base, stack traces) al cliente.
  return {
    type: 'about:blank',
    title: titleFor(HttpStatus.INTERNAL_SERVER_ERROR),
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    detail: 'An unexpected error occurred',
  };
}
