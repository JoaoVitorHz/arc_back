-- AlterTable
ALTER TABLE `assinaturas` MODIFY `forma` ENUM('PIX', 'CARTAO') NOT NULL;

-- AlterTable
ALTER TABLE `pagamentos_assinatura` DROP COLUMN `linkBoleto`,
    MODIFY `forma` ENUM('PIX', 'CARTAO') NULL;
