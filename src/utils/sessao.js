// Funções de autenticação usadas por várias rotas (auth, convites, equipe)
const crypto = require('crypto');
const { rateLimit } = require('express-rate-limit');
const { gerarToken } = require('../lib/jwt');
const { HttpError } = require('./http');

const SALT_ROUNDS = 10;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Limita tentativas de login/cadastro/recuperação/convite por IP (protege contra força bruta).
// Só contam as tentativas que FALHAM: num escritório, a equipe inteira costuma sair pelo
// mesmo IP, e os logins certos de todo mundo não podem esgotar o limite.
const limiteTentativas = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { erro: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' },
});

// Campos do usuário devolvidos ao frontend
const selecaoUsuario = {
  id: true,
  nome: true,
  email: true,
  papel: true,
  verFinanceiro: true,
  deveTrocarSenha: true,
  donoPlataforma: true,
  escritorioId: true,
  escritorio: { select: { id: true, nome: true } },
};

function normalizarEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

function validarEmail(email) {
  if (!EMAIL_REGEX.test(email)) throw new HttpError(400, 'E-mail inválido');
}

function validarSenha(senha) {
  const tamanho = Buffer.byteLength(String(senha ?? ''));
  // bcrypt ignora o que passa de 72 bytes
  if (tamanho < 8 || tamanho > 72) {
    throw new HttpError(400, 'A senha deve ter entre 8 e 72 caracteres');
  }
}

function respostaSessao(usuario) {
  return { token: gerarToken(usuario), usuario };
}

// Tokens de link (redefinir senha, convite): o link leva o token; o banco guarda só o hash
const gerarTokenDeLink = () => crypto.randomBytes(32).toString('hex');
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

// Endereço do frontend, usado nos links enviados por e-mail
const urlDoApp = () => (process.env.APP_URL || process.env.CORS_ORIGIN || 'http://localhost:3000').replace(/\/$/, '');

module.exports = {
  SALT_ROUNDS,
  limiteTentativas,
  selecaoUsuario,
  normalizarEmail,
  validarEmail,
  validarSenha,
  respostaSessao,
  gerarTokenDeLink,
  hashToken,
  urlDoApp,
};
