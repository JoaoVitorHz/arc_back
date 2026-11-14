require('dotenv').config();

const app = require('./app');

const PORT = process.env.PORT || 3333;

app.listen(PORT, () => {
  console.log(`ArcBack rodando em http://localhost:${PORT}`);
});
