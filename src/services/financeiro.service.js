const prisma = require('../lib/prisma');
const { monthRange } = require('../utils/http');

// Totais do mês do escritório, agrupados por tipo (receita/despesa) e situação (pago/pendente)
async function calcularResumoMes(mes, escritorioId) {
  const grupos = await prisma.lancamento.groupBy({
    by: ['tipo', 'pago'],
    where: { escritorioId, vencimento: monthRange(mes) },
    _sum: { valor: true },
  });

  const soma = (tipo, pago) =>
    grupos
      .filter((g) => g.tipo === tipo && (pago === undefined || g.pago === pago))
      .reduce((total, g) => total + Number(g._sum.valor || 0), 0);

  const receitas = soma('RECEITA');
  const despesas = soma('DESPESA');
  const recebido = soma('RECEITA', true);
  const pago = soma('DESPESA', true);

  return {
    mes,
    receitas,
    recebido,
    aReceber: receitas - recebido,
    despesas,
    pago,
    aPagar: despesas - pago,
    saldoPrevisto: receitas - despesas,
    saldoRealizado: recebido - pago,
  };
}

// Total de despesas por categoria: as 5 maiores e o resto somado em "Outras"
function despesasPorCategoria(lancamentos) {
  const totais = new Map();
  for (const l of lancamentos) {
    if (l.tipo !== 'DESPESA') continue;
    const nome = l.categoria?.trim() || 'Sem categoria';
    totais.set(nome, (totais.get(nome) || 0) + Number(l.valor));
  }
  const ordenadas = [...totais]
    .map(([categoria, total]) => ({ categoria, total }))
    .sort((a, b) => b.total - a.total);
  if (ordenadas.length <= 6) return ordenadas;
  const outras = ordenadas.slice(5).reduce((t, c) => t + c.total, 0);
  return [...ordenadas.slice(0, 5), { categoria: 'Outras', total: outras }];
}

module.exports = { calcularResumoMes, despesasPorCategoria };
