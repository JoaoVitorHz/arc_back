const prisma = require('../lib/prisma');
const { conversarEmFluxo } = require('../lib/ia');
const { calcularResumoMes } = require('./financeiro.service');
const { analisarBriefing } = require('./briefingIa.service');
const { podeVerFinanceiro } = require('../middlewares/permissoes');
const { HttpError, monthRange } = require('../utils/http');

// Assistente do escritório: conversa em português e consulta o sistema com ferramentas (function calling).
// Ferramentas de leitura respondem na hora. Ferramentas de ação NÃO executam nada: montam um cartão
// ("ação proposta") que o front mostra para a pessoa confirmar; ao confirmar, o próprio front chama a
// rota normal da API (com as permissões e validações de sempre).

const FUSO_PADRAO = 'America/Sao_Paulo';
const MAX_RODADAS = 6; // chamadas ao modelo por pergunta (cada rodada pode usar várias ferramentas)
const STATUS_ETAPA = { NAO_INICIADA: 'não iniciada', EM_ANDAMENTO: 'em andamento', CONCLUIDA: 'concluída' };
const TIPOS_PROJETO = ['RESIDENCIAL', 'INTERIORES', 'COMERCIAL', 'OUTRO'];
const DIAS_SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const RE_DATA_HORA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const RE_MES = /^\d{4}-\d{2}$/;

// ---------- datas e formatos ----------

function fusoValido(fuso) {
  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone: fuso });
    return fuso;
  } catch {
    return FUSO_PADRAO;
  }
}

// Partes da data/hora atual no fuso da pessoa
function agoraNoFuso(fuso) {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: fuso,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value])
  );
  return { data: `${partes.year}-${partes.month}-${partes.day}`, hora: `${partes.hour}:${partes.minute}` };
}

// Meia-noite de um dia (AAAA-MM-DD) no fuso da pessoa, em UTC
function inicioDoDiaUtc(dataIso, fuso) {
  const [a, m, d] = dataIso.split('-').map(Number);
  const palpite = Date.UTC(a, m - 1, d);
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: fuso,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(palpite))
      .map((p) => [p.type, Number(p.value)])
  );
  const comoUtc = Date.UTC(partes.year, partes.month - 1, partes.day, partes.hour, partes.minute);
  return new Date(palpite - (comoUtc - palpite));
}

const somarDias = (dataIso, dias) => {
  const [a, m, d] = dataIso.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d + dias)).toISOString().slice(0, 10);
};

// Campos @db.Date (meia-noite UTC) -> "AAAA-MM-DD"
const dia = (data) => (data ? data.toISOString().slice(0, 10) : null);

const dataHora = (data, fuso) =>
  data
    ? new Intl.DateTimeFormat('pt-BR', {
        timeZone: fuso,
        weekday: 'short',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(data)
    : null;

const moeda = (valor) =>
  Number(valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// "2026-11-19" -> "qui, 19/11/2026"; "2026-11-19T14:00" -> "qui, 19/11/2026 às 14:00"
function rotuloDataLocal(texto) {
  const [data, hora] = texto.split('T');
  const [a, m, d] = data.split('-').map(Number);
  const semana = DIAS_SEMANA[new Date(Date.UTC(a, m - 1, d)).getUTCDay()];
  return `${semana}, ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${a}${hora ? ` às ${hora}` : ''}`;
}

function progressoEtapas(etapas) {
  const ordenadas = [...etapas].sort((a, b) => a.ordem - b.ordem);
  const concluidas = ordenadas.filter((e) => e.status === 'CONCLUIDA').length;
  return {
    progresso: ordenadas.length ? Math.round((concluidas / ordenadas.length) * 100) : 0,
    etapaAtual: ordenadas.find((e) => e.status !== 'CONCLUIDA')?.nome || 'Concluído',
  };
}

// ---------- definições das ferramentas (JSON Schema estrito) ----------

const texto = (description) => ({ type: ['string', 'null'], description });
const inteiro = (description) => ({ type: ['integer', 'null'], description });
const opcoes = (valores, description) => ({
  type: ['string', 'null'],
  enum: [...valores, null],
  ...(description && { description }),
});

function ferramenta(name, description, properties = {}) {
  return {
    type: 'function',
    function: {
      name,
      description,
      strict: true,
      parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
    },
  };
}

function definicoes(verFinanceiro) {
  const lista = [
    ferramenta('buscar_projetos', 'Lista projetos do escritório com progresso, etapa atual, entrega e etapas atrasadas.', {
      busca: texto('Parte do nome do projeto ou do cliente; null para todos'),
      status: opcoes(['ATIVO', 'PAUSADO', 'CONCLUIDO'], 'Filtra por status; null para todos'),
    }),
    ferramenta('detalhes_projeto', 'Detalhes de um projeto: etapas (status, data prevista, responsável, revisão atual), próximos compromissos e dados do cliente.', {
      projeto_id: { type: 'integer' },
    }),
    ferramenta('buscar_clientes', 'Lista clientes do escritório (nome, e-mail, telefone, número de projetos).', {
      busca: texto('Parte do nome, e-mail ou telefone; null para todos'),
    }),
    ferramenta('detalhes_cliente', 'Detalhes de um cliente: contato, projetos com progresso e próximos compromissos.', {
      cliente_id: { type: 'integer' },
    }),
    ferramenta('etapas_pendentes', 'Etapas não concluídas de projetos ativos.', {
      somente_minhas: { type: 'boolean', description: 'true = só as etapas de quem está conversando' },
      filtro: { type: 'string', enum: ['atrasadas', 'proximos_dias', 'todas'] },
      dias: inteiro('Com filtro proximos_dias: quantos dias à frente (padrão 7)'),
    }),
    ferramenta('agenda', 'Compromissos da agenda entre duas datas (inclusive).', {
      inicio: { type: 'string', description: 'AAAA-MM-DD' },
      fim: { type: 'string', description: 'AAAA-MM-DD' },
    }),
    ferramenta('equipe', 'Pessoas da equipe do escritório (para escolher responsáveis).'),
    ferramenta('criar_compromisso', 'PROPÕE um compromisso na agenda (a pessoa confirma antes de criar).', {
      titulo: { type: 'string' },
      inicio: { type: 'string', description: 'Data e hora local, AAAA-MM-DDTHH:mm' },
      fim: texto('Data e hora local do fim, AAAA-MM-DDTHH:mm'),
      tipo: texto('Nome do tipo de compromisso (ex.: Reunião, Visita de obra), se fizer sentido'),
      local: texto('Endereço ou "online"'),
      cliente_id: inteiro('Cliente relacionado'),
      projeto_id: inteiro('Projeto relacionado'),
      descricao: texto('Observações'),
    }),
    ferramenta('criar_cliente', 'PROPÕE cadastrar um cliente (a pessoa confirma antes).', {
      nome: { type: 'string' },
      email: texto('E-mail'),
      telefone: texto('Telefone'),
      observacoes: texto('Observações'),
    }),
    ferramenta('criar_projeto', 'PROPÕE criar um projeto com as etapas padrão (a pessoa confirma antes). O cliente precisa existir.', {
      nome: { type: 'string' },
      cliente_id: { type: 'integer' },
      tipo: { type: 'string', enum: TIPOS_PROJETO },
      previsao_entrega: texto('AAAA-MM-DD'),
      endereco_obra: texto('Endereço da obra'),
      ...(verFinanceiro && { valor_contrato: { type: ['number', 'null'], description: 'Valor do contrato em reais' } }),
    }),
    ferramenta(
      'montar_projeto_com_ia',
      'Monta um projeto novo completo a partir do briefing (o que o cliente quer): programa de necessidades, proposta com etapas e prazos, ' +
        'parcelas, compromissos e documentos a pedir. Nada é criado: a pessoa abre a revisão por um cartão, ajusta e aprova lá. ' +
        'Use quando pedirem um projeto "com IA" ou descreverem um projeto novo com detalhes (ambientes, área, estilo, prazo, orçamento...).',
      {
        briefing: {
          type: 'string',
          description:
            'Tudo o que a pessoa contou sobre o projeto nesta conversa, com as palavras dela, juntando as mensagens: cliente, local, ' +
            'o que o cliente quer, ambientes, áreas, estilo, prazo, orçamento. Não resuma nem invente.',
        },
        cliente_id: inteiro('Cliente já cadastrado, se você já tiver o ID; senão null (o sistema reconhece o nome no briefing)'),
        tipo: opcoes(TIPOS_PROJETO, 'Só se a pessoa disser o tipo; senão null'),
      }
    ),
    ferramenta('atualizar_etapa', 'PROPÕE alterar uma etapa (a pessoa confirma antes). Campos null ficam como estão.', {
      etapa_id: { type: 'integer' },
      status: opcoes(['NAO_INICIADA', 'EM_ANDAMENTO', 'CONCLUIDA'], 'Novo status'),
      data_prevista: texto('Nova data prevista, AAAA-MM-DD'),
      responsavel_id: inteiro('ID de quem da equipe passa a ser responsável'),
    }),
  ];

  if (verFinanceiro) {
    lista.push(
      ferramenta('resumo_financeiro', 'Totais do mês: receitas, recebido, a receber, despesas, pago, a pagar, saldos e contas vencidas.', {
        mes: texto('AAAA-MM; null para o mês atual'),
      }),
      ferramenta('listar_lancamentos', 'Lançamentos (receitas e despesas), até 40, ordenados pelo vencimento.', {
        mes: texto('AAAA-MM; null para todos os meses'),
        tipo: opcoes(['RECEITA', 'DESPESA']),
        situacao: opcoes(['pago', 'pendente', 'vencido'], 'vencido = pendente com vencimento passado'),
        busca: texto('Parte da descrição, da categoria, do nome do projeto ou do nome do cliente'),
      }),
      ferramenta('criar_lancamento', 'PROPÕE um lançamento no financeiro (a pessoa confirma antes).', {
        tipo: { type: 'string', enum: ['RECEITA', 'DESPESA'] },
        descricao: { type: 'string' },
        valor: { type: 'number', description: 'Em reais, maior que zero' },
        vencimento: { type: 'string', description: 'AAAA-MM-DD' },
        categoria: texto('Categoria'),
        projeto_id: inteiro('Projeto relacionado'),
        pago: { type: 'boolean' },
      }),
      ferramenta('marcar_pagamento', 'PROPÕE marcar um lançamento como pago ou pendente (a pessoa confirma antes).', {
        lancamento_id: { type: 'integer' },
        pago: { type: 'boolean' },
      })
    );
  }
  return lista;
}

// ---------- execução das ferramentas ----------

// Erro que volta para o modelo (ele explica ou tenta de outro jeito), sem derrubar a conversa
class ErroFerramenta extends Error {}

async function projetoDoEscritorio(id, ctx) {
  const projeto = await prisma.projeto.findFirst({
    where: { id, escritorioId: ctx.escritorioId },
    select: { id: true, nome: true },
  });
  if (!projeto) throw new ErroFerramenta(`Projeto ${id} não encontrado`);
  return projeto;
}

async function clienteDoEscritorio(id, ctx) {
  const cliente = await prisma.cliente.findFirst({
    where: { id, escritorioId: ctx.escritorioId },
    select: { id: true, nome: true },
  });
  if (!cliente) throw new ErroFerramenta(`Cliente ${id} não encontrado`);
  return cliente;
}

function exigirFormato(valor, regex, campo, formato) {
  if (valor && !regex.test(valor)) throw new ErroFerramenta(`${campo} deve estar no formato ${formato}`);
}

// Registra a ação proposta (o front mostra o cartão) e responde ao modelo
function proporAcao(ctx, { titulo, linhas, requisicao }) {
  ctx.acoes.push({
    id: `acao-${ctx.acoes.length + 1}-${Date.now()}`,
    titulo,
    linhas: linhas.filter(([, valor]) => valor !== null && valor !== undefined && valor !== ''),
    requisicao,
  });
  return {
    situacao: 'proposta_aguardando_confirmacao',
    aviso: 'Nada foi feito ainda. A pessoa vê um cartão e precisa clicar em Confirmar.',
  };
}

const executores = {
  async buscar_projetos({ busca, status }, ctx) {
    const projetos = await prisma.projeto.findMany({
      where: {
        escritorioId: ctx.escritorioId,
        status: status || undefined,
        OR: busca ? [{ nome: { contains: busca } }, { cliente: { nome: { contains: busca } } }] : undefined,
      },
      include: {
        cliente: { select: { id: true, nome: true } },
        etapas: { select: { status: true, nome: true, ordem: true, dataPrevista: true } },
      },
      orderBy: { criadoEm: 'desc' },
      take: 30,
    });
    const hoje = new Date(`${ctx.hoje}T00:00:00Z`);
    return projetos.map((p) => ({
      id: p.id,
      nome: p.nome,
      cliente: p.cliente,
      status: p.status,
      tipo: p.tipo,
      ...progressoEtapas(p.etapas),
      etapasAtrasadas: p.etapas.filter((e) => e.status !== 'CONCLUIDA' && e.dataPrevista && e.dataPrevista < hoje).length,
      previsaoEntrega: dia(p.previsaoEntrega),
      ...(ctx.verFinanceiro && { valorContrato: p.valorContrato === null ? null : Number(p.valorContrato) }),
    }));
  },

  async detalhes_projeto({ projeto_id }, ctx) {
    const p = await prisma.projeto.findFirst({
      where: { id: projeto_id, escritorioId: ctx.escritorioId },
      include: {
        cliente: { select: { id: true, nome: true, email: true, telefone: true } },
        etapas: {
          orderBy: { ordem: 'asc' },
          include: {
            responsavel: { select: { id: true, nome: true } },
            revisoes: { orderBy: { numero: 'desc' }, take: 1 },
          },
        },
        eventos: {
          where: { inicio: { gte: new Date() } },
          orderBy: { inicio: 'asc' },
          take: 5,
          select: { id: true, titulo: true, inicio: true, local: true },
        },
        _count: { select: { arquivos: true } },
      },
    });
    if (!p) throw new ErroFerramenta(`Projeto ${projeto_id} não encontrado`);

    const detalhes = {
      id: p.id,
      nome: p.nome,
      tipo: p.tipo,
      status: p.status,
      cliente: p.cliente,
      enderecoObra: p.enderecoObra,
      dataInicio: dia(p.dataInicio),
      previsaoEntrega: dia(p.previsaoEntrega),
      observacoes: p.observacoes,
      arquivos: p._count.arquivos,
      ...progressoEtapas(p.etapas),
      etapas: p.etapas.map((e) => {
        const r = e.revisoes[0];
        return {
          id: e.id,
          nome: e.nome,
          status: STATUS_ETAPA[e.status],
          dataPrevista: dia(e.dataPrevista),
          responsavel: e.responsavel?.nome || null,
          revisaoAtual: r
            ? {
                numero: `R${String(r.numero).padStart(2, '0')}`,
                enviadaEm: dia(r.enviadaEm),
                pedidoAlteracao: r.pedidoAlteracao,
                aprovadaEm: dia(r.aprovadaEm),
              }
            : null,
        };
      }),
      proximosCompromissos: p.eventos.map((e) => ({ titulo: e.titulo, quando: dataHora(e.inicio, ctx.fuso), local: e.local })),
    };

    if (ctx.verFinanceiro) {
      const receitas = await prisma.lancamento.groupBy({
        by: ['pago'],
        where: { escritorioId: ctx.escritorioId, projetoId: p.id, tipo: 'RECEITA' },
        _sum: { valor: true },
      });
      const soma = (pago) => Number(receitas.find((r) => r.pago === pago)?._sum.valor || 0);
      detalhes.financeiro = {
        valorContrato: p.valorContrato === null ? null : Number(p.valorContrato),
        recebido: soma(true),
        aReceberLancado: soma(false),
      };
    }
    return detalhes;
  },

  async buscar_clientes({ busca }, ctx) {
    const clientes = await prisma.cliente.findMany({
      where: {
        escritorioId: ctx.escritorioId,
        OR: busca
          ? [{ nome: { contains: busca } }, { email: { contains: busca } }, { telefone: { contains: busca } }]
          : undefined,
      },
      select: { id: true, nome: true, email: true, telefone: true, _count: { select: { projetos: true } } },
      orderBy: { nome: 'asc' },
      take: 30,
    });
    return clientes.map(({ _count, ...c }) => ({ ...c, projetos: _count.projetos }));
  },

  async detalhes_cliente({ cliente_id }, ctx) {
    const c = await prisma.cliente.findFirst({
      where: { id: cliente_id, escritorioId: ctx.escritorioId },
      include: {
        projetos: { include: { etapas: { select: { status: true, nome: true, ordem: true } } } },
        eventos: {
          where: { inicio: { gte: new Date() } },
          orderBy: { inicio: 'asc' },
          take: 5,
          select: { titulo: true, inicio: true },
        },
      },
    });
    if (!c) throw new ErroFerramenta(`Cliente ${cliente_id} não encontrado`);

    // Receitas dos projetos do cliente (como na página do cliente), só para quem vê o financeiro
    let financeiro;
    if (ctx.verFinanceiro) {
      const receitas = await prisma.lancamento.groupBy({
        by: ['pago'],
        where: { escritorioId: ctx.escritorioId, tipo: 'RECEITA', projeto: { clienteId: c.id } },
        _sum: { valor: true },
      });
      const soma = (pago) => Number(receitas.find((r) => r.pago === pago)?._sum.valor || 0);
      financeiro = {
        totalContratos: c.projetos.reduce((t, p) => t + Number(p.valorContrato || 0), 0),
        recebido: soma(true),
        aReceberLancado: soma(false),
      };
    }

    return {
      ...(financeiro && { financeiro }),
      id: c.id,
      nome: c.nome,
      email: c.email,
      telefone: c.telefone,
      documento: c.documento,
      endereco: c.endereco,
      observacoes: c.observacoes,
      projetos: c.projetos.map((p) => ({
        id: p.id,
        nome: p.nome,
        status: p.status,
        ...progressoEtapas(p.etapas),
        ...(ctx.verFinanceiro && { valorContrato: p.valorContrato === null ? null : Number(p.valorContrato) }),
      })),
      proximosCompromissos: c.eventos.map((e) => ({ titulo: e.titulo, quando: dataHora(e.inicio, ctx.fuso) })),
    };
  },

  async etapas_pendentes({ somente_minhas, filtro, dias }, ctx) {
    const hoje = new Date(`${ctx.hoje}T00:00:00Z`);
    const dataPrevista =
      filtro === 'atrasadas'
        ? { lt: hoje }
        : filtro === 'proximos_dias'
          ? { gte: hoje, lte: new Date(`${somarDias(ctx.hoje, dias || 7)}T00:00:00Z`) }
          : undefined;
    const etapas = await prisma.etapa.findMany({
      where: {
        status: { not: 'CONCLUIDA' },
        responsavelId: somente_minhas ? ctx.usuario.id : undefined,
        dataPrevista,
        projeto: { escritorioId: ctx.escritorioId, status: 'ATIVO' },
      },
      include: {
        projeto: { select: { id: true, nome: true } },
        responsavel: { select: { nome: true } },
      },
      orderBy: [{ dataPrevista: 'asc' }],
      take: 40,
    });
    return etapas.map((e) => ({
      id: e.id,
      nome: e.nome,
      status: STATUS_ETAPA[e.status],
      dataPrevista: dia(e.dataPrevista),
      atrasada: Boolean(e.dataPrevista && e.dataPrevista < hoje),
      responsavel: e.responsavel?.nome || null,
      projeto: e.projeto,
    }));
  },

  async agenda({ inicio, fim }, ctx) {
    exigirFormato(inicio, RE_DATA, 'inicio', 'AAAA-MM-DD');
    exigirFormato(fim, RE_DATA, 'fim', 'AAAA-MM-DD');
    const eventos = await prisma.evento.findMany({
      where: {
        escritorioId: ctx.escritorioId,
        inicio: { gte: inicioDoDiaUtc(inicio, ctx.fuso), lt: inicioDoDiaUtc(somarDias(fim, 1), ctx.fuso) },
      },
      include: {
        tipo: { select: { nome: true } },
        cliente: { select: { id: true, nome: true } },
        projeto: { select: { id: true, nome: true } },
      },
      orderBy: { inicio: 'asc' },
      take: 50,
    });
    return eventos.map((e) => ({
      titulo: e.titulo,
      tipo: e.tipo?.nome || null,
      quando: dataHora(e.inicio, ctx.fuso),
      ate: dataHora(e.fim, ctx.fuso),
      local: e.local,
      cliente: e.cliente,
      projeto: e.projeto,
    }));
  },

  async equipe(_, ctx) {
    return prisma.usuario.findMany({
      where: { escritorioId: ctx.escritorioId },
      select: { id: true, nome: true, papel: true },
      orderBy: { nome: 'asc' },
    });
  },

  async resumo_financeiro({ mes }, ctx) {
    exigirFormato(mes, RE_MES, 'mes', 'AAAA-MM');
    const resumo = await calcularResumoMes(mes || ctx.hoje.slice(0, 7), ctx.escritorioId);
    const vencidas = await prisma.lancamento.count({
      where: { escritorioId: ctx.escritorioId, pago: false, vencimento: { lt: new Date(`${ctx.hoje}T00:00:00Z`) } },
    });
    return { ...resumo, contasVencidasNoTotal: vencidas };
  },

  async listar_lancamentos({ mes, tipo, situacao, busca }, ctx) {
    exigirFormato(mes, RE_MES, 'mes', 'AAAA-MM');
    const hoje = new Date(`${ctx.hoje}T00:00:00Z`);
    const lancamentos = await prisma.lancamento.findMany({
      where: {
        escritorioId: ctx.escritorioId,
        tipo: tipo || undefined,
        vencimento: situacao === 'vencido' ? { lt: hoje } : mes ? monthRange(mes) : undefined,
        pago: situacao === 'pago' ? true : situacao ? false : undefined,
        OR: busca
          ? [
              { descricao: { contains: busca } },
              { categoria: { contains: busca } },
              { projeto: { nome: { contains: busca } } },
              { projeto: { cliente: { nome: { contains: busca } } } },
            ]
          : undefined,
      },
      include: { projeto: { select: { id: true, nome: true } } },
      orderBy: { vencimento: 'asc' },
      take: 40,
    });
    return lancamentos.map((l) => ({
      id: l.id,
      descricao: l.descricao,
      tipo: l.tipo,
      valor: Number(l.valor),
      vencimento: dia(l.vencimento),
      pago: l.pago,
      categoria: l.categoria,
      projeto: l.projeto,
    }));
  },

  // ----- ações (só propõem) -----

  async criar_compromisso(a, ctx) {
    exigirFormato(a.inicio, RE_DATA_HORA, 'inicio', 'AAAA-MM-DDTHH:mm');
    exigirFormato(a.fim, RE_DATA_HORA, 'fim', 'AAAA-MM-DDTHH:mm');
    if (a.fim && a.fim <= a.inicio) throw new ErroFerramenta('O fim precisa ser depois do início');
    const cliente = a.cliente_id ? await clienteDoEscritorio(a.cliente_id, ctx) : null;
    const projeto = a.projeto_id ? await projetoDoEscritorio(a.projeto_id, ctx) : null;
    const tipo = a.tipo
      ? (await prisma.tipoEvento.findMany({ where: { escritorioId: ctx.escritorioId }, select: { id: true, nome: true } })).find(
          (t) => t.nome.toLowerCase() === a.tipo.toLowerCase()
        )
      : null;
    return proporAcao(ctx, {
      titulo: 'Novo compromisso',
      linhas: [
        ['Título', a.titulo],
        ['Quando', rotuloDataLocal(a.inicio) + (a.fim ? ` até ${a.fim.slice(11)}` : '')],
        ['Tipo', tipo?.nome],
        ['Local', a.local],
        ['Cliente', cliente?.nome],
        ['Projeto', projeto?.nome],
        ['Observações', a.descricao],
      ],
      requisicao: {
        metodo: 'post',
        rota: '/eventos',
        // o front converte as datas locais (AAAA-MM-DDTHH:mm) para o horário certo antes de enviar
        datasLocais: ['inicio', 'fim'],
        corpo: {
          titulo: a.titulo,
          inicio: a.inicio,
          fim: a.fim,
          tipoId: tipo?.id ?? null,
          local: a.local,
          clienteId: cliente?.id ?? null,
          projetoId: projeto?.id ?? null,
          descricao: a.descricao,
        },
      },
    });
  },

  async criar_cliente(a, ctx) {
    const parecido = await prisma.cliente.findFirst({
      where: { escritorioId: ctx.escritorioId, nome: { contains: a.nome.trim() } },
      select: { id: true, nome: true },
    });
    const resultado = proporAcao(ctx, {
      titulo: 'Novo cliente',
      linhas: [
        ['Nome', a.nome],
        ['E-mail', a.email],
        ['Telefone', a.telefone],
        ['Observações', a.observacoes],
      ],
      requisicao: {
        metodo: 'post',
        rota: '/clientes',
        corpo: { nome: a.nome, email: a.email, telefone: a.telefone, observacoes: a.observacoes },
      },
    });
    if (parecido) resultado.atencao = `Já existe um cliente parecido: ${parecido.nome} (id ${parecido.id}). Avise a pessoa.`;
    return resultado;
  },

  async criar_projeto(a, ctx) {
    exigirFormato(a.previsao_entrega, RE_DATA, 'previsao_entrega', 'AAAA-MM-DD');
    const cliente = await clienteDoEscritorio(a.cliente_id, ctx);
    const valor = ctx.verFinanceiro ? a.valor_contrato : null;
    return proporAcao(ctx, {
      titulo: 'Novo projeto',
      linhas: [
        ['Nome', a.nome],
        ['Cliente', cliente.nome],
        ['Tipo', a.tipo.charAt(0) + a.tipo.slice(1).toLowerCase()],
        ['Entrega', a.previsao_entrega && rotuloDataLocal(a.previsao_entrega)],
        ['Endereço da obra', a.endereco_obra],
        ['Valor do contrato', valor ? moeda(valor) : null],
        ['Etapas', 'as etapas padrão do escritório'],
      ],
      requisicao: {
        metodo: 'post',
        rota: '/projetos',
        corpo: {
          nome: a.nome,
          clienteId: cliente.id,
          tipo: a.tipo,
          previsaoEntrega: a.previsao_entrega,
          enderecoObra: a.endereco_obra,
          ...(valor && { valorContrato: valor }),
        },
      },
    });
  },

  // Roda a mesma análise do "Novo projeto com IA" e devolve um cartão que abre a revisão já preenchida
  async montar_projeto_com_ia(a, ctx) {
    const briefing = String(a.briefing || '').trim();
    if (briefing.length < 30) {
      throw new ErroFerramenta('Briefing curto demais: pergunte à pessoa mais detalhes do projeto (cliente, o que ele quer, ambientes, área).');
    }
    const resultado = await analisarBriefing({
      req: ctx.req,
      body: { briefing, clienteId: a.cliente_id || null, tipo: a.tipo || null },
    });
    const { pacote, clienteExistente } = resultado;
    const { proposta } = pacote;
    const prazo = proposta.etapas.reduce((t, e) => t + e.prazoDias, 0);
    const valor = ctx.verFinanceiro ? proposta.valor.sugerido : null;
    const cliente = clienteExistente?.nome || (pacote.cliente.nome ? `${pacote.cliente.nome} (novo)` : 'a definir na revisão');

    ctx.acoes.push({
      id: `acao-${ctx.acoes.length + 1}-${Date.now()}`,
      tipo: 'revisao', // não chama a API: abre a tela de revisão do "Novo projeto com IA"
      titulo: 'Projeto montado com IA',
      linhas: [
        ['Projeto', pacote.projeto.nome],
        ['Cliente', cliente],
        ['Etapas', `${proposta.etapas.length} etapas, cerca de ${prazo} dias`],
        ['Ambientes', pacote.programa.length ? `${pacote.programa.length} no programa` : null],
        ['Valor sugerido', valor ? moeda(valor) : null],
        ['Parcelas', ctx.verFinanceiro && pacote.parcelas.length ? String(pacote.parcelas.length) : null],
        ['Agenda', pacote.compromissos.length ? `${pacote.compromissos.length} compromissos` : null],
      ].filter(([, v]) => v),
      revisao: { ...resultado, briefing },
    });
    return {
      situacao: 'pacote_pronto_para_revisao',
      projeto: pacote.projeto.nome,
      cliente,
      etapas: proposta.etapas.map((e) => `${e.nome} (${e.prazoDias} dias)`),
      ...(valor && { valorSugerido: valor, parcelas: pacote.parcelas.length }),
      compromissos: pacote.compromissos.length,
      perguntasEmAberto: pacote.perguntas,
      aviso:
        'Nada foi criado ainda. A pessoa clica em "Revisar e aprovar" no cartão, confere tudo na tela de revisão e aprova lá. ' +
        'Responda em duas ou três frases: o que foi montado e que é só revisar e aprovar. Se houver perguntas em aberto, cite no máximo duas. ' +
        'O projeto ainda não existe: escreva o nome dele sem link.',
    };
  },

  async atualizar_etapa(a, ctx) {
    exigirFormato(a.data_prevista, RE_DATA, 'data_prevista', 'AAAA-MM-DD');
    const etapa = await prisma.etapa.findFirst({
      where: { id: a.etapa_id, projeto: { escritorioId: ctx.escritorioId } },
      include: { projeto: { select: { nome: true } }, responsavel: { select: { nome: true } } },
    });
    if (!etapa) throw new ErroFerramenta(`Etapa ${a.etapa_id} não encontrada`);
    const responsavel = a.responsavel_id
      ? await prisma.usuario.findFirst({ where: { id: a.responsavel_id, escritorioId: ctx.escritorioId }, select: { id: true, nome: true } })
      : null;
    if (a.responsavel_id && !responsavel) throw new ErroFerramenta('Responsável precisa ser alguém da equipe');

    const corpo = {};
    if (a.status) corpo.status = a.status;
    if (a.data_prevista) corpo.dataPrevista = a.data_prevista;
    if (responsavel) corpo.responsavelId = responsavel.id;
    if (!Object.keys(corpo).length) throw new ErroFerramenta('Nada para alterar');

    const de = (antes, depois) => `${antes || '—'} → ${depois}`;
    return proporAcao(ctx, {
      titulo: 'Alterar etapa',
      linhas: [
        ['Projeto', etapa.projeto.nome],
        ['Etapa', etapa.nome],
        ['Status', a.status && de(STATUS_ETAPA[etapa.status], STATUS_ETAPA[a.status])],
        ['Data prevista', a.data_prevista && de(etapa.dataPrevista && rotuloDataLocal(dia(etapa.dataPrevista)), rotuloDataLocal(a.data_prevista))],
        ['Responsável', responsavel && de(etapa.responsavel?.nome, responsavel.nome)],
      ],
      requisicao: { metodo: 'patch', rota: `/etapas/${etapa.id}`, corpo },
    });
  },

  async criar_lancamento(a, ctx) {
    exigirFormato(a.vencimento, RE_DATA, 'vencimento', 'AAAA-MM-DD');
    if (!(a.valor > 0)) throw new ErroFerramenta('O valor deve ser maior que zero');
    const projeto = a.projeto_id ? await projetoDoEscritorio(a.projeto_id, ctx) : null;
    return proporAcao(ctx, {
      titulo: a.tipo === 'RECEITA' ? 'Nova receita' : 'Nova despesa',
      linhas: [
        ['Descrição', a.descricao],
        ['Valor', moeda(a.valor)],
        ['Vencimento', rotuloDataLocal(a.vencimento)],
        ['Categoria', a.categoria],
        ['Projeto', projeto?.nome],
        ['Situação', a.pago ? (a.tipo === 'RECEITA' ? 'Recebido' : 'Pago') : 'Pendente'],
      ],
      requisicao: {
        metodo: 'post',
        rota: '/lancamentos',
        corpo: {
          tipo: a.tipo,
          descricao: a.descricao,
          valor: a.valor,
          vencimento: a.vencimento,
          categoria: a.categoria,
          projetoId: projeto?.id ?? null,
          pago: a.pago,
        },
      },
    });
  },

  async marcar_pagamento({ lancamento_id, pago }, ctx) {
    const l = await prisma.lancamento.findFirst({ where: { id: lancamento_id, escritorioId: ctx.escritorioId } });
    if (!l) throw new ErroFerramenta(`Lançamento ${lancamento_id} não encontrado`);
    const situacao = pago ? (l.tipo === 'RECEITA' ? 'Recebido' : 'Pago') : 'Pendente';
    return proporAcao(ctx, {
      titulo: pago ? 'Marcar como pago' : 'Voltar para pendente',
      linhas: [
        ['Lançamento', l.descricao],
        ['Valor', moeda(l.valor)],
        ['Vencimento', rotuloDataLocal(dia(l.vencimento))],
        ['Situação', `${l.pago ? 'Pago' : 'Pendente'} → ${situacao}`],
      ],
      requisicao: { metodo: 'patch', rota: `/lancamentos/${l.id}/pagamento`, corpo: { pago } },
    });
  },
};

const FINANCEIRAS = new Set(['resumo_financeiro', 'listar_lancamentos', 'criar_lancamento', 'marcar_pagamento']);

async function executar(chamada, ctx) {
  const nome = chamada.function?.name;
  const executor = executores[nome];
  // a lista de ferramentas já não inclui as financeiras para quem não tem acesso; checa de novo aqui
  if (!executor || (FINANCEIRAS.has(nome) && !ctx.verFinanceiro)) return { erro: `Ferramenta indisponível: ${nome}` };
  try {
    return await executor(JSON.parse(chamada.function.arguments || '{}'), ctx);
  } catch (error) {
    if (error instanceof ErroFerramenta || error instanceof HttpError) return { erro: error.message };
    if (error instanceof SyntaxError) return { erro: 'Argumentos inválidos' };
    throw error;
  }
}

// ---------- conversa ----------

// Quando a pessoa está ouvindo, a resposta vem em duas partes: primeiro o texto para a voz (assim a
// voz começa enquanto o resto ainda está sendo escrito), depois a marca e o texto da tela.
const MARCA_TELA = '§TELA§';

const INSTRUCOES_FALA = [
  '',
  'A pessoa está OUVINDO as respostas em voz alta. Comece pelo texto que a voz vai falar; depois escreva numa linha sozinha ' +
    MARCA_TELA +
    ' e, depois dela, a resposta escrita da tela. A da tela é independente da falada: segue as regras de sempre ' +
    '(listas quando ajudarem, links, datas dd/mm, horários 14h) e traz os detalhes. Regras do texto falado:',
  '- Fale como uma colega de trabalho conversando: informal, leve e simpática, do jeito que se fala no dia a dia no Brasil. Não leia a tela: conte o essencial com as suas palavras.',
  '- Use a fala do dia a dia: "essa semana", "pra", "tá", "tem uma visita", "beleza", "olha", "fechou". Nada de linguagem formal ("nesta semana", "possui", "encontra-se", "informo que", "gostaria de").',
  '- Varie o começo das respostas; não comece sempre com a mesma palavra. De vez em quando, chame a pessoa pelo primeiro nome, sem exagerar.',
  '- Curto: até três ou quatro frases. Lista longa de dados do sistema (compromissos, etapas, lançamentos) vira resumo ("Você tem três compromissos essa semana; o primeiro é..."). Os detalhes sempre aparecem escritos na conversa: se ajudar, diga que estão aí ("os detalhes tão aí embaixo"), sem oferecer ("se quiser, eu te passo") nem prometer o que não está escrito.',
  '- Conteúdo que a pessoa pediu (dicas, explicação, passo a passo) é falado de verdade, de forma corrida ("Primeiro..., depois..."), sem cortar. Nunca diga que vai falar depois.',
  '- Texto corrido, como fala: sem markdown, listas (nem numeradas), quebras de linha, links, IDs, emojis, abreviações, siglas soletradas ou símbolos (nada de "qui", "19/11", "10h", "R$", "—").',
  '- Datas por extenso e relativas quando ajudar: "hoje", "amanhã", "nessa quinta, dia 19", "dia 3 de dezembro".',
  '- Horários falados: "às 10 da manhã", "das 10 às 11 e meia", "às 2 da tarde", "ao meio-dia".',
  '- Valores falados: "52 mil reais", "mil e duzentos reais e cinquenta centavos".',
  '- Se houver um cartão para confirmar, termine dizendo, do seu jeito, que é só confirmar no cartão ("Deixei pronto aí, é só confirmar"). Não diga que já marcou, fechou ou criou: ainda falta a pessoa confirmar.',
  '- Não escreva ' + MARCA_TELA + ' em nenhum outro lugar.',
  '',
  'Exemplo do formato (a parte da tela NÃO repete a falada: é a versão escrita, com lista e links):',
  'Olha, essa semana você tem dois compromissos: na quinta tem a visita técnica com o Bruno, de manhã, e na sexta uma reunião de briefing à tarde.',
  MARCA_TELA,
  'Essa semana:',
  '- **Qui., 19/11, 10h às 11h30**: Visita técnica inicial, com [Bruno Teixeira](/clientes/3)',
  '- **Sex., 20/11, 14h às 15h**: Reunião de briefing, projeto [Cafeteria Grão & Cia](/projetos/8)',
].join('\n');

// "texto falado §TELA§ texto da tela" -> { resposta, fala }. Sem a marca, tudo é a resposta da tela.
function separarFala(conteudo, voz) {
  const i = voz ? conteudo.indexOf(MARCA_TELA) : -1;
  if (i < 0) return { resposta: conteudo.trim(), fala: null };
  const fala = conteudo.slice(0, i).trim();
  const resposta = conteudo.slice(i + MARCA_TELA.length).trim();
  return { resposta: resposta || fala, fala: fala || null };
}

// Divide o texto que chega aos pedaços em "fala" (antes da marca) e "texto" (depois), avisando cada
// pedaço assim que chega. Segura o fim do pedaço quando ele pode ser o começo da marca.
function divisorDeFluxo(voz, emitir) {
  let parte = voz ? 'fala' : 'texto';
  let pendente = '';
  const enviar = (texto) => texto && emitir(parte, { texto });
  return {
    adicionar(pedaco) {
      pendente += pedaco;
      if (parte === 'fala') {
        const i = pendente.indexOf(MARCA_TELA);
        if (i >= 0) {
          enviar(pendente.slice(0, i));
          pendente = pendente.slice(i + MARCA_TELA.length).replace(/^\s+/, '');
          parte = 'texto';
        } else {
          // guarda o que pode ser o começo da marca ("§", "§TE"...)
          let guardar = 0;
          for (let n = Math.min(MARCA_TELA.length - 1, pendente.length); n > 0; n--) {
            if (MARCA_TELA.startsWith(pendente.slice(-n))) {
              guardar = n;
              break;
            }
          }
          enviar(pendente.slice(0, pendente.length - guardar));
          pendente = pendente.slice(pendente.length - guardar);
          return;
        }
      }
      enviar(pendente);
      pendente = '';
    },
    terminar() {
      enviar(pendente);
      pendente = '';
    },
  };
}

// Uma chamada ao modelo, recebida aos pedaços: o texto vai saindo por "aoEscrever" e as chamadas de
// ferramenta são montadas a partir dos pedaços (só dá para executá-las no fim)
// Quando a resposta veio só com a parte falada: escreve a versão da tela (com os dados já consultados
// na conversa), mandando os pedaços como "texto"
async function escreverTela(conversa, fala, emitir) {
  const pedido = [
    ...conversa,
    { role: 'assistant', content: fala },
    {
      role: 'developer',
      content:
        'Agora escreva só a resposta escrita da tela para a última pergunta, com as regras de sempre: listas quando ajudarem, ' +
        'links markdown com os IDs, datas dd/mm, horários 14h, e os detalhes (é aqui que eles aparecem). Não repita a resposta ' +
        'falada, não fale de voz nem de tela e não escreva ' + MARCA_TELA + '.',
    },
  ];
  const { conteudo } = await rodadaEmFluxo({ messages: pedido }, (texto) => emitir('texto', { texto }));
  return conteudo.trim() || fala;
}

async function rodadaEmFluxo(params, aoEscrever) {
  const fluxo = await conversarEmFluxo(params);
  let conteudo = '';
  const chamadas = [];
  for await (const parte of fluxo) {
    const delta = parte.choices?.[0]?.delta;
    if (!delta) continue;
    for (const tc of delta.tool_calls || []) {
      const c = (chamadas[tc.index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
      if (tc.id) c.id = tc.id;
      if (tc.function?.name) c.function.name += tc.function.name;
      if (tc.function?.arguments) c.function.arguments += tc.function.arguments;
    }
    const texto = delta.content || delta.refusal;
    if (texto) {
      conteudo += texto;
      aoEscrever(texto);
    }
  }
  return { conteudo, chamadas: chamadas.filter(Boolean) };
}

function instrucoes(ctx, escritorio) {
  const [data, hora] = [ctx.hoje, ctx.agora];
  const semana = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${data}T12:00:00Z`));
  return [
    `Você é o assistente do ArcDesk, sistema de gestão do escritório de arquitetura "${escritorio}".`,
    `Você conversa com ${ctx.usuario.nome} (${ctx.usuario.papel === 'ADMIN' ? 'administrador(a)' : 'membro da equipe'}).`,
    `Agora: ${semana}, ${rotuloDataLocal(data).slice(5)}, ${hora} (fuso ${ctx.fuso}).`,
    '',
    'Como responder:',
    '- Português do Brasil, curto e direto: poucas frases ou uma lista. Sem rodeios nem ofertas genéricas no final.',
    '- Busque os dados com as ferramentas. Nunca invente projetos, clientes, datas ou valores; se não encontrar, diga.',
    '- Ao citar um projeto ou cliente, use link markdown com o ID dele: [Casa Serra](/projetos/12), [Marina](/clientes/3). O link de projeto usa o ID do projeto e o de cliente, o ID do cliente; compromissos e etapas não têm link próprio.',
    '- Datas como dd/mm (com o ano se não for o atual), horários como 14h ou 14h30, valores como R$ 1.234,56.',
    '- Para criar ou alterar algo, use a ferramenta de ação: ela só PROPÕE, e a pessoa confirma num cartão. Depois diga em uma frase que é só confirmar. Nunca diga que já foi feito.',
    '- Projeto novo com detalhes do que o cliente quer (ou pedido "com IA"): use montar_projeto_com_ia, não criar_projeto. Não precisa buscar o cliente antes. Se a pessoa só disser "cria um projeto com IA" sem contar nada, pergunte sobre o projeto primeiro.',
    '- Se faltar algo essencial para uma ação (ex.: o horário de uma reunião), pergunte antes. Para achar o ID de um cliente ou projeto pelo nome, busque primeiro.',
    '- Nas ações, preencha só o que a pessoa disse ou o que veio do sistema. Campos opcionais não informados (local, horário de fim, observações...) ficam null: não invente.',
    '- "Quanto falta receber" de um cliente ou projeto = receitas lançadas ainda não pagas (aReceberLancado). Se o contrato for maior que o total lançado, comente a diferença.',
    '- Mensagens entre colchetes, como "[Ação confirmada: ...]", são registros do sistema sobre cartões confirmados ou cancelados.',
    ctx.verFinanceiro
      ? '- Esta pessoa tem acesso ao financeiro.'
      : '- Esta pessoa NÃO tem acesso ao financeiro: não fale de valores, contratos, receitas ou despesas. Se perguntarem, diga que é preciso pedir a liberação a um administrador.',
  ].join('\n');
}

// Histórico vindo do front: só texto de user/assistant, últimas 20 mensagens, terminando na pessoa
function validarHistorico(mensagens) {
  if (!Array.isArray(mensagens) || mensagens.length === 0) throw new HttpError(400, 'Envie a conversa em "mensagens"');
  const historico = mensagens.slice(-20).map((m) => {
    if (!['user', 'assistant'].includes(m?.role) || typeof m.content !== 'string' || !m.content.trim()) {
      throw new HttpError(400, 'Mensagem inválida na conversa');
    }
    return { role: m.role, content: m.content.slice(0, 4000) };
  });
  if (historico.at(-1).role !== 'user') throw new HttpError(400, 'A última mensagem deve ser da pessoa');
  return historico;
}

// emitir(evento, dados): avisa cada pedaço assim que chega ("fala" e "texto"; "descartar" quando um texto
// escrito antes de usar ferramentas deve sair da tela). Sem emitir, só devolve a resposta inteira no fim.
async function responder({ req, mensagens, fuso, voz = false, emitir = () => {} }) {
  const historico = validarHistorico(mensagens);
  const usuario = await prisma.usuario.findUniqueOrThrow({
    where: { id: req.usuario.id },
    select: { id: true, nome: true, papel: true, escritorio: { select: { nome: true } } },
  });
  const zona = fusoValido(fuso || FUSO_PADRAO);
  const agora = agoraNoFuso(zona);
  const ctx = {
    escritorioId: req.escritorioId,
    req, // para montar_projeto_com_ia usar a mesma análise da rota (permissões do financeiro)
    usuario,
    verFinanceiro: podeVerFinanceiro(req.usuario),
    fuso: zona,
    hoje: agora.data,
    agora: agora.hora,
    acoes: [],
  };

  const ferramentas = definicoes(ctx.verFinanceiro);
  const conversa = [
    { role: 'developer', content: instrucoes(ctx, usuario.escritorio?.nome || '') + (voz ? INSTRUCOES_FALA : '') },
    ...historico,
  ];

  for (let rodada = 0; rodada < MAX_RODADAS; rodada++) {
    const divisor = divisorDeFluxo(voz, emitir);
    const { conteudo, chamadas } = await rodadaEmFluxo({ messages: conversa, tools: ferramentas }, (t) =>
      divisor.adicionar(t)
    );

    if (chamadas.length === 0) {
      divisor.terminar();
      if (voz && conteudo.trim() && !conteudo.includes(MARCA_TELA)) {
        // a IA escreveu só a parte falada (esqueceu a marca): a voz já está falando; pede a versão da tela
        const fala = conteudo.trim();
        const resposta = await escreverTela(conversa, fala, emitir);
        return { resposta, fala, acoes: ctx.acoes };
      }
      const { resposta, fala } = separarFala(conteudo || 'Não consegui responder agora.', voz);
      return { resposta, ...(voz && { fala }), acoes: ctx.acoes };
    }

    // texto escrito antes de usar as ferramentas ("deixa eu ver..."): sai da tela (a voz pode já ter falado)
    if (conteudo) emitir('descartar', {});
    conversa.push({ role: 'assistant', content: conteudo || null, tool_calls: chamadas });
    const resultados = await Promise.all(chamadas.map((c) => executar(c, ctx)));
    chamadas.forEach((c, i) => {
      conversa.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(resultados[i]) });
    });
  }

  return {
    resposta: 'Essa pergunta precisou de passos demais. Tente dividir em perguntas menores.',
    acoes: ctx.acoes,
  };
}

module.exports = { responder, validarHistorico, agoraNoFuso, fusoValido, FUSO_PADRAO };
