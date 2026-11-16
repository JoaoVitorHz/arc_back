const { Readable } = require('stream');
const { Router } = require('express');
const multer = require('multer');
const prisma = require('../lib/prisma');
const { iaConfigurada, falar, transcrever, limiteIa, limiteVoz } = require('../lib/ia');
const { responder, validarHistorico } = require('../services/assistente.service');
const { gerarRelatorio } = require('../services/documentosIa.service');
const { analisarBriefing } = require('../services/briefingIa.service');
const { HttpError, parseId } = require('../utils/http');

const router = Router();

// GET /api/ia  -> { ativa } (o front só mostra os recursos de IA quando há chave configurada)
router.get('/', (req, res) => {
  res.json({ ativa: iaConfigurada() });
});

// POST /api/ia/voz  { texto }  -> audio/mpeg em fluxo (a voz de um trecho da resposta do assistente)
router.post('/voz', limiteVoz, async (req, res) => {
  const texto = String(req.body.texto || '').trim();
  if (!texto) throw new HttpError(400, 'Envie o texto');
  if (texto.length > 1200) throw new HttpError(400, 'Trecho longo demais para a voz (máximo 1.200 caracteres)');
  const audio = await falar(texto);
  res.set('Cache-Control', 'no-store').type('audio/mpeg');
  // repassa o áudio enquanto ele é gerado; se a pessoa parar a voz (fecha a conexão), para de gerar
  const fluxo = Readable.fromWeb(audio);
  res.on('close', () => fluxo.destroy());
  fluxo.on('error', () => res.destroy());
  fluxo.pipe(res);
});

// Áudio gravado no navegador (webm/ogg/mp4), guardado só na memória e descartado depois
const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter(req, arquivo, aceitar) {
    if (!arquivo.mimetype.startsWith('audio/') && arquivo.mimetype !== 'video/webm') {
      return aceitar(new HttpError(400, 'Envie um arquivo de áudio'));
    }
    aceitar(null, true);
  },
});

const EXTENSOES_AUDIO = { 'audio/webm': 'webm', 'video/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'mp4', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' };

// POST /api/ia/transcrever  (multipart, campo "audio")  -> { texto }
router.post('/transcrever', limiteVoz, uploadAudio.single('audio'), async (req, res) => {
  if (!req.file?.size) throw new HttpError(400, 'Envie o áudio no campo "audio"');
  const tipo = req.file.mimetype.split(';')[0];

  // nomes do escritório (clientes e projetos ativos) para a transcrição acertar a grafia
  const [clientes, projetos] = await Promise.all([
    prisma.cliente.findMany({ where: { escritorioId: req.escritorioId }, select: { nome: true }, orderBy: { atualizadoEm: 'desc' }, take: 40 }),
    prisma.projeto.findMany({ where: { escritorioId: req.escritorioId, status: 'ATIVO' }, select: { nome: true }, take: 40 }),
  ]);
  const nomes = [...clientes, ...projetos].map((n) => n.nome);
  const dica = nomes.length ? `Conversa de um escritório de arquitetura. Nomes citados: ${nomes.join(', ')}.` : null;

  const texto = await transcrever({
    audio: req.file.buffer,
    nomeArquivo: `fala.${EXTENSOES_AUDIO[tipo] || 'webm'}`,
    tipo,
    dica,
  });
  res.json({ texto });
});

router.use(limiteIa);

// POST /api/ia/assistente  { mensagens: [{ role: 'user'|'assistant', content }], fuso, voz? }
//    voz: true quando a resposta vai ser falada -> vem também "fala" (texto natural para a voz, sem markdown)
// -> { resposta, acoes: [{ id, titulo, linhas: [[rótulo, valor]], requisicao: { metodo, rota, corpo, datasLocais? } }] }
//    (ação com tipo "revisao": traz "revisao" = pacote do Novo projeto com IA, para abrir a tela de revisão)
router.post('/assistente', async (req, res) => {
  res.json(await responder({ req, mensagens: req.body.mensagens, fuso: req.body.fuso, voz: req.body.voz === true }));
});

// POST /api/ia/assistente/fluxo  (mesmo corpo) -> text/event-stream, a resposta chegando aos pedaços:
//   event: fala      { texto }  pedaço do texto para a voz (só com voz: true; vem antes do texto da tela)
//   event: texto     { texto }  pedaço do texto da tela
//   event: descartar {}         o texto da tela até aqui era provisório (a IA foi consultar o sistema)
//   event: fim       { resposta, fala?, acoes }  resposta completa (vale esta, não a soma dos pedaços)
//   event: erro      { erro }
router.post('/assistente/fluxo', async (req, res) => {
  validarHistorico(req.body.mensagens); // erro de formato ainda sai como 400 normal
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no', // proxies (nginx) não seguram os pedaços
  });
  const emitir = (evento, dados) => {
    if (!res.writableEnded) res.write(`event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`);
  };
  try {
    const final = await responder({ req, mensagens: req.body.mensagens, fuso: req.body.fuso, voz: req.body.voz === true, emitir });
    emitir('fim', final);
  } catch (error) {
    if (!(error instanceof HttpError)) console.error('[ia] assistente em fluxo:', error);
    emitir('erro', { erro: error instanceof HttpError ? error.message : 'A IA não respondeu agora. Tente de novo em instantes.' });
  }
  res.end();
});

// POST /api/ia/briefing  { briefing, tipo?, clienteId? }
// -> { pacote, clienteExistente, baseadoEm }: tudo para o "Novo projeto com IA" revisar (nada é criado aqui).
// Quem não vê o financeiro recebe o pacote sem valores e sem parcelas.
router.post('/briefing', async (req, res) => {
  res.json(await analisarBriefing({ req, body: req.body }));
});

// POST /api/ia/relatorio/:projetoId  { observacoes?, fuso? }  -> { assunto, mensagem }
router.post('/relatorio/:projetoId', async (req, res) => {
  res.json(await gerarRelatorio({ req, projetoId: parseId(req.params.projetoId), observacoes: req.body.observacoes }));
});

module.exports = router;
