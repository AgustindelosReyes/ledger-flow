import { applyDecorators } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';
import { PROBLEM_CONTENT_TYPE, ProblemDetails } from './problem-details.js';

/**
 * Documents an error response with its real media type, `application/problem+json`
 * (the `Api*Response({ type })` decorators would declare it as `application/json`).
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
