const { Router } = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const { enviarEmail, escaparHtml, smtpConfigurado } = require('../lib/email');
const { exigirAdmin } = require('../middlewares/permissoes');
const { resumoDoEscritorio } = require('../services/equipe.service');
const { HttpError, parseId, requireFields } = require('../utils/http');
const {
  SALT_ROUNDS,
  selecaoUsuario,
  normalizarEmail,
  validarEmail,
  validarSenha,
  gerarTokenDeLink,
  hashToken,
  urlDoApp,
} = require('../utils/sessao');

const router = Router();

const VALIDADE_CONVITE_DIAS = 7;
const PAPEIS = ['ADMIN', 'MEMBRO'];

const selecaoMembro = {
  id: true,
  nome: true,
  email: true,
  papel: true,
  verFinanceiro: true,
  deveTrocarSenha: true,
  criadoEm: true,
};

function validarPapel(papel) {
  if (!PAPEIS.includes(papel)) throw new HttpError(400, 'Papel inválido');
  return papel;
}

function dadosPessoa(body) {
  const nome = String(body.nome ?? '').trim();
  const email = normalizarEmail(body.email);
  if (!nome) throw new HttpError(400, 'Informe o nome');
  validarEmail(email);
  return { nome, email, papel: validarPapel(body.papel || 'MEMBRO') };
}

const pendente = () => ({ aceitoEm: null, expiraEm: { gt: new Date() } });
const novaValidade = () => new Date(Date.now() + VALIDADE_CONVITE_DIAS * 24 * 60 * 60 * 1000);

function emailConvite({ nomeConvidado, nomeEscritorio, quemConvidou, link }) {
  const texto = [
    `Olá, ${nomeConvidado}!`,
    '',
    `${quemConvidou} convidou você para fazer parte do escritório "${nomeEscritorio}" no ArcGestão.`,
    `Para aceitar, abra o link abaixo (ele vale por ${VALIDADE_CONVITE_DIAS} dias):`,
    '',
    link,
  ].join('\n');

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 480px; color: #18181b">
      <p>Olá, ${escaparHtml(nomeConvidado)}!</p>
      <p>${escaparHtml(quemConvidou)} convidou você para fazer parte do escritório
        <strong>${escaparHtml(nomeEscritorio)}</strong> no ArcGestão.</p>
      <p>
        <a href="${link}" style="display: inline-block; background: #25665e; color: #fff; padding: 10px 18px; border-radius: 8px; text-decoration: none">
          Aceitar convite
        </a>
      </p>
      <p style="color: #71717a; font-size: 13px">O link vale por ${VALIDADE_CONVITE_DIAS} dias.</p>
    </div>`;

  return { texto, html };
}

// Gera o link do convite e envia por e-mail (sem esperar o envio terminar)
async function enviarConvite(req, convite, token) {
  const [escritorio, autor] = await Promise.all([
    prisma.escritorio.findUniqueOrThrow({ where: { id: req.escritorioId }, select: { nome: true } }),
    prisma.usuario.findUniqueOrThrow({ where: { id: req.usuario.id }, select: { nome: true } }),
  ]);
  const link = `${urlDoApp()}/convite?token=${token}`;
  const { texto, html } = emailConvite({
    nomeConvidado: convite.nome,
    nomeEscritorio: escritorio.nome,
    quemConvidou: autor.nome,
    link,
  });
  enviarEmail({ para: convite.email, assunto: `Convite para o escritório ${escritorio.nome} · ArcGestão`, texto, html }).catch(
    (erro) => console.error('Falha ao enviar o convite por e-mail:', erro.message)
  );
  return link;
}

// GET /api/equipe  (todos veem a equipe; convites pendentes só para administradores)
router.get('/', async (req, res) => {
  const souAdmin = req.usuario.papel === 'ADMIN';
  const [membros, convites] = await Promise.all([
    prisma.usuario.findMany({
      where: { escritorioId: req.escritorioId },
      select: selecaoMembro,
      orderBy: [{ papel: 'asc' }, { nome: 'asc' }],
    }),
    souAdmin
      ? prisma.convite.findMany({
          where: { escritorioId: req.escritorioId, ...pendente() },
          select: { id: true, nome: true, email: true, papel: true, expiraEm: true, criadoEm: true },
          orderBy: { criadoEm: 'desc' },
        })
      : [],
  ]);
  res.json({ membros, convites, souAdmin });
});

// POST /api/equipe/sair  (qualquer pessoa da equipe, menos o último administrador)
router.post('/sair', async (req, res) => {
  const resumo = await resumoDoEscritorio(req.escritorioId);
  if (resumo.membros === 1) {
    throw new HttpError(400, 'Você é a única pessoa do escritório. Para deixá-lo, encerre o escritório.');
  }
  if (req.usuario.papel === 'ADMIN' && resumo.admins === 1) {
    throw new HttpError(400, 'Você é o único administrador. Torne outra pessoa administradora antes de sair.');
  }

  const [usuario] = await prisma.$transaction([
    prisma.usuario.update({ where: { id: req.usuario.id }, data: { escritorioId: null }, select: selecaoUsuario }),
    prisma.etapa.updateMany({
      where: { responsavelId: req.usuario.id, projeto: { escritorioId: req.escritorioId } },
      data: { responsavelId: null },
    }),
  ]);
  res.json({ usuario });
});

// ---------- Daqui pra baixo: só administradores ----------
router.use(exigirAdmin);

// POST /api/equipe/convites  { nome, email, papel }  -> devolve o link para copiar
router.post('/convites', async (req, res) => {
  requireFields(req.body, ['nome', 'email']);
  const dados = dadosPessoa(req.body);

  const existente = await prisma.usuario.findUnique({ where: { email: dados.email }, select: { escritorioId: true } });
  if (existente?.escritorioId === req.escritorioId) throw new HttpError(409, 'Esta pessoa já faz parte da equipe');

  const token = gerarTokenDeLink();
  const [, convite] = await prisma.$transaction([
    // um convite pendente por e-mail: o novo substitui o anterior
    prisma.convite.deleteMany({ where: { escritorioId: req.escritorioId, email: dados.email, aceitoEm: null } }),
    prisma.convite.create({
      data: {
        ...dados,
        tokenHash: hashToken(token),
        expiraEm: novaValidade(),
        escritorioId: req.escritorioId,
        convidadoPorId: req.usuario.id,
      },
      select: { id: true, nome: true, email: true, papel: true, expiraEm: true, criadoEm: true },
    }),
  ]);

  const link = await enviarConvite(req, convite, token);
  res.status(201).json({ convite, link, emailEnviado: smtpConfigurado(), contaExiste: Boolean(existente) });
});

// POST /api/equipe/convites/:id/novo-link  (o link antigo deixa de valer; reenvia o e-mail)
router.post('/convites/:id/novo-link', async (req, res) => {
  const id = parseId(req.params.id);
  const token = gerarTokenDeLink();
  const atualizados = await prisma.convite.updateMany({
    where: { id, escritorioId: req.escritorioId, aceitoEm: null },
    data: { tokenHash: hashToken(token), expiraEm: novaValidade() },
  });
  if (!atualizados.count) throw new HttpError(404, 'Convite não encontrado');

  const convite = await prisma.convite.findUniqueOrThrow({
    where: { id },
    select: { id: true, nome: true, email: true, papel: true, expiraEm: true, criadoEm: true },
  });
  const link = await enviarConvite(req, convite, token);
  res.json({ convite, link, emailEnviado: smtpConfigurado() });
});

// DELETE /api/equipe/convites/:id  (cancela o convite)
router.delete('/convites/:id', async (req, res) => {
  const removidos = await prisma.convite.deleteMany({
    where: { id: parseId(req.params.id), escritorioId: req.escritorioId, aceitoEm: null },
  });
  if (!removidos.count) throw new HttpError(404, 'Convite não encontrado');
  res.status(204).end();
});

// POST /api/equipe/membros  { nome, email, papel, senha }
// O administrador cria a conta com uma senha provisória; a pessoa cria a própria senha ao entrar.
router.post('/membros', async (req, res) => {
  requireFields(req.body, ['nome', 'email', 'senha']);
  const dados = dadosPessoa(req.body);
  validarSenha(req.body.senha);

  const existente = await prisma.usuario.findUnique({ where: { email: dados.email }, select: { id: true } });
  if (existente) {
    throw new HttpError(409, 'Este e-mail já tem conta no ArcGestão. Envie um convite para essa pessoa.');
  }

  const [membro] = await prisma.$transaction([
    prisma.usuario.create({
      data: {
        ...dados,
        senhaHash: await bcrypt.hash(String(req.body.senha), SALT_ROUNDS),
        deveTrocarSenha: true,
        escritorioId: req.escritorioId,
      },
      select: selecaoMembro,
    }),
    prisma.convite.deleteMany({ where: { escritorioId: req.escritorioId, email: dados.email, aceitoEm: null } }),
  ]);
  res.status(201).json(membro);
});

async function membroDaEquipe(req) {
  const membro = await prisma.usuario.findFirst({
    where: { id: parseId(req.params.id), escritorioId: req.escritorioId },
    select: selecaoMembro,
  });
  if (!membro) throw new HttpError(404, 'Pessoa não encontrada na equipe');
  return membro;
}

// PATCH /api/equipe/membros/:id  { papel?, verFinanceiro? }  (um dos dois ou ambos)
router.patch('/membros/:id', async (req, res) => {
  const { papel, verFinanceiro } = req.body;
  if (papel === undefined && verFinanceiro === undefined) {
    throw new HttpError(400, 'Envie o papel ou a permissão do financeiro');
  }
  if (papel !== undefined) validarPapel(papel);
  if (verFinanceiro !== undefined && typeof verFinanceiro !== 'boolean') {
    throw new HttpError(400, 'verFinanceiro deve ser true ou false');
  }
  const membro = await membroDaEquipe(req);

  if (membro.papel === 'ADMIN' && papel !== undefined && papel !== 'ADMIN') {
    const { admins } = await resumoDoEscritorio(req.escritorioId);
    if (admins === 1) throw new HttpError(400, 'O escritório precisa ter pelo menos um administrador');
  }

  const atualizado = await prisma.usuario.update({
    where: { id: membro.id },
    data: { papel, verFinanceiro },
    select: selecaoMembro,
  });
  res.json(atualizado);
});

// DELETE /api/equipe/membros/:id  (tira a pessoa da equipe; a conta dela continua existindo)
router.delete('/membros/:id', async (req, res) => {
  const membro = await membroDaEquipe(req);
  if (membro.id === req.usuario.id) {
    throw new HttpError(400, 'Para sair da equipe, use "Sair do escritório" no seu perfil');
  }

  await prisma.$transaction([
    prisma.usuario.update({ where: { id: membro.id }, data: { escritorioId: null } }),
    // as etapas dele ficam sem responsável
    prisma.etapa.updateMany({
      where: { responsavelId: membro.id, projeto: { escritorioId: req.escritorioId } },
      data: { responsavelId: null },
    }),
  ]);
  res.status(204).end();
});

module.exports = router;
