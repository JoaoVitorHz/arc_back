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
  services/            # regras reaproveitadas (resumo financeiro, regras de equipe)
  middlewares/         # autenticar (token), permissoes (exigirEscritorio, exigirAdmin), errorHandler
  utils/sessao.js      # senha, sessão, tokens de link e limite de tentativas
  utils/http.js        # validação, conversão de datas/valores, HttpError
  utils/escopo.js      # garante que cliente/projeto informado é do escritório logado
  lib/jwt.js           # gera e valida os tokens de login
  lib/email.js         # envio de e-mail (SMTP ou terminal)
  lib/armazenamento.js # onde ficam os arquivos enviados (disco hoje; R2/S3 depois)
uploads/               # arquivos enviados (fora do Git)
  constants/etapas.js  # etapas padrão de todo projeto novo
  constants/tiposEvento.js  # cores aceitas e tipos de compromisso padrão
  lib/prisma.js        # cliente do banco
```

## Autenticação e escritórios

- Cada conta pertence a um **escritório**. O cadastro cria o escritório, o primeiro usuário e os tipos de compromisso padrão (Reunião, Visita técnica, Visita de obra, Entrega, Outro).
- Login devolve um **token JWT** (válido por 7 dias). As rotas de dados exigem o header `Authorization: Bearer <token>`.
- Todas as consultas filtram por `escritorioId`: um escritório nunca vê nem altera dados de outro. Ao receber um `clienteId`/`projetoId`, a API confere se ele é do mesmo escritório.
- Senhas são guardadas com **bcrypt**. Login, cadastro, recuperação de senha e aceite de convite aceitam até 20 tentativas **com erro** a cada 15 minutos por IP (as que dão certo não contam, porque a equipe de um escritório costuma sair pelo mesmo IP).

## Arquivos dos projetos

- Cada arquivo (ou link do Drive/Dropbox) pertence a um projeto e fica **dentro de uma etapa** ou na pasta **Geral do projeto** (`etapaId` vazio).
- Limite de **50 MB** por arquivo e 10 por envio; executáveis (`.exe`, `.bat`, `.js`...) são recusados. Arquivos maiores entram como link.
- Os arquivos ficam em `uploads/` (ou `UPLOAD_DIR`), fora do Git, com nome aleatório; o nome original fica no banco. O download passa pela API, que confere o escritório; imagens e PDF podem abrir no navegador (`?visualizar=1`), o resto sempre baixa.
- Apagar uma **etapa** ou um **projeto** apaga os arquivos dele (registro e conteúdo). Apagar um arquivo: quem enviou ou um administrador.
- `lib/armazenamento.js` concentra o acesso ao disco (guardar, ler, apagar): para usar Cloudflare R2/S3 em produção, só ele muda.
- ⚠️ Faça backup da pasta `uploads/` junto com o banco.

## Revisões com o cliente (opcional)

- Cada etapa tem rodadas de revisão: **R00** (entrega original), R01, R02... Tudo é opcional: sem marcar nenhum envio, a etapa fica na R00 e funciona como antes.
- `POST /etapas/:id/revisao/enviar` marca a revisão atual como enviada (data, meio, observação). Depois disso, **anexar arquivos na etapa abre a próxima revisão sozinho**; `POST /etapas/:id/revisao/nova` abre manualmente.
- `pedido` registra o que o cliente pediu; `aprovar` marca como aprovada; `desfazer` desfaz a última marcação (aprovação → pedido → envio → revisão aberta sem arquivos).
- `DELETE /etapas/:id/revisao` apaga a revisão atual e os arquivos dela; a etapa volta para a anterior. Na R00 apaga só os registros (envio, pedido, aprovação) e mantém os arquivos. Só a mais recente pode ser apagada; se já foi enviada ao cliente, só administradores.
- `revisoesPrevistas` (PATCH da etapa) habilita o contador "N de M"; revisões além do previsto podem ser cobradas como extra.
- Arquivos de uma revisão já enviada são o que o cliente recebeu: não podem ser movidos e só um administrador pode apagá-los.
- O upload responde `{ arquivos, revisao }` (`revisao.nova` indica que uma revisão foi aberta).

## Equipe

- **Papéis:** `ADMIN` (gerencia equipe e escritório) e `MEMBRO` (usa o sistema). Quem cria a conta é administrador. Rotas de gestão usam o middleware `exigirAdmin`.
- **Entrar na equipe:** por **convite** (link de 7 dias, uso único, só o hash fica no banco) ou pela **conta criada pelo administrador** (senha provisória; `deveTrocarSenha` obriga a criar a própria no primeiro acesso).
- **Aceitar convite tendo conta:** sem escritório → entra; escritório vazio (só a pessoa e nenhum dado) → ele é apagado e a pessoa entra; com dados → precisa **encerrar**; com equipe → precisa **sair**. Regras em `services/equipe.service.js`.
- **Sair:** qualquer pessoa, menos o último administrador. **Remover:** o administrador tira alguém da equipe (a conta continua existindo).
- **Encerrar escritório:** só o administrador e só quando está sozinho, confirmando com o nome. O escritório fica desativado (`encerradoEm`) e quem encerrou pode **restaurar em até 30 dias**.
- **Sem escritório** (`usuarios.escritorioId` vazio): a pessoa só acessa `/auth`, `/convites` e criar/restaurar escritório; as rotas de dados respondem `403` com `codigo: "SEM_ESCRITORIO"` (middleware `exigirEscritorio`).
- **Recuperação de senha:** o link vale 1 hora e uma única vez; o banco guarda só o hash do token. Trocar a senha (pelo link ou no perfil) encerra as sessões abertas em outros aparelhos (`tokensValidosApos`).

### E-mail

Configure o SMTP no `.env` (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`) e o `APP_URL` (endereço do frontend usado nos links). **Sem `SMTP_HOST`, os e-mails não são enviados: aparecem no terminal da API** — útil em desenvolvimento para copiar o link de redefinição.

## Endpoints

Base: `http://localhost:3333/api`. Erros retornam `{ "erro": "mensagem" }`.

| Método | Rota | Descrição |
|---|---|---|
| POST | `/auth/cadastro` | Cria escritório + usuário `{ nome, email, senha, nomeEscritorio }` → `{ token, usuario }` |
| POST | `/auth/login` | `{ email, senha }` → `{ token, usuario }` |
| GET | `/auth/me` | Usuário logado (exige token) |
| POST | `/auth/esqueci-senha` | `{ email }` → envia o link de redefinição (resposta igual exista ou não a conta) |
| POST | `/auth/redefinir-senha` | `{ token, senha }` → troca a senha e devolve `{ token, usuario }` |
| PUT | `/auth/perfil` | `{ nome, email, senhaAtual? }` (senha atual obrigatória para trocar o e-mail) |
| PUT | `/auth/senha` | `{ senhaAtual, novaSenha }` → devolve um token novo |
| GET | `/convites/token/:token` | Dados do convite (tela do link) |
| POST | `/convites/token/:token/aceitar` | Sem conta `{ nome, senha }` / com conta `{ senha }` → `{ token, usuario }` |
| GET | `/convites/meus` | Convites pendentes para o meu e-mail (logado) |
| POST | `/convites/:id/aceitar` | Aceitar estando logado |
| GET | `/health` | Verifica se a API está no ar |

As rotas abaixo exigem token:

| Método | Rota | Descrição |
|---|---|---|
| GET | `/dashboard` | Indicadores do painel e `minhasEtapas` (etapas não concluídas sob minha responsabilidade) |
| GET | `/escritorio` | Escritório atual com tamanho da equipe e se tem dados |
| PUT | `/escritorio` | Renomear `{ nome }` (admin) |
| POST | `/escritorio/encerrar` | `{ confirmacao: "<nome>" }` (admin, sozinho no escritório) |
| POST | `/escritorio` | Criar meu escritório `{ nome }` (só sem escritório) |
| GET | `/escritorio/encerrados` | Escritórios que eu encerrei e ainda posso restaurar |
| POST | `/escritorio/:id/restaurar` | Restaurar (só sem escritório, até 30 dias) |
| GET | `/equipe` | Membros (todos) e convites pendentes (admin) |
| POST | `/equipe/sair` | Sair do escritório |
| POST | `/equipe/convites` | `{ nome, email, papel }` → `{ convite, link, emailEnviado, contaExiste }` (admin) |
| POST | `/equipe/convites/:id/novo-link` | Gera outro link e reenvia o e-mail (admin) |
| DELETE | `/equipe/convites/:id` | Cancela o convite (admin) |
| POST | `/equipe/membros` | Cria conta com senha provisória `{ nome, email, papel, senha }` (admin) |
| PATCH / DELETE | `/equipe/membros/:id` | Troca o papel `{ papel }` / remove da equipe (admin) |
| GET | `/clientes?busca=` | Lista clientes |
| GET | `/clientes/:id` | Cliente com projetos (com progresso), compromissos e resumo financeiro |
| POST / PUT / DELETE | `/clientes[/:id]` | Cria, edita, exclui (bloqueia se tiver projetos) |
| GET | `/projetos?status=&clienteId=&busca=` | Lista projetos com `progresso` e `etapasAtrasadas` |
| GET | `/projetos/:id` | Projeto com cliente, etapas, compromissos e lançamentos |
| POST | `/projetos` | Cria projeto **com as etapas padrão** |
| PUT / DELETE | `/projetos/:id` | Edita / exclui |
| POST | `/projetos/:id/etapas` | Adiciona etapa ao final |
| PATCH / DELETE | `/etapas/:id` | Altera status, nome, data prevista, responsável `{ responsavelId }` (alguém da equipe ou null), anotações `{ descricao }` (até 5000 caracteres; guarda quem editou e quando) / remove (com os arquivos dela) |
| PUT | `/projetos/:id/etapas/ordem` | Nova ordem das etapas `{ ids: [...] }` (todas, cada uma uma vez) |
| GET | `/projetos/:id/arquivos` | Arquivos e links do projeto |
| POST | `/projetos/:id/arquivos` | Envio multipart: campo `arquivos` (até 10) + `etapaId` opcional |
| POST | `/projetos/:id/links` | `{ nome, url, etapaId? }` |
| GET | `/arquivos/:id/conteudo` | Baixa o arquivo (`?visualizar=1` abre imagem/PDF no navegador) |
| PATCH | `/arquivos/:id` | Move de etapa `{ etapaId }` (null = Geral) e/ou renomeia `{ nome }` |
| DELETE | `/arquivos/:id` | Apaga (quem enviou ou administrador) |
| GET | `/eventos?inicio=&fim=` | Compromissos no intervalo |
| POST / PUT / DELETE | `/eventos[/:id]` | Cria, edita, exclui (`tipoId` opcional) |
| GET | `/tipos-evento` | Tipos de compromisso do escritório, com quantos compromissos usam cada um |
| POST / PUT | `/tipos-evento[/:id]` | `{ nome, cor }`; cores: blue, purple, pink, red, orange, amber, green, gray |
| DELETE | `/tipos-evento/:id` | Exclui; os compromissos desse tipo ficam sem tipo |
| GET | `/lancamentos?mes=AAAA-MM&tipo=&situacao=pago\|pendente` | Lista lançamentos |
| GET | `/lancamentos/resumo?mes=AAAA-MM` | Totais do mês |
| GET | `/lancamentos/fluxo?inicio=AAAA-MM&meses=6` | Fluxo de caixa (pelo vencimento): `{ meses: [{ mes, entradas, saidas, saldo, acumulado }], despesasPorCategoria: [{ categoria, total }] }` |
| POST / PUT / DELETE | `/lancamentos[/:id]` | Cria, edita, exclui. No POST, `repeticao: { modo: "parcelar" | "repetir", vezes }` cria as parcelas (valor total dividido, "(1/4)" no nome) ou repete todo mês |
| PATCH | `/lancamentos/:id/pagamento` | Marca como pago/pendente `{ "pago": true }` |

## Alterando o banco

1. Edite `prisma/schema.prisma`.
2. Rode `npm run db:migrate` e dê um nome à migração.
3. O Prisma Client é regenerado automaticamente.

## Ainda não implementado

- Exclusão automática dos escritórios encerrados há mais de 30 dias (hoje eles só ficam desativados). Ao implementar, apagar também os arquivos deles no armazenamento
- Armazenamento em nuvem (Cloudflare R2/S3) para os arquivos
- Controle de versões das pranchas (R00, R01...) e aprovação pelo cliente
- Testes automatizados
