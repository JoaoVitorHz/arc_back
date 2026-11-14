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
    select: { id: true, escritorioId: true, tokensValidosApos: true },
  });
  // Token emitido antes da última troca de senha: sessão encerrada
  const revogado = usuario?.tokensValidosApos && dados.emitidoEm * 1000 < usuario.tokensValidosApos.getTime();
  if (!usuario || revogado) {
    throw new HttpError(401, 'Sessão expirada. Faça login novamente.');
  }

  req.usuario = { id: usuario.id, escritorioId: usuario.escritorioId };
  req.escritorioId = usuario.escritorioId;
  next();
}

module.exports = autenticar;
