# Verdugo — sistema da barbearia e prótese capilar

Aplicativo web próprio da **Verdugo Barbearia e Prótese Capilar**: atendimentos, vendas de balcão, vendas online
(Mercado Livre, Shopee, TikTok Shop e Amazon), estoque central por SKU, contas, saídas, fechamentos e relatórios.
Funciona no navegador do celular e do computador, com **uma única conta: a do proprietário**.

- Análise da planilha: [`docs/ANALISE.md`](docs/ANALISE.md)
- Arquitetura, segurança e backup: [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md)
- Testes e evidências: [`docs/TESTES.md`](docs/TESTES.md)
- Pendências e decisões suas: [`docs/PENDENCIAS.md`](docs/PENDENCIAS.md)

---

## 1. Abrir no computador (teste local, sem custo)

Precisa do **Node.js 22.13 ou mais novo** (nodejs.org). No terminal, dentro desta pasta:

```bash
npm install                      # instala a única dependência (Express)
npm run definir-senha            # cria a SUA conta (ou abra /configurar com SETUP_TOKEN definido)
npm run importar-planilha        # traz barbeiros, serviços, produtos e saldos da planilha
npm start                        # liga o app
```

Abra **http://127.0.0.1:3000** e entre com o e-mail e a senha que você definiu.

> Para importar uma versão nova da planilha: `python3 scripts/extrair_planilha.py "minha planilha.xlsx" dados/planilha_extraida.json`
> e depois `npm run importar-planilha`. Pode rodar de novo: o que já existe não é duplicado.

**Testar no celular na mesma rede Wi-Fi (só para experimentar):** `HOST=0.0.0.0 npm start` e abra
`http://IP-DO-COMPUTADOR:3000` no celular. Sem HTTPS, não use assim no dia a dia.

## 2. Publicar (TurboCloud · cPanel)

O app roda em **https://app.barbeariaverdugo.com.br** pelo *Setup Node.js App* do cPanel (Passenger).
Passo a passo completo, campos do painel, carga inicial, limpeza e testes: **[`docs/CPANEL.md`](docs/CPANEL.md)**.

Resumo: app em `/home/USUARIO/verdugo-app` (privado), dados em `/home/USUARIO/verdugo-dados` (privado e persistente),
arquivo de entrada `app.cjs`, variáveis `NODE_ENV=production`, `DB_FILE`, `COOKIE_SECURE=1`, `TRUST_PROXY=1` e,
só na primeira vez, `SETUP_TOKEN` para criar a conta em `/configurar`.

## 3. Backup e restauração

- **Pela tela:** Cadastros → Backup → “Baixar backup completo” (arquivo `.sqlite`) ou planilhas CSV.
- **No servidor:** `npm run backup` (salva em `dados/backups/`).
- **Restaurar:** pare o app, copie o backup para `dados/verdugo.db`, apague `dados/verdugo.db-wal` e `dados/verdugo.db-shm` se existirem, ligue o app.
- **Esqueceu a senha?** No servidor: `npm run definir-senha` (troca a senha e encerra todas as sessões).

## 4. Rodar os testes

```bash
npm test                                   # 24 testes de regras (API), incluindo regressões
tests/rodar_ui.sh                          # 19 verificações de tela no celular e no computador (Chromium)
python3 tests/reconciliacao.py planilha.xlsx   # confere os totais do app contra a planilha recalculada
```

## 5. Estrutura

```
server/            servidor (API, regras, banco)
  schema.sql       tabelas
  routes/          atendimentos, balcão, online, estoque, financeiro, cadastros, exportar
  services/        estoque (movimentações), relatórios, CSV
public/            telas (login, app), estilo e logotipo
scripts/           definir senha, importar planilha, backup
tests/             testes automáticos, teste de tela e reconciliação
docs/              análise, arquitetura, testes (com capturas de tela) e pendências
dados/             banco, backups e comprovantes (não versionar)
```
