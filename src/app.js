const express = require('express');
const cors = require('cors');

const routes = require('./routes');
const errorHandler = require('./middlewares/errorHandler');

const app = express();

// Atrás do Nginx em produção: TRUST_PROXY=1 faz req.ip ser o IP real de quem acessa
// (o gateway pede o IP do pagador na assinatura com cartão)
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);

app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:3000' }));
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.use('/api', routes);

app.use((req, res) => res.status(404).json({ erro: 'Rota não encontrada' }));
app.use(errorHandler);

module.exports = app;
