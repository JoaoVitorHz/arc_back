// Conta fixa do painel admin, definida no .env (ADMIN_EMAIL e ADMIN_SENHA). Ao ligar a API:
// - se a conta não existe, é criada como dona da plataforma (sem escritório);
// - se existe, continua dona da plataforma e com a senha do .env (o .env manda: para trocar a
//   senha, troque lá e reinicie a API).
// A senha fica só no .env, que não vai para o git. Use uma senha forte em produção.
const bcrypt = require('bcryptjs');
const prisma = require('./prisma');
const { SALT_ROUNDS, normalizarEmail } = require('../utils/sessao');

async function garantirContaAdmin() {
  const email = normalizarEmail(process.env.ADMIN_EMAIL);
  const senha = String(process.env.ADMIN_SENHA ?? '');
  if (!email || !senha) return;
  if (Buffer.byteLength(senha) < 8) {
    console.warn('[admin] ADMIN_SENHA precisa ter pelo menos 8 caracteres: conta admin não configurada');
    return;
  }

  const conta = await prisma.usuario.findUnique({
    where: { email },
    select: { id: true, senhaHash: true, donoPlataforma: true, bloqueadoEm: true },
  });

  if (!conta) {
    await prisma.usuario.create({
      data: {
        nome: 'Admin ArcDesk',
        email,
        senhaHash: await bcrypt.hash(senha, SALT_ROUNDS),
        donoPlataforma: true,
      },
    });
    console.log(`[admin] conta do painel admin criada: ${email}`);
    return;
  }

  const senhaIgual = await bcrypt.compare(senha, conta.senhaHash);
  if (senhaIgual && conta.donoPlataforma && !conta.bloqueadoEm) return;
  await prisma.usuario.update({
    where: { id: conta.id },
    data: {
      donoPlataforma: true,
      bloqueadoEm: null,
      deveTrocarSenha: false,
      ...(senhaIgual ? {} : { senhaHash: await bcrypt.hash(senha, SALT_ROUNDS) }),
    },
  });
  console.log(`[admin] conta do painel admin atualizada: ${email}`);
}

module.exports = { garantirContaAdmin };
