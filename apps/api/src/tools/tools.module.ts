import { Module } from '@nestjs/common';
import { ToolsService } from './tools.service';
import { ToolsController } from './tools.controller';
import { AlertEngine } from './alert.engine';
import { AuditModule } from '../audit/audit.module';
import { BillingModule } from '../billing/billing.module';

@Module({
  imports: [AuditModule, BillingModule],
  providers: [ToolsService, AlertEngine],
  controllers: [ToolsController],
  exports: [ToolsService, AlertEngine],
})
export class ToolsModule {}
