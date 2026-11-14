-- AlterTable
ALTER TABLE `usuarios` ADD COLUMN `tokensValidosApos` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `tokens_redefinicao_senha` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `tokenHash` VARCHAR(191) NOT NULL,
    `expiraEm` DATETIME(3) NOT NULL,
    `usadoEm` DATETIME(3) NULL,
    `criadoEm` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `usuarioId` INTEGER NOT NULL,

    UNIQUE INDEX `tokens_redefinicao_senha_tokenHash_key`(`tokenHash`),
    INDEX `tokens_redefinicao_senha_usuarioId_idx`(`usuarioId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `tokens_redefinicao_senha` ADD CONSTRAINT `tokens_redefinicao_senha_usuarioId_fkey` FOREIGN KEY (`usuarioId`) REFERENCES `usuarios`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
