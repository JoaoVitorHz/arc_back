// Assinatura do ArcDesk: teste grátis, cobrança no gateway, pagamentos e liberação do acesso.
// O gateway (src/lib/pagamentos) é a fonte da verdade dos pagamentos; aqui fica uma cópia,
// atualizada pelos avisos (webhooks) e pela sincronização ao abrir a tela de planos.
const prisma = require('../lib/prisma');
const gateway = require('../lib/pagamentos');
const { HttpError } = require('../utils/http');
const { PLANOS, planoPorCodigo, planoParaPessoas, DIAS_TESTE, DIAS_TOLERANCIA } = require('../constants/plano');

const DIA = 24 * 60 * 60 * 1000;
const somarDias = (data, dias) => new Date(data.getTime() + dias * DIA);
// Mesmo dia no mês seguinte; se o mês não tiver esse dia, o último dia dele (31/01 -> 28/02,
// e não 03/03 como faria o setUTCMonth sozinho)
function somarMeses(data, meses) {
  const nova = new Date(data);
  const dia = nova.getUTCDate();
  nova.setUTCDate(1);
  nova.setUTCMonth(nova.getUTCMonth() + meses);
  const ultimoDia = new Date(Date.UTC(nova.getUTCFullYear(), nova.getUTCMonth() + 1, 0)).getUTCDate();
  nova.setUTCDate(Math.min(dia, ultimoDia));
  return nova;
}

// Vencimentos só até o dia 28, que existe em todos os meses: assim a mensalidade cai sempre no
// mesmo dia. Se cair em 29, 30 ou 31, passa para o dia 1º do mês seguinte (o cliente ganha
// esses dias, nunca paga antes da hora).
function diaQueExisteTodoMes(texto) {
  const [ano, mes, dia] = texto.split('-').map(Number);
  if (dia <= 28) return texto;
  return paraTexto(new Date(Date.UTC(ano, mes, 1)));
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

// ---------- Pessoas e limite do plano ----------

const pessoasTexto = (n) => (n === 1 ? '1 pessoa' : `${n} pessoas`);

// Quem conta para o limite: a equipe + convites pendentes (senão daria para burlar o limite
// deixando convites em aberto). emailIgnorado: convite que vai ser substituído por um novo.
async function contarPessoas(escritorioId, { comConvites = true, emailIgnorado } = {}) {
  const [membros, convites] = await Promise.all([
    prisma.usuario.count({ where: { escritorioId } }),
    comConvites
      ? prisma.convite.count({
          where: {
            escritorioId,
            aceitoEm: null,
            expiraEm: { gt: new Date() },
            ...(emailIgnorado ? { email: { not: emailIgnorado } } : {}),
          },
        })
      : 0,
  ]);
  return membros + convites;
}

// Plano que vale agora: o da assinatura em andamento (ou cancelada, até o fim do período pago).
// Sem assinatura (teste grátis) não há limite: o escritório testa com a equipe toda.
function planoVigente(assinatura, agora = new Date()) {
  if (!assinatura) return null;
  const vale = assinatura.status !== 'CANCELADA' || (assinatura.pagoAte && agora < assinatura.pagoAte);
  return vale ? planoPorCodigo(assinatura.plano) : null;
}

async function planoDoEscritorio(escritorioId) {
  const assinatura = await prisma.assinatura.findUnique({
    where: { escritorioId },
    select: { plano: true, status: true, pagoAte: true },
  });
  return planoVigente(assinatura);
}

// Antes de pôr mais alguém na equipe (convite, conta criada pelo administrador ou convite aceito).
// aceitandoConvite: quem aceita já estava contado como convite, então só a equipe conta.
async function exigirVaga(escritorioId, { aceitandoConvite = false, emailIgnorado } = {}) {
  const plano = await planoDoEscritorio(escritorioId);
  if (!plano) return;
  const pessoas = await contarPessoas(escritorioId, { comConvites: !aceitandoConvite, emailIgnorado });
  if (pessoas + 1 <= plano.limitePessoas) return;
  if (aceitandoConvite) {
    throw new HttpError(
      403,
      `O escritório atingiu o limite de pessoas do plano ${plano.nome}. Peça ao administrador para mudar de plano.`,
      'LIMITE_PLANO'
    );
  }
  const maior = planoParaPessoas(pessoas + 1);
  throw new HttpError(
    403,
    `O plano ${plano.nome} permite até ${pessoasTexto(plano.limitePessoas)}, contando os convites pendentes.` +
      (maior ? ` Mude para o plano ${maior.nome} em Planos para adicionar mais gente.` : ''),
    'LIMITE_PLANO'
  );
}

// Para a tela da equipe: "3 de 5 pessoas no plano Escritório"
async function vagasDaEquipe(escritorioId) {
  const [plano, pessoas] = await Promise.all([planoDoEscritorio(escritorioId), contarPessoas(escritorioId)]);
  return { pessoas, plano: plano ? { nome: plano.nome, limitePessoas: plano.limitePessoas } : null };
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
  const primeiroVencimento = diaQueExisteTodoMes(datas.sort().at(-1));
  const pessoas = await contarPessoas(escritorioId);
  const planoAtual = assinatura && assinatura.status !== 'CANCELADA' ? planoPorCodigo(assinatura.plano) : null;

  return {
    planos: PLANOS.map(({ codigo, nome, valorMensal, limitePessoas, destaque }) => ({
      codigo,
      nome,
      valorMensal,
      limitePessoas,
      destaque: Boolean(destaque),
    })),
    // plano da assinatura em andamento (null sem assinatura ou cancelada)
    plano: planoAtual ? { codigo: planoAtual.codigo, nome: planoAtual.nome, limitePessoas: planoAtual.limitePessoas } : null,
    // equipe + convites pendentes, e o menor plano em que cabem
    pessoas,
    planoSugerido: planoParaPessoas(pessoas)?.codigo ?? null,
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
  if (!['PIX', 'CARTAO'].includes(dados.forma)) throw new HttpError(400, 'Escolha Pix ou cartão de crédito');
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

const descricaoDoPlano = (plano) => `ArcDesk ${plano.nome} - assinatura mensal`;

// Evita duas assinaturas no gateway se o botão for clicado duas vezes
const assinando = new Set();

async function assinar(req) {
  const escritorioId = req.escritorioId;
  const dados = validarDados(req.body);
  const cartao = dados.forma === 'CARTAO' ? validarCartao(req.body.cartao) : null;
  const plano = planoPorCodigo(req.body.plano);
  if (!plano) throw new HttpError(400, 'Escolha um plano');
  const pessoas = await contarPessoas(escritorioId);
  if (pessoas > plano.limitePessoas) {
    throw new HttpError(
      400,
      `O plano ${plano.nome} permite até ${pessoasTexto(plano.limitePessoas)} e o escritório tem ${pessoasTexto(pessoas)}, contando os convites pendentes. Escolha um plano maior.`
    );
  }

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
      valor: plano.valorMensal,
      forma: dados.forma,
      primeiroVencimento,
      descricao: descricaoDoPlano(plano),
      referencia: `escritorio:${escritorioId}`,
      cartao,
      titular: dados,
      ip: ipDoPagador(req),
    });

    const registro = {
      plano: plano.codigo,
      valor: plano.valorMensal,
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

// ---------- Trocar de plano ----------

// Vale a partir da próxima mensalidade (sem cobrar diferença do mês atual). Para descer de
// plano, a equipe precisa caber no plano menor.
async function trocarPlano(escritorioId, codigo) {
  const plano = planoPorCodigo(codigo);
  if (!plano) throw new HttpError(400, 'Escolha um plano');
  const assinatura = await prisma.assinatura.findUnique({ where: { escritorioId } });
  if (!assinatura || assinatura.status === 'CANCELADA') throw new HttpError(404, 'Não há assinatura ativa');
  if (assinatura.plano === plano.codigo) throw new HttpError(400, `O escritório já está no plano ${plano.nome}`);

  const pessoas = await contarPessoas(escritorioId);
  if (pessoas > plano.limitePessoas) {
    throw new HttpError(
      400,
      `O plano ${plano.nome} permite até ${pessoasTexto(plano.limitePessoas)} e o escritório tem ${pessoasTexto(pessoas)}, contando os convites pendentes. Remova pessoas ou cancele convites em Equipe antes de mudar.`
    );
  }

  await gateway.atualizarAssinatura(assinatura.gatewayAssinaturaId, {
    valor: plano.valorMensal,
    descricao: descricaoDoPlano(plano),
  });
  const atualizada = await prisma.assinatura.update({
    where: { id: assinatura.id },
    data: { plano: plano.codigo, valor: plano.valorMensal },
  });
  try {
    await sincronizar(atualizada); // a mensalidade já gerada muda de valor no gateway
  } catch (erro) {
    console.error('[assinatura] falha ao sincronizar depois de trocar o plano:', erro.message);
  }
  return situacao(escritorioId, { admin: true });
}

// ---------- Cobrança em aberto (QR Code do Pix) ----------

async function cobrancaEmAberto(escritorioId) {
  const assinatura = await prisma.assinatura.findUnique({
    where: { escritorioId },
    include: { pagamentos: { where: { status: { in: EM_ABERTO } }, orderBy: { vencimento: 'asc' }, take: 1 } },
  });
  const pagamento = assinatura?.status !== 'CANCELADA' ? assinatura?.pagamentos[0] : null;
  if (!pagamento) return { pagamento: null };

  const forma = pagamento.forma || assinatura.forma;
  const resposta = { pagamento: { ...resumoPagamento(pagamento), forma } };
  if (forma === 'PIX') resposta.pix = await gateway.pix(pagamento.gatewayPagamentoId);
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

module.exports = {
  situacao,
  assinar,
  cobrancaEmAberto,
  cancelar,
  trocarPlano,
  exigirVaga,
  vagasDaEquipe,
  processarAviso,
  acessoDoEscritorio,
  calcularAcesso,
  // só para os testes
  somarMeses,
  diaQueExisteTodoMes,
};
