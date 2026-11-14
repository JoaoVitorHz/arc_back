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
   cp .env.example .env   # ajuste DATABASE_URL e gere um JWT_SECRET (instruções no arquivo)
   npm install
   npm run db:migrate     # cria as tabelas
   npm run db:seed        # (opcional) conta demo com dados de exemplo
   ```
4. Suba a API:
   ```bash
   npm run dev            # http://localhost:3333
   ```

**Conta demo** (criada pelo seed): `demo@arcgestao.com` / `demo12345`

## Scripts

| Script | O que faz |
|---|---|
| `npm run dev` | Sobe a API e reinicia ao salvar arquivos |
| `npm start` | Sobe a API (produção) |
| `npm run db:migrate` | Aplica/cria migrações a partir do `prisma/schema.prisma` |
| `npm run db:seed` | Recria do zero a conta demo e seus dados de exemplo (outras contas não são alteradas) |
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
  middlewares/         # autenticar (exige token) e errorHandler
  utils/http.js        # validação, conversão de datas/valores, HttpError
  utils/escopo.js      # garante que cliente/projeto informado é do escritório logado
  lib/jwt.js           # gera e valida os tokens de login
  constants/etapas.js  # etapas padrão de todo projeto novo
  constants/tiposEvento.js  # cores aceitas e tipos de compromisso padrão
  lib/prisma.js        # cliente do banco
```

## Autenticação e escritórios

- Cada conta pertence a um **escritório**. O cadastro cria o escritório, o primeiro usuário e os tipos de compromisso padrão (Reunião, Visita técnica, Visita de obra, Entrega, Outro).
- Login devolve um **token JWT** (válido por 7 dias). As rotas de dados exigem o header `Authorization: Bearer <token>`.
- Todas as consultas filtram por `escritorioId`: um escritório nunca vê nem altera dados de outro. Ao receber um `clienteId`/`projetoId`, a API confere se ele é do mesmo escritório.
- Senhas são guardadas com **bcrypt**. Login e cadastro aceitam até 20 tentativas a cada 15 minutos por IP.

## Endpoints

Base: `http://localhost:3333/api`. Erros retornam `{ "erro": "mensagem" }`.

| Método | Rota | Descrição |
|---|---|---|
| POST | `/auth/cadastro` | Cria escritório + usuário `{ nome, email, senha, nomeEscritorio }` → `{ token, usuario }` |
| POST | `/auth/login` | `{ email, senha }` → `{ token, usuario }` |
| GET | `/auth/me` | Usuário logado (exige token) |
| GET | `/health` | Verifica se a API está no ar |

As rotas abaixo exigem token:

| Método | Rota | Descrição |
|---|---|---|
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
| POST / PUT / DELETE | `/eventos[/:id]` | Cria, edita, exclui (`tipoId` opcional) |
| GET | `/tipos-evento` | Tipos de compromisso do escritório, com quantos compromissos usam cada um |
| POST / PUT | `/tipos-evento[/:id]` | `{ nome, cor }`; cores: blue, purple, pink, red, orange, amber, green, gray |
| DELETE | `/tipos-evento/:id` | Exclui; os compromissos desse tipo ficam sem tipo |
| GET | `/lancamentos?mes=AAAA-MM&tipo=&situacao=pago\|pendente` | Lista lançamentos |
| GET | `/lancamentos/resumo?mes=AAAA-MM` | Totais do mês |
| POST / PUT / DELETE | `/lancamentos[/:id]` | Cria, edita, exclui |
| PATCH | `/lancamentos/:id/pagamento` | Marca como pago/pendente `{ "pago": true }` |

## Alterando o banco

1. Edite `prisma/schema.prisma`.
2. Rode `npm run db:migrate` e dê um nome à migração.
3. O Prisma Client é regenerado automaticamente.

## Ainda não implementado

- Convidar outros usuários para o mesmo escritório
- Recuperação de senha por e-mail
- Testes automatizados
