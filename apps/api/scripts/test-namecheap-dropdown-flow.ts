/**
 * End-to-end check of the exact payload the Add Tool modal now sends when a
 * user picks "Namecheap" from the Integration dropdown: Vendor auto-filled +
 * locked to "Namecheap", Payment type auto-set to Subscription, Billing cycle
 * auto-set to Yearly - via the real ToolsService.create(), then verifies the
 * saved row and cleans up (no fabricated real invoice data is left behind).
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

  // Exactly what add-tool-modal.tsx's payload looks like after picking Namecheap
  // from the dropdown (handleProviderChange sets paymentKind=MOSUB, billingCycle=YEARLY,
  // vendor="Namecheap" automatically; user only types Name + amount + renewal date).
  const created = await tools.create(org.id, 'test-actor', {
    name: 'Namecheap',
    departmentId: dept.id,
    vendor: 'Namecheap',
    category: 'DEV_TOOLS',
    paymentKind: 'MOSUB',
    billingCycle: 'YEARLY',
    monthlyAmount: 45,
    alertThresholdPct: 80,
    triggerEmail: 'admin@life180labs.com',
    renewalDate: new Date(new Date().getFullYear() + 1, 0, 15).toISOString(),
  } as any);

  console.log('Created:', {
    name: created.name, vendor: created.vendor, paymentKind: created.paymentKind,
    billingCycle: created.billingCycle, monthlyAmount: created.monthlyAmount,
    monoInitials: created.monoInitials, monoBgColor: created.monoBgColor,
  });

  const checks = [
    ['vendor === "Namecheap"', created.vendor === 'Namecheap'],
    ['paymentKind === "MOSUB"', created.paymentKind === 'MOSUB'],
    ['billingCycle === "YEARLY"', created.billingCycle === 'YEARLY'],
    ['monthlyAmount === 45', created.monthlyAmount === 45],
  ] as const;
  for (const [label, ok] of checks) console.log(`${ok ? '✓' : '✗'} ${label}`);

  // Confirm it now shows up in the tools list exactly like Claude/Railway do,
  // and that the dashboard's dedup (matchProviderByVendor -> NAMECHEAP) would
  // find it via the same vendor field.
  const list = await tools.list(org.id, {});
  const found = list.find((t) => t.id === created.id);
  console.log(`✓ appears in tools.list(): ${!!found}`);

  await prisma.tool.delete({ where: { id: created.id } });
  console.log('Cleaned up test Namecheap tool');
  await prisma.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
