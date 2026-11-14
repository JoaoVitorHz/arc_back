const { Router } = require('express');
const prisma = require('../lib/prisma');
const { exigirAdmin, exigirEscritorio } = require('../middlewares/permissoes');
const { dadosNovoEscritorio, resumoDoEscritorio } = require('../services/equipe.service');
const { HttpError, parseId, requireFields } = require('../utils/http');
const { selecaoUsuario } = require('../utils/sessao');

const router = Router();

const DIAS_PARA_RESTAURAR = 30;
const selecao = { id: true, nome: true, criadoEm: true };

const limiteRestauracao = () => new Date(Date.now() - DIAS_PARA_RESTAURAR * 24 * 60 * 60 * 1000);
const restauravelAte = (encerradoEm) => new Date(encerradoEm.getTime() + DIAS_PARA_RESTAURAR * 24 * 60 * 60 * 1000);
const comparavel = (texto) => String(texto ?? '').trim().toLocaleLowerCase('pt-BR');

function exigirSemEscritorio(req) {
  if (req.escritorioId) {
    throw new HttpError(400, 'Você já faz parte de um escritório. Saia dele ou encerre-o antes.');
  }
}

async function usuarioAtualizado(id) {
  return prisma.usuario.findUniqueOrThrow({ where: { id }, select: selecaoUsuario });
}

// ---------- Para quem está sem escritório ----------

// POST /api/escritorio  { nome }  ("Criar meu escritório")
router.post('/', async (req, res) => {
  exigirSemEscritorio(req);
  requireFields(req.body, ['nome']);
  const nome = String(req.body.nome).trim();
  if (!nome) throw new HttpError(400, 'Informe o nome do escritório');

  const escritorio = await prisma.escritorio.create({ data: dadosNovoEscritorio(nome), select: { id: true } });
  await prisma.usuario.update({ where: { id: req.usuario.id }, data: { escritorioId: escritorio.id, papel: 'ADMIN' } });
  res.status(201).json({ usuario: await usuarioAtualizado(req.usuario.id) });
});

// GET /api/escritorio/encerrados  (escritórios que eu encerrei e ainda posso restaurar)
router.get('/encerrados', async (req, res) => {
  const escritorios = await prisma.escritorio.findMany({
    where: { encerradoPorId: req.usuario.id, encerradoEm: { gte: limiteRestauracao() } },
    select: { id: true, nome: true, encerradoEm: true },
    orderBy: { encerradoEm: 'desc' },
  });
  res.json(escritorios.map((e) => ({ ...e, restauravelAte: restauravelAte(e.encerradoEm) })));
});

// POST /api/escritorio/:id/restaurar
router.post('/:id/restaurar', async (req, res) => {
  exigirSemEscritorio(req);
  const id = parseId(req.params.id);
  const escritorio = await prisma.escritorio.findFirst({
    where: { id, encerradoPorId: req.usuario.id, encerradoEm: { gte: limiteRestauracao() } },
    select: { id: true },
  });
  if (!escritorio) throw new HttpError(404, 'Escritório não encontrado ou prazo de restauração encerrado');

  await prisma.$transaction([
    prisma.escritorio.update({ where: { id }, data: { encerradoEm: null, encerradoPorId: null } }),
    prisma.usuario.update({ where: { id: req.usuario.id }, data: { escritorioId: id, papel: 'ADMIN' } }),
  ]);
  res.json({ usuario: await usuarioAtualizado(req.usuario.id) });
});

// ---------- Escritório atual ----------
router.use(exigirEscritorio);

// GET /api/escritorio  (escritório do usuário logado, com o tamanho da equipe)
router.get('/', async (req, res) => {
  const resumo = await resumoDoEscritorio(req.escritorioId);
  res.json(resumo);
});

// PUT /api/escritorio  { nome }  (só administradores)
router.put('/', exigirAdmin, async (req, res) => {
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

// POST /api/escritorio/encerrar  { confirmacao: "<nome do escritório>" }
// Só o administrador, e só quando ele é a única pessoa do escritório.
// O escritório fica desativado e pode ser restaurado em até 30 dias.
router.post('/encerrar', exigirAdmin, async (req, res) => {
  const resumo = await resumoDoEscritorio(req.escritorioId);
  if (resumo.membros > 1) {
    const outros = resumo.membros - 1;
    throw new HttpError(
      400,
      `Ainda há ${outros} ${outros === 1 ? 'pessoa' : 'pessoas'} na equipe. Remova-as em Equipe antes de encerrar o escritório.`
    );
  }
  if (comparavel(req.body.confirmacao) !== comparavel(resumo.nome)) {
    throw new HttpError(400, 'Digite o nome do escritório exatamente como aparece para confirmar.');
  }

  const agora = new Date();
  await prisma.$transaction([
    prisma.escritorio.update({
      where: { id: req.escritorioId },
      data: { encerradoEm: agora, encerradoPorId: req.usuario.id },
    }),
    prisma.usuario.update({ where: { id: req.usuario.id }, data: { escritorioId: null } }),
    prisma.convite.deleteMany({ where: { escritorioId: req.escritorioId, aceitoEm: null } }),
  ]);

  res.json({ usuario: await usuarioAtualizado(req.usuario.id), restauravelAte: restauravelAte(agora) });
});

module.exports = router;
