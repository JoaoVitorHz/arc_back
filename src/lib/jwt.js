const jwt = require('jsonwebtoken');

const EXPIRACAO = '7d';

function segredo() {
  const valor = process.env.JWT_SECRET;
  if (!valor) throw new Error('JWT_SECRET não definido no .env');
  return valor;
}

// O token guarda só o id do usuário e do escritório
function gerarToken(usuario) {
  return jwt.sign({ escritorioId: usuario.escritorioId }, segredo(), {
    subject: String(usuario.id),
    expiresIn: EXPIRACAO,
  });
}

// Lança erro se o token for inválido ou estiver expirado
function verificarToken(token) {
  const payload = jwt.verify(token, segredo(), { algorithms: ['HS256'] });
  return { usuarioId: Number(payload.sub), escritorioId: payload.escritorioId };
}

module.exports = { gerarToken, verificarToken, segredo };
