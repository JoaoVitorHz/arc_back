const prisma = require('../lib/prisma');
const { gerarJson } = require('../lib/ia');
const { ETAPAS_PADRAO } = require('../constants/etapas');
const { HttpError, parseId } = require('../utils/http');

// Textos gerados pela IA: proposta comercial (com base no histórico do escritório)
// e relatório de andamento para o cliente. As duas respostas vêm em JSON validado por schema.

const TIPOS_PROJETO = { RESIDENCIAL: 'Residencial', INTERIORES: 'Interiores', COMERCIAL: 'Comercial', OUTRO: 'Outro' };
const dia = (data) => (data ? data.toISOString().slice(0, 10) : null);
const diasEntre = (inicio, fim) => (inicio && fim ? Math.round((fim - inicio) / 86400000) : null);

const listaDeTextos = { type: 'array', items: { type: 'string' } };

const SCHEMA_PROPOSTA = {
  type: 'object',
  properties: {
    titulo: { type: 'string', description: 'Ex.: Proposta de projeto arquitetônico - Residência 250 m²' },
    apresentacao: { type: 'string', description: 'Um parágrafo de abertura dirigido ao cliente' },
    escopo: { ...listaDeTextos, description: 'Serviços incluídos, um por item' },
    etapas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          nome: { type: 'string' },
          descricao: { type: 'string', description: 'O que é entregue nesta etapa, numa frase' },
          prazoDias: { type: 'integer', description: 'Duração estimada em dias corridos' },
        },
        required: ['nome', 'descricao', 'prazoDias'],
        additionalProperties: false,
      },
    },
    prazoTotalDias: { type: 'integer' },
    valor: {
      type: 'object',
      properties: {
        sugerido: { type: ['number', 'null'] },
        minimo: { type: ['number', 'null'] },
        maximo: { type: ['number', 'null'] },
        justificativa: { type: 'string', description: 'Como o valor foi estimado (cite os projetos usados como base)' },
      },
      required: ['sugerido', 'minimo', 'maximo', 'justificativa'],
      additionalProperties: false,
    },
    condicoesPagamento: listaDeTextos,
    naoIncluso: { ...listaDeTextos, description: 'Exclusões (ex.: projetos complementares, taxas)' },
    premissas: { ...listaDeTextos, description: 'O que foi suposto por falta de informação' },
  },
  required: ['titulo', 'apresentacao', 'escopo', 'etapas', 'prazoTotalDias', 'valor', 'condicoesPagamento', 'naoIncluso', 'premissas'],
  additionalProperties: false,
};

const INSTRUCOES_PROPOSTA = `Você escreve propostas comerciais para um escritório de arquitetura brasileiro.
A partir da descrição do arquiteto, monte uma proposta profissional, clara e realista, em português do Brasil.

Regras:
- Use só o que foi informado. O que faltar (área, padrão de acabamento, número de pavimentos...) vira item em "premissas", nunca um fato inventado.
- Etapas típicas de arquitetura no Brasil (levantamento, estudo preliminar, anteprojeto, projeto legal, projeto executivo, acompanhamento de obra), adaptadas ao escopo: interiores, por exemplo, não tem projeto legal, mas tem detalhamento de marcenaria. Prefira os nomes de etapa que o escritório já usa.
- Valor: estime com base no histórico de projetos do escritório (valores, tipos e prazos reais). Dê um valor sugerido e uma faixa (mínimo e máximo). Na justificativa, cite quais projetos do histórico serviram de base. Sem histórico comparável, estime pelo mercado brasileiro e diga isso na justificativa. Valores em reais, números sem formatação.
- Condições de pagamento usuais: entrada na assinatura e parcelas vinculadas às entregas das etapas.
- "naoIncluso": exclusões comuns (projetos complementares de estrutura, elétrica e hidráulica, taxas de prefeitura e cartório, RRT, maquete física, cópias impressas), conforme o escopo.
- A apresentação tem um parágrafo, tom cordial e profissional, dirigida ao cliente pelo nome quando houver.
- Tudo, exceto "valor.justificativa", vai para o cliente: nesses campos nunca mencione o histórico, os projetos anteriores ou outros clientes do escritório. O histórico só aparece na justificativa, que é interna.`;

async function gerarProposta({ req, body }) {
  const descricao = String(body.descricao || '').trim();
  if (descricao.length < 15) throw new HttpError(400, 'Descreva o projeto com um pouco mais de detalhe');
  if (descricao.length > 4000) throw new HttpError(400, 'A descrição pode ter no máximo 4.000 caracteres');
  const tipo = body.tipo || 'RESIDENCIAL';
  if (!TIPOS_PROJETO[tipo]) throw new HttpError(400, 'Tipo de projeto inválido');

  const clienteId = body.clienteId ? parseId(body.clienteId) : null;
  const cliente = clienteId
    ? await prisma.cliente.findFirst({ where: { id: clienteId, escritorioId: req.escritorioId }, select: { nome: true } })
    : null;
  if (clienteId && !cliente) throw new HttpError(404, 'Cliente não encontrado');

  const [escritorio, projetos] = await Promise.all([
    prisma.escritorio.findUniqueOrThrow({ where: { id: req.escritorioId }, select: { nome: true } }),
    prisma.projeto.findMany({
      where: { escritorioId: req.escritorioId },
      select: {
        nome: true,
        tipo: true,
        valorContrato: true,
        dataInicio: true,
        previsaoEntrega: true,
        observacoes: true,
        etapas: { select: { nome: true }, orderBy: { ordem: 'asc' } },
      },
      orderBy: { criadoEm: 'desc' },
      take: 40,
    }),
  ]);

  const historico = projetos.map((p) => ({
    nome: p.nome,
    tipo: TIPOS_PROJETO[p.tipo],
    valorContrato: p.valorContrato === null ? null : Number(p.valorContrato),
    duracaoDias: diasEntre(p.dataInicio, p.previsaoEntrega),
    etapas: p.etapas.map((e) => e.nome),
    observacoes: p.observacoes ? p.observacoes.slice(0, 300) : null,
  }));
  const comValor = historico.filter((p) => p.valorContrato);

  const proposta = await gerarJson({
    nome: 'proposta',
    schema: SCHEMA_PROPOSTA,
    instrucoes: INSTRUCOES_PROPOSTA,
    entrada: JSON.stringify({
      escritorio: escritorio.nome,
      cliente: cliente?.nome || null,
      tipoDeProjeto: TIPOS_PROJETO[tipo],
      descricaoDoArquiteto: descricao,
      etapasPadraoDoEscritorio: ETAPAS_PADRAO,
      historicoDeProjetos: historico,
    }),
  });

  return { proposta, baseadoEm: comValor.length };
}

const SCHEMA_RELATORIO = {
  type: 'object',
  properties: {
    assunto: { type: 'string' },
    mensagem: { type: 'string', description: 'Corpo do e-mail em texto simples, com quebras de linha' },
  },
  required: ['assunto', 'mensagem'],
  additionalProperties: false,
};

const INSTRUCOES_RELATORIO = `Você escreve, em nome de um escritório de arquitetura brasileiro, e-mails curtos de atualização do andamento de um projeto para o cliente.

Regras:
- Português do Brasil, tom cordial e profissional, de 120 a 250 palavras, texto simples (sem markdown), com parágrafos curtos.
- Trate o cliente pelo primeiro nome. Assine com o nome de quem envia e o nome do escritório.
- Conte o que já foi concluído, o que está em andamento e os próximos passos, usando só os dados recebidos. Não invente datas, entregas nem reuniões.
- Se houver revisão enviada ao cliente aguardando retorno, peça o retorno com gentileza. Se houver pedido de alteração do cliente, diga que está sendo atendido.
- Cite próximos compromissos marcados com data e hora, se houver.
- Nunca fale de valores, pagamentos ou contrato.
- "observacoesDeQuemEnvia" são recados de quem assina para entrarem no texto com as palavras dele: não mencione que vieram de observações nem de anotações.
- Datas de envio de revisão: diga "enviada em dd/mm" (ou "hoje" se for a data de hoje).`;

async function gerarRelatorio({ req, projetoId, observacoes }) {
  const extra = String(observacoes || '').trim().slice(0, 1500);
  const projeto = await prisma.projeto.findFirst({
    where: { id: projetoId, escritorioId: req.escritorioId },
    include: {
      cliente: { select: { nome: true } },
      etapas: {
        orderBy: { ordem: 'asc' },
        include: { revisoes: { orderBy: { numero: 'desc' }, take: 1 } },
      },
      eventos: {
        where: { inicio: { gte: new Date() } },
        orderBy: { inicio: 'asc' },
        take: 3,
        select: { titulo: true, inicio: true, local: true },
      },
      arquivos: {
        where: { criadoEm: { gte: new Date(Date.now() - 30 * 86400000) } },
        orderBy: { criadoEm: 'desc' },
        take: 10,
        select: { nome: true, criadoEm: true, etapa: { select: { nome: true } } },
      },
    },
  });
  if (!projeto) throw new HttpError(404, 'Projeto não encontrado');

  const remetente = await prisma.usuario.findUniqueOrThrow({
    where: { id: req.usuario.id },
    select: { nome: true, escritorio: { select: { nome: true } } },
  });
  const fuso = req.body?.fuso || 'America/Sao_Paulo';
  const quando = (data) => {
    try {
      return new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, dateStyle: 'full', timeStyle: 'short' }).format(data);
    } catch {
      return data.toISOString();
    }
  };

  const STATUS = { NAO_INICIADA: 'não iniciada', EM_ANDAMENTO: 'em andamento', CONCLUIDA: 'concluída' };
  const dados = {
    hoje: new Date().toISOString().slice(0, 10),
    remetente: remetente.nome,
    escritorio: remetente.escritorio?.nome,
    cliente: projeto.cliente.nome,
    projeto: projeto.nome,
    tipo: TIPOS_PROJETO[projeto.tipo],
    previsaoEntrega: dia(projeto.previsaoEntrega),
    etapas: projeto.etapas.map((e) => {
      const r = e.revisoes[0];
      return {
        nome: e.nome,
        status: STATUS[e.status],
        dataPrevista: dia(e.dataPrevista),
        revisao: r
          ? {
              numero: `R${String(r.numero).padStart(2, '0')}`,
              enviadaAoClienteEm: dia(r.enviadaEm),
              clientePediuAlteracao: r.pedidoAlteracao || null,
              aprovadaEm: dia(r.aprovadaEm),
            }
          : null,
      };
    }),
    proximosCompromissos: projeto.eventos.map((e) => ({ titulo: e.titulo, quando: quando(e.inicio), local: e.local })),
    arquivosRecentes: projeto.arquivos.map((a) => ({ nome: a.nome, etapa: a.etapa?.nome || null, em: dia(a.criadoEm) })),
    observacoesDeQuemEnvia: extra || null,
  };

  return gerarJson({
    nome: 'relatorio_cliente',
    schema: SCHEMA_RELATORIO,
    instrucoes: INSTRUCOES_RELATORIO,
    entrada: JSON.stringify(dados),
  });
}

module.exports = { gerarProposta, gerarRelatorio };
