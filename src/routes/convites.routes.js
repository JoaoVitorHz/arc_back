const { Router } = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const autenticar = require('../middlewares/autenticar');
const { entrarNoEscritorio } = require('../services/equipe.service');
const { exigirVaga } = require('../services/assinatura.service');
const { HttpError, parseId, requireFields } = require('../utils/http');
const {
  SALT_ROUNDS,
  limiteTentativas,
  selecaoUsuario,
  validarSenha,
  respostaSessao,
  hashToken,
} = require('../utils/sessao');

const router = Router();

// Convite ainda pendente, dentro da validade e de um escritório ativo
async function conviteValido(where) {
  const convite = await prisma.convite.findFirst({
    where: { ...where, aceitoEm: null, expiraEm: { gt: new Date() }, escritorio: { encerradoEm: null } },
    include: { escritorio: { select: { id: true, nome: true } } },
  });
  if (!convite) {
    throw new HttpError(400, 'Este convite é inválido, expirou ou já foi usado. Peça um novo ao administrador do escritório.');
  }
  return convite;
}

// Marca como aceito só se ninguém usou antes (evita usar o mesmo convite duas vezes ao mesmo tempo)
async function marcarAceito(convite) {
  await prisma.convite.updateMany({ where: { id: convite.id, aceitoEm: null }, data: { aceitoEm: new Date() } });
}

// ---------- Pelo link do e-mail (sem estar logado) ----------

// GET /api/convites/token/:token  (dados para a tela do convite)
router.get('/token/:token', async (req, res) => {
  const convite = await conviteValido({ tokenHash: hashToken(req.params.token) });
  const conta = await prisma.usuario.findUnique({ where: { email: convite.email }, select: { id: true } });
  res.json({
    nome: convite.nome,
    email: convite.email,
    papel: convite.papel,
    escritorio: { nome: convite.escritorio.nome },
    contaExiste: Boolean(conta),
  });
});

// POST /api/convites/token/:token/aceitar
//   sem conta: { nome, senha } cria a conta já no escritório
//   com conta: { senha } confirma quem é e muda de escritório (se as regras permitirem)
router.post('/token/:token/aceitar', limiteTentativas, async (req, res) => {
  requireFields(req.body, ['senha']);
  const convite = await conviteValido({ tokenHash: hashToken(req.params.token) });
  await exigirVaga(convite.escritorioId, { aceitandoConvite: true });
  const conta = await prisma.usuario.findUnique({
    where: { email: convite.email },
    select: { id: true, senhaHash: true },
  });

  let usuarioId;
  if (!conta) {
    validarSenha(req.body.senha);
    const nome = String(req.body.nome ?? '').trim() || convite.nome;
    const criado = await prisma.usuario.create({
      data: {
        nome,
        email: convite.email,
        senhaHash: await bcrypt.hash(String(req.body.senha), SALT_ROUNDS),
        papel: convite.papel,
        escritorioId: convite.escritorioId,
      },
      select: { id: true },
    });
    usuarioId = criado.id;
  } else {
    if (!(await bcrypt.compare(String(req.body.senha), conta.senhaHash))) {
      throw new HttpError(400, 'Senha incorreta');
    }
    await entrarNoEscritorio(conta.id, convite.escritorioId, convite.papel);
    usuarioId = conta.id;
  }

  await marcarAceito(convite);
  const usuario = await prisma.usuario.findUniqueOrThrow({ where: { id: usuarioId }, select: selecaoUsuario });
  res.json(respostaSessao(usuario));
});

// ---------- Para quem já está logado ----------

async function emailDoUsuario(req) {
  const { email } = await prisma.usuario.findUniqueOrThrow({ where: { id: req.usuario.id }, select: { email: true } });
  return email;
}

// GET /api/convites/meus  (convites pendentes para o e-mail de quem está logado)
router.get('/meus', autenticar, async (req, res) => {
  const convites = await prisma.convite.findMany({
    where: {
      email: await emailDoUsuario(req),
      aceitoEm: null,
      expiraEm: { gt: new Date() },
      escritorio: { encerradoEm: null },
      // convite para o escritório em que a pessoa já está não aparece
      ...(req.escritorioId ? { escritorioId: { not: req.escritorioId } } : {}),
    },
    select: {
      id: true,
      papel: true,
      expiraEm: true,
      escritorio: { select: { nome: true } },
      convidadoPor: { select: { nome: true } },
    },
    orderBy: { criadoEm: 'desc' },
  });
  res.json(convites);
});

// POST /api/convites/:id/aceitar  (aceitar estando logado, ex.: na tela "sem escritório" ou no perfil)
router.post('/:id/aceitar', autenticar, async (req, res) => {
  const convite = await conviteValido({ id: parseId(req.params.id), email: await emailDoUsuario(req) });
  await exigirVaga(convite.escritorioId, { aceitandoConvite: true });
  await entrarNoEscritorio(req.usuario.id, convite.escritorioId, convite.papel);
  await marcarAceito(convite);
  const usuario = await prisma.usuario.findUniqueOrThrow({ where: { id: req.usuario.id }, select: selecaoUsuario });
  res.json({ usuario });
});

module.exports = router;
