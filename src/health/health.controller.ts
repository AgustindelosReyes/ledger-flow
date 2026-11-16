import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { ApiProblemResponse } from '../shared/http/api-problem-response.js';
import { PrismaService } from '../shared/infrastructure/prisma/prisma.service.js';

class HealthResponse {
  @ApiProperty({ enum: ['ok'] })
  status!: 'ok';
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'Readiness probe: checks connectivity with PostgreSQL' })
  @ApiOkResponse({ type: HealthResponse })
  @ApiProblemResponse(503, 'The database is unreachable')
  async check(): Promise<HealthResponse> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException('Database is unreachable');
    }
    return { status: 'ok' };
  }
}
