/**
 * Regression check: confirms IntegrationsService's provider dispatch (fetchLimits,
 * getUsageHistory) correctly routes to ClaudeProvider via the PROVIDERS map -
 * not hardcoded to RAILWAY, and not silently falling through. Uses a synthetic
 * CLAUDE integration with a deliberately invalid key (no real Admin API key
 * available in this environment) - the point is to prove correct *dispatch*
 * and graceful error surfacing, not to validate real Anthropic API data.
 * Cleans up its own test data.
 */
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { IntegrationRunnerService } from '../src/integrations/integration-runner.service';
import { IntegrationsService } from '../src/integrations/integrations.service';

async function main() {
  const prisma = new PrismaService();
  await prisma.$connect();
  const audit = new AuditService(prisma);
  void audit;
  const runner = new IntegrationRunnerService(prisma);
  const integrations = new IntegrationsService(prisma, runner);

  const org = await prisma.organization.findFirst();
  const dept = await prisma.department.findFirst({ where: { orgId: org!.id } });
  if (!org || !dept) throw new Error('No organization/department found');

  const tool = await prisma.tool.create({
    data: {
      orgId: org.id, departmentId: dept.id,
      name: '__test_claude_dispatch__', vendor: 'Anthropic',
      paymentKind: 'PREPAID', monoInitials: 'CD', monoBgColor: '#DE7C1A',
    },
  });

  try {
    await integrations.upsert(tool.id, org.id, {
      provider: 'CLAUDE',
      config: { adminApiKey: 'sk-ant-admin01-fake-test-key' },
    });
    console.log(`Created test CLAUDE integration for tool ${tool.id}`);

    console.log('\n--- fetchLimits (should return null - ClaudeProvider has no fetchLimitsUSD) ---');
    const limits = await integrations.fetchLimits(tool.id, org.id);
    console.log('Result:', limits, limits === null ? '✓ correctly null, no crash' : '✗ UNEXPECTED');

    console.log('\n--- previewLimits (provider=CLAUDE, should also return null) ---');
    const preview = await integrations.previewLimits('CLAUDE', { adminApiKey: 'sk-ant-admin01-fake' });
    console.log('Result:', preview, preview === null ? '✓ correctly null, no crash' : '✗ UNEXPECTED');

    console.log('\n--- getUsageHistory (should reach ClaudeProvider.fetchHistoricalSpendUSD and fail on the fake key with a real Anthropic error, not a dispatch error) ---');
    try {
      const now = new Date();
      await integrations.getUsageHistory(tool.id, org.id, new Date(now.getFullYear(), now.getMonth(), 1), now);
      console.log('✗ UNEXPECTED: call succeeded with a fake key');
    } catch (err: any) {
      const reachedProvider = /invalid|authentication|api key|unauthorized|401|403/i.test(err.message);
      console.log(`Error: ${err.message}`);
      console.log(reachedProvider
        ? '✓ correctly reached Anthropic and got an auth error (dispatch worked - not a "provider not found" or Railway-shaped error)'
        : '✗ error does not look like a genuine Anthropic auth failure - check dispatch');
    }
  } finally {
    await prisma.toolIntegration.deleteMany({ where: { toolId: tool.id } });
    await prisma.tool.delete({ where: { id: tool.id } });
    console.log(`\nCleaned up test tool ${tool.id}`);
    await prisma.$disconnect();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
