const prisma = require('../lib/prisma');

// Revisões são opcionais: enquanto ninguém marca a revisão atual como enviada ao cliente,
// tudo continua na R00 e a etapa funciona como antes.

async function revisaoAtualDaEtapa(etapaId) {
  const etapa = await prisma.etapa.findUniqueOrThrow({ where: { id: etapaId }, select: { revisaoAtual: true } });
  const registro = await prisma.revisaoEtapa.findUnique({
    where: { etapaId_numero: { etapaId, numero: etapa.revisaoAtual } },
  });
  return { numero: etapa.revisaoAtual, registro };
}

// Abre a próxima revisão (R00 -> R01...). A condição no updateMany evita abrir duas
// revisões quando duas pessoas anexam ao mesmo tempo.
async function abrirProximaRevisao(etapaId, numeroAtual) {
  const { count } = await prisma.etapa.updateMany({
    where: { id: etapaId, revisaoAtual: numeroAtual },
    data: { revisaoAtual: numeroAtual + 1 },
  });
  return count ? numeroAtual + 1 : (await revisaoAtualDaEtapa(etapaId)).numero;
}

// Em qual revisão um arquivo novo entra. Se a revisão atual já foi enviada ao cliente,
// o que vem depois é a próxima revisão (as pranchas corrigidas), aberta automaticamente.
async function revisaoParaNovoArquivo(etapaId) {
  const { numero, registro } = await revisaoAtualDaEtapa(etapaId);
  if (!registro?.enviadaEm) return { numero, nova: false };
  const nova = await abrirProximaRevisao(etapaId, numero);
  return { numero: nova, nova: true, aposAprovacao: Boolean(registro.aprovadaEm) };
}

// Arquivo de uma revisão já enviada: faz parte do que o cliente recebeu
async function revisaoFoiEnviada(etapaId, numero) {
  if (!etapaId) return false;
  const registro = await prisma.revisaoEtapa.findUnique({
    where: { etapaId_numero: { etapaId, numero } },
    select: { enviadaEm: true },
  });
  return Boolean(registro?.enviadaEm);
}

module.exports = { revisaoAtualDaEtapa, abrirProximaRevisao, revisaoParaNovoArquivo, revisaoFoiEnviada };
