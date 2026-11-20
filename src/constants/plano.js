// O plano do ArcDesk. O preço vale daqui (a tela só mostra o que a API manda).
// ASSINATURA_VALOR_TESTE (no .env) troca o preço por um valor baixo para testar a cobrança em
// produção. Apague a linha depois do teste.
const VALOR_TESTE = Number(String(process.env.ASSINATURA_VALOR_TESTE || '').replace(',', '.'));
if (VALOR_TESTE > 0) console.warn(`[assinatura] ATENÇÃO: preço de teste ativo (R$ ${VALOR_TESTE})`);

const PLANO = {
  codigo: 'ESCRITORIO',
  nome: 'ArcDesk Escritório',
  valorMensal: VALOR_TESTE > 0 ? VALOR_TESTE : 149,
};

// Dias de teste grátis contados da criação do escritório
const DIAS_TESTE = Number(process.env.ASSINATURA_DIAS_TESTE || 7);

// Dias de tolerância depois do vencimento antes de suspender o acesso
const DIAS_TOLERANCIA = Number(process.env.ASSINATURA_DIAS_TOLERANCIA || 7);

module.exports = { PLANO, DIAS_TESTE, DIAS_TOLERANCIA };
