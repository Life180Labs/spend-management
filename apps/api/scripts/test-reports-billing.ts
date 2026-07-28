/**
 * Verifies the real ReportsService.billingHistory() output that the Reports ->
 * Billing History screen consumes, against actual current data - confirms the
 * live current-month synthesis, the Jun 2026 Railway backfill, and the schema
 * change (billingCycle) didn't break the reports pipeline.
 */
import { PrismaService } from '../src/prisma/prisma.service';
import { ReportsService } from '../src/reports/reports.service';

async function main() {
  const prisma = new PrismaService();
  await prisma.$connect();
  const reports = new ReportsService(prisma);

  const org = await prisma.organization.findFirst();
  if (!org) throw new Error('No organization found');

  const result = await reports.billingHistory(org.id, { limit: 100 });
  console.log(`Total billing rows: ${result.total}\n`);
  for (const r of result.items) {
    console.log(`${r.monthKey}  ${r.tool?.name?.padEnd(10) ?? '?'}  $${r.amount.toFixed(2)}  ${r.status}  id=${r.id}`);
  }

  await prisma.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
