const { Router } = require('express');
const prisma = require('../lib/prisma');
const armazenamento = require('../lib/armazenamento');
const { HttpError, parseId, toDate, toOptionalInt } = require('../utils/http');

const router = Router();

const STATUS_VALIDOS = ['NAO_INICIADA', 'EM_ANDAMENTO', 'CONCLUIDA'];
const TAMANHO_MAXIMO_DESCRICAO = 5000;

// A etapa pertence ao escritório pelo projeto dela
const daEtapa = (req) => ({
  id: parseId(req.params.id),
  projeto: { escritorioId: req.escritorioId },
});

// PATCH /api/etapas/:id  (atualiza só os campos enviados)
router.patch('/:id', async (req, res) => {
  const { nome, status, dataPrevista, descricao, responsavelId } = req.body;
  const data = {};

  if (nome !== undefined) {
    const texto = String(nome ?? '').trim();
    if (!texto) throw new HttpError(400, 'O nome da etapa não pode ficar vazio');
    if (texto.length > 191) throw new HttpError(400, 'O nome da etapa pode ter no máximo 191 caracteres');
    data.nome = texto;
  }
  // Responsável: precisa ser alguém da equipe do escritório (null = sem responsável)
  if (responsavelId !== undefined) {
    const id = toOptionalInt(responsavelId);
    if (id !== null) {
      const daEquipe = await prisma.usuario.count({ where: { id, escritorioId: req.escritorioId } });
      if (!daEquipe) throw new HttpError(400, 'Responsável precisa ser alguém da equipe');
    }
    data.responsavelId = id;
  }
  if (status !== undefined) {
    if (!STATUS_VALIDOS.includes(status)) throw new HttpError(400, 'Status inválido');
    data.status = status;
  }
  if (dataPrevista !== undefined) {
    data.dataPrevista = toDate(dataPrevista);
  }
  // Anotações: qualquer membro pode escrever; guarda quem editou por último e quando
  if (descricao !== undefined) {
    const texto = String(descricao ?? '').trim();
    if (texto.length > TAMANHO_MAXIMO_DESCRICAO) {
      throw new HttpError(400, `As anotações podem ter no máximo ${TAMANHO_MAXIMO_DESCRICAO} caracteres`);
    }
    data.descricao = texto || null;
    data.descricaoEditadaEm = new Date();
    data.descricaoEditadaPorId = req.usuario.id;
  }

  const etapa = await prisma.etapa.update({ where: daEtapa(req), data });

  res.json(etapa);
});

// DELETE /api/etapas/:id  (os arquivos da etapa são apagados junto, inclusive do armazenamento)
router.delete('/:id', async (req, res) => {
  const where = daEtapa(req);
  const arquivos = await prisma.arquivo.findMany({
    where: { etapaId: where.id, escritorioId: req.escritorioId },
    select: { chave: true },
  });
  await prisma.etapa.delete({ where }); // o banco apaga os registros dos arquivos (cascade)
  await armazenamento.apagar(arquivos.map((a) => a.chave));
  res.status(204).end();
});

module.exports = router;
