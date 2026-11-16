const prisma = require('../lib/prisma');
const { gerarJson } = require('../lib/ia');
const { HttpError } = require('../utils/http');

// Relatório de andamento do projeto para o cliente, escrito pela IA (JSON validado por schema).
// A proposta comercial fica no "Novo projeto com IA" (briefingIa.service.js).

const TIPOS_PROJETO = { RESIDENCIAL: 'Residencial', INTERIORES: 'Interiores', COMERCIAL: 'Comercial', OUTRO: 'Outro' };
const dia = (data) => (data ? data.toISOString().slice(0, 10) : null);

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

module.exports = { gerarRelatorio };
