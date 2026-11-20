const { HttpError } = require('../utils/http');
const { acessoDoEscritorio } = require('../services/assinatura.service');

// Com ASSINATURA_OBRIGATORIA=true, escritório sem teste grátis nem assinatura em dia fica em
// "modo vitrine": pode ler os dados (a tela mostra tudo borrado atrás do convite para assinar),
// mas não cria, edita, apaga nem usa a IA (todo uso da IA é POST). Continua podendo entrar,
// ver a assinatura e pagar. Desligado por padrão enquanto a cobrança não está em produção.
const LEITURA = ['GET', 'HEAD', 'OPTIONS'];

async function exigirAssinatura(req, res, next) {
  if (process.env.ASSINATURA_OBRIGATORIA !== 'true' || LEITURA.includes(req.method)) return next();
  const acesso = await acessoDoEscritorio(req.escritorioId);
  if (!acesso.liberado) {
    throw new HttpError(
      402,
      'O acesso do escritório está suspenso por falta de pagamento. Assine em Planos para voltar a usar.',
      'ASSINATURA_PENDENTE'
    );
  }
  next();
}

module.exports = exigirAssinatura;
