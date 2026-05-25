/*
  Warnings:

  - A unique constraint covering the columns `[referral_code]` on the table `drivers` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `referral_code` to the `drivers` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED');

-- CreateEnum
CREATE TYPE "PaymentType" AS ENUM ('REGISTRATION', 'RENEWAL', 'WRIT');

-- CreateEnum
CREATE TYPE "AffiliatePayoutStatus" AS ENUM ('PENDING', 'PROCESSING', 'PAID');

-- AlterTable
ALTER TABLE "drivers" ADD COLUMN "referral_code" TEXT;
ALTER TABLE "drivers" ADD COLUMN "referred_by_code" TEXT;
UPDATE "drivers" SET "referral_code" = CONCAT('AWAS', UPPER(SUBSTRING(MD5(RANDOM()::TEXT), 1, 4))) WHERE "referral_code" IS NULL;
ALTER TABLE "drivers" ALTER COLUMN "referral_code" SET NOT NULL;

-- CreateTable
CREATE TABLE "payments" (
    "id" SERIAL NOT NULL,
    "vehicle_plate" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "type" "PaymentType" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "billplz_bill_id" TEXT,
    "billplz_url" TEXT,
    "paid_at" TIMESTAMP(3),
    "referral_code" TEXT,
    "affiliate_cut" DECIMAL(10,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "affiliates" (
    "id" SERIAL NOT NULL,
    "driver_id" INTEGER NOT NULL,
    "referral_code" TEXT NOT NULL,
    "total_referrals" INTEGER NOT NULL DEFAULT 0,
    "total_earnings" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "pending_payout" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "paid_out" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "bank_name" TEXT,
    "bank_account_number" TEXT,
    "bank_account_name" TEXT,
    "duitnow_number" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "affiliates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "affiliate_earnings" (
    "id" SERIAL NOT NULL,
    "affiliate_id" INTEGER NOT NULL,
    "payment_id" INTEGER NOT NULL,
    "referred_plate" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "type" "PaymentType" NOT NULL,
    "is_paid" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "affiliate_earnings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "affiliate_payouts" (
    "id" SERIAL NOT NULL,
    "affiliate_id" INTEGER NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" "AffiliatePayoutStatus" NOT NULL DEFAULT 'PENDING',
    "method" TEXT,
    "reference" TEXT,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "affiliate_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payments_billplz_bill_id_key" ON "payments"("billplz_bill_id");

-- CreateIndex
CREATE UNIQUE INDEX "affiliates_driver_id_key" ON "affiliates"("driver_id");

-- CreateIndex
CREATE UNIQUE INDEX "affiliates_referral_code_key" ON "affiliates"("referral_code");

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_earnings_payment_id_key" ON "affiliate_earnings"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "drivers_referral_code_key" ON "drivers"("referral_code");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_vehicle_plate_fkey" FOREIGN KEY ("vehicle_plate") REFERENCES "drivers"("vehicle_plate") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliates" ADD CONSTRAINT "affiliates_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_earnings" ADD CONSTRAINT "affiliate_earnings_affiliate_id_fkey" FOREIGN KEY ("affiliate_id") REFERENCES "affiliates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_earnings" ADD CONSTRAINT "affiliate_earnings_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_payouts" ADD CONSTRAINT "affiliate_payouts_affiliate_id_fkey" FOREIGN KEY ("affiliate_id") REFERENCES "affiliates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
