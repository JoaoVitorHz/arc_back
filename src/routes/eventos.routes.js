const { Router } = require('express');
const prisma = require('../lib/prisma');
const { garantirDoEscritorio } = require('../utils/escopo');
const {
  parseId,
  requireFields,
  emptyToNull,
  toDate,
  toOptionalInt,
} = require('../utils/http');

const router = Router();

const incluirRelacoes = {
  tipo: { select: { id: true, nome: true, cor: true } },
  cliente: { select: { id: true, nome: true } },
  projeto: { select: { id: true, nome: true } },
};

async function dadosEvento(body, escritorioId) {
  const dados = {
    titulo: body.titulo?.trim(),
    tipoId: toOptionalInt(body.tipoId),
    inicio: toDate(body.inicio),
    fim: toDate(body.fim),
    local: emptyToNull(body.local),
    descricao: emptyToNull(body.descricao),
    clienteId: toOptionalInt(body.clienteId),
    projetoId: toOptionalInt(body.projetoId),
  };
  await garantirDoEscritorio('tipoEvento', dados.tipoId, escritorioId);
  await garantirDoEscritorio('cliente', dados.clienteId, escritorioId);
  await garantirDoEscritorio('projeto', dados.projetoId, escritorioId);
  return dados;
}

// GET /api/eventos?inicio=2026-11-10&fim=2026-11-17
router.get('/', async (req, res) => {
  const { inicio, fim } = req.query;

  const eventos = await prisma.evento.findMany({
    where: {
      escritorioId: req.escritorioId,
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
    data: { ...(await dadosEvento(req.body, req.escritorioId)), escritorioId: req.escritorioId },
    include: incluirRelacoes,
  });
  res.status(201).json(evento);
});

// PUT /api/eventos/:id
router.put('/:id', async (req, res) => {
  requireFields(req.body, ['titulo', 'inicio']);
  const evento = await prisma.evento.update({
    where: { id: parseId(req.params.id), escritorioId: req.escritorioId },
    data: await dadosEvento(req.body, req.escritorioId),
    include: incluirRelacoes,
  });
  res.json(evento);
});

// DELETE /api/eventos/:id
router.delete('/:id', async (req, res) => {
  await prisma.evento.delete({
    where: { id: parseId(req.params.id), escritorioId: req.escritorioId },
  });
  res.status(204).end();
});

module.exports = router;
