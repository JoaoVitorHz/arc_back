const { Router } = require('express');
const { iaConfigurada, falar, limiteIa, limiteVoz } = require('../lib/ia');
const { exigirFinanceiro } = require('../middlewares/permissoes');
const { responder } = require('../services/assistente.service');
const { gerarProposta, gerarRelatorio } = require('../services/documentosIa.service');
const { HttpError, parseId } = require('../utils/http');

const router = Router();

// GET /api/ia  -> { ativa } (o front só mostra os recursos de IA quando há chave configurada)
router.get('/', (req, res) => {
  res.json({ ativa: iaConfigurada() });
});

// POST /api/ia/voz  { texto }  -> audio/mpeg (a voz de um trecho da resposta do assistente)
router.post('/voz', limiteVoz, async (req, res) => {
  const texto = String(req.body.texto || '').trim();
  if (!texto) throw new HttpError(400, 'Envie o texto');
  if (texto.length > 1200) throw new HttpError(400, 'Trecho longo demais para a voz (máximo 1.200 caracteres)');
  const audio = await falar(texto);
  res.set('Cache-Control', 'no-store').type('audio/mpeg').send(audio);
});

router.use(limiteIa);

// POST /api/ia/assistente  { mensagens: [{ role: 'user'|'assistant', content }], fuso }
// -> { resposta, acoes: [{ id, titulo, linhas: [[rótulo, valor]], requisicao: { metodo, rota, corpo, datasLocais? } }] }
router.post('/assistente', async (req, res) => {
  res.json(await responder({ req, mensagens: req.body.mensagens, fuso: req.body.fuso }));
});

// POST /api/ia/proposta  { descricao, tipo, clienteId? }  (usa valores de contrato: só quem vê o financeiro)
router.post('/proposta', exigirFinanceiro, async (req, res) => {
  res.json(await gerarProposta({ req, body: req.body }));
});

// POST /api/ia/relatorio/:projetoId  { observacoes?, fuso? }  -> { assunto, mensagem }
router.post('/relatorio/:projetoId', async (req, res) => {
  res.json(await gerarRelatorio({ req, projetoId: parseId(req.params.projetoId), observacoes: req.body.observacoes }));
});

module.exports = router;
