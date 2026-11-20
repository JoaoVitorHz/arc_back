// Assinatura do ArcDesk: teste grátis, cobrança no gateway, pagamentos e liberação do acesso.
// O gateway (src/lib/pagamentos) é a fonte da verdade dos pagamentos; aqui fica uma cópia,
// atualizada pelos avisos (webhooks) e pela sincronização ao abrir a tela de planos.
const prisma = require('../lib/prisma');
const gateway = require('../lib/pagamentos');
const { HttpError } = require('../utils/http');
const { PLANO, DIAS_TESTE, DIAS_TOLERANCIA } = require('../constants/plano');

const DIA = 24 * 60 * 60 * 1000;
const somarDias = (data, dias) => new Date(data.getTime() + dias * DIA);
function somarMeses(data, meses) {
  const nova = new Date(data);
  nova.setUTCMonth(nova.getUTCMonth() + meses);
  return nova;
}
// "AAAA-MM-DD" (datas do gateway) <-> Date em UTC, como as colunas @db.Date
const paraData = (texto) => (texto ? new Date(`${String(texto).slice(0, 10)}T00:00:00Z`) : null);
const paraTexto = (data) => data.toISOString().slice(0, 10);
// Hoje no horário de Brasília, em "AAAA-MM-DD"
const hojeBrasil = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

const cobrancaObrigatoria = () => process.env.ASSINATURA_OBRIGATORIA === 'true';
const EM_ABERTO = ['PENDENTE', 'ATRASADO'];

// ---------- Acesso ----------

// Pode usar o sistema? Teste grátis, assinatura em dia, pago até uma data (mesmo cancelada)
// ou atrasada ainda dentro da tolerância.
function calcularAcesso(escritorio, assinatura, atrasadaDesde, agora = new Date()) {
  const testeAte = somarDias(escritorio.criadoEm, DIAS_TESTE);
  const emTeste = agora < testeAte;
  const pago = Boolean(assinatura?.pagoAte && agora < assinatura.pagoAte);
  const diasTeste = emTeste ? Math.ceil((testeAte - agora) / DIA) : 0;

  let liberado;
  let motivo;
  let suspendeEm = null;
  if (assinatura?.status === 'ATIVA') {
    liberado = true;
    motivo = 'ATIVA';
  } else if (assinatura?.status === 'ATRASADA') {
    suspendeEm = atrasadaDesde ? somarDias(atrasadaDesde, DIAS_TOLERANCIA) : null;
    liberado = emTeste || pago || !suspendeEm || agora < suspendeEm;
    motivo = 'ATRASADA';
  } else {
    liberado = emTeste || pago;
    motivo = emTeste ? 'TESTE' : pago ? 'PAGO_ATE' : 'SEM_ASSINATURA';
  }
  return { obrigatoria: cobrancaObrigatoria(), liberado, motivo, testeAte, diasTeste, suspendeEm };
}

async function carregar(escritorioId) {
  return prisma.escritorio.findUnique({
    where: { id: escritorioId },
    select: {
      criadoEm: true,
      assinatura: { include: { pagamentos: { orderBy: { vencimento: 'desc' }, take: 24 } } },
    },
  });
}

function atrasadaDesde(pagamentos = []) {
  const atrasados = pagamentos.filter((p) => p.status === 'ATRASADO').map((p) => p.vencimento);
  return atrasados.length ? new Date(Math.min(...atrasados)) : null;
}

// Usado pelo middleware que bloqueia as rotas quando ASSINATURA_OBRIGATORIA=true
async function acessoDoEscritorio(escritorioId) {
  const escritorio = await carregar(escritorioId);
  const assinatura = escritorio.assinatura;
  return calcularAcesso(escritorio, assinatura, atrasadaDesde(assinatura?.pagamentos));
}

// ---------- Cópia local dos pagamentos ----------

async function salvarPagamento(assinaturaId, p) {
  const dados = {
    valor: p.valor,
    vencimento: paraData(p.vencimento),
    status: p.status,
    forma: p.forma,
    pagoEm: paraData(p.pagoEm),
    linkFatura: p.linkFatura,
    linkBoleto: p.linkBoleto,
  };
  await prisma.pagamentoAssinatura.upsert({
    where: { gatewayPagamentoId: p.gatewayPagamentoId },
    create: { assinaturaId, gatewayPagamentoId: p.gatewayPagamentoId, ...dados },
    update: dados,
  });
}

// Situação e "pago até" saem dos pagamentos: cada mensalidade paga garante um mês a partir
// do vencimento dela. Estornos tiram esse mês de volta.
async function recalcular(assinaturaId) {
  const assinatura = await prisma.assinatura.findUnique({ where: { id: assinaturaId }, include: { pagamentos: true } });
  const pagos = assinatura.pagamentos.filter((p) => p.status === 'PAGO');
  const ultimoPago = pagos.length ? new Date(Math.max(...pagos.map((p) => p.vencimento))) : null;
  let status = 'AGUARDANDO_PAGAMENTO';
  if (assinatura.status === 'CANCELADA') status = 'CANCELADA';
  else if (assinatura.pagamentos.some((p) => p.status === 'ATRASADO')) status = 'ATRASADA';
  else if (pagos.length) status = 'ATIVA';
  await prisma.assinatura.update({
    where: { id: assinaturaId },
    data: { status, pagoAte: ultimoPago ? somarMeses(ultimoPago, 1) : null },
  });
}

async function sincronizar(assinatura) {
  const pagamentos = await gateway.listarPagamentos(assinatura.gatewayAssinaturaId);
  for (const p of pagamentos) await salvarPagamento(assinatura.id, p);
  await recalcular(assinatura.id);
}

// ---------- O que a tela recebe ----------

function resumoPagamento(p) {
  return {
    id: p.id,
    valor: Number(p.valor),
    vencimento: paraTexto(p.vencimento),
    status: p.status,
    forma: p.forma,
    pagoEm: p.pagoEm ? paraTexto(p.pagoEm) : null,
    linkFatura: p.linkFatura,
  };
}

// Membros só veem se o acesso está liberado; dados de cobrança e pagamentos são do administrador
async function situacao(escritorioId, { admin = false, sincronizarAgora = false } = {}) {
  let escritorio = await carregar(escritorioId);
  const atual = escritorio.assinatura;
  if (sincronizarAgora && admin && atual && atual.status !== 'CANCELADA' && gateway.configurado()) {
    try {
      await sincronizar(atual);
      escritorio = await carregar(escritorioId);
    } catch (erro) {
      // a tela abre com a última cópia; o próximo aviso do gateway corrige
      console.error('[assinatura] falha ao sincronizar:', erro.message);
    }
  }

  const assinatura = escritorio.assinatura;
  const pagamentos = assinatura?.pagamentos ?? [];
  const acesso = calcularAcesso(escritorio, assinatura, atrasadaDesde(pagamentos));
  const proxima = pagamentos.filter((p) => EM_ABERTO.includes(p.status)).at(-1);
  // Quem assina durante o teste só paga quando o teste acaba; quem volta depois de cancelar,
  // quando acaba o período que já pagou (para não cobrar o mesmo mês duas vezes)
  const datas = [hojeBrasil()];
  if (acesso.diasTeste > 0) datas.push(paraTexto(acesso.testeAte));
  if (assinatura?.pagoAte) datas.push(paraTexto(assinatura.pagoAte));
  const primeiroVencimento = datas.sort().at(-1);

  return {
    plano: { nome: PLANO.nome, valorMensal: PLANO.valorMensal },
    cobrancaConfigurada: gateway.configurado(),
    acesso,
    primeiroVencimento,
    assinatura: !assinatura
      ? null
      : admin
        ? {
            status: assinatura.status,
            plano: assinatura.plano,
            valor: Number(assinatura.valor),
            forma: assinatura.forma,
            cartaoFinal: assinatura.cartaoFinal,
            cartaoBandeira: assinatura.cartaoBandeira,
            nome: assinatura.nome,
            email: assinatura.email,
            pagoAte: assinatura.pagoAte,
            canceladaEm: assinatura.canceladaEm,
            proximoVencimento: proxima ? paraTexto(proxima.vencimento) : null,
            criadoEm: assinatura.criadoEm,
          }
        : { status: assinatura.status },
    pagamentos: admin ? pagamentos.map(resumoPagamento) : [],
  };
}

// ---------- Assinar ----------

const digitos = (valor) => String(valor ?? '').replace(/\D/g, '');

function cpfValido(cpf) {
  if (cpf.length !== 11 || /^(\d)\1+$/.test(cpf)) return false;
  for (const tamanho of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < tamanho; i++) soma += Number(cpf[i]) * (tamanho + 1 - i);
    if (((soma * 10) % 11) % 10 !== Number(cpf[tamanho])) return false;
  }
  return true;
}

function cnpjValido(cnpj) {
  if (cnpj.length !== 14 || /^(\d)\1+$/.test(cnpj)) return false;
  for (const tamanho of [12, 13]) {
    let soma = 0;
    let peso = tamanho - 7;
    for (let i = 0; i < tamanho; i++) {
      soma += Number(cnpj[i]) * peso--;
      if (peso < 2) peso = 9;
    }
    const digito = soma % 11 < 2 ? 0 : 11 - (soma % 11);
    if (digito !== Number(cnpj[tamanho])) return false;
  }
  return true;
}

function validarDados(corpo) {
  const tipoPessoa = corpo.tipoPessoa === 'PF' ? 'PF' : 'PJ';
  const dados = {
    tipoPessoa,
    nome: String(corpo.nome ?? '').trim(),
    documento: digitos(corpo.documento),
    email: String(corpo.email ?? '').trim().toLowerCase(),
    telefone: digitos(corpo.telefone) || null,
    cep: digitos(corpo.cep),
    numero: String(corpo.numero ?? '').trim(),
    forma: corpo.forma,
  };
  if (!dados.nome) throw new HttpError(400, tipoPessoa === 'PJ' ? 'Informe a razão social' : 'Informe o nome completo');
  if (tipoPessoa === 'PF' ? !cpfValido(dados.documento) : !cnpjValido(dados.documento)) {
    throw new HttpError(400, tipoPessoa === 'PF' ? 'CPF inválido' : 'CNPJ inválido');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(dados.email)) throw new HttpError(400, 'E-mail inválido');
  if (dados.telefone && (dados.telefone.length < 10 || dados.telefone.length > 11)) {
    throw new HttpError(400, 'Telefone inválido');
  }
  if (dados.cep.length !== 8) throw new HttpError(400, 'CEP inválido');
  if (!dados.numero) throw new HttpError(400, 'Informe o número do endereço');
  if (!['PIX', 'BOLETO', 'CARTAO'].includes(dados.forma)) throw new HttpError(400, 'Escolha a forma de pagamento');
  return dados;
}

function validarCartao(cartao = {}) {
  const numero = digitos(cartao.numero);
  const [mes, ano] = String(cartao.validade ?? '').split('/');
  const cvv = digitos(cartao.cvv);
  const nome = String(cartao.nome ?? '').trim();
  if (numero.length < 13 || numero.length > 19) throw new HttpError(400, 'Número do cartão inválido');
  if (!nome) throw new HttpError(400, 'Informe o nome impresso no cartão');
  if (!/^\d{2}$/.test(mes ?? '') || Number(mes) < 1 || Number(mes) > 12 || !/^\d{2}$/.test(ano ?? '')) {
    throw new HttpError(400, 'Validade do cartão inválida (use MM/AA)');
  }
  if (cvv.length < 3 || cvv.length > 4) throw new HttpError(400, 'CVV inválido');
  return { numero, nome, mes, ano: `20${ano}`, cvv };
}

// IP de quem está pagando (o Asaas pede na assinatura com cartão)
const ipDoPagador = (req) => String(req.ip || '').replace(/^::ffff:/, '');

// Evita duas assinaturas no gateway se o botão for clicado duas vezes
const assinando = new Set();

async function assinar(req) {
  const escritorioId = req.escritorioId;
  const dados = validarDados(req.body);
  const cartao = dados.forma === 'CARTAO' ? validarCartao(req.body.cartao) : null;

  if (assinando.has(escritorioId)) throw new HttpError(409, 'A assinatura já está sendo criada. Aguarde.');
  assinando.add(escritorioId);
  try {
    const escritorio = await carregar(escritorioId);
    const existente = escritorio.assinatura;
    if (existente && existente.status !== 'CANCELADA') {
      throw new HttpError(409, 'O escritório já tem uma assinatura');
    }
    const { primeiroVencimento } = await situacao(escritorioId);

    // Quem volta depois de cancelar reaproveita o cliente no gateway (se o documento for o mesmo)
    const gatewayClienteId =
      existente && existente.documento === dados.documento
        ? existente.gatewayClienteId
        : await gateway.criarCliente({ ...dados, referencia: `escritorio:${escritorioId}` });

    const criada = await gateway.criarAssinatura({
      clienteId: gatewayClienteId,
      valor: PLANO.valorMensal,
      forma: dados.forma,
      primeiroVencimento,
      descricao: `${PLANO.nome} - assinatura mensal`,
      referencia: `escritorio:${escritorioId}`,
      cartao,
      titular: dados,
      ip: ipDoPagador(req),
    });

    const registro = {
      plano: PLANO.codigo,
      valor: PLANO.valorMensal,
      forma: dados.forma,
      status: 'AGUARDANDO_PAGAMENTO',
      gateway: gateway.nome,
      gatewayClienteId,
      gatewayAssinaturaId: criada.gatewayAssinaturaId,
      tipoPessoa: dados.tipoPessoa,
      nome: dados.nome,
      documento: dados.documento,
      email: dados.email,
      telefone: dados.telefone,
      cep: dados.cep,
      numero: dados.numero,
      cartaoFinal: criada.cartaoFinal,
      cartaoBandeira: criada.cartaoBandeira,
      canceladaEm: null,
    };
    let assinatura;
    try {
      assinatura = await prisma.assinatura.upsert({
        where: { escritorioId },
        create: { escritorioId, ...registro },
        update: registro,
      });
    } catch (erro) {
      // a assinatura existe no gateway mas não foi salva aqui: o id no log permite corrigir
      console.error(`[assinatura] criada no gateway (${criada.gatewayAssinaturaId}) mas não salva:`, erro.message);
      throw erro;
    }

    try {
      await sincronizar(assinatura);
    } catch (erro) {
      console.error('[assinatura] falha ao buscar a primeira cobrança:', erro.message);
    }

    if (process.env.ASAAS_EMITIR_NOTA === 'true') {
      try {
        await gateway.configurarNota(assinatura.gatewayAssinaturaId);
      } catch (erro) {
        // a cobrança segue; a nota pode ser configurada no painel do gateway
        console.error('[assinatura] falha ao configurar a nota fiscal:', erro.message);
      }
    }

    return situacao(escritorioId, { admin: true });
  } finally {
    assinando.delete(escritorioId);
  }
}

// ---------- Cobrança em aberto (Pix / boleto) ----------

async function cobrancaEmAberto(escritorioId) {
  const assinatura = await prisma.assinatura.findUnique({
    where: { escritorioId },
    include: { pagamentos: { where: { status: { in: EM_ABERTO } }, orderBy: { vencimento: 'asc' }, take: 1 } },
  });
  const pagamento = assinatura?.status !== 'CANCELADA' ? assinatura?.pagamentos[0] : null;
  if (!pagamento) return { pagamento: null };

  const forma = pagamento.forma || assinatura.forma;
  const resposta = { pagamento: { ...resumoPagamento(pagamento), forma, linkBoleto: pagamento.linkBoleto } };
  if (forma === 'PIX') resposta.pix = await gateway.pix(pagamento.gatewayPagamentoId);
  if (forma === 'BOLETO') resposta.linhaDigitavel = await gateway.linhaDigitavel(pagamento.gatewayPagamentoId);
  return resposta;
}

// ---------- Cancelar ----------

async function marcarCancelada(assinaturaId) {
  await prisma.$transaction([
    prisma.assinatura.update({ where: { id: assinaturaId }, data: { status: 'CANCELADA', canceladaEm: new Date() } }),
    // o gateway apaga as cobranças em aberto ao cancelar
    prisma.pagamentoAssinatura.updateMany({
      where: { assinaturaId, status: { in: EM_ABERTO } },
      data: { status: 'CANCELADO' },
    }),
  ]);
  await recalcular(assinaturaId);
}

async function cancelar(escritorioId) {
  const assinatura = await prisma.assinatura.findUnique({ where: { escritorioId } });
  if (!assinatura || assinatura.status === 'CANCELADA') throw new HttpError(404, 'Não há assinatura ativa');
  await gateway.cancelarAssinatura(assinatura.gatewayAssinaturaId);
  await marcarCancelada(assinatura.id);
  return situacao(escritorioId, { admin: true });
}

// ---------- Avisos do gateway (webhook) ----------

// Os dados do aviso só dizem "qual cobrança mudou"; a situação é buscada de novo no gateway,
// então avisos repetidos ou fora de ordem não estragam nada.
async function processarAviso(corpo) {
  const aviso = gateway.lerWebhook(corpo);
  if (!aviso.gatewayAssinaturaId) return 'ignorado';
  const assinatura = await prisma.assinatura.findUnique({
    where: { gatewayAssinaturaId: aviso.gatewayAssinaturaId },
  });
  if (!assinatura) return 'ignorado'; // cobrança que não é de uma assinatura do ArcDesk

  if (aviso.assinaturaCancelada) {
    if (assinatura.status !== 'CANCELADA') await marcarCancelada(assinatura.id);
    return 'cancelada';
  }
  if (!aviso.gatewayPagamentoId || !aviso.tipo.startsWith('PAYMENT_')) return 'ignorado';

  if (aviso.tipo === 'PAYMENT_DELETED') {
    await prisma.pagamentoAssinatura.updateMany({
      where: { gatewayPagamentoId: aviso.gatewayPagamentoId },
      data: { status: 'CANCELADO' },
    });
  } else {
    await salvarPagamento(assinatura.id, await gateway.buscarPagamento(aviso.gatewayPagamentoId));
  }
  await recalcular(assinatura.id);
  return 'atualizado';
}

module.exports = { situacao, assinar, cobrancaEmAberto, cancelar, processarAviso, acessoDoEscritorio, calcularAcesso };
