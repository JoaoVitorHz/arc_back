const crypto = require('crypto');
const fsp = require('fs').promises;
const path = require('path');
const { Router } = require('express');
const multer = require('multer');
const prisma = require('../lib/prisma');
const armazenamento = require('../lib/armazenamento');
const { garantirDoEscritorio } = require('../utils/escopo');
const { revisaoParaNovoArquivo, revisaoFoiEnviada } = require('../services/revisoes.service');
const { HttpError, parseId, requireFields, toOptionalInt } = require('../utils/http');

const router = Router();

const TAMANHO_MAXIMO_MB = 50;
const MAX_ARQUIVOS_POR_ENVIO = 10;
const TAMANHO_MAXIMO_NOME = 191; // limite da coluna no banco

// Executáveis e scripts não são aceitos
const EXTENSOES_BLOQUEADAS = new Set([
  '.exe', '.msi', '.bat', '.cmd', '.com', '.scr', '.ps1', '.vbs', '.js', '.jar', '.sh', '.dll', '.app',
]);
// Tipos que o navegador pode mostrar sem baixar (HTML/SVG ficam de fora: poderiam rodar scripts)
const VISUALIZAVEIS = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf']);

const selecaoArquivo = {
  id: true,
  tipo: true,
  nome: true,
  mimeType: true,
  tamanho: true,
  url: true,
  criadoEm: true,
  etapaId: true,
  revisaoNumero: true,
  enviadoPorId: true,
  enviadoPor: { select: { id: true, nome: true } },
};

const upload = multer({
  dest: armazenamento.PASTA_TEMPORARIA,
  defParamCharset: 'utf8', // nomes com acento ("Prancha térreo.pdf")
  limits: { fileSize: TAMANHO_MAXIMO_MB * 1024 * 1024, files: MAX_ARQUIVOS_POR_ENVIO },
  fileFilter(req, arquivo, aceitar) {
    const extensao = path.extname(arquivo.originalname).toLowerCase();
    if (EXTENSOES_BLOQUEADAS.has(extensao)) {
      return aceitar(new HttpError(400, `Arquivos ${extensao} não são permitidos`));
    }
    aceitar(null, true);
  },
});

// Mantém a extensão ao encurtar nomes muito longos
function limitarNome(nome) {
  const limpo = String(nome).trim() || 'arquivo';
  if (limpo.length <= TAMANHO_MAXIMO_NOME) return limpo;
  const extensao = path.extname(limpo).slice(0, 20);
  return limpo.slice(0, TAMANHO_MAXIMO_NOME - extensao.length) + extensao;
}

// A etapa precisa ser do mesmo projeto. Vazio = pasta "Geral do projeto".
async function etapaDoProjeto(valor, projetoId) {
  const etapaId = toOptionalInt(valor);
  if (etapaId === null) return null;
  const existe = await prisma.etapa.count({ where: { id: etapaId, projetoId } });
  if (!existe) throw new HttpError(400, 'Etapa não encontrada neste projeto');
  return etapaId;
}

async function projetoDoEscritorio(req) {
  const projetoId = parseId(req.params.id);
  await garantirDoEscritorio('projeto', projetoId, req.escritorioId);
  return projetoId;
}

async function arquivoDoEscritorio(req) {
  const arquivo = await prisma.arquivo.findFirst({
    where: { id: parseId(req.params.id), escritorioId: req.escritorioId },
  });
  if (!arquivo) throw new HttpError(404, 'Arquivo não encontrado');
  return arquivo;
}

// "Prancha térreo.pdf" no cabeçalho do download (RFC 5987, com nome ASCII de reserva)
function contentDisposition(tipo, nome) {
  const ascii = nome.normalize('NFD').replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '') || 'arquivo';
  return `${tipo}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(nome)}`;
}

// GET /api/projetos/:id/arquivos  (todos os arquivos e links do projeto)
router.get('/projetos/:id/arquivos', async (req, res) => {
  const projetoId = await projetoDoEscritorio(req);
  const arquivos = await prisma.arquivo.findMany({
    where: { projetoId, escritorioId: req.escritorioId },
    select: selecaoArquivo,
    orderBy: { criadoEm: 'desc' },
  });
  res.json(arquivos);
});

// POST /api/projetos/:id/arquivos  (multipart: "arquivos" + "etapaId" opcional)
router.post(
  '/projetos/:id/arquivos',
  // confere o projeto ANTES de receber os arquivos (não ocupa disco com envio de quem não pode)
  async (req, res, next) => {
    req.projetoId = await projetoDoEscritorio(req);
    next();
  },
  upload.array('arquivos', MAX_ARQUIVOS_POR_ENVIO),
  async (req, res) => {
    const enviados = req.files || [];
    try {
      if (!enviados.length) throw new HttpError(400, 'Selecione ao menos um arquivo');
      const etapaId = await etapaDoProjeto(req.body.etapaId, req.projetoId);
      const revisao = etapaId ? await revisaoParaNovoArquivo(etapaId) : null;

      const criados = [];
      for (const enviado of enviados) {
        const extensao = path.extname(enviado.originalname).toLowerCase().slice(0, 20);
        const chave = `${req.escritorioId}/${req.projetoId}/${crypto.randomUUID()}${extensao}`;
        await armazenamento.guardar(enviado.path, chave);
        enviado.guardado = true;
        try {
          criados.push(
            await prisma.arquivo.create({
              data: {
                tipo: 'ARQUIVO',
                nome: limitarNome(enviado.originalname),
                mimeType: enviado.mimetype,
                tamanho: enviado.size,
                chave,
                escritorioId: req.escritorioId,
                projetoId: req.projetoId,
                etapaId,
                revisaoNumero: revisao?.numero ?? 0,
                enviadoPorId: req.usuario.id,
              },
              select: selecaoArquivo,
            })
          );
        } catch (erro) {
          await armazenamento.apagar([chave]); // não deixa arquivo sem registro
          throw erro;
        }
      }
      res.status(201).json({ arquivos: criados, revisao });
    } finally {
      // temporários que não chegaram a ser guardados (erro no meio do caminho)
      await Promise.all(enviados.filter((a) => !a.guardado).map((a) => fsp.rm(a.path, { force: true })));
    }
  }
);

// POST /api/projetos/:id/links  { nome, url, etapaId? }  (Drive, Dropbox, WeTransfer...)
router.post('/projetos/:id/links', async (req, res) => {
  const projetoId = await projetoDoEscritorio(req);
  requireFields(req.body, ['url']);

  let url;
  try {
    url = new URL(String(req.body.url).trim());
  } catch {
    throw new HttpError(400, 'Link inválido');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new HttpError(400, 'O link precisa começar com http:// ou https://');

  const etapaId = await etapaDoProjeto(req.body.etapaId, projetoId);
  const revisao = etapaId ? await revisaoParaNovoArquivo(etapaId) : null;

  const arquivo = await prisma.arquivo.create({
    data: {
      tipo: 'LINK',
      nome: limitarNome(req.body.nome || url.hostname),
      url: url.toString(),
      escritorioId: req.escritorioId,
      projetoId,
      etapaId,
      revisaoNumero: revisao?.numero ?? 0,
      enviadoPorId: req.usuario.id,
    },
    select: selecaoArquivo,
  });
  res.status(201).json({ arquivo, revisao });
});

// GET /api/arquivos/:id/conteudo?visualizar=1  (baixa; com visualizar=1, imagens/PDF abrem no navegador)
router.get('/arquivos/:id/conteudo', async (req, res) => {
  const arquivo = await arquivoDoEscritorio(req);
  if (arquivo.tipo !== 'ARQUIVO') throw new HttpError(400, 'Este item é um link, não um arquivo');

  const inline = req.query.visualizar === '1' && VISUALIZAVEIS.has(arquivo.mimeType);
  const leitura = armazenamento.abrirLeitura(arquivo.chave);
  leitura.on('error', () => {
    if (!res.headersSent) res.status(404).json({ erro: 'Arquivo não encontrado no armazenamento' });
    else res.destroy();
  });
  leitura.once('open', () => {
    res.setHeader('Content-Type', inline ? arquivo.mimeType : 'application/octet-stream');
    res.setHeader('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', arquivo.nome));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (arquivo.tamanho) res.setHeader('Content-Length', arquivo.tamanho);
    leitura.pipe(res);
  });
});

// PATCH /api/arquivos/:id  { etapaId?, nome? }  (mover de etapa / renomear)
router.patch('/arquivos/:id', async (req, res) => {
  const arquivo = await arquivoDoEscritorio(req);
  const data = {};
  if (req.body.etapaId !== undefined) {
    const destino = await etapaDoProjeto(req.body.etapaId, arquivo.projetoId);
    if (destino !== arquivo.etapaId) {
      if (await revisaoFoiEnviada(arquivo.etapaId, arquivo.revisaoNumero)) {
        throw new HttpError(409, 'Este arquivo faz parte de uma revisão já enviada ao cliente e não pode ser movido');
      }
      data.etapaId = destino;
      data.revisaoNumero = destino ? (await revisaoParaNovoArquivo(destino)).numero : 0;
    }
  }
  if (req.body.nome !== undefined) {
    if (!String(req.body.nome).trim()) throw new HttpError(400, 'O nome não pode ficar vazio');
    data.nome = limitarNome(req.body.nome);
  }

  const atualizado = await prisma.arquivo.update({ where: { id: arquivo.id }, data, select: selecaoArquivo });
  res.json(atualizado);
});

// DELETE /api/arquivos/:id  (quem enviou ou um administrador)
router.delete('/arquivos/:id', async (req, res) => {
  const arquivo = await arquivoDoEscritorio(req);
  if (arquivo.enviadoPorId !== req.usuario.id && req.usuario.papel !== 'ADMIN') {
    throw new HttpError(403, 'Só quem enviou o arquivo ou um administrador pode apagá-lo');
  }
  if (req.usuario.papel !== 'ADMIN' && (await revisaoFoiEnviada(arquivo.etapaId, arquivo.revisaoNumero))) {
    throw new HttpError(403, 'Este arquivo faz parte de uma revisão já enviada ao cliente: só um administrador pode apagá-lo');
  }

  await prisma.arquivo.delete({ where: { id: arquivo.id } });
  await armazenamento.apagar([arquivo.chave]);
  res.status(204).end();
});

module.exports = router;
