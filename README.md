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
npm run definir-senha            # cria a SUA conta (e-mail + senha de 10+ caracteres)
npm run importar-planilha        # traz barbeiros, serviços, produtos e saldos da planilha
npm start                        # liga o app
```

Abra **http://127.0.0.1:3000** e entre com o e-mail e a senha que você definiu.

> Para importar uma versão nova da planilha: `python3 scripts/extrair_planilha.py "minha planilha.xlsx" dados/planilha_extraida.json`
> e depois `npm run importar-planilha`. Pode rodar de novo: o que já existe não é duplicado.

**Testar no celular na mesma rede Wi-Fi (só para experimentar):** `HOST=0.0.0.0 npm start` e abra
`http://IP-DO-COMPUTADOR:3000` no celular. Sem HTTPS, não use assim no dia a dia.

## 2. Publicar com acesso privado (precisa da sua autorização)

Nada foi publicado nem contratado. Para usar pelo celular de qualquer lugar, o app precisa rodar num lugar ligado
24h **com HTTPS**. Opções (em ordem de simplicidade):

| Opção | O que é preciso | Custo |
|---|---|---|
| **A. Servidor pequeno (VPS)** com Caddy na frente | contratar um VPS Linux, apontar um domínio (ex.: `app.verdugo.com.br`) | mensalidade baixa do VPS + domínio |
| **B. Plataforma com disco persistente** (ex.: Fly.io, Railway, Render) | conta na plataforma, volume para `dados/` | mensalidade baixa |
| **C. Computador da barbearia + Cloudflare Tunnel** | um computador sempre ligado, conta gratuita na Cloudflare, domínio | só o domínio |

Antes de contratar, eu confirmo os preços atuais e te mostro o passo a passo; nada é feito sem o seu “ok”.

Configuração em produção (qualquer opção):

```bash
NODE_ENV=production PORT=3000 HOST=127.0.0.1 TRUST_PROXY=1 COOKIE_SECURE=1 \
DB_FILE=/caminho/seguro/verdugo.db npm start
```

- `TRUST_PROXY=1` quando houver um proxy HTTPS na frente (Caddy/Cloudflare), para o bloqueio de senha usar o IP real.
- `COOKIE_SECURE=1` obriga o cookie de sessão a só trafegar por HTTPS.
- Exemplo de Caddy (HTTPS automático):
  ```
  app.seudominio.com.br {
      reverse_proxy 127.0.0.1:3000
  }
  ```
- Backup diário automático (cron do Linux, 3h da manhã) + cópia para fora do servidor:
  ```
  0 3 * * * cd /opt/verdugo-app && npm run -s backup
  ```

A proteção é de verdade: sem login, o link só mostra a tela de entrada — nem o código da tela, nem a API respondem.

## 3. Backup e restauração

- **Pela tela:** Cadastros → Backup → “Baixar backup completo” (arquivo `.sqlite`) ou planilhas CSV.
- **No servidor:** `npm run backup` (salva em `dados/backups/`).
- **Restaurar:** pare o app, copie o backup para `dados/verdugo.db`, apague `dados/verdugo.db-wal` e `dados/verdugo.db-shm` se existirem, ligue o app.
- **Esqueceu a senha?** No servidor: `npm run definir-senha` (troca a senha e encerra todas as sessões).

## 4. Rodar os testes

```bash
npm test                                   # 23 testes de regras (API), incluindo regressões
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
