import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Create a default organization
  const org = await prisma.organization.upsert({
    where: { slug: 'default-org' },
    update: {},
    create: {
      name: 'Default Organization',
      slug: 'default-org',
      currency: 'USD',
      planTier: 'PRO',
    },
  });

  // Create a default department
  await prisma.department.upsert({
    where: { orgId_code: { orgId: org.id, code: 'DEFAULT' } },
    update: {},
    create: {
      orgId: org.id,
      name: 'Default Department',
      code: 'DEFAULT',
    },
  });

  console.log('Seed complete. Ready to sign up.');
}

main().catch(console.error).finally(() => prisma.$disconnect());
