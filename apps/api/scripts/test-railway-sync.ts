/**
 * Regression check: runs the real IntegrationRunnerService.runOne() against the
 * live Railway integration to confirm the sync pipeline still works unchanged
 * after the billingCycle schema/migration work (which touched Tool + Scheduler,
 * not the integration runner, but this proves it end-to-end rather than by
 * code inspection alone).
 */
import { PrismaService } from '../src/prisma/prisma.service';
import { IntegrationRunnerService } from '../src/integrations/integration-runner.service';

async function main() {
  const prisma = new PrismaService();
  await prisma.$connect();
  const runner = new IntegrationRunnerService(prisma);

  const integration = await prisma.toolIntegration.findFirst({
    where: { provider: 'RAILWAY', isActive: true, tool: { deletedAt: null } },
    include: { tool: true },
  });
  if (!integration) throw new Error('No active Railway integration found');

  console.log(`Before: usedAmount=$${integration.tool.usedAmount}, lastSyncAt=${integration.lastSyncAt}`);
  await runner.runOne(integration);

  const after = await prisma.tool.findUnique({ where: { id: integration.toolId } });
  const integrationAfter = await prisma.toolIntegration.findUnique({ where: { id: integration.id } });
  console.log(`After:  usedAmount=$${after!.usedAmount}, barPct=${after!.barPct}, lastSyncAt=${integrationAfter!.lastSyncAt}`);
  console.log(`lastError: ${integrationAfter!.lastError ?? '(none)'}`);
  console.log(`breakdown items: ${(integrationAfter!.lastSyncBreakdown as any[])?.length ?? 0}`);
  console.log(`byProject items: ${(integrationAfter!.lastSyncByProject as any[])?.length ?? 0}`);

  await prisma.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
