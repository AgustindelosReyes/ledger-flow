import { applyDecorators } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';
import { PROBLEM_CONTENT_TYPE, ProblemDetails } from './problem-details.js';

/**
 * Documenta una respuesta de error con su media type real, `application/problem+json`
 * (los decoradores `Api*Response({ type })` la declararían como `application/json`).
 */
export function ApiProblemResponse(
  status: number,
  description: string,
): ReturnType<typeof applyDecorators> {
  return applyDecorators(
    ApiExtraModels(ProblemDetails),
    ApiResponse({
      status,
      description,
      content: { [PROBLEM_CONTENT_TYPE]: { schema: { $ref: getSchemaPath(ProblemDetails) } } },
    }),
  );
}
