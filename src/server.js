require('dotenv').config();

const app = require('./app');
const { segredo } = require('./lib/jwt');
const { garantirContaAdmin } = require('./lib/contaAdmin');

const PORT = process.env.PORT || 3333;

// Falha logo na subida se faltar o JWT_SECRET, em vez de só no primeiro login
segredo();

// Conta fixa do painel admin (ADMIN_EMAIL / ADMIN_SENHA no .env)
garantirContaAdmin().catch((erro) => console.error('[admin] falha ao configurar a conta admin:', erro.message));

app.listen(PORT, () => {
  console.log(`ArcBack rodando em http://localhost:${PORT}`);
});
