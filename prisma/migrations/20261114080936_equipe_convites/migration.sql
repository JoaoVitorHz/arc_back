-- DropForeignKey
ALTER TABLE `usuarios` DROP FOREIGN KEY `usuarios_escritorioId_fkey`;

-- AlterTable
ALTER TABLE `escritorios` ADD COLUMN `encerradoEm` DATETIME(3) NULL,
    ADD COLUMN `encerradoPorId` INTEGER NULL;

-- AlterTable
ALTER TABLE `usuarios` ADD COLUMN `deveTrocarSenha` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `papel` ENUM('ADMIN', 'MEMBRO') NOT NULL DEFAULT 'ADMIN',
    MODIFY `escritorioId` INTEGER NULL;

-- CreateTable
CREATE TABLE `convites` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `nome` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `papel` ENUM('ADMIN', 'MEMBRO') NOT NULL DEFAULT 'MEMBRO',
    `tokenHash` VARCHAR(191) NOT NULL,
    `expiraEm` DATETIME(3) NOT NULL,
    `aceitoEm` DATETIME(3) NULL,
    `criadoEm` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `escritorioId` INTEGER NOT NULL,
    `convidadoPorId` INTEGER NULL,

    UNIQUE INDEX `convites_tokenHash_key`(`tokenHash`),
    INDEX `convites_escritorioId_idx`(`escritorioId`),
    INDEX `convites_email_idx`(`email`),
    INDEX `convites_convidadoPorId_idx`(`convidadoPorId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `escritorios_encerradoPorId_idx` ON `escritorios`(`encerradoPorId`);

-- AddForeignKey
ALTER TABLE `escritorios` ADD CONSTRAINT `escritorios_encerradoPorId_fkey` FOREIGN KEY (`encerradoPorId`) REFERENCES `usuarios`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `usuarios` ADD CONSTRAINT `usuarios_escritorioId_fkey` FOREIGN KEY (`escritorioId`) REFERENCES `escritorios`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `convites` ADD CONSTRAINT `convites_escritorioId_fkey` FOREIGN KEY (`escritorioId`) REFERENCES `escritorios`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `convites` ADD CONSTRAINT `convites_convidadoPorId_fkey` FOREIGN KEY (`convidadoPorId`) REFERENCES `usuarios`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
