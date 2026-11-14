-- Autenticação e multi-tenant: escritórios, usuários e escritorioId nas tabelas de dados.
-- Dados que já existiam são movidos para um "Escritório de exemplo" em vez de serem perdidos.

-- CreateTable
CREATE TABLE `escritorios` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `nome` VARCHAR(191) NOT NULL,
    `criadoEm` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `atualizadoEm` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `usuarios` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `nome` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `senhaHash` VARCHAR(191) NOT NULL,
    `criadoEm` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `atualizadoEm` DATETIME(3) NOT NULL,
    `escritorioId` INTEGER NOT NULL,

    UNIQUE INDEX `usuarios_email_key`(`email`),
    INDEX `usuarios_escritorioId_idx`(`escritorioId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Escritório que recebe os dados antigos (só é criado se houver algum dado)
INSERT INTO `escritorios` (`nome`, `atualizadoEm`)
SELECT 'Escritório de exemplo', CURRENT_TIMESTAMP(3) FROM DUAL
WHERE EXISTS (SELECT 1 FROM `clientes`)
   OR EXISTS (SELECT 1 FROM `projetos`)
   OR EXISTS (SELECT 1 FROM `eventos`)
   OR EXISTS (SELECT 1 FROM `lancamentos`);

-- Adiciona a coluna como opcional, preenche e depois torna obrigatória
ALTER TABLE `clientes` ADD COLUMN `escritorioId` INTEGER NULL;
ALTER TABLE `projetos` ADD COLUMN `escritorioId` INTEGER NULL;
ALTER TABLE `eventos` ADD COLUMN `escritorioId` INTEGER NULL;
ALTER TABLE `lancamentos` ADD COLUMN `escritorioId` INTEGER NULL;

UPDATE `clientes` SET `escritorioId` = (SELECT MIN(`id`) FROM `escritorios`);
UPDATE `projetos` SET `escritorioId` = (SELECT MIN(`id`) FROM `escritorios`);
UPDATE `eventos` SET `escritorioId` = (SELECT MIN(`id`) FROM `escritorios`);
UPDATE `lancamentos` SET `escritorioId` = (SELECT MIN(`id`) FROM `escritorios`);

ALTER TABLE `clientes` MODIFY `escritorioId` INTEGER NOT NULL;
ALTER TABLE `projetos` MODIFY `escritorioId` INTEGER NOT NULL;
ALTER TABLE `eventos` MODIFY `escritorioId` INTEGER NOT NULL;
ALTER TABLE `lancamentos` MODIFY `escritorioId` INTEGER NOT NULL;

-- CreateIndex
CREATE INDEX `clientes_escritorioId_idx` ON `clientes`(`escritorioId`);
CREATE INDEX `projetos_escritorioId_idx` ON `projetos`(`escritorioId`);
CREATE INDEX `eventos_escritorioId_inicio_idx` ON `eventos`(`escritorioId`, `inicio`);
CREATE INDEX `lancamentos_escritorioId_vencimento_idx` ON `lancamentos`(`escritorioId`, `vencimento`);

-- AddForeignKey
ALTER TABLE `usuarios` ADD CONSTRAINT `usuarios_escritorioId_fkey` FOREIGN KEY (`escritorioId`) REFERENCES `escritorios`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `clientes` ADD CONSTRAINT `clientes_escritorioId_fkey` FOREIGN KEY (`escritorioId`) REFERENCES `escritorios`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `projetos` ADD CONSTRAINT `projetos_escritorioId_fkey` FOREIGN KEY (`escritorioId`) REFERENCES `escritorios`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `eventos` ADD CONSTRAINT `eventos_escritorioId_fkey` FOREIGN KEY (`escritorioId`) REFERENCES `escritorios`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `lancamentos` ADD CONSTRAINT `lancamentos_escritorioId_fkey` FOREIGN KEY (`escritorioId`) REFERENCES `escritorios`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
