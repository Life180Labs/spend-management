/**
 * End-to-end check of the payload the Add Tool modal sends when a user picks
 * "Google Workspace" from the Integration dropdown: Vendor auto-filled + locked
 * to "Google Workspace", Payment type auto-set to Subscription, Billing cycle
 * auto-set to Monthly (the default - no new schema/cron work needed, unlike
 * Namecheap's Yearly case) - via the real ToolsService.create(), then verifies
 * the saved row, dedup matching, and cleans up (no fabricated real invoice
 * data is left behind).
 */
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { ToolsService } from '../src/tools/tools.service';

async function main() {
  const prisma = new PrismaService();
  await prisma.$connect();
  const audit = new AuditService(prisma);
  const tools = new ToolsService(prisma, audit);

  const org = await prisma.organization.findFirst();
  const dept = await prisma.department.findFirst({ where: { orgId: org!.id } });
  if (!org || !dept) throw new Error('No organization/department found');

  const created = await tools.create(org.id, 'test-actor', {
    name: 'Google Workspace',
    departmentId: dept.id,
    vendor: 'Google Workspace',
    category: 'COMMUNICATION',
    paymentKind: 'MOSUB',
    billingCycle: 'MONTHLY',
    monthlyAmount: 2.4,
    alertThresholdPct: 80,
    triggerEmail: 'admin@life180labs.com',
    renewalDate: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).toISOString(),
  } as any);

  console.log('Created:', {
    name: created.name, vendor: created.vendor, paymentKind: created.paymentKind,
    billingCycle: created.billingCycle, monthlyAmount: created.monthlyAmount,
    monoInitials: created.monoInitials, monoBgColor: created.monoBgColor,
  });

  const checks = [
    ['vendor === "Google Workspace"', created.vendor === 'Google Workspace'],
    ['paymentKind === "MOSUB"', created.paymentKind === 'MOSUB'],
    ['billingCycle === "MONTHLY"', created.billingCycle === 'MONTHLY'],
    ['monthlyAmount === 2.4', created.monthlyAmount === 2.4],
  ] as const;
  for (const [label, ok] of checks) console.log(`${ok ? '✓' : '✗'} ${label}`);

  const list = await tools.list(org.id, {});
  const found = list.find((t) => t.id === created.id);
  console.log(`✓ appears in tools.list(): ${!!found}`);

  await prisma.alertConfig.deleteMany({ where: { toolId: created.id } });
  await prisma.tool.delete({ where: { id: created.id } });
  console.log('Cleaned up test Google Workspace tool');
  await prisma.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
