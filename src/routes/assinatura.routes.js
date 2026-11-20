const { Router } = require('express');
const { exigirAdmin } = require('../middlewares/permissoes');
const { situacao, assinar, cobrancaEmAberto, cancelar } = require('../services/assinatura.service');

const router = Router();

// GET /api/assinatura?sincronizar=1
// -> { plano, cobrancaConfigurada, acesso, primeiroVencimento, assinatura, pagamentos }
// sincronizar=1 confere os pagamentos no gateway antes de responder (tela de planos)
router.get('/', async (req, res) => {
  res.json(
    await situacao(req.escritorioId, {
      admin: req.usuario.papel === 'ADMIN',
      sincronizarAgora: req.query.sincronizar === '1',
    })
  );
});

// POST /api/assinatura
// { tipoPessoa: 'PJ'|'PF', nome, documento, email, telefone?, cep, numero, forma: 'PIX'|'BOLETO'|'CARTAO',
//   cartao?: { numero, nome, validade: 'MM/AA', cvv } }
// O cartão vai direto para o gateway: não é salvo nem registrado em log
router.post('/', exigirAdmin, async (req, res) => {
  res.status(201).json(await assinar(req));
});

// GET /api/assinatura/cobranca -> { pagamento, pix?: { imagem, copiaECola, expiraEm }, linhaDigitavel? }
router.get('/cobranca', exigirAdmin, async (req, res) => {
  res.json(await cobrancaEmAberto(req.escritorioId));
});

// POST /api/assinatura/cancelar  (o acesso continua até o fim do período pago)
router.post('/cancelar', exigirAdmin, async (req, res) => {
  res.json(await cancelar(req.escritorioId));
});

module.exports = router;
