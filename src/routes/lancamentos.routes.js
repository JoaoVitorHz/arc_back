const crypto = require('crypto');
const { Router } = require('express');
const prisma = require('../lib/prisma');
const { calcularResumoMes, despesasPorCategoria } = require('../services/financeiro.service');
const { garantirDoEscritorio } = require('../utils/escopo');
const {
  HttpError,
  parseId,
  requireFields,
  emptyToNull,
  toDate,
  toDecimal,
  toOptionalInt,
  monthRange,
  currentMonth,
} = require('../utils/http');

const router = Router();

const MAX_VEZES = 60;

// Soma meses mantendo o dia; se o mês não tiver esse dia (ex.: 31), usa o último dia do mês
function somarMeses(data, meses) {
  const ano = data.getUTCFullYear();
  const mes = data.getUTCMonth() + meses;
  const ultimoDia = new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate();
  return new Date(Date.UTC(ano, mes, Math.min(data.getUTCDate(), ultimoDia)));
}

// { modo: 'parcelar' | 'repetir', vezes } -> lista de lançamentos a criar (ou só o original)
function aplicarRepeticao(dados, repeticao) {
  if (!repeticao || !repeticao.modo || repeticao.modo === 'unico') return [dados];
  if (!['parcelar', 'repetir'].includes(repeticao.modo)) throw new HttpError(400, 'Repetição inválida');
  const vezes = Number(repeticao.vezes);
  if (!Number.isInteger(vezes) || vezes < 2 || vezes > MAX_VEZES) {
    throw new HttpError(400, `Informe de 2 a ${MAX_VEZES} vezes`);
  }

  // Parcelar divide o valor total; os centavos que sobram vão na última parcela
  const centavos = Math.round(dados.valor * 100);
  const base = Math.floor(centavos / vezes);
  const serieId = crypto.randomUUID();

  return Array.from({ length: vezes }, (_, i) => {
    const valor =
      repeticao.modo === 'parcelar' ? (i === vezes - 1 ? centavos - base * (vezes - 1) : base) / 100 : dados.valor;
    const pago = i === 0 ? dados.pago : false; // "já foi pago" vale só para o primeiro
    return {
      ...dados,
      descricao: repeticao.modo === 'parcelar' ? `${dados.descricao} (${i + 1}/${vezes})` : dados.descricao,
      valor,
      vencimento: somarMeses(dados.vencimento, i),
      pago,
      dataPagamento: pago ? dados.dataPagamento : null,
      serieId,
    };
  });
}

// "(2/4)" no fim da descrição das parcelas
const SUFIXO_PARCELA = /\s*\(\d+\/\d+\)$/;

// Mesma data com outro dia do mês (31 vira o último dia em meses mais curtos)
function comDia(data, dia) {
  const ultimoDia = new Date(Date.UTC(data.getUTCFullYear(), data.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(data.getUTCFullYear(), data.getUTCMonth(), Math.min(dia, ultimoDia)));
}

// Lançamentos da mesma série a partir deste (inclusive), em ordem
function esteEProximos(lancamento) {
  return prisma.lancamento.findMany({
    where: {
      escritorioId: lancamento.escritorioId,
      serieId: lancamento.serieId,
      vencimento: { gte: lancamento.vencimento },
    },
    orderBy: { vencimento: 'asc' },
  });
}

async function buscarLancamento(id, escritorioId) {
  const lancamento = await prisma.lancamento.findFirst({ where: { id: parseId(id), escritorioId } });
  if (!lancamento) throw new HttpError(404, 'Lançamento não encontrado');
  return lancamento;
}

// Quantos lançamentos da série existem a partir de cada um (inclusive), para a tela
// oferecer "este e os próximos" só quando faz sentido
async function comRestantesNaSerie(lancamentos, escritorioId) {
  const series = [...new Set(lancamentos.map((l) => l.serieId).filter(Boolean))];
  if (!series.length) return lancamentos;
  const daSerie = await prisma.lancamento.findMany({
    where: { escritorioId, serieId: { in: series } },
    select: { serieId: true, vencimento: true },
  });
  return lancamentos.map((l) => ({
    ...l,
    restantesNaSerie: l.serieId
      ? daSerie.filter((s) => s.serieId === l.serieId && s.vencimento >= l.vencimento).length
      : 1,
  }));
}

async function dadosLancamento(body, escritorioId) {
  if (!['RECEITA', 'DESPESA'].includes(body.tipo)) {
    throw new HttpError(400, 'Tipo deve ser RECEITA ou DESPESA');
  }
  const valor = toDecimal(body.valor);
  if (valor === null || valor <= 0) {
    throw new HttpError(400, 'O valor deve ser maior que zero');
  }

  const pago = Boolean(body.pago);
  const dados = {
    descricao: body.descricao?.trim(),
    tipo: body.tipo,
    valor,
    vencimento: toDate(body.vencimento),
    pago,
    dataPagamento: pago ? toDate(body.dataPagamento) || new Date() : null,
    categoria: emptyToNull(body.categoria),
    projetoId: toOptionalInt(body.projetoId),
  };
  await garantirDoEscritorio('projeto', dados.projetoId, escritorioId);
  return dados;
}

// GET /api/lancamentos?mes=2026-11&tipo=RECEITA&situacao=pendente&projetoId=1
// Período em vez de um mês (ex.: exportar para o contador): ?inicio=2026-01&fim=2026-12
router.get('/', async (req, res) => {
  const { mes, inicio, fim, tipo, situacao, projetoId } = req.query;

  let vencimento;
  if (inicio || fim) {
    if (!inicio || !fim) throw new HttpError(400, 'Informe o mês inicial e o final');
    vencimento = { gte: monthRange(inicio).gte, lt: monthRange(fim).lt };
    if (vencimento.gte >= vencimento.lt) throw new HttpError(400, 'O mês final deve ser depois do inicial');
  } else if (mes) {
    vencimento = monthRange(mes);
  }

  const lancamentos = await prisma.lancamento.findMany({
    where: {
      escritorioId: req.escritorioId,
      vencimento,
      tipo: tipo || undefined,
      pago: situacao === 'pago' ? true : situacao === 'pendente' ? false : undefined,
      projetoId: projetoId ? parseId(projetoId) : undefined,
    },
    include: { projeto: { select: { id: true, nome: true } } },
    orderBy: { vencimento: 'asc' },
  });

  res.json(await comRestantesNaSerie(lancamentos, req.escritorioId));
});

// GET /api/lancamentos/fluxo?inicio=2026-11&meses=6
// -> { meses: [{ mes, entradas, saidas, saldo, acumulado }], despesasPorCategoria: [{ categoria, total }] }
// Considera todos os lançamentos pelo vencimento (pagos ou não): é a previsão do caixa.
router.get('/fluxo', async (req, res) => {
  const inicio = req.query.inicio || currentMonth();
  const meses = Math.min(Math.max(Number(req.query.meses) || 6, 1), 24);
  const { gte } = monthRange(inicio);
  const lt = somarMeses(gte, meses);

  const lancamentos = await prisma.lancamento.findMany({
    where: { escritorioId: req.escritorioId, vencimento: { gte, lt } },
    select: { tipo: true, valor: true, vencimento: true, categoria: true },
  });

  let acumulado = 0;
  const fluxo = Array.from({ length: meses }, (_, i) => {
    const data = somarMeses(gte, i);
    const chave = `${data.getUTCFullYear()}-${String(data.getUTCMonth() + 1).padStart(2, '0')}`;
    const doMes = lancamentos.filter((l) => l.vencimento.toISOString().slice(0, 7) === chave);
    const soma = (tipo) => doMes.filter((l) => l.tipo === tipo).reduce((t, l) => t + Number(l.valor), 0);
    const entradas = soma('RECEITA');
    const saidas = soma('DESPESA');
    acumulado += entradas - saidas;
    return { mes: chave, entradas, saidas, saldo: entradas - saidas, acumulado };
  });

  res.json({ meses: fluxo, despesasPorCategoria: despesasPorCategoria(lancamentos) });
});

// GET /api/lancamentos/resumo?mes=2026-11
router.get('/resumo', async (req, res) => {
  res.json(await calcularResumoMes(req.query.mes || currentMonth(), req.escritorioId));
});

// POST /api/lancamentos  (opcional: repeticao = { modo: 'parcelar' | 'repetir', vezes })
router.post('/', async (req, res) => {
  requireFields(req.body, ['descricao', 'tipo', 'valor', 'vencimento']);
  const dados = { ...(await dadosLancamento(req.body, req.escritorioId)), escritorioId: req.escritorioId };
  const lista = aplicarRepeticao(dados, req.body.repeticao);

  const criados = await prisma.$transaction(lista.map((data) => prisma.lancamento.create({ data })));
  res.status(201).json(criados.length === 1 ? criados[0] : { criados: criados.length, lancamentos: criados });
});

// PUT /api/lancamentos/:id  (opcional: aplicarEm = 'proximos' altera também os próximos da série)
// Nos próximos: descrição (mantendo o "(2/4)" de cada um), tipo, valor, categoria, projeto e o dia
// do vencimento (se mudar o mês, todos andam junto). Pago/não pago de cada um não muda.
router.put('/:id', async (req, res) => {
  requireFields(req.body, ['descricao', 'tipo', 'valor', 'vencimento']);
  const atual = await buscarLancamento(req.params.id, req.escritorioId);
  const dados = await dadosLancamento(req.body, req.escritorioId);

  if (req.body.aplicarEm !== 'proximos' || !atual.serieId) {
    const lancamento = await prisma.lancamento.update({ where: { id: atual.id }, data: dados });
    return res.json({ ...lancamento, atualizados: 1 });
  }

  const proximos = (await esteEProximos(atual)).filter((l) => l.id !== atual.id);
  const mesesDeslocados =
    dados.vencimento.getUTCFullYear() * 12 +
    dados.vencimento.getUTCMonth() -
    (atual.vencimento.getUTCFullYear() * 12 + atual.vencimento.getUTCMonth());
  const dia = dados.vencimento.getUTCDate();
  const base = dados.descricao.replace(SUFIXO_PARCELA, '');

  const [lancamento] = await prisma.$transaction([
    prisma.lancamento.update({ where: { id: atual.id }, data: dados }),
    ...proximos.map((l) => {
      const sufixo = l.descricao.match(SUFIXO_PARCELA)?.[0] ?? '';
      return prisma.lancamento.update({
        where: { id: l.id },
        data: {
          descricao: base + sufixo,
          tipo: dados.tipo,
          valor: dados.valor,
          categoria: dados.categoria,
          projetoId: dados.projetoId,
          vencimento: comDia(somarMeses(l.vencimento, mesesDeslocados), dia),
        },
      });
    }),
  ]);
  res.json({ ...lancamento, atualizados: proximos.length + 1 });
});

// PATCH /api/lancamentos/:id/pagamento  { pago: true | false }
router.patch('/:id/pagamento', async (req, res) => {
  const pago = Boolean(req.body.pago);
  const lancamento = await prisma.lancamento.update({
    where: { id: parseId(req.params.id), escritorioId: req.escritorioId },
    data: { pago, dataPagamento: pago ? new Date() : null },
  });
  res.json(lancamento);
});

// DELETE /api/lancamentos/:id  (?escopo=proximos exclui também os próximos da série)
router.delete('/:id', async (req, res) => {
  const atual = await buscarLancamento(req.params.id, req.escritorioId);
  const ids =
    req.query.escopo === 'proximos' && atual.serieId ? (await esteEProximos(atual)).map((l) => l.id) : [atual.id];
  const { count } = await prisma.lancamento.deleteMany({ where: { id: { in: ids }, escritorioId: req.escritorioId } });
  res.json({ excluidos: count });
});

module.exports = router;
