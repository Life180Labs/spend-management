import { PrismaService } from '../src/prisma/prisma.service';
import { ReportsService } from '../src/reports/reports.service';

async function main() {
  const prisma = new PrismaService();
  await prisma.$connect();
  const reports = new ReportsService(prisma);

  const org = await prisma.organization.findFirst();
  const kpis = await reports.dashboardKpis(org!.id);
  console.log('totalMonthlySpend:', kpis.totalMonthlySpend);
  console.log('Expect ~= 20 (Claude) + 10/12 (Namecheap yearly) + 16.24 (Railway) = ~37.07');

  await prisma.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
