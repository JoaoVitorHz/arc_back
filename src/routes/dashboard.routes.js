const { Router } = require('express');
const prisma = require('../lib/prisma');
const { calcularResumoMes } = require('../services/financeiro.service');
const { currentMonth } = require('../utils/http');

const router = Router();

// GET /api/dashboard
router.get('/', async (req, res) => {
  const agora = new Date();
  const hojeUtc = new Date(Date.UTC(agora.getFullYear(), agora.getMonth(), agora.getDate()));

  const [projetosAtivos, totalClientes, projetos, proximosEventos, contasVencidas, resumoMes] =
    await Promise.all([
      prisma.projeto.count({ where: { status: 'ATIVO' } }),
      prisma.cliente.count(),
      prisma.projeto.findMany({
        where: { status: 'ATIVO' },
        include: {
          cliente: { select: { id: true, nome: true } },
          etapas: { select: { status: true, nome: true, ordem: true } },
        },
        orderBy: { previsaoEntrega: 'asc' },
        take: 6,
      }),
      prisma.evento.findMany({
        where: { inicio: { gte: agora } },
        include: {
          cliente: { select: { id: true, nome: true } },
          projeto: { select: { id: true, nome: true } },
        },
        orderBy: { inicio: 'asc' },
        take: 5,
      }),
      prisma.lancamento.count({ where: { pago: false, vencimento: { lt: hojeUtc } } }),
      calcularResumoMes(currentMonth()),
    ]);

  const projetosResumo = projetos.map(({ etapas, ...projeto }) => {
    const ordenadas = [...etapas].sort((a, b) => a.ordem - b.ordem);
    const concluidas = ordenadas.filter((e) => e.status === 'CONCLUIDA').length;
    const etapaAtual = ordenadas.find((e) => e.status !== 'CONCLUIDA');
    return {
      ...projeto,
      progresso: ordenadas.length ? Math.round((concluidas / ordenadas.length) * 100) : 0,
      etapaAtual: etapaAtual?.nome || 'Concluído',
    };
  });

  res.json({
    projetosAtivos,
    totalClientes,
    contasVencidas,
    resumoMes,
    projetos: projetosResumo,
    proximosEventos,
  });
});

module.exports = router;
