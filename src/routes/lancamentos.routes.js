const { Router } = require('express');
const prisma = require('../lib/prisma');
const { calcularResumoMes } = require('../services/financeiro.service');
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
    };
  });
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
router.get('/', async (req, res) => {
  const { mes, tipo, situacao, projetoId } = req.query;

  const lancamentos = await prisma.lancamento.findMany({
    where: {
      escritorioId: req.escritorioId,
      vencimento: mes ? monthRange(mes) : undefined,
      tipo: tipo || undefined,
      pago: situacao === 'pago' ? true : situacao === 'pendente' ? false : undefined,
      projetoId: projetoId ? parseId(projetoId) : undefined,
    },
    include: { projeto: { select: { id: true, nome: true } } },
    orderBy: { vencimento: 'asc' },
  });

  res.json(lancamentos);
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

// Total de despesas por categoria no período: as 5 maiores e o resto somado em "Outras"
function despesasPorCategoria(lancamentos) {
  const totais = new Map();
  for (const l of lancamentos) {
    if (l.tipo !== 'DESPESA') continue;
    const nome = l.categoria?.trim() || 'Sem categoria';
    totais.set(nome, (totais.get(nome) || 0) + Number(l.valor));
  }
  const ordenadas = [...totais]
    .map(([categoria, total]) => ({ categoria, total }))
    .sort((a, b) => b.total - a.total);
  if (ordenadas.length <= 6) return ordenadas;
  const outras = ordenadas.slice(5).reduce((t, c) => t + c.total, 0);
  return [...ordenadas.slice(0, 5), { categoria: 'Outras', total: outras }];
}

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

// PUT /api/lancamentos/:id
router.put('/:id', async (req, res) => {
  requireFields(req.body, ['descricao', 'tipo', 'valor', 'vencimento']);
  const lancamento = await prisma.lancamento.update({
    where: { id: parseId(req.params.id), escritorioId: req.escritorioId },
    data: await dadosLancamento(req.body, req.escritorioId),
  });
  res.json(lancamento);
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

// DELETE /api/lancamentos/:id
router.delete('/:id', async (req, res) => {
  await prisma.lancamento.delete({
    where: { id: parseId(req.params.id), escritorioId: req.escritorioId },
  });
  res.status(204).end();
});

module.exports = router;
