const { Router } = require('express');
const prisma = require('../lib/prisma');
const {
  parseId,
  requireFields,
  emptyToNull,
  toDate,
  toOptionalInt,
} = require('../utils/http');

const router = Router();

const incluirRelacoes = {
  cliente: { select: { id: true, nome: true } },
  projeto: { select: { id: true, nome: true } },
};

function dadosEvento(body) {
  return {
    titulo: body.titulo?.trim(),
    tipo: body.tipo || undefined,
    inicio: toDate(body.inicio),
    fim: toDate(body.fim),
    local: emptyToNull(body.local),
    descricao: emptyToNull(body.descricao),
    clienteId: toOptionalInt(body.clienteId),
    projetoId: toOptionalInt(body.projetoId),
  };
}

// GET /api/eventos?inicio=2026-11-10&fim=2026-11-17
router.get('/', async (req, res) => {
  const { inicio, fim } = req.query;

  const eventos = await prisma.evento.findMany({
    where: {
      inicio: {
        gte: toDate(inicio) || undefined,
        lt: toDate(fim) || undefined,
      },
    },
    include: incluirRelacoes,
    orderBy: { inicio: 'asc' },
  });

  res.json(eventos);
});

// POST /api/eventos
router.post('/', async (req, res) => {
  requireFields(req.body, ['titulo', 'inicio']);
  const evento = await prisma.evento.create({
    data: dadosEvento(req.body),
    include: incluirRelacoes,
  });
  res.status(201).json(evento);
});

// PUT /api/eventos/:id
router.put('/:id', async (req, res) => {
  requireFields(req.body, ['titulo', 'inicio']);
  const evento = await prisma.evento.update({
    where: { id: parseId(req.params.id) },
    data: dadosEvento(req.body),
    include: incluirRelacoes,
  });
  res.json(evento);
});

// DELETE /api/eventos/:id
router.delete('/:id', async (req, res) => {
  await prisma.evento.delete({ where: { id: parseId(req.params.id) } });
  res.status(204).end();
});

module.exports = router;
