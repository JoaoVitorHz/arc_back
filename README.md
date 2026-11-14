# ArcBack

API do **ArcGestão**, sistema de gestão para escritórios de arquitetura.

**Stack:** Node.js · Express 5 · Prisma 6 · MySQL/MariaDB (XAMPP)

## Como rodar

1. Inicie o **MySQL** pelo painel do XAMPP.
2. Crie o banco (só na primeira vez), pelo phpMyAdmin ou pelo terminal:
   ```sql
   CREATE DATABASE arcgestao CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   ```
3. Configure o ambiente e instale as dependências:
   ```bash
   cp .env.example .env   # ajuste DATABASE_URL se o seu MySQL tiver senha
   npm install
   npm run db:migrate     # cria as tabelas
   npm run db:seed        # (opcional) dados de exemplo
   ```
4. Suba a API:
   ```bash
   npm run dev            # http://localhost:3333
   ```

## Scripts

| Script | O que faz |
|---|---|
| `npm run dev` | Sobe a API e reinicia ao salvar arquivos |
| `npm start` | Sobe a API (produção) |
| `npm run db:migrate` | Aplica/cria migrações a partir do `prisma/schema.prisma` |
| `npm run db:seed` | **Apaga tudo** e insere dados de exemplo |
| `npm run db:studio` | Abre o Prisma Studio para ver/editar os dados |

## Estrutura

```
prisma/
  schema.prisma        # modelo do banco (tabelas, enums, relações)
  migrations/          # histórico de alterações do banco
  seed.js              # dados de exemplo
src/
  server.js            # inicia o servidor
  app.js               # Express, CORS, rotas e tratamento de erros
  routes/              # um arquivo por recurso
  services/            # regras reaproveitadas (ex.: resumo financeiro)
  middlewares/         # errorHandler
  utils/http.js        # validação, conversão de datas/valores, HttpError
  constants/etapas.js  # etapas padrão de todo projeto novo
  lib/prisma.js        # cliente do banco
```

## Endpoints

Base: `http://localhost:3333/api`. Erros retornam `{ "erro": "mensagem" }`.

| Método | Rota | Descrição |
|---|---|---|
| GET | `/health` | Verifica se a API está no ar |
| GET | `/dashboard` | Indicadores do painel |
| GET | `/clientes?busca=` | Lista clientes |
| GET | `/clientes/:id` | Cliente com seus projetos |
| POST / PUT / DELETE | `/clientes[/:id]` | Cria, edita, exclui (bloqueia se tiver projetos) |
| GET | `/projetos?status=&clienteId=&busca=` | Lista projetos com `progresso` |
| GET | `/projetos/:id` | Projeto com cliente, etapas, compromissos e lançamentos |
| POST | `/projetos` | Cria projeto **com as etapas padrão** |
| PUT / DELETE | `/projetos/:id` | Edita / exclui |
| POST | `/projetos/:id/etapas` | Adiciona etapa ao final |
| PATCH / DELETE | `/etapas/:id` | Altera status, nome, data prevista / remove |
| GET | `/eventos?inicio=&fim=` | Compromissos no intervalo |
| POST / PUT / DELETE | `/eventos[/:id]` | Cria, edita, exclui |
| GET | `/lancamentos?mes=AAAA-MM&tipo=&situacao=pago\|pendente` | Lista lançamentos |
| GET | `/lancamentos/resumo?mes=AAAA-MM` | Totais do mês |
| POST / PUT / DELETE | `/lancamentos[/:id]` | Cria, edita, exclui |
| PATCH | `/lancamentos/:id/pagamento` | Marca como pago/pendente `{ "pago": true }` |

## Alterando o banco

1. Edite `prisma/schema.prisma`.
2. Rode `npm run db:migrate` e dê um nome à migração.
3. O Prisma Client é regenerado automaticamente.

## Ainda não implementado

- Login e separação de dados por escritório (multi-tenant)
- Testes automatizados
