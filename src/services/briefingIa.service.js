const prisma = require('../lib/prisma');
const { gerarJson } = require('../lib/ia');
const { ETAPAS_PADRAO } = require('../constants/etapas');
const { podeVerFinanceiro } = require('../middlewares/permissoes');
const { HttpError, parseId } = require('../utils/http');

// "Novo projeto com IA": o arquiteto passa o briefing (o que levantou com o cliente) e a IA monta
// o pacote inteiro para ele revisar: cliente, projeto, programa de necessidades, proposta com etapas
// e prazos, parcelas, compromissos, documentos a pedir ao cliente e perguntas que ficaram faltando.
// Nada é criado aqui: a criação é em POST /projetos/completo, depois que a pessoa aprova.

const TIPOS = ['RESIDENCIAL', 'INTERIORES', 'COMERCIAL', 'OUTRO'];
const TIPOS_PROJETO = { RESIDENCIAL: 'Residencial', INTERIORES: 'Interiores', COMERCIAL: 'Comercial', OUTRO: 'Outro' };
const diasEntre = (inicio, fim) => (inicio && fim ? Math.round((fim - inicio) / 86400000) : null);

const textos = (description) => ({ type: 'array', items: { type: 'string' }, ...(description && { description }) });
const objeto = (properties) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const opcional = (tipo, description) => ({ type: [tipo, 'null'], ...(description && { description }) });

const SCHEMA_PACOTE = objeto({
  resumo: { type: 'string', description: 'Duas ou três frases para o arquiteto: o que é o projeto e o essencial do cliente' },
  cliente: objeto({
    nome: opcional('string'),
    email: opcional('string'),
    telefone: opcional('string'),
  }),
  projeto: objeto({
    nome: { type: 'string', description: 'Nome curto, como o escritório chamaria: tipo + sobrenome do cliente ou o local (ex.: Residência Souza, Apartamento Moema)' },
    tipo: { type: 'string', enum: TIPOS },
    enderecoObra: opcional('string'),
  }),
  programa: {
    type: 'array',
    description: 'Programa de necessidades: um item por ambiente',
    items: objeto({
      ambiente: { type: 'string' },
      quantidade: { type: 'integer' },
      areaM2: opcional('number', 'Área de cada unidade, em m²'),
      observacao: opcional('string', 'Detalhe pedido pelo cliente que não está no nome do ambiente; senão null'),
    }),
  },
  areaConstruidaM2: opcional('number', 'Área construída total estimada (ambientes + paredes e circulação), ou a informada'),
  proposta: objeto({
    titulo: { type: 'string', description: 'Ex.: Proposta de projeto arquitetônico - Residência Souza' },
    apresentacao: { type: 'string', description: 'Um parágrafo de abertura dirigido ao cliente' },
    escopo: textos('Serviços incluídos, um por item'),
    etapas: {
      type: 'array',
      items: objeto({
        nome: { type: 'string' },
        descricao: { type: 'string', description: 'O que é entregue nesta etapa, numa frase' },
        prazoDias: { type: 'integer', description: 'Duração estimada em dias corridos' },
      }),
    },
    valor: objeto({
      sugerido: opcional('number'),
      minimo: opcional('number'),
      maximo: opcional('number'),
      justificativa: { type: 'string', description: 'Como o valor foi estimado (cite os projetos usados como base)' },
    }),
    condicoesPagamento: textos(),
    naoIncluso: textos('Exclusões (ex.: projetos complementares, taxas)'),
    premissas: textos('O que foi suposto por falta de informação'),
  }),
  parcelas: {
    type: 'array',
    items: objeto({
      descricao: { type: 'string', description: 'Ex.: Entrada, Entrega do estudo preliminar' },
      percentual: { type: 'integer' },
      etapa: opcional('string', 'Nome exato (igual em proposta.etapas) da etapa em cuja entrega a parcela vence; null = na assinatura do contrato'),
    }),
  },
  compromissos: {
    type: 'array',
    items: objeto({
      titulo: { type: 'string' },
      tipo: opcional('string', 'Um dos tiposDeCompromisso do escritório'),
      etapa: opcional('string', 'Nome exato (igual em proposta.etapas) da etapa a partir de cuja entrega o compromisso é marcado; null = a partir do início do projeto'),
      diasDepois: { type: 'integer', description: 'Dias depois do marco acima' },
      duracaoMinutos: { type: 'integer' },
      descricao: opcional('string'),
    }),
  },
  documentosCliente: textos('Documentos e informações a pedir ao cliente'),
  perguntas: textos('O que ficou faltando no briefing e é importante perguntar ao cliente'),
});

const INSTRUCOES = `Você ajuda um escritório de arquitetura brasileiro a transformar o briefing de um cliente (anotações do arquiteto, às vezes ditadas) num pacote pronto para revisar: programa de necessidades, proposta comercial, cronograma, parcelas, agenda e pendências. Português do Brasil.

Regras gerais:
- Use só o que está no briefing. Nunca invente dados do cliente (nome, e-mail, telefone, endereço): o que não foi dito fica null.
- O que você precisou supor (área, padrão de acabamento, número de pavimentos...) vai em "proposta.premissas"; o que é importante e não foi dito vai em "perguntas" (até 8, as mais importantes primeiro, escritas para o arquiteto perguntar ao cliente).
- "tipoInformado", quando vier, é o tipo do projeto. Se não vier, deduza: casa ou prédio novo/reforma com obra = RESIDENCIAL ou COMERCIAL; só ambientes internos, móveis e marcenaria = INTERIORES.

Programa de necessidades:
- Um item por ambiente pedido (ex.: Suíte master, Quarto, Sala de estar e jantar integradas, Cozinha, Área gourmet, Garagem). Ambientes iguais ficam num item com quantidade.
- Inclua ambientes de apoio que todo projeto desse tipo tem e o cliente não precisa dizer (ex.: banheiro social, lavanderia). Não acrescente desejos que o cliente não disse. Circulação e paredes não são ambientes: entram só na área construída.
- "observacao" só traz um detalhe que o cliente pediu e que não está no nome (ex.: "voltada para a piscina"); se o nome já diz tudo, null. Nunca repita o nome.
- areaM2 é a área de cada unidade, estimada pelo padrão do projeto quando não foi informada. "areaConstruidaM2": a área informada pelo cliente ou a soma dos ambientes mais 15% a 25% de paredes e circulação.

Proposta:
- Etapas típicas de arquitetura no Brasil (levantamento, estudo preliminar, anteprojeto, projeto legal, projeto executivo, acompanhamento de obra), adaptadas ao escopo: interiores não tem projeto legal, mas tem detalhamento de marcenaria e luminotécnico. Prefira os nomes de etapa que o escritório já usa (etapasPadraoDoEscritorio e histórico). Prazos realistas para o porte.
- Valor: estime com base no histórico de projetos do escritório (valores, tipos e prazos reais). Dê um valor sugerido e uma faixa (mínimo e máximo). Na justificativa, cite quais projetos do histórico serviram de base. Sem histórico comparável, estime pelo mercado brasileiro e diga isso na justificativa. Valores em reais, números sem formatação. O valor é o dos honorários do projeto de arquitetura: orçamento da obra ou verba do cliente citados no briefing não são esse valor (servem só como referência de porte). Com "valoresDisponiveis" true, sugerido, mínimo e máximo nunca ficam null e há sempre parcelas. Se "valoresDisponiveis" for false, os campos de valor ficam null, a justificativa fica vazia e "parcelas" fica vazio.
- "naoIncluso": exclusões comuns (projetos complementares de estrutura, elétrica e hidráulica, taxas de prefeitura e cartório, RRT, maquete física, cópias impressas), conforme o escopo.
- A apresentação tem um parágrafo, tom cordial e profissional, dirigida ao cliente pelo nome quando houver.
- Tudo da proposta, exceto "valor.justificativa", vai para o cliente: nunca mencione o histórico, projetos anteriores ou outros clientes do escritório nesses campos.

Parcelas (honorários):
- Entrada na assinatura do contrato (etapa null) e as demais vinculadas às entregas das etapas ("etapa" = o nome da etapa, escrito exatamente como em proposta.etapas). De 3 a 6 parcelas, percentuais inteiros maiores que zero, somando exatamente 100. Nem toda etapa precisa de parcela.
- "proposta.condicoesPagamento" descreve essas mesmas parcelas em texto, em percentuais (sem valores em reais).

Compromissos (agenda), de 2 a 5:
- "etapa" é o nome da etapa (exatamente como em proposta.etapas) cuja entrega é o marco, ou null para contar do início do projeto.
- Visita técnica / levantamento logo no início (etapa null, poucos dias depois), reuniões de apresentação ao cliente na entrega das etapas que são apresentadas (estudo preliminar, anteprojeto) e a entrega final.
- "tipo" é um dos tiposDeCompromisso do escritório, escrito igual; se nenhum servir, null.

Documentos a pedir ao cliente: de 4 a 10, conforme o tipo. Obra ou reforma: matrícula do imóvel, IPTU, planta ou levantamento existente, levantamento topográfico (terreno), regras do condomínio ou loteamento. Interiores: planta do imóvel, manual do proprietário com pontos de elétrica e hidráulica, regras de reforma do condomínio. Em geral: fotos e referências de estilo que o cliente goste, documentos pessoais para o contrato.`;

// Projetos do escritório para estimar prazos e valores (valores só para quem vê o financeiro)
async function historicoDoEscritorio(escritorioId, comValores) {
  const projetos = await prisma.projeto.findMany({
    where: { escritorioId },
    select: {
      nome: true,
      tipo: true,
      valorContrato: true,
      dataInicio: true,
      previsaoEntrega: true,
      observacoes: true,
      briefing: true, // o resumo dos projetos criados pelo briefing
      etapas: { select: { nome: true }, orderBy: { ordem: 'asc' } },
    },
    orderBy: { criadoEm: 'desc' },
    take: 40,
  });
  return projetos.map((p) => ({
    nome: p.nome,
    tipo: TIPOS_PROJETO[p.tipo],
    ...(comValores && { valorContrato: p.valorContrato === null ? null : Number(p.valorContrato) }),
    duracaoDias: diasEntre(p.dataInicio, p.previsaoEntrega),
    etapas: p.etapas.map((e) => e.nome),
    observacoes: (p.observacoes || p.briefing?.resumo || '').slice(0, 300) || null,
  }));
}

// "Marina Souza" == "marina  souza" == "Marina Souza " (sem acento e sem diferença de caixa)
const normalizar = (texto) =>
  String(texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

// Ajustes no que a IA devolveu: limites, referências a etapas que existem, percentuais somando 100
function arrumarPacote(pacote, { tipo, comValores, tiposEvento }) {
  const { proposta } = pacote;
  if (tipo) pacote.projeto.tipo = tipo;
  proposta.etapas = proposta.etapas.slice(0, 30).map((e) => ({ ...e, prazoDias: Math.min(720, Math.max(1, e.prazoDias)) }));
  const numeroDaEtapa = new Map(proposta.etapas.map((e, i) => [normalizar(e.nome), i + 1]));
  // nome exato ou, se a IA escrever um pouco diferente ("Entrega do estudo preliminar"), o que contém o nome
  const etapaPeloNome = (nome) => {
    if (!nome) return null;
    const alvo = normalizar(nome);
    if (numeroDaEtapa.has(alvo)) return numeroDaEtapa.get(alvo);
    const parecida = [...numeroDaEtapa.keys()].filter((n) => alvo.includes(n)).sort((x, y) => y.length - x.length)[0];
    return parecida ? numeroDaEtapa.get(parecida) : null;
  };

  // circulação e paredes entram só na área construída, não são ambientes do programa
  pacote.programa = pacote.programa
    .filter((item) => !/circula|parede/i.test(item.ambiente))
    .slice(0, 60)
    .map((item) => ({
    ...item,
      quantidade: Math.min(50, Math.max(1, item.quantidade)),
      areaM2: item.areaM2 && item.areaM2 > 0 ? Math.round(item.areaM2 * 10) / 10 : null,
      observacao: item.observacao && normalizar(item.observacao) !== normalizar(item.ambiente) ? item.observacao : null,
    }));
  if (pacote.areaConstruidaM2 !== null) pacote.areaConstruidaM2 = Math.round(pacote.areaConstruidaM2);

  if (!comValores) {
    proposta.valor = { sugerido: null, minimo: null, maximo: null, justificativa: '' };
    pacote.parcelas = [];
  } else {
    pacote.parcelas = pacote.parcelas
      .slice(0, 12)
      .filter((p) => p.percentual > 0)
      .map((p) => ({ ...p, etapa: etapaPeloNome(p.etapa) }));
    const soma = pacote.parcelas.reduce((s, p) => s + p.percentual, 0);
    if (pacote.parcelas.length && soma !== 100) pacote.parcelas.at(-1).percentual += 100 - soma;
  }

  const nomesTipos = new Map(tiposEvento.map((t) => [normalizar(t.nome), t]));
  pacote.compromissos = pacote.compromissos.slice(0, 8).map(({ tipo: nomeTipo, ...c }) => ({
    ...c,
    tipoId: nomesTipos.get(normalizar(nomeTipo))?.id ?? null,
    etapa: etapaPeloNome(c.etapa) ?? 0, // 0 = início do projeto
    diasDepois: Math.min(365, Math.max(0, c.diasDepois)),
    duracaoMinutos: Math.min(480, Math.max(15, c.duracaoMinutos)),
  }));
  pacote.documentosCliente = pacote.documentosCliente.slice(0, 20);
  pacote.perguntas = pacote.perguntas.slice(0, 8);
  return pacote;
}

async function analisarBriefing({ req, body }) {
  const briefing = String(body.briefing || '').trim();
  if (briefing.length < 30) throw new HttpError(400, 'Conte um pouco mais sobre o projeto (pelo menos uma ou duas frases)');
  if (briefing.length > 8000) throw new HttpError(400, 'O briefing pode ter no máximo 8.000 caracteres');
  const tipo = body.tipo || null;
  if (tipo && !TIPOS.includes(tipo)) throw new HttpError(400, 'Tipo de projeto inválido');

  const { escritorioId } = req;
  const comValores = podeVerFinanceiro(req.usuario);
  const clienteId = body.clienteId ? parseId(body.clienteId) : null;

  const [escritorio, clienteEscolhido, clientes, tiposEvento, historico] = await Promise.all([
    prisma.escritorio.findUniqueOrThrow({ where: { id: escritorioId }, select: { nome: true } }),
    clienteId ? prisma.cliente.findFirst({ where: { id: clienteId, escritorioId }, select: { id: true, nome: true } }) : null,
    prisma.cliente.findMany({ where: { escritorioId }, select: { id: true, nome: true } }),
    prisma.tipoEvento.findMany({ where: { escritorioId }, select: { id: true, nome: true } }),
    historicoDoEscritorio(escritorioId, comValores),
  ]);
  if (clienteId && !clienteEscolhido) throw new HttpError(404, 'Cliente não encontrado');

  const pacote = await gerarJson({
    nome: 'pacote_projeto',
    schema: SCHEMA_PACOTE,
    instrucoes: INSTRUCOES,
    entrada: JSON.stringify({
      hoje: new Date().toISOString().slice(0, 10),
      escritorio: escritorio.nome,
      tipoInformado: tipo ? TIPOS_PROJETO[tipo] : null,
      clienteJaCadastrado: clienteEscolhido?.nome || null,
      briefing,
      etapasPadraoDoEscritorio: ETAPAS_PADRAO,
      tiposDeCompromisso: tiposEvento.map((t) => t.nome),
      valoresDisponiveis: comValores,
      historicoDeProjetos: historico,
    }),
  });

  arrumarPacote(pacote, { tipo, comValores, tiposEvento });

  // cliente: o escolhido na tela ou, se o nome do briefing bater com um cadastrado, esse
  const clienteExistente =
    clienteEscolhido || clientes.find((c) => pacote.cliente.nome && normalizar(c.nome) === normalizar(pacote.cliente.nome)) || null;

  return {
    pacote,
    clienteExistente,
    baseadoEm: comValores ? historico.filter((p) => p.valorContrato).length : 0,
  };
}

module.exports = { analisarBriefing };
