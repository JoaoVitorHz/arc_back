-- AlterTable
ALTER TABLE `escritorios` ADD COLUMN `cortesiaAte` DATETIME(3) NULL,
    ADD COLUMN `testeAte` DATETIME(3) NULL,
    ADD COLUMN `ultimoUsoIaEm` DATETIME(3) NULL,
    ADD COLUMN `usosIa` INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `pagamentos_assinatura` ADD COLUMN `notaEmitidaEm` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `usuarios` ADD COLUMN `bloqueadoEm` DATETIME(3) NULL,
    ADD COLUMN `donoPlataforma` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `ultimoAcessoEm` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `acoes_admin` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `adminId` INTEGER NULL,
    `acao` VARCHAR(191) NOT NULL,
    `alvoTipo` VARCHAR(191) NOT NULL,
    `alvoId` INTEGER NOT NULL,
    `detalhes` JSON NULL,
    `criadoEm` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `acoes_admin_alvoTipo_alvoId_idx`(`alvoTipo`, `alvoId`),
    INDEX `acoes_admin_adminId_idx`(`adminId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `acoes_admin` ADD CONSTRAINT `acoes_admin_adminId_fkey` FOREIGN KEY (`adminId`) REFERENCES `usuarios`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
