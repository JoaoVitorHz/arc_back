const crypto = require('crypto');
const { Router } = require('express');
const prisma = require('../lib/prisma');
const armazenamento = require('../lib/armazenamento');
const { ETAPAS_PADRAO } = require('../constants/etapas');
const { garantirDoEscritorio } = require('../utils/escopo');
const { podeVerFinanceiro } = require('../middlewares/permissoes');
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

// Sem acesso ao financeiro: o projeto vai sem o valor do contrato e sem os lançamentos
function paraQuemVe(req, projeto) {
  if (podeVerFinanceiro(req.usuario)) return projeto;
  const { valorContrato, lancamentos, ...resto } = projeto;
  return resto;
}

async function dadosProjeto(req) {
  const { body, escritorioId } = req;
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
  // quem não vê o financeiro não mexe no valor (o formulário dele nem mostra o campo)
  if (!podeVerFinanceiro(req.usuario)) delete dados.valorContrato;
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
      ...paraQuemVe(req, projeto),
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
    omit: { briefing: false },
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

  res.json({ ...paraQuemVe(req, projeto), progresso: calcularProgresso(projeto.etapas) });
});

// Etapas enviadas na criação (ex.: vindas de uma proposta): [{ nome, dataPrevista? }]
function etapasEnviadas(etapas) {
  if (etapas === undefined) return null;
  if (!Array.isArray(etapas) || etapas.length === 0 || etapas.length > 30) {
    throw new HttpError(400, 'Envie de 1 a 30 etapas');
  }
  return etapas.map((etapa, index) => {
    const nome = String(etapa?.nome ?? '').trim();
    if (!nome || nome.length > 191) throw new HttpError(400, 'Cada etapa precisa de um nome (até 191 caracteres)');
    return { nome, ordem: index + 1, dataPrevista: toDate(etapa.dataPrevista) };
  });
}

// POST /api/projetos  (cria as etapas padrão junto, ou as enviadas em "etapas")
router.post('/', async (req, res) => {
  requireFields(req.body, ['nome', 'clienteId']);
  const etapas = etapasEnviadas(req.body.etapas) || ETAPAS_PADRAO.map((nome, index) => ({ nome, ordem: index + 1 }));

  const projeto = await prisma.projeto.create({
    data: {
      ...(await dadosProjeto(req)),
      escritorioId: req.escritorioId,
      etapas: { create: etapas },
    },
  });

  res.status(201).json(paraQuemVe(req, projeto));
});

// ---- Projeto completo (vindo do "Novo projeto com IA", depois que a pessoa revisou e aprovou) ----

const texto = (valor, max) => {
  const t = String(valor ?? '').trim();
  return t ? t.slice(0, max) : null;
};
const textos = (lista, maxItens, max) =>
  Array.isArray(lista) ? lista.map((t) => texto(t, max)).filter(Boolean).slice(0, maxItens) : [];
const inteiro = (valor, min, max) => {
  const n = Math.round(Number(valor));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
};
const area = (valor) => {
  const n = Number(valor);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : null;
};

// Documentos a pedir ao cliente: [{ nome, recebido }]
const documentosEnviados = (lista) =>
  Array.isArray(lista)
    ? lista
        .slice(0, 30)
        .map((d) => ({ nome: texto(d?.nome, 200), recebido: Boolean(d?.recebido) }))
        .filter((d) => d.nome)
    : [];

// Programa de necessidades: [{ ambiente, quantidade, areaM2, observacao }]
const programaEnviado = (lista) =>
  Array.isArray(lista)
    ? lista
        .slice(0, 60)
        .map((item) => ({
          ambiente: texto(item?.ambiente, 120),
          quantidade: inteiro(item?.quantidade, 1, 50) || 1,
          areaM2: area(item?.areaM2),
          observacao: texto(item?.observacao, 300),
        }))
        .filter((item) => item.ambiente)
    : [];

// O que fica guardado no projeto: só os campos conhecidos, com limites de tamanho
function briefingEnviado(b) {
  if (!b || typeof b !== 'object') return null;
  const p = b.proposta && typeof b.proposta === 'object' ? b.proposta : null;
  return {
    texto: texto(b.texto, 8000),
    resumo: texto(b.resumo, 1000),
    programa: programaEnviado(b.programa),
    areaConstruidaM2: area(b.areaConstruidaM2),
    documentos: documentosEnviados(b.documentos),
    perguntas: textos(b.perguntas, 10, 300),
    // a proposta como foi aprovada (sem valor: o valor é o do contrato, que só aparece para quem vê o financeiro)
    proposta: p && {
      titulo: texto(p.titulo, 200),
      apresentacao: texto(p.apresentacao, 3000),
      escopo: textos(p.escopo, 40, 500),
      etapas: Array.isArray(p.etapas)
        ? p.etapas.slice(0, 30).map((e) => ({
            nome: texto(e?.nome, 191) || 'Etapa',
            descricao: texto(e?.descricao, 500) || '',
            prazoDias: inteiro(e?.prazoDias, 1, 720) || 1,
          }))
        : [],
      condicoesPagamento: textos(p.condicoesPagamento, 20, 300),
      naoIncluso: textos(p.naoIncluso, 30, 300),
      premissas: textos(p.premissas, 30, 300),
    },
    criadoEm: new Date().toISOString(),
  };
}

// Parcelas a receber: [{ descricao, valor, vencimento }]
function parcelasEnviadas(lista) {
  if (lista === undefined || lista === null) return [];
  if (!Array.isArray(lista) || lista.length > 24) throw new HttpError(400, 'Envie no máximo 24 parcelas');
  return lista.map((p) => {
    const descricao = texto(p?.descricao, 191);
    const valor = toDecimal(p?.valor);
    const vencimento = toDate(p?.vencimento);
    if (!descricao || !vencimento) throw new HttpError(400, 'Cada parcela precisa de descrição e vencimento');
    if (valor === null || valor <= 0) throw new HttpError(400, 'O valor de cada parcela deve ser maior que zero');
    return { descricao, valor, vencimento };
  });
}

// Compromissos: [{ titulo, tipoId?, inicio, fim?, descricao? }]
async function compromissosEnviados(lista, escritorioId) {
  if (lista === undefined || lista === null) return [];
  if (!Array.isArray(lista) || lista.length > 12) throw new HttpError(400, 'Envie no máximo 12 compromissos');
  const compromissos = lista.map((c) => {
    const titulo = texto(c?.titulo, 191);
    const inicio = toDate(c?.inicio);
    const fim = toDate(c?.fim);
    if (!titulo || !inicio) throw new HttpError(400, 'Cada compromisso precisa de título e data');
    if (fim && fim <= inicio) throw new HttpError(400, 'O fim do compromisso precisa ser depois do início');
    return { titulo, inicio, fim, descricao: texto(c?.descricao, 2000), tipoId: c?.tipoId ? parseId(c.tipoId) : null };
  });
  for (const tipoId of new Set(compromissos.map((c) => c.tipoId).filter(Boolean))) {
    await garantirDoEscritorio('tipoEvento', tipoId, escritorioId);
  }
  return compromissos;
}

// Cliente: { id } de um cadastrado ou { nome, email?, telefone? } para cadastrar
async function clienteEnviado(cliente, escritorioId) {
  if (cliente?.id) {
    const id = parseId(cliente.id);
    await garantirDoEscritorio('cliente', id, escritorioId);
    return { id };
  }
  const nome = texto(cliente?.nome, 191);
  if (!nome) throw new HttpError(400, 'Informe o cliente: escolha um cadastrado ou o nome do novo cliente');
  return { novo: { nome, email: texto(cliente.email, 191), telefone: texto(cliente.telefone, 191) } };
}

// POST /api/projetos/completo
// { cliente, projeto: { nome, tipo, enderecoObra?, valorContrato?, dataInicio?, previsaoEntrega?, observacoes? },
//   etapas: [{ nome, dataPrevista? }], briefing?, parcelas?: [{ descricao, valor, vencimento }],
//   compromissos?: [{ titulo, tipoId?, inicio, fim?, descricao? }] }
// Cria cliente (se novo), projeto com etapas e briefing, parcelas a receber e compromissos, tudo ou nada.
router.post('/completo', async (req, res) => {
  const { escritorioId } = req;
  const verFinanceiro = podeVerFinanceiro(req.usuario);
  const p = req.body.projeto || {};
  const nome = texto(p.nome, 191);
  if (!nome) throw new HttpError(400, 'Informe o nome do projeto');
  if (p.tipo && !['RESIDENCIAL', 'INTERIORES', 'COMERCIAL', 'OUTRO'].includes(p.tipo)) {
    throw new HttpError(400, 'Tipo de projeto inválido');
  }

  const cliente = await clienteEnviado(req.body.cliente, escritorioId);
  const etapas = etapasEnviadas(req.body.etapas ?? []);
  const parcelas = parcelasEnviadas(req.body.parcelas);
  if (parcelas.length && !verFinanceiro) {
    throw new HttpError(403, 'Você não tem acesso ao financeiro para lançar parcelas', 'SEM_FINANCEIRO');
  }
  const compromissos = await compromissosEnviados(req.body.compromissos, escritorioId);
  const briefing = briefingEnviado(req.body.briefing);

  const criado = await prisma.$transaction(async (tx) => {
    const clienteId = cliente.id ?? (await tx.cliente.create({ data: { ...cliente.novo, escritorioId } })).id;
    const projeto = await tx.projeto.create({
      data: {
        nome,
        tipo: p.tipo || undefined,
        enderecoObra: texto(p.enderecoObra, 191),
        valorContrato: verFinanceiro ? toDecimal(p.valorContrato) : null,
        dataInicio: toDate(p.dataInicio),
        previsaoEntrega: toDate(p.previsaoEntrega),
        observacoes: texto(p.observacoes, 5000),
        ...(briefing && { briefing }),
        clienteId,
        escritorioId,
        etapas: { create: etapas },
      },
    });
    if (parcelas.length) {
      const serieId = crypto.randomUUID(); // mesma série: dá para editar "esta e as próximas"
      await tx.lancamento.createMany({
        data: parcelas.map((parcela) => ({
          ...parcela,
          tipo: 'RECEITA',
          categoria: 'Projeto',
          serieId,
          projetoId: projeto.id,
          escritorioId,
        })),
      });
    }
    if (compromissos.length) {
      await tx.evento.createMany({
        data: compromissos.map((c) => ({ ...c, clienteId, projetoId: projeto.id, escritorioId })),
      });
    }
    return { ...projeto, clienteNovo: !cliente.id };
  });

  res.status(201).json({
    ...paraQuemVe(req, criado),
    criados: { etapas: etapas.length, parcelas: parcelas.length, compromissos: compromissos.length },
  });
});

// PATCH /api/projetos/:id/documentos-cliente  { documentos: [{ nome, recebido }] }
// Lista de documentos a pedir ao cliente (do briefing): marcar o que chegou, incluir ou tirar itens
router.patch('/:id/documentos-cliente', async (req, res) => {
  const id = parseId(req.params.id);
  const atual = await prisma.projeto.findFirstOrThrow({
    where: { id, escritorioId: req.escritorioId },
    select: { briefing: true },
  });
  const briefing = { ...(atual.briefing || {}), documentos: documentosEnviados(req.body.documentos) };
  await prisma.projeto.update({ where: { id, escritorioId: req.escritorioId }, data: { briefing } });
  res.json(briefing.documentos);
});

// PATCH /api/projetos/:id/briefing  { resumo, programa: [{ ambiente, quantidade, areaM2, observacao }], areaConstruidaM2 }
// Editar o resumo e o programa de necessidades (o resto do briefing fica como está)
router.patch('/:id/briefing', async (req, res) => {
  const id = parseId(req.params.id);
  const atual = await prisma.projeto.findFirstOrThrow({
    where: { id, escritorioId: req.escritorioId },
    select: { briefing: true },
  });
  const editado = {
    resumo: texto(req.body.resumo, 1000),
    programa: programaEnviado(req.body.programa),
    areaConstruidaM2: area(req.body.areaConstruidaM2),
  };
  const briefing = { ...(atual.briefing || {}), ...editado };
  await prisma.projeto.update({ where: { id, escritorioId: req.escritorioId }, data: { briefing } });
  res.json(editado);
});

// PUT /api/projetos/:id
router.put('/:id', async (req, res) => {
  requireFields(req.body, ['nome', 'clienteId']);

  const projeto = await prisma.projeto.update({
    where: { id: parseId(req.params.id), escritorioId: req.escritorioId },
    data: await dadosProjeto(req),
  });

  res.json(paraQuemVe(req, projeto));
});

// PATCH /api/projetos/:id/status  { status: 'ATIVO' | 'PAUSADO' | 'CONCLUIDO' }  (ex.: botão "Concluir projeto")
router.patch('/:id/status', async (req, res) => {
  if (!['ATIVO', 'PAUSADO', 'CONCLUIDO'].includes(req.body.status)) {
    throw new HttpError(400, 'Status inválido');
  }
  const projeto = await prisma.projeto.update({
    where: { id: parseId(req.params.id), escritorioId: req.escritorioId },
    data: { status: req.body.status },
  });
  res.json(paraQuemVe(req, projeto));
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
