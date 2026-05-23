/*
  Warnings:

  - A unique constraint covering the columns `[writ_number]` on the table `accident_logs` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[other_vehicle_hash]` on the table `accident_logs` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "RoadCondition" AS ENUM ('DRY', 'WET', 'FLOODED', 'UNDER_CONSTRUCTION', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "WeatherCondition" AS ENUM ('CLEAR', 'RAINY', 'FOGGY', 'HAZY', 'NIGHT', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "InjuryStatus" AS ENUM ('NONE', 'MINOR', 'SERIOUS');

-- AlterTable
ALTER TABLE "accident_logs" ADD COLUMN     "emergency_alert_sent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "incident_description" TEXT,
ADD COLUMN     "injury_status" "InjuryStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "other_vehicle_hash" TEXT,
ADD COLUMN     "other_vehicle_make_model" TEXT,
ADD COLUMN     "other_vehicle_plate" TEXT,
ADD COLUMN     "other_vehicle_video_url" TEXT,
ADD COLUMN     "road_condition" "RoadCondition" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "weather_condition" "WeatherCondition" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "writ_number" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "accident_logs_writ_number_key" ON "accident_logs"("writ_number");

-- CreateIndex
CREATE UNIQUE INDEX "accident_logs_other_vehicle_hash_key" ON "accident_logs"("other_vehicle_hash");
