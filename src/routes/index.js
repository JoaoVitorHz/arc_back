const { Router } = require('express');
const autenticar = require('../middlewares/autenticar');

const router = Router();

// Rotas públicas
router.use('/auth', require('./auth.routes'));

// Daqui pra baixo, todas exigem login
router.use(autenticar);

router.use('/clientes', require('./clientes.routes'));
router.use('/projetos', require('./projetos.routes'));
router.use('/etapas', require('./etapas.routes'));
router.use('/eventos', require('./eventos.routes'));
router.use('/tipos-evento', require('./tiposEvento.routes'));
router.use('/lancamentos', require('./lancamentos.routes'));
router.use('/dashboard', require('./dashboard.routes'));

module.exports = router;
