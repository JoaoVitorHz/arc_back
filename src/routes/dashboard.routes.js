const { Router } = require('express');
const prisma = require('../lib/prisma');
const { calcularResumoMes } = require('../services/financeiro.service');
const { currentMonth } = require('../utils/http');

const router = Router();

// GET /api/dashboard
router.get('/', async (req, res) => {
  const agora = new Date();
  const hojeUtc = new Date(Date.UTC(agora.getFullYear(), agora.getMonth(), agora.getDate()));
  const { escritorioId } = req;

  const [projetosAtivos, totalClientes, projetos, proximosEventos, contasVencidas, resumoMes, minhasEtapas] =
    await Promise.all([
      prisma.projeto.count({ where: { escritorioId, status: 'ATIVO' } }),
      prisma.cliente.count({ where: { escritorioId } }),
      prisma.projeto.findMany({
        where: { escritorioId, status: 'ATIVO' },
        include: {
          cliente: { select: { id: true, nome: true } },
          etapas: { select: { status: true, nome: true, ordem: true } },
        },
        orderBy: { previsaoEntrega: 'asc' },
        take: 6,
      }),
      prisma.evento.findMany({
        where: { escritorioId, inicio: { gte: agora } },
        include: {
          tipo: { select: { id: true, nome: true, cor: true } },
          cliente: { select: { id: true, nome: true } },
          projeto: { select: { id: true, nome: true } },
        },
        orderBy: { inicio: 'asc' },
        take: 5,
      }),
      prisma.lancamento.count({ where: { escritorioId, pago: false, vencimento: { lt: hojeUtc } } }),
      calcularResumoMes(currentMonth(), escritorioId),
      // Etapas sob minha responsabilidade, ainda não concluídas, em projetos ativos
      prisma.etapa.findMany({
        where: {
          responsavelId: req.usuario.id,
          status: { not: 'CONCLUIDA' },
          projeto: { escritorioId, status: 'ATIVO' },
        },
        select: {
          id: true,
          nome: true,
          status: true,
          dataPrevista: true,
          projeto: { select: { id: true, nome: true } },
        },
      }),
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
    // com data primeiro (das mais antigas/atrasadas para as mais distantes), sem data no fim
    minhasEtapas: minhasEtapas.sort(
      (a, b) => (a.dataPrevista?.getTime() ?? Infinity) - (b.dataPrevista?.getTime() ?? Infinity)
    ),
  });
});

module.exports = router;
