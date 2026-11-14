const { Router } = require('express');
const prisma = require('../lib/prisma');
const { CORES_TIPO_EVENTO } = require('../constants/tiposEvento');
const { HttpError, parseId, requireFields } = require('../utils/http');

const router = Router();

const TAMANHO_MAXIMO_NOME = 40;

function dadosTipo(body) {
  const nome = String(body.nome ?? '').trim();
  if (!nome) throw new HttpError(400, 'Informe o nome do tipo');
  if (nome.length > TAMANHO_MAXIMO_NOME) {
    throw new HttpError(400, `O nome pode ter no máximo ${TAMANHO_MAXIMO_NOME} caracteres`);
  }
  if (!CORES_TIPO_EVENTO.includes(body.cor)) throw new HttpError(400, 'Cor inválida');
  return { nome, cor: body.cor };
}

// Nomes não podem se repetir no mesmo escritório (a comparação ignora maiúsculas/minúsculas)
async function garantirNomeLivre(nome, escritorioId, idAtual) {
  const existente = await prisma.tipoEvento.findFirst({
    where: { escritorioId, nome, id: idAtual ? { not: idAtual } : undefined },
    select: { id: true },
  });
  if (existente) throw new HttpError(409, 'Já existe um tipo com esse nome');
}

// GET /api/tipos-evento  (com quantos compromissos usam cada tipo)
router.get('/', async (req, res) => {
  const tipos = await prisma.tipoEvento.findMany({
    where: { escritorioId: req.escritorioId },
    include: { _count: { select: { eventos: true } } },
    orderBy: { id: 'asc' },
  });
  res.json(tipos);
});

// POST /api/tipos-evento  { nome, cor }
router.post('/', async (req, res) => {
  requireFields(req.body, ['nome', 'cor']);
  const dados = dadosTipo(req.body);
  await garantirNomeLivre(dados.nome, req.escritorioId);

  const tipo = await prisma.tipoEvento.create({
    data: { ...dados, escritorioId: req.escritorioId },
  });
  res.status(201).json(tipo);
});

// PUT /api/tipos-evento/:id  { nome, cor }
router.put('/:id', async (req, res) => {
  requireFields(req.body, ['nome', 'cor']);
  const id = parseId(req.params.id);
  const dados = dadosTipo(req.body);
  await garantirNomeLivre(dados.nome, req.escritorioId, id);

  const tipo = await prisma.tipoEvento.update({
    where: { id, escritorioId: req.escritorioId },
    data: dados,
  });
  res.json(tipo);
});

// DELETE /api/tipos-evento/:id  (os compromissos desse tipo ficam sem tipo)
router.delete('/:id', async (req, res) => {
  await prisma.tipoEvento.delete({
    where: { id: parseId(req.params.id), escritorioId: req.escritorioId },
  });
  res.status(204).end();
});

module.exports = router;
