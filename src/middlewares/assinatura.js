const { HttpError } = require('../utils/http');
const { acessoDoEscritorio } = require('../services/assinatura.service');

// Com ASSINATURA_OBRIGATORIA=true, escritórios sem teste grátis nem assinatura em dia ficam sem
// acesso aos dados (continuam podendo entrar, ver a assinatura e pagar). Desligado por padrão
// enquanto a cobrança não está em produção.
async function exigirAssinatura(req, res, next) {
  if (process.env.ASSINATURA_OBRIGATORIA !== 'true') return next();
  const acesso = await acessoDoEscritorio(req.escritorioId);
  if (!acesso.liberado) {
    throw new HttpError(
      402,
      'O acesso do escritório está suspenso por falta de pagamento. Regularize a assinatura em Planos.',
      'ASSINATURA_PENDENTE'
    );
  }
  next();
}

module.exports = exigirAssinatura;
