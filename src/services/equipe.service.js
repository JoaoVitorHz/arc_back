const prisma = require('../lib/prisma');
const { HttpError } = require('../utils/http');
const { TIPOS_EVENTO_PADRAO } = require('../constants/tiposEvento');

// Quantas pessoas e administradores o escritório tem, e se já tem dados de trabalho
async function resumoDoEscritorio(escritorioId) {
  const where = { escritorioId };
  const [escritorio, membros, admins, clientes, projetos, eventos, lancamentos] = await Promise.all([
    prisma.escritorio.findUniqueOrThrow({ where: { id: escritorioId }, select: { id: true, nome: true } }),
    prisma.usuario.count({ where }),
    prisma.usuario.count({ where: { ...where, papel: 'ADMIN' } }),
    prisma.cliente.count({ where }),
    prisma.projeto.count({ where }),
    prisma.evento.count({ where }),
    prisma.lancamento.count({ where }),
  ]);
  return {
    ...escritorio,
    membros,
    admins,
    temDados: clientes + projetos + eventos + lancamentos > 0,
  };
}

// Coloca a pessoa num escritório (ao aceitar convite). Regras para o escritório atual dela:
// - sem escritório: entra direto;
// - escritório vazio (só ela e nenhum dado): ele é apagado e ela entra no novo;
// - com equipe ou com dados: bloqueia e explica o que fazer antes.
async function entrarNoEscritorio(usuarioId, destinoId, papel) {
  const usuario = await prisma.usuario.findUniqueOrThrow({
    where: { id: usuarioId },
    select: { escritorioId: true },
  });

  if (usuario.escritorioId === destinoId) return; // já faz parte

  if (!usuario.escritorioId) {
    await prisma.usuario.update({ where: { id: usuarioId }, data: { escritorioId: destinoId, papel } });
    return;
  }

  const atual = await resumoDoEscritorio(usuario.escritorioId);
  if (atual.membros > 1) {
    throw new HttpError(
      409,
      `Você faz parte da equipe do escritório "${atual.nome}". Para aceitar, saia dele antes em Perfil → Sair do escritório.`,
      'ESCRITORIO_COM_EQUIPE'
    );
  }
  if (atual.temDados) {
    throw new HttpError(
      409,
      `Seu escritório "${atual.nome}" tem clientes, projetos ou lançamentos. Para aceitar, encerre-o antes em Perfil → Encerrar escritório.`,
      'ESCRITORIO_COM_DADOS'
    );
  }

  // Escritório vazio: não há nada a preservar
  await prisma.$transaction([
    prisma.usuario.update({ where: { id: usuarioId }, data: { escritorioId: destinoId, papel } }),
    prisma.escritorio.delete({ where: { id: atual.id } }), // leva junto tipos de compromisso e convites
  ]);
}

// Novo escritório (cadastro ou "Criar meu escritório"), com os tipos de compromisso padrão
function dadosNovoEscritorio(nome) {
  return { nome, tiposEvento: { create: TIPOS_EVENTO_PADRAO } };
}

module.exports = { resumoDoEscritorio, entrarNoEscritorio, dadosNovoEscritorio };
