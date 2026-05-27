-- CreateEnum
CREATE TYPE "VideoStatus" AS ENUM ('PENDING', 'PROCESSING', 'VERIFIED', 'FAILED');

-- AlterTable
ALTER TABLE "accident_logs" ADD COLUMN     "raw_video_url" TEXT,
ADD COLUMN     "sealed_video_url" TEXT,
ADD COLUMN     "video_hash" TEXT,
ADD COLUMN     "video_sealed_at" TIMESTAMP(3),
ADD COLUMN     "video_status" "VideoStatus" NOT NULL DEFAULT 'PENDING';
