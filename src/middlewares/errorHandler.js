const { Prisma } = require('@prisma/client');
const { HttpError } = require('../utils/http');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ erro: err.message, codigo: err.codigo });
  }

  if (err.name === 'MulterError') {
    const mensagens = {
      LIMIT_FILE_SIZE: 'O arquivo passa do limite de 50 MB. Para arquivos maiores, adicione um link (Drive, Dropbox...).',
      LIMIT_FILE_COUNT: 'Envie no máximo 10 arquivos por vez.',
      LIMIT_UNEXPECTED_FILE: 'Campo de arquivo inesperado.',
    };
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ erro: mensagens[err.code] || 'Não foi possível receber o arquivo.' });
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
