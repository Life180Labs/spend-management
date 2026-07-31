import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { SchedulerModule } from './scheduler/scheduler.module';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { DepartmentsModule } from './departments/departments.module';
import { ToolsModule } from './tools/tools.module';
import { BudgetsModule } from './budgets/budgets.module';
import { SpendRequestsModule } from './spend-requests/spend-requests.module';
import { BillingModule } from './billing/billing.module';
import { ReportsModule } from './reports/reports.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AuditModule } from './audit/audit.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),
    PrismaModule,
    AuthModule,
    UsersModule,
    OrganizationsModule,
    DepartmentsModule,
    ToolsModule,
    BudgetsModule,
    SpendRequestsModule,
    BillingModule,
    ReportsModule,
    NotificationsModule,
    AuditModule,
    SchedulerModule,
    IntegrationsModule,
    HealthModule,
  ],
})
export class AppModule {}
