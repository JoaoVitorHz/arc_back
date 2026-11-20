const prisma = require('../lib/prisma');
const { verificarToken } = require('../lib/jwt');
const { HttpError } = require('../utils/http');

// Exige "Authorization: Bearer <token>" e preenche req.usuario e req.escritorioId.
// Todas as rotas de dados usam req.escritorioId para filtrar o que cada escritório vê.
async function autenticar(req, res, next) {
  const [tipo, token] = (req.headers.authorization || '').split(' ');
  if (tipo !== 'Bearer' || !token) {
    throw new HttpError(401, 'Faça login para continuar');
  }

  let dados;
  try {
    dados = verificarToken(token);
  } catch {
    throw new HttpError(401, 'Sessão expirada. Faça login novamente.');
  }

  // Confere no banco: um usuário removido perde o acesso mesmo com token válido
  const usuario = await prisma.usuario.findUnique({
    where: { id: dados.usuarioId },
    select: {
      id: true,
      escritorioId: true,
      papel: true,
      verFinanceiro: true,
      tokensValidosApos: true,
      bloqueadoEm: true,
      ultimoAcessoEm: true,
      donoPlataforma: true,
    },
  });
  // Token emitido antes da última troca de senha: sessão encerrada
  const revogado = usuario?.tokensValidosApos && dados.emitidoEm * 1000 < usuario.tokensValidosApos.getTime();
  if (!usuario || revogado) {
    throw new HttpError(401, 'Sessão expirada. Faça login novamente.');
  }
  // Bloqueado pelo dono da plataforma: sai na hora, mesmo com token válido
  if (usuario.bloqueadoEm) {
    throw new HttpError(401, 'Esta conta está bloqueada. Fale com o suporte do ArcDesk.');
  }

  // Último acesso (para o painel admin): no máximo uma gravação a cada 15 minutos por pessoa
  if (!usuario.ultimoAcessoEm || Date.now() - usuario.ultimoAcessoEm.getTime() > 15 * 60 * 1000) {
    prisma.usuario
      .update({ where: { id: usuario.id }, data: { ultimoAcessoEm: new Date() } })
      .catch((erro) => console.error('Falha ao gravar o último acesso:', erro.message));
  }

  // escritorioId pode ser null (pessoa sem escritório): as rotas de dados usam exigirEscritorio
  req.usuario = {
    id: usuario.id,
    escritorioId: usuario.escritorioId,
    papel: usuario.papel,
    verFinanceiro: usuario.verFinanceiro,
    donoPlataforma: usuario.donoPlataforma,
  };
  req.escritorioId = usuario.escritorioId;
  next();
}

module.exports = autenticar;
