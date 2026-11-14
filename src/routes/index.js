const { Router } = require('express');

const router = Router();

router.use('/clientes', require('./clientes.routes'));
router.use('/projetos', require('./projetos.routes'));
router.use('/etapas', require('./etapas.routes'));
router.use('/eventos', require('./eventos.routes'));
router.use('/lancamentos', require('./lancamentos.routes'));
router.use('/dashboard', require('./dashboard.routes'));

module.exports = router;
