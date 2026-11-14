const { Router } = require('express');
const prisma = require('../lib/prisma');
const { HttpError, parseId, toDate } = require('../utils/http');

const router = Router();

const STATUS_VALIDOS = ['NAO_INICIADA', 'EM_ANDAMENTO', 'CONCLUIDA'];

// A etapa pertence ao escritório pelo projeto dela
const daEtapa = (req) => ({
  id: parseId(req.params.id),
  projeto: { escritorioId: req.escritorioId },
});

// PATCH /api/etapas/:id  (atualiza só os campos enviados)
router.patch('/:id', async (req, res) => {
  const { nome, status, dataPrevista } = req.body;
  const data = {};

  if (nome !== undefined) {
    if (!nome.trim()) throw new HttpError(400, 'O nome da etapa não pode ficar vazio');
    data.nome = nome.trim();
  }
  if (status !== undefined) {
    if (!STATUS_VALIDOS.includes(status)) throw new HttpError(400, 'Status inválido');
    data.status = status;
  }
  if (dataPrevista !== undefined) {
    data.dataPrevista = toDate(dataPrevista);
  }

  const etapa = await prisma.etapa.update({ where: daEtapa(req), data });

  res.json(etapa);
});

// DELETE /api/etapas/:id
router.delete('/:id', async (req, res) => {
  await prisma.etapa.delete({ where: daEtapa(req) });
  res.status(204).end();
});

module.exports = router;
