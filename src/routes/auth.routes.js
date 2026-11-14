const { Router } = require('express');
const bcrypt = require('bcryptjs');
const { rateLimit } = require('express-rate-limit');
const prisma = require('../lib/prisma');
const { gerarToken } = require('../lib/jwt');
const autenticar = require('../middlewares/autenticar');
const { HttpError, requireFields } = require('../utils/http');

const router = Router();

const SALT_ROUNDS = 10;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Hash usado quando o e-mail não existe, para o login levar o mesmo tempo nos dois casos
const HASH_FALSO = bcrypt.hashSync('senha-inexistente', SALT_ROUNDS);

// Limita tentativas de login/cadastro por IP (protege contra força bruta)
const limiteTentativas = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { erro: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' },
});

const selecaoUsuario = {
  id: true,
  nome: true,
  email: true,
  escritorioId: true,
  escritorio: { select: { id: true, nome: true } },
};

function normalizarEmail(email) {
  return String(email).trim().toLowerCase();
}

function validarSenha(senha) {
  const tamanho = Buffer.byteLength(String(senha));
  // bcrypt ignora o que passa de 72 bytes
  if (tamanho < 8 || tamanho > 72) {
    throw new HttpError(400, 'A senha deve ter entre 8 e 72 caracteres');
  }
}

function respostaSessao(usuario) {
  return { token: gerarToken(usuario), usuario };
}

// POST /api/auth/cadastro  { nome, email, senha, nomeEscritorio }
// Cria o escritório e o primeiro usuário dele
router.post('/cadastro', limiteTentativas, async (req, res) => {
  requireFields(req.body, ['nome', 'email', 'senha', 'nomeEscritorio']);

  const nome = String(req.body.nome).trim();
  const nomeEscritorio = String(req.body.nomeEscritorio).trim();
  const email = normalizarEmail(req.body.email);

  if (!nome || !nomeEscritorio) throw new HttpError(400, 'Preencha seu nome e o nome do escritório');
  if (!EMAIL_REGEX.test(email)) throw new HttpError(400, 'E-mail inválido');
  validarSenha(req.body.senha);

  const existente = await prisma.usuario.findUnique({ where: { email }, select: { id: true } });
  if (existente) throw new HttpError(409, 'Já existe uma conta com este e-mail');

  const senhaHash = await bcrypt.hash(String(req.body.senha), SALT_ROUNDS);

  const escritorio = await prisma.escritorio.create({
    data: {
      nome: nomeEscritorio,
      usuarios: { create: { nome, email, senhaHash } },
    },
    select: { usuarios: { select: selecaoUsuario } },
  });

  res.status(201).json(respostaSessao(escritorio.usuarios[0]));
});

// POST /api/auth/login  { email, senha }
router.post('/login', limiteTentativas, async (req, res) => {
  requireFields(req.body, ['email', 'senha']);

  const usuario = await prisma.usuario.findUnique({
    where: { email: normalizarEmail(req.body.email) },
    select: { ...selecaoUsuario, senhaHash: true },
  });

  const senhaCorreta = await bcrypt.compare(String(req.body.senha), usuario?.senhaHash || HASH_FALSO);
  if (!usuario || !senhaCorreta) {
    throw new HttpError(401, 'E-mail ou senha incorretos');
  }

  // eslint-disable-next-line no-unused-vars
  const { senhaHash, ...dados } = usuario;
  res.json(respostaSessao(dados));
});

// GET /api/auth/me  (dados do usuário logado)
router.get('/me', autenticar, async (req, res) => {
  const usuario = await prisma.usuario.findUniqueOrThrow({
    where: { id: req.usuario.id },
    select: selecaoUsuario,
  });
  res.json(usuario);
});

module.exports = router;
