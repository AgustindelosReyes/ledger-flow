import { BadRequestException, ValidationPipe, type ValidationError } from '@nestjs/common';

export interface FieldError {
  readonly field: string;
  readonly messages: readonly string[];
}

export class ValidationFailedException extends BadRequestException {
  constructor(readonly errors: readonly FieldError[]) {
    super('The request body failed validation');
  }
}

function flatten(errors: readonly ValidationError[], parentPath = ''): FieldError[] {
  return errors.flatMap((error) => {
    const field = parentPath === '' ? error.property : `${parentPath}.${error.property}`;
    const own: FieldError[] =
      error.constraints === undefined
        ? []
        : [{ field, messages: Object.values(error.constraints) }];
    return [...own, ...flatten(error.children ?? [], field)];
  });
}

export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) => new ValidationFailedException(flatten(errors)),
  });
}
