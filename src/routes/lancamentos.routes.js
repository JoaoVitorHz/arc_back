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

// GET /api/lancamentos/resumo?mes=2026-11
router.get('/resumo', async (req, res) => {
  res.json(await calcularResumoMes(req.query.mes || currentMonth(), req.escritorioId));
});

// POST /api/lancamentos
router.post('/', async (req, res) => {
  requireFields(req.body, ['descricao', 'tipo', 'valor', 'vencimento']);
  const lancamento = await prisma.lancamento.create({
    data: { ...(await dadosLancamento(req.body, req.escritorioId)), escritorioId: req.escritorioId },
  });
  res.status(201).json(lancamento);
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
