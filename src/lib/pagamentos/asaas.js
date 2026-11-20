// Gateway Asaas (API v3). Tudo o que é específico do Asaas fica aqui: o resto do sistema
// só conhece as funções exportadas, com nomes e formatos do ArcDesk. Para colocar outro
// gateway (ex.: Stripe), basta escrever um arquivo com as mesmas funções.
// Docs: https://docs.asaas.com
const crypto = require('crypto');
const { HttpError } = require('../../utils/http');

const URLS = {
  sandbox: 'https://api-sandbox.asaas.com/v3',
  producao: 'https://api.asaas.com/v3',
};

const nome = 'asaas';

function baseUrl() {
  if (process.env.ASAAS_URL) return process.env.ASAAS_URL.replace(/\/$/, '');
  return process.env.ASAAS_AMBIENTE === 'producao' ? URLS.producao : URLS.sandbox;
}

function configurado() {
  return Boolean(process.env.ASAAS_API_KEY);
}

// Chamada à API. Erros do Asaas vêm como { errors: [{ code, description }] } e a descrição
// já é em português, então vai direto para a tela. Os dados enviados nunca são registrados
// no log (podem ter número de cartão).
async function chamar(metodo, caminho, corpo) {
  if (!configurado()) {
    throw new HttpError(503, 'A cobrança ainda não está configurada no servidor', 'GATEWAY_NAO_CONFIGURADO');
  }
  let resposta;
  try {
    resposta = await fetch(baseUrl() + caminho, {
      method: metodo,
      headers: {
        access_token: process.env.ASAAS_API_KEY,
        'User-Agent': 'ArcDesk/1.0',
        ...(corpo ? { 'Content-Type': 'application/json' } : {}),
      },
      body: corpo ? JSON.stringify(corpo) : undefined,
      // a doc pede pelo menos 60s na criação com cartão
      signal: AbortSignal.timeout(60000),
    });
  } catch (erro) {
    console.error(`[asaas] ${metodo} ${caminho} falhou:`, erro.name);
    throw new HttpError(502, 'Não foi possível falar com o sistema de pagamentos. Tente de novo em instantes.');
  }

  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok) {
    const descricao = dados?.errors?.map((e) => e.description).filter(Boolean).join(' ');
    console.error(`[asaas] ${metodo} ${caminho} -> ${resposta.status}`, dados?.errors?.map((e) => e.code));
    if (resposta.status === 401) {
      throw new HttpError(502, 'A chave do sistema de pagamentos é inválida. Avise o suporte.');
    }
    throw new HttpError(resposta.status >= 500 ? 502 : 400, descricao || 'O sistema de pagamentos recusou a operação.');
  }
  return dados;
}

const FORMA_PARA_ASAAS = { PIX: 'PIX', BOLETO: 'BOLETO', CARTAO: 'CREDIT_CARD' };
const FORMA_DO_ASAAS = { PIX: 'PIX', BOLETO: 'BOLETO', CREDIT_CARD: 'CARTAO' };

const STATUS_DO_ASAAS = {
  PENDING: 'PENDENTE',
  AWAITING_RISK_ANALYSIS: 'PENDENTE',
  RECEIVED: 'PAGO',
  CONFIRMED: 'PAGO',
  RECEIVED_IN_CASH: 'PAGO',
  DUNNING_RECEIVED: 'PAGO',
  OVERDUE: 'ATRASADO',
  DUNNING_REQUESTED: 'ATRASADO',
  REFUNDED: 'ESTORNADO',
  REFUND_REQUESTED: 'ESTORNADO',
  REFUND_IN_PROGRESS: 'ESTORNADO',
  CHARGEBACK_REQUESTED: 'ESTORNADO',
  CHARGEBACK_DISPUTE: 'ESTORNADO',
  AWAITING_CHARGEBACK_REVERSAL: 'ESTORNADO',
};

// Cobrança do Asaas -> formato do ArcDesk
function normalizarPagamento(p) {
  return {
    gatewayPagamentoId: p.id,
    gatewayAssinaturaId: p.subscription || null,
    valor: p.value,
    vencimento: p.dueDate, // "AAAA-MM-DD"
    status: p.deleted ? 'CANCELADO' : STATUS_DO_ASAAS[p.status] || 'PENDENTE',
    forma: FORMA_DO_ASAAS[p.billingType] || null,
    pagoEm: p.paymentDate || p.confirmedDate || p.clientPaymentDate || null,
    linkFatura: p.invoiceUrl || null,
    linkBoleto: p.bankSlipUrl || null,
  };
}

async function criarCliente({ nome: nomeCliente, documento, email, telefone, cep, numero, referencia }) {
  const cliente = await chamar('POST', '/customers', {
    name: nomeCliente,
    cpfCnpj: documento,
    email,
    mobilePhone: telefone || undefined,
    postalCode: cep,
    addressNumber: numero,
    externalReference: referencia,
  });
  return cliente.id;
}

// cartao: { numero, nome, mes, ano, cvv } | titular: dados de cobrança | ip: IP de quem está pagando
async function criarAssinatura({ clienteId, valor, forma, primeiroVencimento, descricao, referencia, cartao, titular, ip }) {
  const corpo = {
    customer: clienteId,
    billingType: FORMA_PARA_ASAAS[forma],
    value: valor,
    nextDueDate: primeiroVencimento,
    cycle: 'MONTHLY',
    description: descricao,
    externalReference: referencia,
  };
  if (forma === 'CARTAO') {
    corpo.creditCard = {
      holderName: cartao.nome,
      number: cartao.numero,
      expiryMonth: cartao.mes,
      expiryYear: cartao.ano,
      ccv: cartao.cvv,
    };
    corpo.creditCardHolderInfo = {
      name: titular.nome,
      email: titular.email,
      cpfCnpj: titular.documento,
      postalCode: titular.cep,
      addressNumber: titular.numero,
      phone: titular.telefone || undefined,
      mobilePhone: titular.telefone || undefined,
    };
    corpo.remoteIp = ip;
  }
  const assinatura = await chamar('POST', '/subscriptions', corpo);
  return {
    gatewayAssinaturaId: assinatura.id,
    cartaoFinal: assinatura.creditCard?.creditCardNumber || null,
    cartaoBandeira: assinatura.creditCard?.creditCardBrand || null,
  };
}

// Encerra a recorrência; o Asaas apaga as cobranças pendentes e mantém as pagas
async function cancelarAssinatura(gatewayAssinaturaId) {
  await chamar('DELETE', `/subscriptions/${encodeURIComponent(gatewayAssinaturaId)}`);
}

async function listarPagamentos(gatewayAssinaturaId) {
  const lista = await chamar('GET', `/subscriptions/${encodeURIComponent(gatewayAssinaturaId)}/payments?limit=100`);
  return (lista.data || []).map(normalizarPagamento);
}

async function buscarPagamento(gatewayPagamentoId) {
  return normalizarPagamento(await chamar('GET', `/payments/${encodeURIComponent(gatewayPagamentoId)}`));
}

async function pix(gatewayPagamentoId) {
  const dados = await chamar('GET', `/payments/${encodeURIComponent(gatewayPagamentoId)}/pixQrCode`);
  return { imagem: dados.encodedImage, copiaECola: dados.payload, expiraEm: dados.expirationDate };
}

async function linhaDigitavel(gatewayPagamentoId) {
  const dados = await chamar('GET', `/payments/${encodeURIComponent(gatewayPagamentoId)}/identificationField`);
  return dados.identificationField;
}

// Nota fiscal automática da assinatura (só quando ASAAS_EMITIR_NOTA=true). Os códigos vêm da
// contabilidade e ficam no .env. Confira no painel do Asaas antes de ligar em produção.
async function configurarNota(gatewayAssinaturaId) {
  const numero = (nomeVar) => Number(String(process.env[nomeVar] || '0').replace(',', '.'));
  await chamar('POST', `/subscriptions/${encodeURIComponent(gatewayAssinaturaId)}/invoiceSettings`, {
    municipalServiceCode: process.env.ASAAS_NOTA_CODIGO_SERVICO || undefined,
    municipalServiceName: process.env.ASAAS_NOTA_DESCRICAO || undefined,
    effectiveDatePeriod: 'ON_PAYMENT_CONFIRMATION',
    receivedOnly: true,
    observations: process.env.ASAAS_NOTA_OBSERVACOES || undefined,
    taxes: {
      retainIss: false,
      iss: numero('ASAAS_NOTA_ISS'),
      pis: 0,
      cofins: 0,
      csll: 0,
      inss: 0,
      ir: 0,
      nbsCode: process.env.ASAAS_NOTA_NBS || undefined,
    },
  });
}

// Aviso (webhook) do Asaas: confere o token do cabeçalho asaas-access-token
function webhookAutentico(req) {
  const esperado = process.env.ASAAS_WEBHOOK_TOKEN || '';
  const recebido = req.get('asaas-access-token') || '';
  if (!esperado || esperado.length !== recebido.length) return false;
  return crypto.timingSafeEqual(Buffer.from(esperado), Buffer.from(recebido));
}

// Corpo do webhook -> { tipo, gatewayPagamentoId, gatewayAssinaturaId }
function lerWebhook(corpo) {
  return {
    tipo: corpo?.event || '',
    gatewayPagamentoId: corpo?.payment?.id || null,
    gatewayAssinaturaId: corpo?.payment?.subscription || corpo?.subscription?.id || null,
    assinaturaCancelada: corpo?.event === 'SUBSCRIPTION_DELETED' || corpo?.event === 'SUBSCRIPTION_INACTIVATED',
  };
}

module.exports = {
  nome,
  configurado,
  criarCliente,
  criarAssinatura,
  cancelarAssinatura,
  listarPagamentos,
  buscarPagamento,
  pix,
  linhaDigitavel,
  configurarNota,
  webhookAutentico,
  lerWebhook,
};
