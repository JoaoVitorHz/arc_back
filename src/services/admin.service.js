// Painel admin (dono da plataforma): métricas, escritórios, usuários, notas fiscais e o registro
// de tudo o que é feito por aqui. Mostra dados de GESTÃO (plano, pagamentos, uso); não abre os
// projetos, clientes e lançamentos dos escritórios (só a contagem deles).
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { agoraEmSegundos } = require('../lib/jwt');
const { HttpError, parseId } = require('../utils/http');
const { SALT_ROUNDS, normalizarEmail, validarEmail } = require('../utils/sessao');
const { planoPorCodigo } = require('../constants/plano');
const { calcularAcesso } = require('./assinatura.service');

const DIA = 24 * 60 * 60 * 1000;
const ATIVAS = ['ATIVA', 'AGUARDANDO_PAGAMENTO', 'ATRASADA'];

// ---------- Registro das ações ----------

async function registrar(req, acao, alvoTipo, alvoId, detalhes) {
  await prisma.acaoAdmin.create({ data: { adminId: req.usuario.id, acao, alvoTipo, alvoId, detalhes } });
}

// ---------- Escritórios ----------

// função: a data dos convites válidos é a de cada consulta
const selecaoEscritorio = () => ({
  id: true,
  nome: true,
  criadoEm: true,
  encerradoEm: true,
  testeAte: true,
  cortesiaAte: true,
  usosIa: true,
  ultimoUsoIaEm: true,
  assinatura: {
    select: {
      plano: true,
      status: true,
      valor: true,
      forma: true,
      pagoAte: true,
      telefone: true,
      email: true,
      pagamentos: { where: { status: 'ATRASADO' }, select: { vencimento: true } },
    },
  },
  usuarios: {
    select: { id: true, nome: true, email: true, papel: true, ultimoAcessoEm: true },
    orderBy: { criadoEm: 'asc' },
  },
  _count: {
    select: {
      clientes: true,
      projetos: true,
      eventos: true,
      lancamentos: true,
      convites: { where: { aceitoEm: null, expiraEm: { gt: new Date() } } },
    },
  },
});

// Situação do escritório para o admin
function situacaoDe(escritorio, acesso) {
  const status = escritorio.assinatura?.status;
  if (escritorio.encerradoEm) return 'ENCERRADO';
  if (!acesso.liberado) return 'SUSPENSO';
  if (acesso.motivo === 'ATIVA') return 'ATIVO';
  if (acesso.motivo === 'ATRASADA') return 'ATRASADO';
  if (acesso.motivo === 'CORTESIA') return 'CORTESIA';
  if (status === 'AGUARDANDO_PAGAMENTO') return 'AGUARDANDO';
  if (status === 'CANCELADA') return 'CANCELADO';
  return 'TESTE';
}

function resumirEscritorio(e, agora = new Date()) {
  const atrasos = e.assinatura?.pagamentos.map((p) => p.vencimento) ?? [];
  const acesso = calcularAcesso(e, e.assinatura, atrasos.length ? new Date(Math.min(...atrasos)) : null, agora);
  const plano = e.assinatura ? planoPorCodigo(e.assinatura.plano) : null;
  const administrador = e.usuarios.find((u) => u.papel === 'ADMIN') ?? e.usuarios[0] ?? null;
  const acessos = e.usuarios.map((u) => u.ultimoAcessoEm).filter(Boolean);
  const pagando = e.assinatura && ATIVAS.includes(e.assinatura.status);
  return {
    id: e.id,
    nome: e.nome,
    criadoEm: e.criadoEm,
    encerradoEm: e.encerradoEm,
    situacao: situacaoDe(e, acesso),
    testeAte: acesso.testeAte,
    diasTeste: acesso.diasTeste,
    cortesiaAte: acesso.cortesiaAte,
    suspendeEm: acesso.suspendeEm,
    plano: plano && pagando ? { codigo: plano.codigo, nome: plano.nome } : null,
    valorMensal: pagando ? Number(e.assinatura.valor) : null,
    assinaturaStatus: e.assinatura?.status ?? null,
    pessoas: e.usuarios.length + e._count.convites,
    administrador: administrador ? { id: administrador.id, nome: administrador.nome, email: administrador.email } : null,
    telefone: e.assinatura?.telefone ?? null,
    ultimoAcessoEm: acessos.length ? new Date(Math.max(...acessos)) : null,
    uso: {
      clientes: e._count.clientes,
      projetos: e._count.projetos,
      compromissos: e._count.eventos,
      lancamentos: e._count.lancamentos,
      ia: e.usosIa,
      ultimoUsoIaEm: e.ultimoUsoIaEm,
    },
  };
}

async function todosOsEscritorios() {
  const lista = await prisma.escritorio.findMany({ select: selecaoEscritorio(), orderBy: { criadoEm: 'desc' } });
  const agora = new Date();
  return lista.map((e) => resumirEscritorio(e, agora));
}

const SITUACOES = ['TESTE', 'AGUARDANDO', 'ATIVO', 'ATRASADO', 'CORTESIA', 'CANCELADO', 'SUSPENSO', 'ENCERRADO'];

// filtro: uma situação (TESTE, ATIVO...) ou vazio; busca: nome do escritório ou do/e-mail do administrador
async function listarEscritorios({ filtro, busca } = {}) {
  let lista = await todosOsEscritorios();
  if (filtro && SITUACOES.includes(filtro)) lista = lista.filter((e) => e.situacao === filtro);
  const termo = String(busca ?? '').trim().toLowerCase();
  if (termo) {
    lista = lista.filter((e) =>
      [e.nome, e.administrador?.nome, e.administrador?.email].some((t) => t?.toLowerCase().includes(termo))
    );
  }
  // em teste: quem está mais perto de acabar primeiro (é a lista de acompanhamento)
  if (filtro === 'TESTE') lista.sort((a, b) => new Date(a.testeAte) - new Date(b.testeAte));
  return lista;
}

async function resumo() {
  const lista = await todosOsEscritorios();
  const porSituacao = Object.fromEntries(SITUACOES.map((s) => [s, 0]));
  for (const e of lista) porSituacao[e.situacao] += 1;
  const agora = Date.now();
  const desde = (dias) => lista.filter((e) => agora - new Date(e.criadoEm).getTime() <= dias * DIA).length;
  const [usuarios, notasPendentes] = await Promise.all([
    prisma.usuario.count(),
    prisma.pagamentoAssinatura.count({ where: { status: 'PAGO', notaEmitidaEm: null } }),
  ]);
  return {
    // MRR: soma das mensalidades das assinaturas em dia
    mrr: lista.filter((e) => e.situacao === 'ATIVO').reduce((soma, e) => soma + (e.valorMensal || 0), 0),
    // assinaram mas ainda não pagaram a primeira (ou estão em atraso)
    aReceber: lista
      .filter((e) => e.situacao === 'AGUARDANDO' || e.situacao === 'ATRASADO')
      .reduce((soma, e) => soma + (e.valorMensal || 0), 0),
    escritorios: { total: lista.filter((e) => !e.encerradoEm).length, ...porSituacao },
    novos: { ultimos7Dias: desde(7), ultimos30Dias: desde(30) },
    usuarios,
    notasPendentes,
    testesAcabando: lista
      .filter((e) => e.situacao === 'TESTE')
      .sort((a, b) => new Date(a.testeAte) - new Date(b.testeAte))
      .slice(0, 8),
  };
}

async function detalheEscritorio(idTexto) {
  const id = parseId(idTexto);
  const e = await prisma.escritorio.findUnique({ where: { id }, select: selecaoEscritorio() });
  if (!e) throw new HttpError(404, 'Escritório não encontrado');
  const [usuarios, assinatura, acoes] = await Promise.all([
    prisma.usuario.findMany({
      where: { escritorioId: id },
      select: selecaoUsuarioAdmin,
      orderBy: { criadoEm: 'asc' },
    }),
    prisma.assinatura.findUnique({
      where: { escritorioId: id },
      select: {
        plano: true,
        status: true,
        valor: true,
        forma: true,
        tipoPessoa: true,
        nome: true,
        documento: true,
        email: true,
        telefone: true,
        cartaoFinal: true,
        cartaoBandeira: true,
        pagoAte: true,
        canceladaEm: true,
        criadoEm: true,
        pagamentos: {
          select: { id: true, valor: true, vencimento: true, status: true, forma: true, pagoEm: true, notaEmitidaEm: true },
          orderBy: { vencimento: 'desc' },
        },
      },
    }),
    prisma.acaoAdmin.findMany({
      where: { alvoTipo: 'ESCRITORIO', alvoId: id },
      include: { admin: { select: { nome: true } } },
      orderBy: { criadoEm: 'desc' },
      take: 30,
    }),
  ]);
  return {
    ...resumirEscritorio(e),
    usuarios,
    assinatura: assinatura ? { ...assinatura, valor: Number(assinatura.valor) } : null,
    acoes,
  };
}

async function estenderTeste(req) {
  const id = parseId(req.params.id);
  const dias = Number(req.body.dias);
  if (!Number.isInteger(dias) || dias < 1 || dias > 60) throw new HttpError(400, 'Informe de 1 a 60 dias');
  const e = await prisma.escritorio.findUnique({ where: { id }, select: selecaoEscritorio() });
  if (!e) throw new HttpError(404, 'Escritório não encontrado');
  const { testeAte } = resumirEscritorio(e);
  // a partir do fim atual do teste (ou de hoje, se já acabou)
  const base = Math.max(Date.now(), new Date(testeAte).getTime());
  const novo = new Date(base + dias * DIA);
  await prisma.escritorio.update({ where: { id }, data: { testeAte: novo } });
  await registrar(req, 'ESTENDER_TESTE', 'ESCRITORIO', id, { dias, testeAteAntes: testeAte, testeAte: novo });
  return detalheEscritorio(id);
}

// { dias } dá cortesia por N dias a partir de hoje; { remover: true } tira a cortesia
async function definirCortesia(req) {
  const id = parseId(req.params.id);
  let cortesiaAte = null;
  if (!req.body.remover) {
    const dias = Number(req.body.dias);
    if (!Number.isInteger(dias) || dias < 1 || dias > 365) throw new HttpError(400, 'Informe de 1 a 365 dias');
    cortesiaAte = new Date(Date.now() + dias * DIA);
  }
  const existe = await prisma.escritorio.findUnique({ where: { id }, select: { id: true } });
  if (!existe) throw new HttpError(404, 'Escritório não encontrado');
  await prisma.escritorio.update({ where: { id }, data: { cortesiaAte } });
  await registrar(req, cortesiaAte ? 'DAR_CORTESIA' : 'TIRAR_CORTESIA', 'ESCRITORIO', id, {
    dias: req.body.dias ?? null,
    cortesiaAte,
  });
  return detalheEscritorio(id);
}

// ---------- Usuários ----------

const selecaoUsuarioAdmin = {
  id: true,
  nome: true,
  email: true,
  papel: true,
  criadoEm: true,
  ultimoAcessoEm: true,
  bloqueadoEm: true,
  deveTrocarSenha: true,
  donoPlataforma: true,
  escritorio: { select: { id: true, nome: true, encerradoEm: true } },
};

async function listarUsuarios({ busca } = {}) {
  const termo = String(busca ?? '').trim();
  return prisma.usuario.findMany({
    where: termo
      ? { OR: [{ nome: { contains: termo } }, { email: { contains: termo } }, { escritorio: { nome: { contains: termo } } }] }
      : undefined,
    select: selecaoUsuarioAdmin,
    orderBy: { criadoEm: 'desc' },
    take: 500,
  });
}

async function usuarioAlvo(req) {
  const usuario = await prisma.usuario.findUnique({ where: { id: parseId(req.params.id) }, select: selecaoUsuarioAdmin });
  if (!usuario) throw new HttpError(404, 'Usuário não encontrado');
  return usuario;
}

// { nome?, email? }
async function editarUsuario(req) {
  const atual = await usuarioAlvo(req);
  const dados = {};
  if (req.body.nome !== undefined) {
    const nome = String(req.body.nome).trim();
    if (!nome) throw new HttpError(400, 'Informe o nome');
    dados.nome = nome;
  }
  if (req.body.email !== undefined) {
    const email = normalizarEmail(req.body.email);
    validarEmail(email);
    if (email !== atual.email) {
      const outro = await prisma.usuario.findUnique({ where: { email }, select: { id: true } });
      if (outro) throw new HttpError(409, 'Já existe outra conta com este e-mail');
    }
    dados.email = email;
  }
  if (!Object.keys(dados).length) throw new HttpError(400, 'Nada para alterar');
  const usuario = await prisma.usuario.update({ where: { id: atual.id }, data: dados, select: selecaoUsuarioAdmin });
  await registrar(req, 'EDITAR_USUARIO', 'USUARIO', atual.id, {
    antes: { nome: atual.nome, email: atual.email },
    depois: { nome: usuario.nome, email: usuario.email },
  });
  return usuario;
}

// Senha provisória legível (sem 0/O, 1/l): a pessoa troca no próximo login
function senhaProvisoria() {
  const letras = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(10), (b) => letras[b % letras.length]).join('');
}

async function novaSenha(req) {
  const atual = await usuarioAlvo(req);
  const senha = senhaProvisoria();
  await prisma.usuario.update({
    where: { id: atual.id },
    // encerra as sessões abertas e pede uma senha nova no próximo login
    data: { senhaHash: await bcrypt.hash(senha, SALT_ROUNDS), deveTrocarSenha: true, tokensValidosApos: agoraEmSegundos() },
  });
  await registrar(req, 'NOVA_SENHA', 'USUARIO', atual.id, null);
  return { senha };
}

// { bloquear: true|false }
async function bloquearUsuario(req) {
  const atual = await usuarioAlvo(req);
  const bloquear = req.body.bloquear === true;
  if (bloquear && (atual.id === req.usuario.id || atual.donoPlataforma)) {
    throw new HttpError(400, 'Não é possível bloquear o dono da plataforma');
  }
  const usuario = await prisma.usuario.update({
    where: { id: atual.id },
    data: bloquear ? { bloqueadoEm: new Date(), tokensValidosApos: agoraEmSegundos() } : { bloqueadoEm: null },
    select: selecaoUsuarioAdmin,
  });
  await registrar(req, bloquear ? 'BLOQUEAR_USUARIO' : 'DESBLOQUEAR_USUARIO', 'USUARIO', atual.id, null);
  return usuario;
}

// ---------- Notas fiscais (emitidas à mão) ----------

// filtro: PENDENTE (padrão) | EMITIDA | TODAS
async function listarPagamentos({ filtro = 'PENDENTE' } = {}) {
  const nota = filtro === 'EMITIDA' ? { not: null } : filtro === 'TODAS' ? undefined : null;
  const pagamentos = await prisma.pagamentoAssinatura.findMany({
    where: { status: 'PAGO', ...(nota !== undefined ? { notaEmitidaEm: nota } : {}) },
    select: {
      id: true,
      valor: true,
      vencimento: true,
      pagoEm: true,
      forma: true,
      notaEmitidaEm: true,
      assinatura: {
        select: {
          plano: true,
          tipoPessoa: true,
          nome: true,
          documento: true,
          email: true,
          telefone: true,
          cep: true,
          numero: true,
          escritorio: { select: { id: true, nome: true } },
        },
      },
    },
    orderBy: [{ pagoEm: 'desc' }, { id: 'desc' }],
    take: 300,
  });
  return pagamentos.map((p) => ({
    ...p,
    valor: Number(p.valor),
    plano: planoPorCodigo(p.assinatura.plano)?.nome ?? p.assinatura.plano,
  }));
}

// { emitida: true|false }
async function marcarNota(req) {
  const id = parseId(req.params.id);
  const pagamento = await prisma.pagamentoAssinatura.findUnique({ where: { id }, select: { id: true, status: true } });
  if (!pagamento || pagamento.status !== 'PAGO') throw new HttpError(404, 'Pagamento não encontrado');
  const emitida = req.body.emitida !== false;
  await prisma.pagamentoAssinatura.update({ where: { id }, data: { notaEmitidaEm: emitida ? new Date() : null } });
  await registrar(req, emitida ? 'NOTA_EMITIDA' : 'NOTA_DESMARCADA', 'PAGAMENTO', id, null);
  return { id, notaEmitidaEm: emitida ? new Date() : null };
}

module.exports = {
  resumo,
  listarEscritorios,
  detalheEscritorio,
  estenderTeste,
  definirCortesia,
  listarUsuarios,
  editarUsuario,
  novaSenha,
  bloquearUsuario,
  listarPagamentos,
  marcarNota,
};
