// O plano do ArcDesk. O preço vale daqui (a tela só mostra o que a API manda).
const PLANO = {
  codigo: 'ESCRITORIO',
  nome: 'ArcDesk Escritório',
  valorMensal: 149,
};

// Dias de teste grátis contados da criação do escritório
const DIAS_TESTE = Number(process.env.ASSINATURA_DIAS_TESTE || 14);

// Dias de tolerância depois do vencimento antes de suspender o acesso
const DIAS_TOLERANCIA = Number(process.env.ASSINATURA_DIAS_TOLERANCIA || 7);

module.exports = { PLANO, DIAS_TESTE, DIAS_TOLERANCIA };
