const { Router } = require('express');
const gateway = require('../lib/pagamentos');
const { processarAviso } = require('../services/assinatura.service');

const router = Router();

// POST /api/webhooks/asaas  (chamado pelo Asaas, sem login: autenticado pelo token do cabeçalho)
// Configure no painel do Asaas (Integrações > Webhooks) a URL pública desta rota e o mesmo
// token do ASAAS_WEBHOOK_TOKEN. O Asaas só considera entregue com status 200; qualquer erro
// aqui faz ele tentar de novo.
router.post('/asaas', async (req, res) => {
  if (!gateway.webhookAutentico(req)) {
    return res.status(401).json({ erro: 'Token inválido' });
  }
  const resultado = await processarAviso(req.body);
  res.json({ ok: true, resultado });
});

module.exports = router;
