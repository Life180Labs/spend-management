import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  const tools = await prisma.tool.findMany({
    where: { paymentKind: { in: ['MOSUB', 'CAPSUB'] }, deletedAt: null },
    select: { id: true, name: true, renewalDate: true, billingCycle: true, monthlyAmount: true },
  });
  const now = new Date();
  console.log('Server "now":', now.toISOString(), '(local:', now.toString(), ')');
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  console.log('startOfToday used by rollForwardRenewalDates:', startOfToday.toISOString());
  console.log();
  for (const t of tools) {
    console.log(JSON.stringify({
      name: t.name,
      renewalDate: t.renewalDate,
      billingCycle: t.billingCycle,
      pastDue: t.renewalDate ? new Date(t.renewalDate) < startOfToday : null,
    }));
  }
  await prisma.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
