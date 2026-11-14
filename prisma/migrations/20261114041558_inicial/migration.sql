-- CreateTable
CREATE TABLE `clientes` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `nome` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NULL,
    `telefone` VARCHAR(191) NULL,
    `documento` VARCHAR(191) NULL,
    `endereco` VARCHAR(191) NULL,
    `observacoes` TEXT NULL,
    `criadoEm` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `atualizadoEm` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `projetos` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `nome` VARCHAR(191) NOT NULL,
    `tipo` ENUM('RESIDENCIAL', 'INTERIORES', 'COMERCIAL', 'OUTRO') NOT NULL DEFAULT 'RESIDENCIAL',
    `status` ENUM('ATIVO', 'PAUSADO', 'CONCLUIDO') NOT NULL DEFAULT 'ATIVO',
    `enderecoObra` VARCHAR(191) NULL,
    `valorContrato` DECIMAL(12, 2) NULL,
    `dataInicio` DATE NULL,
    `previsaoEntrega` DATE NULL,
    `observacoes` TEXT NULL,
    `criadoEm` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `atualizadoEm` DATETIME(3) NOT NULL,
    `clienteId` INTEGER NOT NULL,

    INDEX `projetos_clienteId_idx`(`clienteId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `etapas` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `nome` VARCHAR(191) NOT NULL,
    `ordem` INTEGER NOT NULL,
    `status` ENUM('NAO_INICIADA', 'EM_ANDAMENTO', 'CONCLUIDA') NOT NULL DEFAULT 'NAO_INICIADA',
    `dataPrevista` DATE NULL,
    `criadoEm` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `atualizadoEm` DATETIME(3) NOT NULL,
    `projetoId` INTEGER NOT NULL,

    INDEX `etapas_projetoId_idx`(`projetoId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `eventos` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `titulo` VARCHAR(191) NOT NULL,
    `tipo` ENUM('REUNIAO', 'VISITA_TECNICA', 'VISITA_OBRA', 'ENTREGA', 'OUTRO') NOT NULL DEFAULT 'REUNIAO',
    `inicio` DATETIME(3) NOT NULL,
    `fim` DATETIME(3) NULL,
    `local` VARCHAR(191) NULL,
    `descricao` TEXT NULL,
    `criadoEm` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `atualizadoEm` DATETIME(3) NOT NULL,
    `clienteId` INTEGER NULL,
    `projetoId` INTEGER NULL,

    INDEX `eventos_inicio_idx`(`inicio`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `lancamentos` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `descricao` VARCHAR(191) NOT NULL,
    `tipo` ENUM('RECEITA', 'DESPESA') NOT NULL,
    `valor` DECIMAL(12, 2) NOT NULL,
    `vencimento` DATE NOT NULL,
    `pago` BOOLEAN NOT NULL DEFAULT false,
    `dataPagamento` DATE NULL,
    `categoria` VARCHAR(191) NULL,
    `criadoEm` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `atualizadoEm` DATETIME(3) NOT NULL,
    `projetoId` INTEGER NULL,

    INDEX `lancamentos_vencimento_idx`(`vencimento`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `projetos` ADD CONSTRAINT `projetos_clienteId_fkey` FOREIGN KEY (`clienteId`) REFERENCES `clientes`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `etapas` ADD CONSTRAINT `etapas_projetoId_fkey` FOREIGN KEY (`projetoId`) REFERENCES `projetos`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `eventos` ADD CONSTRAINT `eventos_clienteId_fkey` FOREIGN KEY (`clienteId`) REFERENCES `clientes`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `eventos` ADD CONSTRAINT `eventos_projetoId_fkey` FOREIGN KEY (`projetoId`) REFERENCES `projetos`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `lancamentos` ADD CONSTRAINT `lancamentos_projetoId_fkey` FOREIGN KEY (`projetoId`) REFERENCES `projetos`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
