const { Router } = require('express');
const autenticar = require('../middlewares/autenticar');
const { exigirEscritorio, exigirFinanceiro } = require('../middlewares/permissoes');
const exigirAssinatura = require('../middlewares/assinatura');

const router = Router();

// Rotas públicas (algumas rotas internas delas exigem login individualmente)
router.use('/auth', require('./auth.routes'));
router.use('/convites', require('./convites.routes'));
// Avisos do gateway de pagamentos (autenticados pelo token do próprio gateway)
router.use('/webhooks', require('./webhooks.routes'));

// Daqui pra baixo, todas exigem login
router.use(autenticar);

// Funciona também para quem está sem escritório (criar, restaurar); o resto exige escritório
router.use('/escritorio', require('./escritorio.routes'));

// Daqui pra baixo, é preciso fazer parte de um escritório
router.use(exigirEscritorio);

// A assinatura fica acessível mesmo com o pagamento pendente (para poder pagar)
router.use('/assinatura', require('./assinatura.routes'));

// Daqui pra baixo, só com teste grátis ou assinatura em dia (se ASSINATURA_OBRIGATORIA=true)
router.use(exigirAssinatura);

router.use('/equipe', require('./equipe.routes'));
router.use(require('./arquivos.routes'));
router.use('/clientes', require('./clientes.routes'));
router.use('/projetos', require('./projetos.routes'));
router.use('/etapas', require('./etapas.routes'));
router.use('/eventos', require('./eventos.routes'));
router.use('/tipos-evento', require('./tiposEvento.routes'));
router.use('/lancamentos', exigirFinanceiro, require('./lancamentos.routes'));
router.use('/dashboard', require('./dashboard.routes'));
router.use('/ia', require('./ia.routes'));

module.exports = router;
