require('dotenv').config();

const app = require('./app');
const { segredo } = require('./lib/jwt');

const PORT = process.env.PORT || 3333;

// Falha logo na subida se faltar o JWT_SECRET, em vez de só no primeiro login
segredo();

app.listen(PORT, () => {
  console.log(`ArcBack rodando em http://localhost:${PORT}`);
});
