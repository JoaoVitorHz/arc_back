// Gateway de pagamentos em uso. Hoje só o Asaas; outro gateway (ex.: Stripe para clientes de
// fora do Brasil) entra como um arquivo com as mesmas funções de ./asaas.js.
module.exports = require('./asaas');
