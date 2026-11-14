-- AlterTable
ALTER TABLE `arquivos` ADD COLUMN `revisaoNumero` INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `etapas` ADD COLUMN `revisaoAtual` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `revisoesPrevistas` INTEGER NULL;

-- CreateTable
CREATE TABLE `revisoes_etapa` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `numero` INTEGER NOT NULL,
    `enviadaEm` DATE NULL,
    `meioEnvio` ENUM('WHATSAPP', 'EMAIL', 'REUNIAO', 'OUTRO') NULL,
    `observacaoEnvio` TEXT NULL,
    `pedidoAlteracao` TEXT NULL,
    `pedidoEm` DATE NULL,
    `aprovadaEm` DATE NULL,
    `observacaoAprovacao` TEXT NULL,
    `criadoEm` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `atualizadoEm` DATETIME(3) NOT NULL,
    `etapaId` INTEGER NOT NULL,
    `enviadaPorId` INTEGER NULL,
    `pedidoPorId` INTEGER NULL,
    `aprovadaPorId` INTEGER NULL,

    INDEX `revisoes_etapa_enviadaPorId_idx`(`enviadaPorId`),
    INDEX `revisoes_etapa_pedidoPorId_idx`(`pedidoPorId`),
    INDEX `revisoes_etapa_aprovadaPorId_idx`(`aprovadaPorId`),
    UNIQUE INDEX `revisoes_etapa_etapaId_numero_key`(`etapaId`, `numero`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `revisoes_etapa` ADD CONSTRAINT `revisoes_etapa_etapaId_fkey` FOREIGN KEY (`etapaId`) REFERENCES `etapas`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `revisoes_etapa` ADD CONSTRAINT `revisoes_etapa_enviadaPorId_fkey` FOREIGN KEY (`enviadaPorId`) REFERENCES `usuarios`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `revisoes_etapa` ADD CONSTRAINT `revisoes_etapa_pedidoPorId_fkey` FOREIGN KEY (`pedidoPorId`) REFERENCES `usuarios`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `revisoes_etapa` ADD CONSTRAINT `revisoes_etapa_aprovadaPorId_fkey` FOREIGN KEY (`aprovadaPorId`) REFERENCES `usuarios`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
