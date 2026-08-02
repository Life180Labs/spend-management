/**
 * Read-only diagnostic: calls RailwayProvider.fetchSpendUSD with a REAL Railway
 * integration config (local DB - the same real Railway workspace/token as prod,
 * per user confirmation this issue reproduces locally too) to see which code
 * path executes (Path A: direct billing via customer.currentUsage, vs Path C:
 * calendar-month reconstruction fallback) and what each would return. Makes no
 * writes to the DB or to Railway.
 *
 * Usage: npx ts-node scripts/diagnose-prod-railway.ts
 */
import { PrismaClient } from '@prisma/client';
import { RailwayProvider } from '../src/integrations/providers/railway.provider';

async function main() {
  const prod = new PrismaClient(); // local .env DATABASE_URL
  const integration = await prod.toolIntegration.findFirst({ where: { provider: 'RAILWAY', isActive: true } });
  if (!integration) throw new Error('No Railway integration found in prod.');

  console.log('Integration found. lastSyncAt:', integration.lastSyncAt, 'lastSyncAmountUSD:', integration.lastSyncAmountUSD);

  const config = integration.config as any;
  const apiToken = config.apiToken;
  console.log('Token prefix:', apiToken?.slice(0, 8) + '...');

  // Directly probe Path A (direct billing) to see if it succeeds or falls through.
  const RAILWAY_GQL = 'https://backboard.railway.app/graphql/v2';
  const h = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` };
  const billingQuery = `query { me { workspaces { name customer { currentUsage } } } }`;
  const resp = await fetch(RAILWAY_GQL, { method: 'POST', headers: h, body: JSON.stringify({ query: billingQuery }) });
  const json: any = await resp.json();
  console.log('\nPath A (direct billing) raw response:', JSON.stringify(json, null, 2));

  console.log('\n--- Now calling the real RailwayProvider.fetchSpendUSD (same path the sync cron uses) ---');
  const provider = new RailwayProvider();
  const result = await provider.fetchSpendUSD(config);
  console.log('Result:', JSON.stringify(result, null, 2));

  await prod.$disconnect();
}

main().catch((err) => { console.error('ERROR:', err.message); process.exit(1); });
