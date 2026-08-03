/**
 * Real end-to-end pipeline test for the GCP integration, against the real local DB
 * and real service classes - only the external BigQuery call is faked (via a
 * temporary monkey-patch of GCPProvider.prototype.fetchSpendUSD), since no real GCP
 * credentials exist yet. Everything else - ToolsService, IntegrationsService,
 * IntegrationRunnerService, ReportsService - runs for real.
 *
 * Creates a real (temporary) tool + integration, runs a real sync, verifies every
 * downstream consumer (tools list API shape, dashboard KPIs, period-spend-by-tool)
 * reflects it correctly, then deletes everything it created - no fake data left
 * behind in the real dashboard.
 */
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { ToolsService } from '../src/tools/tools.service';
import { IntegrationsService } from '../src/integrations/integrations.service';
import { IntegrationRunnerService, PROVIDERS } from '../src/integrations/integration-runner.service';
import { ReportsService } from '../src/reports/reports.service';
import { GCPProvider } from '../src/integrations/providers/gcp.provider';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`✓ ${message}`);
}

async function main() {
  const prisma = new PrismaService();
  await prisma.$connect();
  const audit = new AuditService(prisma);
  const tools = new ToolsService(prisma, audit);
  const runner = new IntegrationRunnerService(prisma);
  const integrations = new IntegrationsService(prisma, runner);
  const reports = new ReportsService(prisma);

  const org = await prisma.organization.findFirst();
  const dept = await prisma.department.findFirst();
  if (!org || !dept) throw new Error('No organization/department found - run the seed first.');

  // Fake the one thing we can't have yet: a real BigQuery response. Everything else
  // downstream runs against the real database via the real service classes.
  const gcpProvider = PROVIDERS.GCP as GCPProvider;
  const originalFetchSpendUSD = gcpProvider.fetchSpendUSD.bind(gcpProvider);
  gcpProvider.fetchSpendUSD = async () => ({ amountUSD: 23.47 });

  let createdToolId: string | null = null;

  try {
    console.log('--- 1. Create a real GCP tool via the real ToolsService ---');
    const tool = await tools.create(org.id, 'test-script', {
      name: 'GCP Prod (test)',
      vendor: 'Google Cloud',
      category: 'CLOUD_INFRA' as any,
      paymentKind: 'PREPAID' as any,
      departmentId: dept.id,
      capAmount: 100,
      alertThresholdPct: 80,
      triggerEmail: 'admin@life180labs.com',
    } as any);
    createdToolId = tool.id;
    assert(!!tool.id, 'tool created');

    console.log('\n--- 2. Connect the GCP integration via the real IntegrationsService ---');
    await integrations.upsert(tool.id, org.id, {
      provider: 'GCP',
      config: {
        serviceAccountJson: JSON.stringify({ client_email: 'sa@test.iam.gserviceaccount.com', private_key: 'fake' }),
        gcpProjectId: 'test-billing-project',
        datasetId: 'spend_management_dataset',
        tableName: 'gcp_billing_export_v1_TEST',
        billingAccountId: '000000-000000-000000',
      },
    });
    const savedIntegration = await integrations.get(tool.id, org.id);
    assert(savedIntegration?.provider === 'GCP', 'integration saved with provider=GCP');
    // Config masking must not crash on GCP's multi-field config shape.
    assert(typeof savedIntegration?.config.serviceAccountJson === 'string', 'masked config still has a serviceAccountJson field');

    console.log('\n--- 3. Run a real sync via IntegrationRunnerService (BigQuery call faked, everything else real) ---');
    const rawIntegration = await prisma.toolIntegration.findUnique({ where: { toolId: tool.id } });
    await runner.runOne(rawIntegration!);

    const toolAfterSync = await tools.findOne(tool.id, org.id);
    assert(toolAfterSync.usedAmount === 23.47, `usedAmount synced correctly (got ${toolAfterSync.usedAmount})`);
    assert(toolAfterSync.barPct === 23, `barPct computed correctly from cap ($100): got ${toolAfterSync.barPct}%`);

    const integrationAfterSync = await prisma.toolIntegration.findUnique({ where: { toolId: tool.id } });
    assert(integrationAfterSync?.lastSyncAmountUSD === 23.47, 'lastSyncAmountUSD persisted');
    assert(integrationAfterSync?.lastSyncRemainingBalanceUSD === null, 'lastSyncRemainingBalanceUSD is explicitly null (GCP has no wallet balance) - not left untouched');
    assert(integrationAfterSync?.lastError === null, 'no lastError after a successful sync');
    // GCP never returns providerState, so config must be byte-for-byte untouched by the sync.
    assert(
      JSON.stringify(integrationAfterSync?.config) === JSON.stringify(rawIntegration!.config),
      'config left completely untouched by the sync (GCP has no providerState to persist)',
    );

    console.log('\n--- 4. Verify the tools list API shape (what the frontend actually receives) ---');
    const list = await tools.list(org.id, {});
    const listedTool = list.find((t: any) => t.id === tool.id);
    assert(!!listedTool, 'tool appears in the real tools list');
    assert(listedTool.integration.provider === 'GCP', 'listed tool has integration.provider = GCP');
    assert(listedTool.integration.lastSyncRemainingBalanceUSD === null, 'listed tool exposes lastSyncRemainingBalanceUSD field (null for GCP) - frontend Tool interface field present');

    console.log('\n--- 5. Verify dashboard KPIs include this tool without error ---');
    const kpis = await reports.dashboardKpis(org.id);
    assert(kpis.totalMonthlySpend >= 23.47, `dashboardKpis.totalMonthlySpend includes the new tool's spend (total: ${kpis.totalMonthlySpend})`);

    console.log('\n--- 6. Verify periodSpendByTool includes this tool for this_month ---');
    const byTool = await reports.periodSpendByTool(org.id, 'this_month');
    assert(byTool[tool.id] === 23.47, `periodSpendByTool includes this tool at the correct amount (got ${byTool[tool.id]})`);

    console.log('\n--- 7. Verify getUsageHistory dispatches to GCP correctly (fetchHistoricalSpendUSD, still faked) ---');
    gcpProvider.fetchSpendUSD = originalFetchSpendUSD; // restore for clarity, not used below
    const originalFetchHistorical = gcpProvider.fetchHistoricalSpendUSD.bind(gcpProvider);
    gcpProvider.fetchHistoricalSpendUSD = async () => ({ amountUSD: 99.99, breakdown: [], byProject: [] });
    const history = await integrations.getUsageHistory(tool.id, org.id, new Date(2026, 6, 1), new Date(2026, 7, 1));
    assert(history.amountUSD === 99.99, `getUsageHistory correctly dispatches to GCPProvider (got ${history.amountUSD})`);
    gcpProvider.fetchHistoricalSpendUSD = originalFetchHistorical;

    console.log('\n✅ ALL ASSERTIONS PASSED - GCP integration works end-to-end through the real pipeline.');
  } finally {
    gcpProvider.fetchSpendUSD = originalFetchSpendUSD;
    console.log('\n--- Cleanup: deleting the test tool (real data, not left behind) ---');
    if (createdToolId) {
      await prisma.toolIntegration.deleteMany({ where: { toolId: createdToolId } });
      await prisma.alertConfig.deleteMany({ where: { toolId: createdToolId } });
      await prisma.tool.delete({ where: { id: createdToolId } });
      console.log('✓ test tool, integration, and alert config deleted');
    }
    await prisma.$disconnect();
  }
}

main().catch((err) => { console.error('\n❌ FAILED:', err.message); process.exit(1); });
