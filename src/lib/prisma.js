const { PrismaClient } = require('@prisma/client');

// O briefing do projeto (JSON grande) fica fora de todas as consultas; quem precisa pede com
// omit: { briefing: false } (ex.: GET /projetos/:id)
const prisma = new PrismaClient({ omit: { projeto: { briefing: true } } });

module.exports = prisma;
