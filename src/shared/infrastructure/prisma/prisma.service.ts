import { Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Env } from '../../../config/env.js';
import { PrismaClient } from '../../../generated/prisma/client.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnApplicationShutdown {
  constructor(config: ConfigService<Env, true>) {
    super({
      adapter: new PrismaPg({
        connectionString: config.get('DATABASE_URL', { infer: true }),
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  /**
   * Disconnects in the last shutdown phase: the relay and the worker, which stop in
   * `onModuleDestroy`, still need the database to finish the work in progress.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }
}
