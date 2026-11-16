import { Module } from '@nestjs/common';
import { AdminApiKeyGuard } from '../../shared/http/admin-api-key.guard.js';
import { InvoicingModule } from '../invoicing/invoicing.module.js';
import { OperationTraceQuery } from './operation-trace.query.js';
import { OperationsController } from './operations.controller.js';

@Module({
  imports: [InvoicingModule],
  controllers: [OperationsController],
  providers: [OperationTraceQuery, AdminApiKeyGuard],
})
export class OperationsModule {}
