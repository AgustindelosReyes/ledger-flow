import { Module } from '@nestjs/common';
import { InvoicingModule } from '../invoicing/invoicing.module.js';
import { OutboxRelay } from './outbox-relay.js';

@Module({
  imports: [InvoicingModule],
  providers: [OutboxRelay],
  exports: [OutboxRelay],
})
export class OutboxModule {}
