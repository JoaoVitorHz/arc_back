// Dados de exemplo para desenvolvimento: npm run db:seed
// Cria (ou recria do zero) a conta demo. Outras contas não são alteradas.
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const { ETAPAS_PADRAO } = require('../src/constants/etapas');

const prisma = new PrismaClient();

const DEMO = { email: 'demo@arcgestao.com', senha: 'demo12345' };

function diasAPartirDeHoje(dias, hora) {
  const data = new Date();
  data.setDate(data.getDate() + dias);
  if (hora !== undefined) data.setHours(hora, 0, 0, 0);
  return data;
}

function dataUtc(dias) {
  const d = diasAPartirDeHoje(dias);
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

// Apaga os escritórios informados e tudo que pertence a eles (na ordem das chaves estrangeiras)
async function apagarEscritorios(ids) {
  if (!ids.length) return;
  const where = { escritorioId: { in: ids } };
  await prisma.lancamento.deleteMany({ where });
  await prisma.evento.deleteMany({ where });
  await prisma.projeto.deleteMany({ where }); // etapas vão junto (cascade)
  await prisma.cliente.deleteMany({ where });
  await prisma.usuario.deleteMany({ where });
  await prisma.escritorio.deleteMany({ where: { id: { in: ids } } });
}

let escritorioId;

async function criarProjeto({ etapasConcluidas, ...dados }) {
  return prisma.projeto.create({
    data: {
      ...dados,
      escritorioId,
      etapas: {
        create: ETAPAS_PADRAO.map((nome, i) => ({
          nome,
          ordem: i + 1,
          status:
            i < etapasConcluidas ? 'CONCLUIDA' : i === etapasConcluidas ? 'EM_ANDAMENTO' : 'NAO_INICIADA',
        })),
      },
    },
  });
}

async function main() {
  // Remove a conta demo anterior e escritórios sem nenhum usuário (ex.: dados de antes do login)
  const antigos = await prisma.escritorio.findMany({
    where: { OR: [{ usuarios: { some: { email: DEMO.email } } }, { usuarios: { none: {} } }] },
    select: { id: true },
  });
  await apagarEscritorios(antigos.map((e) => e.id));

  const escritorio = await prisma.escritorio.create({
    data: {
      nome: 'Studio Demo Arquitetura',
      usuarios: {
        create: { nome: 'Usuário Demo', email: DEMO.email, senhaHash: await bcrypt.hash(DEMO.senha, 10) },
      },
    },
  });
  escritorioId = escritorio.id;

  const ana = await prisma.cliente.create({
    data: { escritorioId, nome: 'Ana Souza', email: 'ana@exemplo.com', telefone: '(11) 99999-1111', documento: '123.456.789-00' },
  });
  const carlos = await prisma.cliente.create({
    data: { escritorioId, nome: 'Carlos Lima', email: 'carlos@exemplo.com', telefone: '(11) 98888-2222' },
  });
  const cafe = await prisma.cliente.create({
    data: { escritorioId, nome: 'Café Aroma Ltda', email: 'contato@cafearoma.com', documento: '12.345.678/0001-90' },
  });

  const casa = await criarProjeto({
    nome: 'Casa Jardim Europa',
    tipo: 'RESIDENCIAL',
    enderecoObra: 'Rua das Flores, 120',
    valorContrato: 48000,
    dataInicio: dataUtc(-60),
    previsaoEntrega: dataUtc(90),
    clienteId: ana.id,
    etapasConcluidas: 2,
  });
  const apto = await criarProjeto({
    nome: 'Apartamento Moema - Interiores',
    tipo: 'INTERIORES',
    valorContrato: 22000,
    dataInicio: dataUtc(-20),
    previsaoEntrega: dataUtc(45),
    clienteId: carlos.id,
    etapasConcluidas: 1,
  });
  const loja = await criarProjeto({
    nome: 'Cafeteria Centro',
    tipo: 'COMERCIAL',
    valorContrato: 35000,
    dataInicio: dataUtc(-100),
    previsaoEntrega: dataUtc(15),
    clienteId: cafe.id,
    etapasConcluidas: 4,
  });

  await prisma.evento.createMany({
    data: [
      { escritorioId, titulo: 'Apresentação do anteprojeto', tipo: 'REUNIAO', inicio: diasAPartirDeHoje(1, 10), clienteId: ana.id, projetoId: casa.id },
      { escritorioId, titulo: 'Levantamento de medidas', tipo: 'VISITA_TECNICA', inicio: diasAPartirDeHoje(2, 14), local: 'Av. Ibirapuera, 500', clienteId: carlos.id, projetoId: apto.id },
      { escritorioId, titulo: 'Visita de obra', tipo: 'VISITA_OBRA', inicio: diasAPartirDeHoje(4, 9), clienteId: cafe.id, projetoId: loja.id },
      { escritorioId, titulo: 'Entrega do executivo', tipo: 'ENTREGA', inicio: diasAPartirDeHoje(7, 17), clienteId: cafe.id, projetoId: loja.id },
    ],
  });

  await prisma.lancamento.createMany({
    data: [
      { escritorioId, descricao: 'Casa Jardim Europa - parcela 2/4', tipo: 'RECEITA', valor: 12000, vencimento: dataUtc(-3), pago: true, dataPagamento: dataUtc(-3), projetoId: casa.id },
      { escritorioId, descricao: 'Casa Jardim Europa - parcela 3/4', tipo: 'RECEITA', valor: 12000, vencimento: dataUtc(10), projetoId: casa.id },
      { escritorioId, descricao: 'Apto Moema - entrada', tipo: 'RECEITA', valor: 6600, vencimento: dataUtc(-5), projetoId: apto.id },
      { escritorioId, descricao: 'Cafeteria - parcela final', tipo: 'RECEITA', valor: 8750, vencimento: dataUtc(15), projetoId: loja.id },
      { escritorioId, descricao: 'Aluguel do escritório', tipo: 'DESPESA', valor: 3500, vencimento: dataUtc(-2), pago: true, dataPagamento: dataUtc(-2), categoria: 'Fixo' },
      { escritorioId, descricao: 'Licença de software (BIM)', tipo: 'DESPESA', valor: 890, vencimento: dataUtc(5), categoria: 'Software' },
      { escritorioId, descricao: 'Plotagem de pranchas', tipo: 'DESPESA', valor: 240, vencimento: dataUtc(1), categoria: 'Projeto', projetoId: casa.id },
    ],
  });

  console.log('Seed concluído: 3 clientes, 3 projetos, 4 eventos, 7 lançamentos.');
  console.log(`Login demo: ${DEMO.email} / ${DEMO.senha}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
