const { Router } = require('express');
const admin = require('../services/admin.service');

// Painel admin: só o dono da plataforma (o middleware exigirDonoPlataforma fica no index.js).
// Tudo o que altera algo fica registrado em acoes_admin.
const router = Router();

// GET /api/admin/resumo -> { mrr, aReceber, escritorios: { total, TESTE, ATIVO... }, novos, usuarios, notasPendentes, testesAcabando }
router.get('/resumo', async (req, res) => {
  res.json(await admin.resumo());
});

// GET /api/admin/escritorios?filtro=TESTE|AGUARDANDO|ATIVO|ATRASADO|CORTESIA|CANCELADO|SUSPENSO|ENCERRADO&busca=
router.get('/escritorios', async (req, res) => {
  res.json(await admin.listarEscritorios({ filtro: req.query.filtro, busca: req.query.busca }));
});

// GET /api/admin/escritorios/:id  (equipe, assinatura, pagamentos e ações do admin)
router.get('/escritorios/:id', async (req, res) => {
  res.json(await admin.detalheEscritorio(req.params.id));
});

// POST /api/admin/escritorios/:id/estender-teste  { dias }
router.post('/escritorios/:id/estender-teste', async (req, res) => {
  res.json(await admin.estenderTeste(req));
});

// POST /api/admin/escritorios/:id/cortesia  { dias } | { remover: true }
router.post('/escritorios/:id/cortesia', async (req, res) => {
  res.json(await admin.definirCortesia(req));
});

// GET /api/admin/usuarios?busca=
router.get('/usuarios', async (req, res) => {
  res.json(await admin.listarUsuarios({ busca: req.query.busca }));
});

// PATCH /api/admin/usuarios/:id  { nome?, email? }
router.patch('/usuarios/:id', async (req, res) => {
  res.json(await admin.editarUsuario(req));
});

// POST /api/admin/usuarios/:id/nova-senha -> { senha } (provisória: a pessoa troca no próximo login)
router.post('/usuarios/:id/nova-senha', async (req, res) => {
  res.json(await admin.novaSenha(req));
});

// POST /api/admin/usuarios/:id/bloqueio  { bloquear: true|false }
router.post('/usuarios/:id/bloqueio', async (req, res) => {
  res.json(await admin.bloquearUsuario(req));
});

// GET /api/admin/pagamentos?filtro=PENDENTE|EMITIDA|TODAS  (pagamentos recebidos, para emitir as notas)
router.get('/pagamentos', async (req, res) => {
  res.json(await admin.listarPagamentos({ filtro: req.query.filtro }));
});

// PATCH /api/admin/pagamentos/:id/nota  { emitida: true|false }
router.patch('/pagamentos/:id/nota', async (req, res) => {
  res.json(await admin.marcarNota(req));
});

module.exports = router;
