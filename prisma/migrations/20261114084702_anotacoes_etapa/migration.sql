-- AlterTable
ALTER TABLE `etapas` ADD COLUMN `descricao` TEXT NULL,
    ADD COLUMN `descricaoEditadaEm` DATETIME(3) NULL,
    ADD COLUMN `descricaoEditadaPorId` INTEGER NULL;

-- CreateIndex
CREATE INDEX `etapas_descricaoEditadaPorId_idx` ON `etapas`(`descricaoEditadaPorId`);

-- AddForeignKey
ALTER TABLE `etapas` ADD CONSTRAINT `etapas_descricaoEditadaPorId_fkey` FOREIGN KEY (`descricaoEditadaPorId`) REFERENCES `usuarios`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
