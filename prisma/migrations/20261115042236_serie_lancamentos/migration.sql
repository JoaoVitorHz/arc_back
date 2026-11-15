-- AlterTable
ALTER TABLE `lancamentos` ADD COLUMN `serieId` VARCHAR(36) NULL;

-- CreateIndex
CREATE INDEX `lancamentos_serieId_idx` ON `lancamentos`(`serieId`);
