const { Router } = require('express');
const autenticar = require('../middlewares/autenticar');
const { exigirEscritorio } = require('../middlewares/permissoes');

const router = Router();

// Rotas públicas (algumas rotas internas delas exigem login individualmente)
router.use('/auth', require('./auth.routes'));
router.use('/convites', require('./convites.routes'));

// Daqui pra baixo, todas exigem login
router.use(autenticar);

// Funciona também para quem está sem escritório (criar, restaurar); o resto exige escritório
router.use('/escritorio', require('./escritorio.routes'));

// Daqui pra baixo, é preciso fazer parte de um escritório
router.use(exigirEscritorio);

router.use('/equipe', require('./equipe.routes'));
router.use('/clientes', require('./clientes.routes'));
router.use('/projetos', require('./projetos.routes'));
router.use('/etapas', require('./etapas.routes'));
router.use('/eventos', require('./eventos.routes'));
router.use('/tipos-evento', require('./tiposEvento.routes'));
router.use('/lancamentos', require('./lancamentos.routes'));
router.use('/dashboard', require('./dashboard.routes'));

module.exports = router;
