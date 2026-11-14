const { Router } = require('express');
const prisma = require('../lib/prisma');
const { HttpError, parseId, requireFields, emptyToNull } = require('../utils/http');

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

// GET /api/clientes/:id
router.get('/:id', async (req, res) => {
  const cliente = await prisma.cliente.findFirstOrThrow({
    where: { id: parseId(req.params.id), escritorioId: req.escritorioId },
    include: { projetos: { orderBy: { criadoEm: 'desc' } } },
  });
  res.json(cliente);
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
