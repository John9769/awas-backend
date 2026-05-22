/*
  Warnings:

  - A unique constraint covering the columns `[consent_token]` on the table `verification_requests` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "verification_requests" ADD COLUMN     "consent_token" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "verification_requests_consent_token_key" ON "verification_requests"("consent_token");
