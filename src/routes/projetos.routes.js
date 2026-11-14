const { Router } = require('express');
const prisma = require('../lib/prisma');
const armazenamento = require('../lib/armazenamento');
const { ETAPAS_PADRAO } = require('../constants/etapas');
const { garantirDoEscritorio } = require('../utils/escopo');
const {
  HttpError,
  parseId,
  requireFields,
  emptyToNull,
  toDate,
  toDecimal,
} = require('../utils/http');

const router = Router();

// Etapas não concluídas com data prevista anterior a hoje (datas de etapa são salvas como meia-noite UTC)
function contarAtrasadas(etapas) {
  const agora = new Date();
  const hojeUtc = Date.UTC(agora.getFullYear(), agora.getMonth(), agora.getDate());
  return etapas.filter((e) => e.status !== 'CONCLUIDA' && e.dataPrevista && e.dataPrevista.getTime() < hojeUtc).length;
}

// Percentual de etapas concluídas
function calcularProgresso(etapas) {
  if (!etapas.length) return 0;
  const concluidas = etapas.filter((e) => e.status === 'CONCLUIDA').length;
  return Math.round((concluidas / etapas.length) * 100);
}

async function dadosProjeto(body, escritorioId) {
  const dados = {
    nome: body.nome?.trim(),
    tipo: body.tipo || undefined,
    status: body.status || undefined,
    enderecoObra: emptyToNull(body.enderecoObra),
    valorContrato: toDecimal(body.valorContrato),
    dataInicio: toDate(body.dataInicio),
    previsaoEntrega: toDate(body.previsaoEntrega),
    observacoes: emptyToNull(body.observacoes),
    clienteId: parseId(body.clienteId),
  };
  await garantirDoEscritorio('cliente', dados.clienteId, escritorioId);
  return dados;
}

// GET /api/projetos?status=&clienteId=&busca=
router.get('/', async (req, res) => {
  const { status, clienteId, busca } = req.query;

  const projetos = await prisma.projeto.findMany({
    where: {
      escritorioId: req.escritorioId,
      status: status || undefined,
      clienteId: clienteId ? parseId(clienteId) : undefined,
      nome: busca ? { contains: busca } : undefined,
    },
    include: {
      cliente: { select: { id: true, nome: true } },
      etapas: { select: { status: true, dataPrevista: true } },
    },
    orderBy: { criadoEm: 'desc' },
  });

  res.json(
    projetos.map(({ etapas, ...projeto }) => ({
      ...projeto,
      totalEtapas: etapas.length,
      etapasAtrasadas: contarAtrasadas(etapas),
      progresso: calcularProgresso(etapas),
    }))
  );
});

// GET /api/projetos/:id
router.get('/:id', async (req, res) => {
  const projeto = await prisma.projeto.findFirstOrThrow({
    where: { id: parseId(req.params.id), escritorioId: req.escritorioId },
    include: {
      cliente: true,
      etapas: {
        orderBy: { ordem: 'asc' },
        include: {
          descricaoEditadaPor: { select: { id: true, nome: true } },
          responsavel: { select: { id: true, nome: true } },
          revisoes: {
            orderBy: { numero: 'asc' },
            include: {
              enviadaPor: { select: { nome: true } },
              pedidoPor: { select: { nome: true } },
              aprovadaPor: { select: { nome: true } },
            },
          },
        },
      },
      lancamentos: { orderBy: { vencimento: 'asc' } },
      eventos: {
        orderBy: { inicio: 'asc' },
        include: { tipo: { select: { id: true, nome: true, cor: true } } },
      },
    },
  });

  res.json({ ...projeto, progresso: calcularProgresso(projeto.etapas) });
});

// POST /api/projetos  (cria as etapas padrão junto)
router.post('/', async (req, res) => {
  requireFields(req.body, ['nome', 'clienteId']);

  const projeto = await prisma.projeto.create({
    data: {
      ...(await dadosProjeto(req.body, req.escritorioId)),
      escritorioId: req.escritorioId,
      etapas: {
        create: ETAPAS_PADRAO.map((nome, index) => ({ nome, ordem: index + 1 })),
      },
    },
  });

  res.status(201).json(projeto);
});

// PUT /api/projetos/:id
router.put('/:id', async (req, res) => {
  requireFields(req.body, ['nome', 'clienteId']);

  const projeto = await prisma.projeto.update({
    where: { id: parseId(req.params.id), escritorioId: req.escritorioId },
    data: await dadosProjeto(req.body, req.escritorioId),
  });

  res.json(projeto);
});

// DELETE /api/projetos/:id  (etapas e arquivos são apagados; eventos e lançamentos ficam sem projeto)
router.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const arquivos = await prisma.arquivo.findMany({
    where: { projetoId: id, escritorioId: req.escritorioId },
    select: { chave: true },
  });
  await prisma.projeto.delete({ where: { id, escritorioId: req.escritorioId } });
  await armazenamento.apagar(arquivos.map((a) => a.chave));
  res.status(204).end();
});

// PUT /api/projetos/:id/etapas/ordem  { ids: [3, 1, 2, ...] }  (nova ordem das etapas)
router.put('/:id/etapas/ordem', async (req, res) => {
  const projetoId = parseId(req.params.id);
  await garantirDoEscritorio('projeto', projetoId, req.escritorioId);

  const ids = Array.isArray(req.body.ids) ? req.body.ids.map((id) => parseId(id)) : null;
  const atuais = await prisma.etapa.findMany({ where: { projetoId }, select: { id: true } });
  const mesmas = ids && ids.length === atuais.length && new Set(ids).size === ids.length && atuais.every((e) => ids.includes(e.id));
  if (!mesmas) throw new HttpError(400, 'Envie todas as etapas do projeto, cada uma uma vez, na nova ordem');

  await prisma.$transaction(ids.map((id, i) => prisma.etapa.update({ where: { id }, data: { ordem: i + 1 } })));
  res.status(204).end();
});

// POST /api/projetos/:id/etapas  (adiciona etapa no final)
router.post('/:id/etapas', async (req, res) => {
  requireFields(req.body, ['nome']);
  const projetoId = parseId(req.params.id);
  await garantirDoEscritorio('projeto', projetoId, req.escritorioId);

  const ultima = await prisma.etapa.findFirst({
    where: { projetoId },
    orderBy: { ordem: 'desc' },
  });

  const etapa = await prisma.etapa.create({
    data: {
      nome: req.body.nome.trim(),
      ordem: (ultima?.ordem || 0) + 1,
      dataPrevista: toDate(req.body.dataPrevista),
      projetoId,
    },
  });

  res.status(201).json(etapa);
});

module.exports = router;
