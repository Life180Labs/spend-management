/**
 * One-off backfill: logs a PAID BillingRecord for a tool's most recently *completed*
 * calendar month, using the same fetchHistoricalSpendUSD path the monthly cron
 * (SchedulerService.recordCompletedMonthUsageBilling) uses going forward. Needed because
 * that cron only runs from now on - it can't retroactively fill months that already
 * closed before it existed.
 *
 * Usage: DATABASE_URL="postgresql://spm_user:spm_pass@localhost:5433/spend_management" \
 *   npx ts-node scripts/backfill-billing.ts <toolId>
 */
import { PrismaClient } from '@prisma/client';
import { RailwayProvider } from '../src/integrations/providers/railway.provider';
import { ClaudeProvider } from '../src/integrations/providers/claude.provider';

const PROVIDERS: Record<string, { fetchHistoricalSpendUSD: (config: any, range: { startDate: Date; endDate: Date }) => Promise<{ amountUSD: number }> }> = {
  RAILWAY: new RailwayProvider(),
  CLAUDE: new ClaudeProvider(),
};

function formatMonthLabel(monthKey: string): string {
  const [year, month] = monthKey.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[parseInt(month) - 1]} ${year}`;
}

async function main() {
  const toolId = process.argv[2];
  if (!toolId) {
    console.error('Usage: ts-node scripts/backfill-billing.ts <toolId>');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const tool = await prisma.tool.findUnique({ where: { id: toolId }, include: { integration: true } });
    if (!tool) throw new Error(`Tool ${toolId} not found`);
    if (!tool.integration?.isActive) throw new Error(`Tool ${tool.name} has no active integration`);

    const provider = PROVIDERS[tool.integration.provider];
    if (!provider) throw new Error(`No provider registered for ${tool.integration.provider}`);

    const now = new Date();
    const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfPrevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfPrevMonth = new Date(startOfThisMonth.getTime() - 1);
    const monthKey = `${startOfPrevMonth.getFullYear()}-${String(startOfPrevMonth.getMonth() + 1).padStart(2, '0')}`;

    console.log(`Fetching ${tool.integration.provider} spend for ${tool.name}, ${monthKey}...`);
    const { amountUSD } = await provider.fetchHistoricalSpendUSD(
      tool.integration.config as Record<string, any>,
      { startDate: startOfPrevMonth, endDate: startOfThisMonth },
    );
    console.log(`  → $${amountUSD.toFixed(2)}`);

    const record = await prisma.billingRecord.upsert({
      where: { orgId_toolId_monthKey: { orgId: tool.orgId, toolId: tool.id, monthKey } },
      update: { amount: amountUSD, status: 'PAID', paidAt: endOfPrevMonth },
      create: {
        orgId: tool.orgId,
        toolId: tool.id,
        toolSnapshotJson: { name: tool.name, vendor: tool.vendor, category: tool.category },
        monthKey,
        monthLabel: formatMonthLabel(monthKey),
        amount: amountUSD,
        status: 'PAID',
        paidAt: endOfPrevMonth,
      },
    });

    console.log(`Recorded billing record ${record.id} for ${tool.name} — ${monthKey}: $${amountUSD.toFixed(2)} (PAID)`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
