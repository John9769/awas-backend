-- CreateEnum
CREATE TYPE "SubStatus" AS ENUM ('ACTIVE', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "InstitutionType" AS ENUM ('INSURANCE', 'LAWYER');

-- CreateEnum
CREATE TYPE "VehicleType" AS ENUM ('CAR', 'MOTORCYCLE');

-- CreateTable
CREATE TABLE "drivers" (
    "id" SERIAL NOT NULL,
    "vehicle_plate" TEXT NOT NULL,
    "vehicle_make_model" TEXT NOT NULL,
    "vehicle_type" "VehicleType" NOT NULL DEFAULT 'CAR',
    "mykad_last_four" TEXT NOT NULL,
    "phone" TEXT,
    "sub_status" "SubStatus" NOT NULL DEFAULT 'ACTIVE',
    "sub_expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drivers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accident_logs" (
    "id" SERIAL NOT NULL,
    "log_hash" TEXT NOT NULL,
    "vehicle_plate" TEXT NOT NULL,
    "latitude" DECIMAL(10,8) NOT NULL,
    "longitude" DECIMAL(11,8) NOT NULL,
    "video_url" TEXT NOT NULL,
    "is_report_paid" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accident_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_requests" (
    "id" SERIAL NOT NULL,
    "log_hash" TEXT NOT NULL,
    "institutional_user_id" INTEGER,
    "requester_type" "InstitutionType" NOT NULL,
    "company_name" TEXT NOT NULL,
    "case_reference_no" TEXT NOT NULL,
    "approval_status" "RequestStatus" NOT NULL DEFAULT 'PENDING',
    "driver_approved_at" TIMESTAMP(3),
    "is_payment_settled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "institutional_users" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "company_name" TEXT NOT NULL,
    "requester_type" "InstitutionType" NOT NULL,
    "license_id" TEXT NOT NULL,
    "is_approved" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "institutional_users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "drivers_vehicle_plate_key" ON "drivers"("vehicle_plate");

-- CreateIndex
CREATE UNIQUE INDEX "accident_logs_log_hash_key" ON "accident_logs"("log_hash");

-- CreateIndex
CREATE INDEX "verification_requests_log_hash_idx" ON "verification_requests"("log_hash");

-- CreateIndex
CREATE UNIQUE INDEX "institutional_users_email_key" ON "institutional_users"("email");

-- AddForeignKey
ALTER TABLE "accident_logs" ADD CONSTRAINT "accident_logs_vehicle_plate_fkey" FOREIGN KEY ("vehicle_plate") REFERENCES "drivers"("vehicle_plate") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_requests" ADD CONSTRAINT "verification_requests_log_hash_fkey" FOREIGN KEY ("log_hash") REFERENCES "accident_logs"("log_hash") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_requests" ADD CONSTRAINT "verification_requests_institutional_user_id_fkey" FOREIGN KEY ("institutional_user_id") REFERENCES "institutional_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
