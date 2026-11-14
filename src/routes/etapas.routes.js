const { Router } = require('express');
const prisma = require('../lib/prisma');
const armazenamento = require('../lib/armazenamento');
const { HttpError, parseId, toDate, toOptionalInt } = require('../utils/http');
const { revisaoAtualDaEtapa, abrirProximaRevisao } = require('../services/revisoes.service');

const router = Router();

const STATUS_VALIDOS = ['NAO_INICIADA', 'EM_ANDAMENTO', 'CONCLUIDA'];
const TAMANHO_MAXIMO_DESCRICAO = 5000;
const MEIOS_ENVIO = ['WHATSAPP', 'EMAIL', 'REUNIAO', 'OUTRO'];

// A etapa pertence ao escritório pelo projeto dela
const daEtapa = (req) => ({
  id: parseId(req.params.id),
  projeto: { escritorioId: req.escritorioId },
});

// PATCH /api/etapas/:id  (atualiza só os campos enviados)
router.patch('/:id', async (req, res) => {
  const { nome, status, dataPrevista, descricao, responsavelId, revisoesPrevistas } = req.body;
  const data = {};

  if (nome !== undefined) {
    const texto = String(nome ?? '').trim();
    if (!texto) throw new HttpError(400, 'O nome da etapa não pode ficar vazio');
    if (texto.length > 191) throw new HttpError(400, 'O nome da etapa pode ter no máximo 191 caracteres');
    data.nome = texto;
  }
  // Responsável: precisa ser alguém da equipe do escritório (null = sem responsável)
  if (responsavelId !== undefined) {
    const id = toOptionalInt(responsavelId);
    if (id !== null) {
      const daEquipe = await prisma.usuario.count({ where: { id, escritorioId: req.escritorioId } });
      if (!daEquipe) throw new HttpError(400, 'Responsável precisa ser alguém da equipe');
    }
    data.responsavelId = id;
  }
  // Quantas revisões o contrato prevê para a etapa (opcional; vazio = sem contador)
  if (revisoesPrevistas !== undefined) {
    const valor = revisoesPrevistas === null || revisoesPrevistas === '' ? null : Number(revisoesPrevistas);
    if (valor !== null && (!Number.isInteger(valor) || valor < 0 || valor > 99)) {
      throw new HttpError(400, 'Revisões previstas deve ser um número entre 0 e 99');
    }
    data.revisoesPrevistas = valor;
  }
  if (status !== undefined) {
    if (!STATUS_VALIDOS.includes(status)) throw new HttpError(400, 'Status inválido');
    data.status = status;
  }
  if (dataPrevista !== undefined) {
    data.dataPrevista = toDate(dataPrevista);
  }
  // Anotações: qualquer membro pode escrever; guarda quem editou por último e quando
  if (descricao !== undefined) {
    const texto = String(descricao ?? '').trim();
    if (texto.length > TAMANHO_MAXIMO_DESCRICAO) {
      throw new HttpError(400, `As anotações podem ter no máximo ${TAMANHO_MAXIMO_DESCRICAO} caracteres`);
    }
    data.descricao = texto || null;
    data.descricaoEditadaEm = new Date();
    data.descricaoEditadaPorId = req.usuario.id;
  }

  const etapa = await prisma.etapa.update({ where: daEtapa(req), data });

  res.json(etapa);
});

// DELETE /api/etapas/:id  (os arquivos da etapa são apagados junto, inclusive do armazenamento)
router.delete('/:id', async (req, res) => {
  const where = daEtapa(req);
  const arquivos = await prisma.arquivo.findMany({
    where: { etapaId: where.id, escritorioId: req.escritorioId },
    select: { chave: true },
  });
  await prisma.etapa.delete({ where }); // o banco apaga os registros dos arquivos (cascade)
  await armazenamento.apagar(arquivos.map((a) => a.chave));
  res.status(204).end();
});

// ---------- Revisões com o cliente (tudo opcional) ----------

async function etapaDoEscritorio(req) {
  const etapa = await prisma.etapa.findFirst({ where: daEtapa(req), select: { id: true, revisaoAtual: true } });
  if (!etapa) throw new HttpError(404, 'Etapa não encontrada');
  return etapa;
}

function textoOpcional(valor, campo) {
  const texto = String(valor ?? '').trim();
  if (texto.length > TAMANHO_MAXIMO_DESCRICAO) {
    throw new HttpError(400, `${campo} pode ter no máximo ${TAMANHO_MAXIMO_DESCRICAO} caracteres`);
  }
  return texto || null;
}

// Data informada pela pessoa ("2026-11-14"); sem data = hoje
const dataDoEvento = (valor) => toDate(valor) || new Date();
const rotulo = (numero) => `R${String(numero).padStart(2, '0')}`;

async function revisaoEnviadaAtual(etapa) {
  const { numero, registro } = await revisaoAtualDaEtapa(etapa.id);
  if (!registro?.enviadaEm) {
    throw new HttpError(400, `A revisão ${rotulo(numero)} ainda não foi marcada como enviada ao cliente`);
  }
  return registro;
}

// POST /api/etapas/:id/revisao/enviar  { data?, meio?, observacao? }  (marca a revisão atual como enviada)
router.post('/:id/revisao/enviar', async (req, res) => {
  const etapa = await etapaDoEscritorio(req);
  const { registro } = await revisaoAtualDaEtapa(etapa.id);
  if (registro?.enviadaEm) throw new HttpError(400, 'Esta revisão já está marcada como enviada');
  const meio = req.body.meio || null;
  if (meio && !MEIOS_ENVIO.includes(meio)) throw new HttpError(400, 'Meio de envio inválido');

  const dados = {
    enviadaEm: dataDoEvento(req.body.data),
    meioEnvio: meio,
    observacaoEnvio: textoOpcional(req.body.observacao, 'A observação'),
    enviadaPorId: req.usuario.id,
  };
  const revisao = await prisma.revisaoEtapa.upsert({
    where: { etapaId_numero: { etapaId: etapa.id, numero: etapa.revisaoAtual } },
    create: { etapaId: etapa.id, numero: etapa.revisaoAtual, ...dados },
    update: dados,
  });
  res.json(revisao);
});

// POST /api/etapas/:id/revisao/pedido  { texto, data? }  (o cliente pediu alteração na revisão enviada)
router.post('/:id/revisao/pedido', async (req, res) => {
  const etapa = await etapaDoEscritorio(req);
  const registro = await revisaoEnviadaAtual(etapa);
  if (registro.aprovadaEm) throw new HttpError(400, 'Esta revisão já foi aprovada pelo cliente');
  const texto = textoOpcional(req.body.texto, 'O pedido');
  if (!texto) throw new HttpError(400, 'Descreva o que o cliente pediu');

  const revisao = await prisma.revisaoEtapa.update({
    where: { id: registro.id },
    data: { pedidoAlteracao: texto, pedidoEm: dataDoEvento(req.body.data), pedidoPorId: req.usuario.id },
  });
  res.json(revisao);
});

// POST /api/etapas/:id/revisao/aprovar  { data?, observacao? }
router.post('/:id/revisao/aprovar', async (req, res) => {
  const etapa = await etapaDoEscritorio(req);
  const registro = await revisaoEnviadaAtual(etapa);
  if (registro.aprovadaEm) throw new HttpError(400, 'Esta revisão já está marcada como aprovada');

  const revisao = await prisma.revisaoEtapa.update({
    where: { id: registro.id },
    data: {
      aprovadaEm: dataDoEvento(req.body.data),
      observacaoAprovacao: textoOpcional(req.body.observacao, 'A observação'),
      aprovadaPorId: req.usuario.id,
    },
  });
  res.json(revisao);
});

// POST /api/etapas/:id/revisao/nova  (abre a próxima revisão; opcional: anexar depois do envio já abre sozinho)
router.post('/:id/revisao/nova', async (req, res) => {
  const etapa = await etapaDoEscritorio(req);
  await revisaoEnviadaAtual(etapa);
  const numero = await abrirProximaRevisao(etapa.id, etapa.revisaoAtual);
  res.json({ revisaoAtual: numero });
});

// POST /api/etapas/:id/revisao/desfazer  (desfaz a última marcação da revisão atual, em caso de engano)
router.post('/:id/revisao/desfazer', async (req, res) => {
  const etapa = await etapaDoEscritorio(req);
  const { numero, registro } = await revisaoAtualDaEtapa(etapa.id);

  if (registro?.aprovadaEm) {
    await prisma.revisaoEtapa.update({
      where: { id: registro.id },
      data: { aprovadaEm: null, observacaoAprovacao: null, aprovadaPorId: null },
    });
    return res.json({ desfeito: 'aprovacao' });
  }
  if (registro?.pedidoEm) {
    await prisma.revisaoEtapa.update({
      where: { id: registro.id },
      data: { pedidoAlteracao: null, pedidoEm: null, pedidoPorId: null },
    });
    return res.json({ desfeito: 'pedido' });
  }
  if (registro?.enviadaEm) {
    await prisma.revisaoEtapa.delete({ where: { id: registro.id } });
    return res.json({ desfeito: 'envio' });
  }
  // Revisão aberta por engano (ainda sem envio): volta para a anterior, se não tiver arquivos
  if (numero > 0) {
    const arquivos = await prisma.arquivo.count({ where: { etapaId: etapa.id, revisaoNumero: numero } });
    if (arquivos) throw new HttpError(400, 'Esta revisão já tem arquivos. Apague ou mova os arquivos antes de desfazê-la.');
    await prisma.etapa.update({ where: { id: etapa.id }, data: { revisaoAtual: numero - 1 } });
    return res.json({ desfeito: 'nova_revisao' });
  }
  throw new HttpError(400, 'Não há nada para desfazer');
});

// DELETE /api/etapas/:id/revisao  (apaga a revisão atual e os arquivos dela; a etapa volta para a anterior)
// Só a mais recente pode ser apagada, para o histórico não ficar com buracos. A Nº 00 (entrega original)
// não é apagada. Revisão já enviada ao cliente: só administradores.
router.delete('/:id/revisao', async (req, res) => {
  const etapa = await etapaDoEscritorio(req);
  const { numero, registro } = await revisaoAtualDaEtapa(etapa.id);
  if (numero === 0) {
    throw new HttpError(400, 'A Revisão Nº 00 é a entrega original e não pode ser apagada. Use "Desfazer" para limpar as marcações.');
  }
  if (registro?.enviadaEm && req.usuario.papel !== 'ADMIN') {
    throw new HttpError(403, 'Esta revisão já foi enviada ao cliente: só um administrador pode apagá-la');
  }

  const arquivos = await prisma.arquivo.findMany({
    where: { etapaId: etapa.id, revisaoNumero: numero, escritorioId: req.escritorioId },
    select: { id: true, chave: true },
  });
  await prisma.$transaction([
    prisma.arquivo.deleteMany({ where: { id: { in: arquivos.map((a) => a.id) } } }),
    prisma.revisaoEtapa.deleteMany({ where: { etapaId: etapa.id, numero } }),
    prisma.etapa.update({ where: { id: etapa.id }, data: { revisaoAtual: numero - 1 } }),
  ]);
  await armazenamento.apagar(arquivos.map((a) => a.chave));

  res.json({ revisaoAtual: numero - 1, arquivosApagados: arquivos.length });
});

module.exports = router;
