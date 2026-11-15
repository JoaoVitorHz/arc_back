const { Router } = require('express');
const prisma = require('../lib/prisma');
const { HttpError, parseId, requireFields, emptyToNull } = require('../utils/http');
const { podeVerFinanceiro } = require('../middlewares/permissoes');

const router = Router();

function dadosCliente(body) {
  return {
    nome: body.nome?.trim(),
    email: emptyToNull(body.email),
    telefone: emptyToNull(body.telefone),
    documento: emptyToNull(body.documento),
    endereco: emptyToNull(body.endereco),
    observacoes: emptyToNull(body.observacoes),
  };
}

// GET /api/clientes?busca=
router.get('/', async (req, res) => {
  const { busca } = req.query;

  const clientes = await prisma.cliente.findMany({
    where: {
      escritorioId: req.escritorioId,
      OR: busca
        ? [
            { nome: { contains: busca } },
            { email: { contains: busca } },
            { telefone: { contains: busca } },
            { documento: { contains: busca } },
          ]
        : undefined,
    },
    include: { _count: { select: { projetos: true } } },
    orderBy: { nome: 'asc' },
  });

  res.json(clientes);
});

// GET /api/clientes/:id  (página do cliente: projetos com progresso, compromissos e resumo financeiro)
router.get('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const { escritorioId } = req;

  const cliente = await prisma.cliente.findFirstOrThrow({
    where: { id, escritorioId },
    include: {
      projetos: {
        orderBy: { criadoEm: 'desc' },
        include: { etapas: { select: { status: true, nome: true, ordem: true } } },
      },
      eventos: {
        orderBy: { inicio: 'desc' },
        include: {
          tipo: { select: { id: true, nome: true, cor: true } },
          projeto: { select: { id: true, nome: true } },
        },
      },
    },
  });

  const projetos = cliente.projetos.map(({ etapas, valorContrato, ...projeto }) => {
    const ordenadas = [...etapas].sort((a, b) => a.ordem - b.ordem);
    const concluidas = ordenadas.filter((e) => e.status === 'CONCLUIDA').length;
    return {
      ...projeto,
      ...(podeVerFinanceiro(req.usuario) && { valorContrato }),
      progresso: ordenadas.length ? Math.round((concluidas / ordenadas.length) * 100) : 0,
      etapaAtual: ordenadas.find((e) => e.status !== 'CONCLUIDA')?.nome || 'Concluído',
    };
  });

  // Sem acesso ao financeiro: sem valores de contrato e sem o resumo financeiro
  if (!podeVerFinanceiro(req.usuario)) {
    return res.json({ ...cliente, projetos, financeiro: null });
  }

  // Receitas dos projetos deste cliente
  const receitas = await prisma.lancamento.groupBy({
    by: ['pago'],
    where: { escritorioId, tipo: 'RECEITA', projeto: { clienteId: id } },
    _sum: { valor: true },
  });
  const somaReceitas = (pago) => Number(receitas.find((r) => r.pago === pago)?._sum.valor || 0);
  const totalContratos = cliente.projetos.reduce((total, p) => total + Number(p.valorContrato || 0), 0);

  res.json({
    ...cliente,
    projetos,
    financeiro: {
      totalContratos,
      recebido: somaReceitas(true),
      aReceber: somaReceitas(false),
    },
  });
});

// POST /api/clientes
router.post('/', async (req, res) => {
  requireFields(req.body, ['nome']);
  const cliente = await prisma.cliente.create({
    data: { ...dadosCliente(req.body), escritorioId: req.escritorioId },
  });
  res.status(201).json(cliente);
});

// PUT /api/clientes/:id
router.put('/:id', async (req, res) => {
  requireFields(req.body, ['nome']);
  const cliente = await prisma.cliente.update({
    where: { id: parseId(req.params.id), escritorioId: req.escritorioId },
    data: dadosCliente(req.body),
  });
  res.json(cliente);
});

// DELETE /api/clientes/:id
router.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);

  const totalProjetos = await prisma.projeto.count({
    where: { clienteId: id, escritorioId: req.escritorioId },
  });
  if (totalProjetos > 0) {
    throw new HttpError(409, 'Este cliente possui projetos. Exclua ou transfira os projetos antes.');
  }

  await prisma.cliente.delete({ where: { id, escritorioId: req.escritorioId } });
  res.status(204).end();
});

module.exports = router;
