const OpenAI = require('openai');
const { rateLimit } = require('express-rate-limit');
const { HttpError } = require('../utils/http');

// Recursos de IA (assistente, proposta, relatório) usando a OpenAI (Chat Completions).
// Configure no .env: OPENAI_API_KEY (obrigatória) e OPENAI_MODEL (opcional).
// Sem a chave, as rotas de IA respondem 503 e o front esconde os botões.

const MODELO_PADRAO = 'gpt-5.4-mini';

let cliente;

function iaConfigurada() {
  return Boolean(process.env.OPENAI_API_KEY);
}

function modelo() {
  return process.env.OPENAI_MODEL || MODELO_PADRAO;
}

function obterCliente() {
  if (!iaConfigurada()) {
    throw new HttpError(503, 'Os recursos de IA não estão configurados neste servidor', 'IA_DESLIGADA');
  }
  // a chave vem de OPENAI_API_KEY (padrão do SDK)
  if (!cliente) cliente = new OpenAI({ timeout: 90 * 1000, maxRetries: 1 });
  return cliente;
}

// Uma chamada ao modelo. Erros da OpenAI viram uma mensagem amigável (o detalhe fica no log)
// Erros da OpenAI viram mensagens para a pessoa (sem detalhes técnicos)
function erroDaIa(error) {
  if (!(error instanceof OpenAI.APIError)) return error;
  console.error(`[ia] OpenAI ${error.status}: ${error.message}`);
  if (error.status === 429) {
    return new HttpError(503, 'A IA está ocupada ou sem créditos no momento. Tente de novo em instantes.', 'IA_LIMITE');
  }
  return new HttpError(502, 'A IA não respondeu agora. Tente de novo em instantes.', 'IA_ERRO');
}

// Mesma chamada, mas a resposta chega aos pedaços (para mostrar e falar enquanto é escrita).
// Erros no meio do fluxo também viram mensagens para a pessoa.
async function* conversarEmFluxo(params) {
  const openai = obterCliente();
  try {
    const fluxo = await openai.chat.completions.create({ model: modelo(), ...params, stream: true });
    for await (const parte of fluxo) yield parte;
  } catch (error) {
    throw erroDaIa(error);
  }
}

async function conversar(params) {
  const openai = obterCliente();
  try {
    return await openai.chat.completions.create({ model: modelo(), ...params });
  } catch (error) {
    throw erroDaIa(error);
  }
}

// Resposta em JSON garantida pelo schema (Structured Outputs, strict)
async function gerarJson({ instrucoes, entrada, nome, schema }) {
  const resposta = await conversar({
    messages: [
      { role: 'developer', content: instrucoes },
      { role: 'user', content: entrada },
    ],
    response_format: { type: 'json_schema', json_schema: { name: nome, strict: true, schema } },
  });
  const mensagem = resposta.choices[0].message;
  if (mensagem.refusal || !mensagem.content) {
    throw new HttpError(422, 'A IA não conseguiu gerar este conteúdo. Reformule e tente de novo.', 'IA_RECUSOU');
  }
  return JSON.parse(mensagem.content);
}

// Voz do assistente (texto -> mp3). OPENAI_VOZ e OPENAI_MODELO_VOZ são opcionais.
const INSTRUCOES_VOZ =
  'Fale em português do Brasil, num tom informal, descontraído e caloroso, como uma colega de trabalho conversando ' +
  'no dia a dia (sorriso na voz, entonação de conversa, nada de locutora ou atendimento formal). Ritmo ágil e sem pausas longas. ' +
  'Leia datas como "16/11" por extenso ("dia 16 de novembro"), "14h" como "14 horas" e valores em reais por extenso.';

// Devolve o áudio (mp3) como fluxo: os primeiros pedaços chegam antes de a frase inteira ficar pronta,
// e a rota repassa direto para o navegador ir tocando
async function falar(texto) {
  const openai = obterCliente();
  try {
    const resposta = await openai.audio.speech.create({
      model: process.env.OPENAI_MODELO_VOZ || 'gpt-4o-mini-tts',
      voice: process.env.OPENAI_VOZ || 'marin',
      input: texto,
      instructions: INSTRUCOES_VOZ,
      response_format: 'mp3',
    });
    return resposta.body;
  } catch (error) {
    if (error instanceof OpenAI.APIError) {
      console.error(`[ia] voz OpenAI ${error.status}: ${error.message}`);
      throw new HttpError(502, 'Não foi possível gerar a voz agora.', 'IA_ERRO');
    }
    throw error;
  }
}

// Cada chamada custa dinheiro: limite por pessoa (60 a cada 10 minutos)
const limiteIa = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 60,
  keyGenerator: (req) => `usuario-${req.usuario.id}`,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { erro: 'Muitos pedidos à IA em pouco tempo. Aguarde alguns minutos.' },
});

// Fala da pessoa -> texto. A "dica" (nomes de clientes e projetos) ajuda a acertar nomes próprios.
async function transcrever({ audio, nomeArquivo, tipo, dica }) {
  const openai = obterCliente();
  try {
    const resultado = await openai.audio.transcriptions.create({
      model: process.env.OPENAI_MODELO_TRANSCRICAO || 'gpt-4o-mini-transcribe',
      file: await OpenAI.toFile(audio, nomeArquivo, { type: tipo }),
      language: 'pt',
      ...(dica && { prompt: dica }),
    });
    return (resultado.text || '').trim();
  } catch (error) {
    if (error instanceof OpenAI.APIError) {
      console.error(`[ia] transcrição OpenAI ${error.status}: ${error.message}`);
      throw new HttpError(502, 'Não foi possível entender o áudio agora. Tente de novo.', 'IA_ERRO');
    }
    throw error;
  }
}

// A voz vem em vários pedidos por resposta (um por trecho): limite próprio, mais folgado
const limiteVoz = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 200,
  keyGenerator: (req) => `voz-${req.usuario.id}`,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { erro: 'Muitos pedidos de voz em pouco tempo. Aguarde alguns minutos.' },
});

module.exports = { iaConfigurada, modelo, conversar, conversarEmFluxo, gerarJson, falar, transcrever, limiteIa, limiteVoz };
