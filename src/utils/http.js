// Erro com status HTTP, tratado pelo middleware errorHandler
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(400, 'ID inválido');
  }
  return id;
}

function requireFields(body, fields) {
  const faltando = fields.filter(
    (campo) => body[campo] === undefined || body[campo] === null || body[campo] === ''
  );
  if (faltando.length) {
    throw new HttpError(400, `Campos obrigatórios: ${faltando.join(', ')}`);
  }
}

// Converte "" e undefined em null para campos opcionais
function emptyToNull(value) {
  return value === undefined || value === '' ? null : value;
}

// Aceita "2026-11-14" ou ISO completo. Vazio vira null.
function toDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const data = new Date(value);
  if (Number.isNaN(data.getTime())) {
    throw new HttpError(400, `Data inválida: ${value}`);
  }
  return data;
}

function toOptionalInt(value) {
  if (value === undefined || value === null || value === '') return null;
  return parseId(value);
}

function toDecimal(value) {
  if (value === undefined || value === null || value === '') return null;
  const numero = Number(String(value).replace(',', '.'));
  if (Number.isNaN(numero)) {
    throw new HttpError(400, `Valor inválido: ${value}`);
  }
  return numero;
}

// "2026-11" -> intervalo [1º dia do mês, 1º dia do mês seguinte)
function monthRange(mes) {
  const [ano, mesNum] = (mes || '').split('-').map(Number);
  if (!ano || !mesNum || mesNum < 1 || mesNum > 12) {
    throw new HttpError(400, 'Mês inválido, use o formato AAAA-MM');
  }
  return {
    gte: new Date(Date.UTC(ano, mesNum - 1, 1)),
    lt: new Date(Date.UTC(ano, mesNum, 1)),
  };
}

function currentMonth() {
  const hoje = new Date();
  return `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
}

module.exports = {
  HttpError,
  parseId,
  requireFields,
  emptyToNull,
  toDate,
  toOptionalInt,
  toDecimal,
  monthRange,
  currentMonth,
};
