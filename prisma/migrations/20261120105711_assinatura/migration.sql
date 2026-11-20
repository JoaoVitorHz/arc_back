-- CreateTable
CREATE TABLE `assinaturas` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `escritorioId` INTEGER NOT NULL,
    `plano` VARCHAR(191) NOT NULL,
    `valor` DECIMAL(10, 2) NOT NULL,
    `forma` ENUM('PIX', 'BOLETO', 'CARTAO') NOT NULL,
    `status` ENUM('AGUARDANDO_PAGAMENTO', 'ATIVA', 'ATRASADA', 'CANCELADA') NOT NULL DEFAULT 'AGUARDANDO_PAGAMENTO',
    `gateway` VARCHAR(191) NOT NULL,
    `gatewayClienteId` VARCHAR(191) NOT NULL,
    `gatewayAssinaturaId` VARCHAR(191) NOT NULL,
    `tipoPessoa` VARCHAR(191) NOT NULL,
    `nome` VARCHAR(191) NOT NULL,
    `documento` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `telefone` VARCHAR(191) NULL,
    `cep` VARCHAR(191) NOT NULL,
    `numero` VARCHAR(191) NOT NULL,
    `cartaoFinal` VARCHAR(191) NULL,
    `cartaoBandeira` VARCHAR(191) NULL,
    `pagoAte` DATETIME(3) NULL,
    `canceladaEm` DATETIME(3) NULL,
    `criadoEm` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `atualizadoEm` DATETIME(3) NOT NULL,

    UNIQUE INDEX `assinaturas_escritorioId_key`(`escritorioId`),
    UNIQUE INDEX `assinaturas_gatewayAssinaturaId_key`(`gatewayAssinaturaId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pagamentos_assinatura` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `assinaturaId` INTEGER NOT NULL,
    `gatewayPagamentoId` VARCHAR(191) NOT NULL,
    `valor` DECIMAL(10, 2) NOT NULL,
    `vencimento` DATE NOT NULL,
    `status` ENUM('PENDENTE', 'PAGO', 'ATRASADO', 'ESTORNADO', 'CANCELADO') NOT NULL,
    `forma` ENUM('PIX', 'BOLETO', 'CARTAO') NULL,
    `pagoEm` DATETIME(3) NULL,
    `linkFatura` VARCHAR(500) NULL,
    `linkBoleto` VARCHAR(500) NULL,
    `criadoEm` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `atualizadoEm` DATETIME(3) NOT NULL,

    UNIQUE INDEX `pagamentos_assinatura_gatewayPagamentoId_key`(`gatewayPagamentoId`),
    INDEX `pagamentos_assinatura_assinaturaId_vencimento_idx`(`assinaturaId`, `vencimento`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `assinaturas` ADD CONSTRAINT `assinaturas_escritorioId_fkey` FOREIGN KEY (`escritorioId`) REFERENCES `escritorios`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `pagamentos_assinatura` ADD CONSTRAINT `pagamentos_assinatura_assinaturaId_fkey` FOREIGN KEY (`assinaturaId`) REFERENCES `assinaturas`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
