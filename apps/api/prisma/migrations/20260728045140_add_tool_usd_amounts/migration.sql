-- AlterTable
ALTER TABLE "tool_integrations" ALTER COLUMN "config" DROP DEFAULT,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "tools" ADD COLUMN     "capAmountUSD" DOUBLE PRECISION,
ADD COLUMN     "usedAmountUSD" DOUBLE PRECISION;
