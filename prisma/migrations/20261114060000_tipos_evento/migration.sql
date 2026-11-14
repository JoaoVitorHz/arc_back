-- Tipos de compromisso passam a ser cadastrados por escritório (antes era um enum fixo).
-- Cada escritório recebe os 5 tipos padrão e os compromissos existentes são convertidos.

-- CreateTable
CREATE TABLE `tipos_evento` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `nome` VARCHAR(191) NOT NULL,
    `cor` VARCHAR(191) NOT NULL DEFAULT 'blue',
    `criadoEm` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `atualizadoEm` DATETIME(3) NOT NULL,
    `escritorioId` INTEGER NOT NULL,

    UNIQUE INDEX `tipos_evento_escritorioId_nome_key`(`escritorioId`, `nome`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Tipos padrão para cada escritório existente (mesma ordem do enum antigo)
INSERT INTO `tipos_evento` (`nome`, `cor`, `escritorioId`, `atualizadoEm`) SELECT 'Reunião', 'blue', `id`, CURRENT_TIMESTAMP(3) FROM `escritorios` ORDER BY `id`;
INSERT INTO `tipos_evento` (`nome`, `cor`, `escritorioId`, `atualizadoEm`) SELECT 'Visita técnica', 'purple', `id`, CURRENT_TIMESTAMP(3) FROM `escritorios` ORDER BY `id`;
INSERT INTO `tipos_evento` (`nome`, `cor`, `escritorioId`, `atualizadoEm`) SELECT 'Visita de obra', 'amber', `id`, CURRENT_TIMESTAMP(3) FROM `escritorios` ORDER BY `id`;
INSERT INTO `tipos_evento` (`nome`, `cor`, `escritorioId`, `atualizadoEm`) SELECT 'Entrega', 'green', `id`, CURRENT_TIMESTAMP(3) FROM `escritorios` ORDER BY `id`;
INSERT INTO `tipos_evento` (`nome`, `cor`, `escritorioId`, `atualizadoEm`) SELECT 'Outro', 'gray', `id`, CURRENT_TIMESTAMP(3) FROM `escritorios` ORDER BY `id`;

-- Converte o enum antigo para o tipo cadastrado do mesmo escritório
ALTER TABLE `eventos` ADD COLUMN `tipoId` INTEGER NULL;

UPDATE `eventos` e
JOIN `tipos_evento` t
  ON t.`escritorioId` = e.`escritorioId`
 AND t.`nome` = CASE e.`tipo`
      WHEN 'REUNIAO' THEN 'Reunião'
      WHEN 'VISITA_TECNICA' THEN 'Visita técnica'
      WHEN 'VISITA_OBRA' THEN 'Visita de obra'
      WHEN 'ENTREGA' THEN 'Entrega'
      ELSE 'Outro'
    END
SET e.`tipoId` = t.`id`;

ALTER TABLE `eventos` DROP COLUMN `tipo`;

-- CreateIndex
CREATE INDEX `eventos_tipoId_idx` ON `eventos`(`tipoId`);

-- AddForeignKey
ALTER TABLE `tipos_evento` ADD CONSTRAINT `tipos_evento_escritorioId_fkey` FOREIGN KEY (`escritorioId`) REFERENCES `escritorios`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `eventos` ADD CONSTRAINT `eventos_tipoId_fkey` FOREIGN KEY (`tipoId`) REFERENCES `tipos_evento`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
