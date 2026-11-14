const prisma = require('../lib/prisma');
const { HttpError } = require('./http');

const NOMES = { cliente: 'Cliente', projeto: 'Projeto', tipoEvento: 'Tipo de compromisso' };

// Garante que o cliente/projeto/tipo informado pertence ao escritório do usuário.
// Sem isso, alguém poderia vincular um registro de outro escritório só mandando o id.
async function garantirDoEscritorio(modelo, id, escritorioId) {
  if (id === null || id === undefined) return;
  const total = await prisma[modelo].count({ where: { id, escritorioId } });
  if (!total) throw new HttpError(400, `${NOMES[modelo]} não encontrado`);
}

module.exports = { garantirDoEscritorio };
