-- CreateTable
CREATE TABLE `arquivos` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `tipo` ENUM('ARQUIVO', 'LINK') NOT NULL DEFAULT 'ARQUIVO',
    `nome` VARCHAR(191) NOT NULL,
    `mimeType` VARCHAR(191) NULL,
    `tamanho` INTEGER NULL,
    `chave` VARCHAR(191) NULL,
    `url` TEXT NULL,
    `criadoEm` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `escritorioId` INTEGER NOT NULL,
    `projetoId` INTEGER NOT NULL,
    `etapaId` INTEGER NULL,
    `enviadoPorId` INTEGER NULL,

    INDEX `arquivos_escritorioId_idx`(`escritorioId`),
    INDEX `arquivos_projetoId_idx`(`projetoId`),
    INDEX `arquivos_etapaId_idx`(`etapaId`),
    INDEX `arquivos_enviadoPorId_idx`(`enviadoPorId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `arquivos` ADD CONSTRAINT `arquivos_escritorioId_fkey` FOREIGN KEY (`escritorioId`) REFERENCES `escritorios`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `arquivos` ADD CONSTRAINT `arquivos_projetoId_fkey` FOREIGN KEY (`projetoId`) REFERENCES `projetos`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `arquivos` ADD CONSTRAINT `arquivos_etapaId_fkey` FOREIGN KEY (`etapaId`) REFERENCES `etapas`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `arquivos` ADD CONSTRAINT `arquivos_enviadoPorId_fkey` FOREIGN KEY (`enviadoPorId`) REFERENCES `usuarios`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
