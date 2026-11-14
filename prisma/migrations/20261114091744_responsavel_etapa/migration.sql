-- AlterTable
ALTER TABLE `etapas` ADD COLUMN `responsavelId` INTEGER NULL;

-- CreateIndex
CREATE INDEX `etapas_responsavelId_idx` ON `etapas`(`responsavelId`);

-- AddForeignKey
ALTER TABLE `etapas` ADD CONSTRAINT `etapas_responsavelId_fkey` FOREIGN KEY (`responsavelId`) REFERENCES `usuarios`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
