// Planos do ArcDesk: mesmas funcionalidades, muda o tamanho da equipe (cada pessoa usa a IA,
// que é o que mais custa). O preço vale daqui (a tela só mostra o que a API manda).
// limitePessoas conta quem está na equipe + convites pendentes.

// ASSINATURA_VALOR_TESTE (no .env) troca o preço de todos os planos por um valor baixo para
// testar a cobrança em produção. Apague a linha depois do teste.
const VALOR_TESTE = Number(String(process.env.ASSINATURA_VALOR_TESTE || '').replace(',', '.'));
if (VALOR_TESTE > 0) console.warn(`[assinatura] ATENÇÃO: preço de teste ativo (R$ ${VALOR_TESTE})`);
const preco = (valor) => (VALOR_TESTE > 0 ? VALOR_TESTE : valor);

const PLANOS = [
  { codigo: 'SOLO', nome: 'Solo', valorMensal: preco(89), limitePessoas: 1 },
  { codigo: 'ESCRITORIO', nome: 'Escritório', valorMensal: preco(149), limitePessoas: 5, destaque: true },
  { codigo: 'EQUIPE', nome: 'Equipe', valorMensal: preco(249), limitePessoas: 15 },
];

const planoPorCodigo = (codigo) => PLANOS.find((p) => p.codigo === codigo) || null;

// Menor plano em que cabe a equipe (null se passar do maior)
const planoParaPessoas = (pessoas) => PLANOS.find((p) => pessoas <= p.limitePessoas) || null;

// Dias de teste grátis contados da criação do escritório
const DIAS_TESTE = Number(process.env.ASSINATURA_DIAS_TESTE || 7);

// Dias de tolerância depois do vencimento antes de suspender o acesso
const DIAS_TOLERANCIA = Number(process.env.ASSINATURA_DIAS_TOLERANCIA || 7);

module.exports = { PLANOS, planoPorCodigo, planoParaPessoas, DIAS_TESTE, DIAS_TOLERANCIA };
