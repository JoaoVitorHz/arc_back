const { Prisma } = require('@prisma/client');
const { HttpError } = require('../utils/http');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ erro: err.message });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2025') {
      return res.status(404).json({ erro: 'Registro não encontrado' });
    }
    if (err.code === 'P2002') {
      return res.status(409).json({ erro: 'Já existe um registro com esses dados' });
    }
    if (err.code === 'P2003') {
      return res.status(400).json({ erro: 'Registro relacionado não existe ou está em uso' });
    }
  }

  if (err instanceof Prisma.PrismaClientValidationError) {
    return res.status(400).json({ erro: 'Dados inválidos' });
  }

  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ erro: 'JSON inválido' });
  }

  console.error(err);
  return res.status(500).json({ erro: 'Erro interno do servidor' });
}

module.exports = errorHandler;
