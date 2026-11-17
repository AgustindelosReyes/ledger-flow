import { Catch, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import { correlationIdOf } from './correlation-id.js';
import { PROBLEM_CONTENT_TYPE, toProblem, type Problem } from './problem-details.js';

/** Global filter: every error response is sent as `application/problem+json` (RFC 7807). */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const correlationId = correlationIdOf(request);
    const problem: Problem = {
      ...toProblem(exception),
      instance: request.originalUrl,
      ...(correlationId === undefined ? {} : { correlationId }),
    };

    if (problem.status >= 500) {
      this.logger.error({ err: exception }, 'Unhandled exception');
    } else {
      this.logger.warn({ problem }, 'Request rejected');
    }

    response.status(problem.status).type(PROBLEM_CONTENT_TYPE).json(problem);
  }
}
