const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// Onde os arquivos enviados ficam guardados. Hoje: pasta no disco do servidor (UPLOAD_DIR).
// Para usar Cloudflare R2 / Amazon S3 no futuro, basta reimplementar as três funções
// abaixo (guardar, abrirLeitura, apagar) com o SDK do serviço; as rotas não mudam.

const PASTA = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads'));
// Uploads chegam primeiro aqui (mesmo disco, para mover sem copiar)
const PASTA_TEMPORARIA = path.join(PASTA, '.tmp');

fs.mkdirSync(PASTA_TEMPORARIA, { recursive: true });

// Caminho real de uma chave, sem deixar sair da pasta de uploads (ex.: "../../.env")
function caminho(chave) {
  const destino = path.resolve(PASTA, chave);
  if (!destino.startsWith(PASTA + path.sep)) throw new Error(`Chave de arquivo inválida: ${chave}`);
  return destino;
}

// Move o arquivo temporário do upload para o lugar definitivo
async function guardar(caminhoTemporario, chave) {
  const destino = caminho(chave);
  await fsp.mkdir(path.dirname(destino), { recursive: true });
  try {
    await fsp.rename(caminhoTemporario, destino);
  } catch (erro) {
    if (erro.code !== 'EXDEV') throw erro; // outro disco: copia e apaga
    await fsp.copyFile(caminhoTemporario, destino);
    await fsp.rm(caminhoTemporario, { force: true });
  }
}

function abrirLeitura(chave) {
  return fs.createReadStream(caminho(chave));
}

// Apaga vários arquivos; falhas só são registradas (o registro no banco já foi removido)
async function apagar(chaves) {
  await Promise.all(
    chaves.filter(Boolean).map((chave) =>
      fsp.rm(caminho(chave), { force: true }).catch((erro) =>
        console.error(`Não foi possível apagar o arquivo ${chave}:`, erro.message)
      )
    )
  );
}

module.exports = { PASTA_TEMPORARIA, guardar, abrirLeitura, apagar };
