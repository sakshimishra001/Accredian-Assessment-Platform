-- CreateEnum
CREATE TYPE "CalculatorType" AS ENUM ('BASIC', 'SCIENTIFIC');

-- AlterTable
ALTER TABLE "assessments" ADD COLUMN     "calculatorEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "calculatorType" "CalculatorType" NOT NULL DEFAULT 'BASIC';
