const { HttpError } = require('../utils/http');

// Rotas de dados: a pessoa precisa fazer parte de um escritório
function exigirEscritorio(req, res, next) {
  if (!req.escritorioId) {
    throw new HttpError(403, 'Você não faz parte de nenhum escritório', 'SEM_ESCRITORIO');
  }
  next();
}

// Ações de gestão (equipe, configurações do escritório): só administradores
function exigirAdmin(req, res, next) {
  if (req.usuario?.papel !== 'ADMIN') {
    throw new HttpError(403, 'Apenas administradores do escritório podem fazer isso', 'SOMENTE_ADMIN');
  }
  next();
}

// Quem vê dinheiro (lançamentos, valores de contrato, resumo do mês): administradores sempre;
// membros só com a opção "Ver o financeiro" ligada pelo administrador na Equipe
function podeVerFinanceiro(usuario) {
  return usuario?.papel === 'ADMIN' || Boolean(usuario?.verFinanceiro);
}

function exigirFinanceiro(req, res, next) {
  if (!podeVerFinanceiro(req.usuario)) {
    throw new HttpError(403, 'Você não tem acesso ao financeiro do escritório', 'SEM_FINANCEIRO');
  }
  next();
}

module.exports = { exigirEscritorio, exigirAdmin, exigirFinanceiro, podeVerFinanceiro };
