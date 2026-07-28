-- CreateEnum
CREATE TYPE "BillingCycle" AS ENUM ('MONTHLY', 'YEARLY');

-- AlterTable
ALTER TABLE "tools" ADD COLUMN "billingCycle" "BillingCycle" NOT NULL DEFAULT 'MONTHLY';
