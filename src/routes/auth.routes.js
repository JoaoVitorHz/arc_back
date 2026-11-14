const crypto = require('crypto');
const { Router } = require('express');
const bcrypt = require('bcryptjs');
const { rateLimit } = require('express-rate-limit');
const prisma = require('../lib/prisma');
const { gerarToken, agoraEmSegundos } = require('../lib/jwt');
const { enviarEmail } = require('../lib/email');
const { TIPOS_EVENTO_PADRAO } = require('../constants/tiposEvento');
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
// Cria o escritório, o primeiro usuário dele e os tipos de compromisso padrão
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
      tiposEvento: { create: TIPOS_EVENTO_PADRAO },
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

// ---------- Recuperação de senha ----------

const VALIDADE_LINK_MINUTOS = 60;
const MENSAGEM_ESQUECI =
  'Se existir uma conta com esse e-mail, enviamos um link para redefinir a senha. Confira também a caixa de spam.';

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const urlDoApp = () => (process.env.APP_URL || process.env.CORS_ORIGIN || 'http://localhost:3000').replace(/\/$/, '');

function emailRedefinicao(nome, link) {
  const texto = [
    `Olá, ${nome}!`,
    '',
    'Recebemos um pedido para redefinir a senha da sua conta no ArcGestão.',
    `Para criar uma nova senha, abra o link abaixo (ele vale por ${VALIDADE_LINK_MINUTOS} minutos e só pode ser usado uma vez):`,
    '',
    link,
    '',
    'Se não foi você, ignore este e-mail: sua senha continua a mesma.',
  ].join('\n');

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 480px; color: #18181b">
      <p>Olá, ${nome}!</p>
      <p>Recebemos um pedido para redefinir a senha da sua conta no <strong>ArcGestão</strong>.</p>
      <p>
        <a href="${link}" style="display: inline-block; background: #25665e; color: #fff; padding: 10px 18px; border-radius: 8px; text-decoration: none">
          Criar nova senha
        </a>
      </p>
      <p style="color: #71717a; font-size: 13px">
        O link vale por ${VALIDADE_LINK_MINUTOS} minutos e só pode ser usado uma vez.
        Se não foi você, ignore este e-mail: sua senha continua a mesma.
      </p>
    </div>`;

  return { texto, html };
}

// POST /api/auth/esqueci-senha  { email }
// Responde sempre a mesma mensagem, exista ou não a conta (não revela quais e-mails estão cadastrados)
router.post('/esqueci-senha', limiteTentativas, async (req, res) => {
  requireFields(req.body, ['email']);
  const usuario = await prisma.usuario.findUnique({
    where: { email: normalizarEmail(req.body.email) },
    select: { id: true, nome: true, email: true },
  });

  if (usuario) {
    const token = crypto.randomBytes(32).toString('hex');
    await prisma.$transaction([
      // só o link mais recente vale
      prisma.tokenRedefinicaoSenha.deleteMany({ where: { usuarioId: usuario.id } }),
      prisma.tokenRedefinicaoSenha.create({
        data: {
          usuarioId: usuario.id,
          tokenHash: hashToken(token),
          expiraEm: new Date(Date.now() + VALIDADE_LINK_MINUTOS * 60 * 1000),
        },
      }),
    ]);

    const link = `${urlDoApp()}/redefinir-senha?token=${token}`;
    const { texto, html } = emailRedefinicao(usuario.nome, link);
    // Sem await: a resposta não demora mais quando a conta existe
    enviarEmail({ para: usuario.email, assunto: 'Redefinir sua senha · ArcGestão', texto, html }).catch((erro) =>
      console.error('Falha ao enviar o e-mail de redefinição de senha:', erro.message)
    );
  }

  res.json({ mensagem: MENSAGEM_ESQUECI });
});

// POST /api/auth/redefinir-senha  { token, senha }  -> já entra logado
router.post('/redefinir-senha', limiteTentativas, async (req, res) => {
  requireFields(req.body, ['token', 'senha']);
  validarSenha(req.body.senha);

  const registro = await prisma.tokenRedefinicaoSenha.findUnique({
    where: { tokenHash: hashToken(req.body.token) },
  });
  // Marca como usado só se ainda estiver válido (evita usar o mesmo link duas vezes ao mesmo tempo)
  const marcado = registro
    ? await prisma.tokenRedefinicaoSenha.updateMany({
        where: { id: registro.id, usadoEm: null, expiraEm: { gt: new Date() } },
        data: { usadoEm: new Date() },
      })
    : { count: 0 };
  if (!marcado.count) {
    throw new HttpError(400, 'Este link é inválido ou expirou. Peça um novo em "Esqueci minha senha".');
  }

  const senhaHash = await bcrypt.hash(String(req.body.senha), SALT_ROUNDS);
  const [usuario] = await prisma.$transaction([
    prisma.usuario.update({
      where: { id: registro.usuarioId },
      // encerra as sessões abertas em outros aparelhos
      data: { senhaHash, tokensValidosApos: agoraEmSegundos() },
      select: selecaoUsuario,
    }),
    prisma.tokenRedefinicaoSenha.deleteMany({ where: { usuarioId: registro.usuarioId } }),
  ]);

  res.json(respostaSessao(usuario));
});

// ---------- Perfil do usuário logado ----------
// Senha atual errada responde 400 (e não 401), porque 401 faz o frontend encerrar a sessão.

async function conferirSenhaAtual(usuarioId, senhaAtual, mensagem) {
  const { senhaHash } = await prisma.usuario.findUniqueOrThrow({
    where: { id: usuarioId },
    select: { senhaHash: true },
  });
  if (!senhaAtual || !(await bcrypt.compare(String(senhaAtual), senhaHash))) {
    throw new HttpError(400, mensagem);
  }
}

// PUT /api/auth/perfil  { nome, email, senhaAtual? }  (senhaAtual só é exigida para trocar o e-mail)
router.put('/perfil', autenticar, async (req, res) => {
  requireFields(req.body, ['nome', 'email']);
  const nome = String(req.body.nome).trim();
  const email = normalizarEmail(req.body.email);
  if (!nome) throw new HttpError(400, 'Informe seu nome');
  if (!EMAIL_REGEX.test(email)) throw new HttpError(400, 'E-mail inválido');

  const atual = await prisma.usuario.findUniqueOrThrow({ where: { id: req.usuario.id }, select: { email: true } });
  if (email !== atual.email) {
    await conferirSenhaAtual(
      req.usuario.id,
      req.body.senhaAtual,
      'Senha atual incorreta. Ela é necessária para trocar o e-mail.'
    );
    const emUso = await prisma.usuario.findUnique({ where: { email }, select: { id: true } });
    if (emUso) throw new HttpError(409, 'Já existe uma conta com este e-mail');
  }

  const usuario = await prisma.usuario.update({
    where: { id: req.usuario.id },
    data: { nome, email },
    select: selecaoUsuario,
  });
  res.json(usuario);
});

// PUT /api/auth/senha  { senhaAtual, novaSenha }  -> devolve um token novo (os antigos deixam de valer)
router.put('/senha', autenticar, async (req, res) => {
  requireFields(req.body, ['senhaAtual', 'novaSenha']);
  await conferirSenhaAtual(req.usuario.id, req.body.senhaAtual, 'Senha atual incorreta');
  validarSenha(req.body.novaSenha);

  const usuario = await prisma.usuario.update({
    where: { id: req.usuario.id },
    data: {
      senhaHash: await bcrypt.hash(String(req.body.novaSenha), SALT_ROUNDS),
      tokensValidosApos: agoraEmSegundos(),
    },
    select: selecaoUsuario,
  });
  res.json(respostaSessao(usuario));
});

module.exports = router;
