/**
 * One-off verification script: exercises the REAL rollForwardRenewalDates cron
 * logic (not a reimplementation) against synthetic MONTHLY and YEARLY test
 * tools, to prove the billingCycle generalization didn't regress the monthly
 * path and correctly handles the yearly one. Cleans up its own test data.
 *
 * Usage: DATABASE_URL="postgresql://spm_user:spm_pass@localhost:5433/spend_management" \
 *   npx ts-node scripts/test-billing-cycle.ts
 */
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { BillingService } from '../src/billing/billing.service';
import { SchedulerService } from '../src/scheduler/scheduler.service';

async function main() {
  const prisma = new PrismaService();
  await prisma.$connect();

  const audit = new AuditService(prisma);
  const billing = new BillingService(prisma, audit);
  // mail + integrationRunner are never touched by rollForwardRenewalDates - safe to stub.
  const scheduler = new SchedulerService(prisma, null as any, null as any, billing);

  const org = await prisma.organization.findFirst();
  const dept = await prisma.department.findFirst({ where: { orgId: org!.id } });
  if (!org || !dept) throw new Error('No organization/department found - seed the DB first');

  const now = new Date();
  const testTools: { id: string; label: string }[] = [];

  try {
    // ── YEARLY test tool: renewed 13 months ago -> should roll forward exactly
    // one year and log exactly one completed cycle. ──────────────────────────
    const yearlyRenewal = new Date(now.getFullYear(), now.getMonth() - 13, 18);
    const yearlyTool = await prisma.tool.create({
      data: {
        orgId: org.id, departmentId: dept.id,
        name: '__test_namecheap_yearly__', vendor: 'Namecheap',
        paymentKind: 'MOSUB', billingCycle: 'YEARLY',
        monthlyAmount: 1200, renewalDate: yearlyRenewal,
        monoInitials: 'NC', monoBgColor: '#DE3910',
      },
    });
    testTools.push({ id: yearlyTool.id, label: 'YEARLY' });
    console.log(`Created YEARLY test tool ${yearlyTool.id}, renewalDate=${yearlyRenewal.toDateString()}`);

    // ── MONTHLY test tool: renewed 3 months ago -> should roll forward month
    // by month and log 3 completed cycles (regression check for the pre-
    // existing monthly path, using a throwaway tool rather than Claude Pro's
    // real row). ────────────────────────────────────────────────────────────
    const monthlyRenewal = new Date(now.getFullYear(), now.getMonth() - 3, 5);
    const monthlyTool = await prisma.tool.create({
      data: {
        orgId: org.id, departmentId: dept.id,
        name: '__test_monthly_regression__', vendor: 'Test Vendor',
        paymentKind: 'MOSUB', billingCycle: 'MONTHLY',
        monthlyAmount: 50, renewalDate: monthlyRenewal,
        monoInitials: 'TM', monoBgColor: '#5E6AD2',
      },
    });
    testTools.push({ id: monthlyTool.id, label: 'MONTHLY' });
    console.log(`Created MONTHLY test tool ${monthlyTool.id}, renewalDate=${monthlyRenewal.toDateString()}`);

    console.log('\nRunning the real SchedulerService.rollForwardRenewalDates()...\n');
    await scheduler.rollForwardRenewalDates();

    const yearlyAfter = await prisma.tool.findUnique({ where: { id: yearlyTool.id } });
    const yearlyRecords = await prisma.billingRecord.findMany({ where: { toolId: yearlyTool.id }, orderBy: { monthKey: 'asc' } });
    console.log('--- YEARLY result ---');
    console.log(`renewalDate: ${yearlyRenewal.toDateString()} -> ${yearlyAfter!.renewalDate!.toDateString()}`);
    console.log(`billing records created: ${yearlyRecords.length} (expect 1)`);
    yearlyRecords.forEach((r) => console.log(`  ${r.monthKey}: $${r.amount} (${r.status})`));

    const monthlyAfter = await prisma.tool.findUnique({ where: { id: monthlyTool.id } });
    const monthlyRecords = await prisma.billingRecord.findMany({ where: { toolId: monthlyTool.id }, orderBy: { monthKey: 'asc' } });
    console.log('\n--- MONTHLY result (regression check) ---');
    console.log(`renewalDate: ${monthlyRenewal.toDateString()} -> ${monthlyAfter!.renewalDate!.toDateString()}`);
    console.log(`billing records created: ${monthlyRecords.length} (expect 3)`);
    monthlyRecords.forEach((r) => console.log(`  ${r.monthKey}: $${r.amount} (${r.status})`));

    // Idempotency check: running it again right now should create zero new records
    // and leave renewalDate untouched, since both tools are now in the future.
    await scheduler.rollForwardRenewalDates();
    const yearlyRecordsAfter2ndRun = await prisma.billingRecord.count({ where: { toolId: yearlyTool.id } });
    const monthlyRecordsAfter2ndRun = await prisma.billingRecord.count({ where: { toolId: monthlyTool.id } });
    console.log('\n--- Idempotency check (2nd run, same day) ---');
    console.log(`YEARLY record count unchanged: ${yearlyRecordsAfter2ndRun === yearlyRecords.length} (${yearlyRecordsAfter2ndRun})`);
    console.log(`MONTHLY record count unchanged: ${monthlyRecordsAfter2ndRun === monthlyRecords.length} (${monthlyRecordsAfter2ndRun})`);
  } finally {
    for (const t of testTools) {
      await prisma.billingRecord.deleteMany({ where: { toolId: t.id } });
      await prisma.tool.delete({ where: { id: t.id } });
      console.log(`Cleaned up ${t.label} test tool ${t.id}`);
    }
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
