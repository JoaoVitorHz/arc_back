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

module.exports = { calcularResumoMes };
