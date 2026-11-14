const { Router } = require('express');
const prisma = require('../lib/prisma');
const { HttpError, requireFields } = require('../utils/http');

const router = Router();

const selecao = { id: true, nome: true, criadoEm: true };

// GET /api/escritorio  (escritório do usuário logado)
router.get('/', async (req, res) => {
  const escritorio = await prisma.escritorio.findUniqueOrThrow({
    where: { id: req.escritorioId },
    select: selecao,
  });
  res.json(escritorio);
});

// PUT /api/escritorio  { nome }
router.put('/', async (req, res) => {
  requireFields(req.body, ['nome']);
  const nome = String(req.body.nome).trim();
  if (!nome) throw new HttpError(400, 'Informe o nome do escritório');

  const escritorio = await prisma.escritorio.update({
    where: { id: req.escritorioId },
    data: { nome },
    select: selecao,
  });
  res.json(escritorio);
});

module.exports = router;
