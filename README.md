# Verdugo — sistema da barbearia e prótese capilar

Aplicativo web próprio da **Verdugo Barbearia e Prótese Capilar**: atendimentos, vendas de balcão, vendas online
(Mercado Livre, Shopee, TikTok Shop e Amazon), estoque central por SKU, contas, saídas, fechamentos e relatórios.
Funciona no navegador do celular e do computador, com **uma única conta: a do proprietário**.

- Análise da planilha: [`docs/ANALISE.md`](docs/ANALISE.md)
- Arquitetura, segurança e backup: [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md)
- Testes e evidências: [`docs/TESTES.md`](docs/TESTES.md)
- Pendências e decisões suas: [`docs/PENDENCIAS.md`](docs/PENDENCIAS.md)

---

## 1. Onde roda

O app fica publicado na **Vercel** (site com HTTPS) e os dados ficam no **Supabase** (banco Postgres).
Os comprovantes das saídas ficam guardados no próprio banco — ou no Supabase Storage, se você configurar a chave.

### Variáveis de ambiente (na Vercel → Settings → Environment Variables)

| Variável | Obrigatória | O que é |
|---|---|---|
| `DATABASE_URL` | sim | Supabase → **Connect** → *Transaction pooler* (porta 6543), com a senha do banco no lugar de `[YOUR-PASSWORD]` |
| `SETUP_TOKEN` | só na 1ª vez | um código seu (12+ caracteres) para liberar a tela de primeira configuração |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | não | se definidas, os comprovantes vão para o Storage (bucket privado `comprovantes`) em vez do banco |

Sem `DATABASE_URL` o site não sobe (mostra o que falta) — nunca roda com banco temporário.

### Primeira vez

1. Publique com as variáveis acima.
2. Abra **https://SEU-SITE.vercel.app/configurar**, digite o `SETUP_TOKEN`, seu e-mail e a senha, e deixe marcado
   “Importar os dados da planilha”. A conta é criada e a tela se desativa sozinha.
3. Entre pelo login. (Pode apagar o `SETUP_TOKEN` da Vercel depois.)

As tabelas são criadas sozinhas no primeiro acesso. A API pública do Supabase não enxerga nada (RLS ligado em todas as tabelas).

## 2. Testar no computador

Precisa do **Node.js 22** (nodejs.org). Dentro desta pasta:

```bash
npm install
npm start          # sem DATABASE_URL: banco em memória (nada fica salvo) — só para experimentar
                   # abra http://127.0.0.1:3000/configurar (SETUP_TOKEN=... npm start)
DATABASE_URL="postgresql://..." npm start      # usando o banco do Supabase
```

> Planilha nova: `python3 scripts/extrair_planilha.py "minha planilha.xlsx" dados/planilha_extraida.json`
> e depois `DATABASE_URL=... npm run importar-planilha`. Pode rodar de novo: o que já existe não é duplicado.

## 3. Backup e restauração

- **Pela tela:** Cadastros → Backup → “Baixar backup completo” (arquivo `.json` com todas as tabelas) ou planilhas CSV.
- **Pelo computador:** `DATABASE_URL=... npm run backup` (salva em `dados/backups/`).
- **Restaurar:** `DATABASE_URL=... npm run restaurar-backup arquivo.json` (pede confirmação; substitui os dados atuais).
- **Esqueceu a senha?** `DATABASE_URL=... npm run definir-senha` (troca a senha e encerra todas as sessões).

## 4. Rodar os testes

```bash
npm test                                   # 23 testes de regras (API) num Postgres em memória
TEST_PG_URL=postgres://... npm test        # os mesmos testes num servidor Postgres de verdade
tests/rodar_ui.sh                          # 19 verificações de tela no celular e no computador (Chromium)
python3 tests/reconciliacao.py planilha.xlsx   # confere os totais do app contra a planilha recalculada
```

## 5. Estrutura

```
api/index.js       entrada na Vercel
server/            servidor (API, regras, banco)
  schema.sql       tabelas (Postgres)
  db.js, db-worker.js  conexão com o Postgres/Supabase
  routes/          atendimentos, balcão, online, estoque, financeiro, cadastros, exportar
  services/        estoque (movimentações), relatórios, CSV
public/            telas (login, app), estilo e logotipo
scripts/           definir senha, importar planilha, backup e restauração
tests/             testes automáticos, teste de tela e reconciliação
docs/              análise, arquitetura, testes (com capturas de tela) e pendências
dados/             planilha extraída; backups locais (não versionar)
```
