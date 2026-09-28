# Publicar na TurboCloud (cPanel · Setup Node.js App)

Endereço: **https://app.barbeariaverdugo.com.br** — o site principal e os outros domínios não são tocados.

## Onde cada coisa fica

```
/home/SEU_USUARIO/
├── verdugo-app/                    ← o app (PRIVADO — fora de qualquer public_html)
│   ├── app.cjs                     ← arquivo de entrada do Passenger
│   ├── server/ public/ scripts/ …
│   └── dados/planilha_extraida.json  (só para a carga inicial — apague depois)
├── verdugo-dados/                  ← banco e comprovantes (PRIVADO e persistente)
│   ├── verdugo.db (+ -wal, -shm)
│   ├── comprovantes/
│   └── backups/
└── app.barbeariaverdugo.com.br/    ← pasta pública do subdomínio: fica VAZIA
    └── .htaccess                   (criado pelo cPanel; só aponta para o app)
```

O app só responde pelas rotas dele: telas, `/api` (com login) e o logotipo. Nenhum arquivo das pastas
acima sai por URL — isso foi testado (ver "Testes feitos").

> **Importante:** o usuário de FTP `acessoapp@app.barbeariaverdugo.com.br` abre direto na **pasta pública** do
> subdomínio. **Não envie o app por ele** — o código e a planilha ficariam baixáveis. Use o **Gerenciador de
> Arquivos do cPanel** (ou o FTP da conta principal) para colocar o app em `/home/SEU_USUARIO/verdugo-app`.

## Passo a passo

**0. Confira a versão do Node.** Em *Setup Node.js App → Create Application*, abra a lista *Node.js version*.
Precisa ter **22.13 ou mais nova** (22.x ou 24.x). Se só houver 20 ou menor, pare aqui e peça à TurboCloud o Node 22
(o app usa o SQLite embutido do Node, que não existe antes do 22.13).

**1. Envie o app.** No *Gerenciador de Arquivos*, na sua pasta inicial (`/home/SEU_USUARIO`), crie a pasta
`verdugo-app`, entre nela, envie o `verdugo-app-cpanel.zip` e use *Extract*. Confira que `app.cjs` e `package.json`
ficaram direto dentro de `verdugo-app` (e não em `verdugo-app/verdugo-app`). **Não envie `node_modules`** —
o cPanel cria essa pasta sozinho.

**2. Crie a pasta dos dados.** Ainda em `/home/SEU_USUARIO`, crie `verdugo-dados` (vazia).

**3. Crie o app** em *Setup Node.js App → Create Application*:

| Campo | O que colocar |
|---|---|
| Node.js version | 22.x (22.13 ou mais nova) — ou 24.x |
| Application mode | **Production** |
| Application root | `verdugo-app` |
| Application URL | `app.barbeariaverdugo.com.br` (deixe o caminho depois da barra vazio) |
| Application startup file | `app.cjs` |
| Passenger log file | `/home/SEU_USUARIO/verdugo-dados/passenger.log` (opcional, ajuda a achar erros) |

Em **Environment variables**, adicione (troque `SEU_USUARIO` pelo usuário que aparece no Gerenciador de Arquivos):

| Nome | Valor |
|---|---|
| `NODE_ENV` | `production` |
| `DB_FILE` | `/home/SEU_USUARIO/verdugo-dados/verdugo.db` |
| `COOKIE_SECURE` | `1` |
| `TRUST_PROXY` | `1` |
| `SETUP_TOKEN` | um código seu, 12+ caracteres (só para criar a conta; apague depois) |

Não defina `PORT` nem `HOST`: o Passenger cuida disso.

Clique em **Create**.

**4. Instale as dependências.** Na tela do app, clique em **Run NPM Install** (instala só o Express). Depois **Restart**.

**5. HTTPS.** Em *Domínios* (ou *SSL/TLS Status*), confirme que `app.barbeariaverdugo.com.br` tem certificado
(AutoSSL) e ligue **Force HTTPS Redirect** para esse subdomínio. O cookie de login só funciona em HTTPS.

**6. Sem listagem de pasta.** No Gerenciador de Arquivos, marque *Settings → Show Hidden Files*, abra
`app.barbeariaverdugo.com.br/.htaccess` e acrescente **no final** (fora do bloco que o cPanel escreveu):

```
Options -Indexes
```

**7. Crie a sua conta e importe a planilha.** Abra **https://app.barbeariaverdugo.com.br/configurar**, digite o
`SETUP_TOKEN`, seu e-mail e a senha (10+ caracteres, letras e números) e deixe marcado *Importar os dados da planilha*.
O que veio marcado como "a confirmar" na planilha continua marcado — nada vira lançamento confirmado sozinho.
Depois disso a tela `/configurar` deixa de existir.

**8. Limpeza depois da carga inicial.**
- Apague `verdugo-app/dados/planilha_extraida.json` no Gerenciador de Arquivos (os dados já estão no banco).
- Apague a variável `SETUP_TOKEN` em Setup Node.js App e clique em **Restart**.

**9. Confira (5 minutos).** Numa janela anônima, sem login:
- `https://app.barbeariaverdugo.com.br/` → vai para a tela de login;
- `…/api/inicio` → mostra "Sessão expirada";
- `…/dados/planilha_extraida.json`, `…/package.json`, `…/app.cjs`, `…/server/index.js` → "Página não encontrada";
- `http://app.barbeariaverdugo.com.br` (sem s) → redireciona para `https://`;
- o site principal `barbeariaverdugo.com.br` abre como antes.

## Atualizar o app depois

1. *Setup Node.js App* → **Stop App**. 2. Baixe um backup (abaixo). 3. Envie o zip novo para `verdugo-app` e extraia
por cima (os dados ficam em `verdugo-dados`, que não é tocada). 4. **Run NPM Install** → **Start/Restart**.

## Backup e restauração

- **Pela tela (recomendado, toda semana):** Cadastros → Backup → **Baixar backup completo** (arquivo `.sqlite`) e
  guarde no Google Drive / pen drive. É uma cópia consistente, feita com o app ligado.
- **Restaurar:** *Stop App* → no Gerenciador de Arquivos, envie o backup para `verdugo-dados/`, renomeie para
  `verdugo.db` (substituindo), apague `verdugo.db-wal` e `verdugo.db-shm` se existirem → *Start App*.
  (Testado: o app volta exatamente ao estado do backup.)
- **Comprovantes:** ficam em `verdugo-dados/comprovantes/`. O backup `.sqlite` guarda os lançamentos; para guardar
  também as imagens, use *Compress* nessa pasta no Gerenciador de Arquivos e baixe o `.zip`.
- O backup automático do cPanel/TurboCloud, se existir no seu plano, é um extra — não o único.

## Esqueceu a senha?

Em *Setup Node.js App*, se o painel tiver **Run JS script**, rode `definir-senha` com as variáveis `VERDUGO_EMAIL` e
`VERDUGO_SENHA` definidas temporariamente (apague-as depois). Sem isso: *Stop App*, baixe um backup, e peça ajuda —
a troca também pode ser feita num computador com o backup e devolvida ao servidor.

## Se algo der errado

- Página de erro do Passenger / "Incomplete response": veja `verdugo-dados/passenger.log` (ou o log indicado no painel).
- "Cannot find module 'node:sqlite'": a versão do Node escolhida é antiga — troque para 22.13+ e *Restart*.
- "node_modules" com erro no NPM Install: apague a pasta `verdugo-app/node_modules` se ela tiver sido enviada e rode de novo.

## Testes feitos antes de publicar

- 24 testes automáticos das regras (`npm test`), incluindo um novo para a trava geral de login.
- Simulação do carregador do Passenger (o app entra por `app.cjs`, o Passenger assume a porta) com banco numa pasta
  privada separada, verificando: primeira configuração (código errado recusado, conta única, tela some depois),
  importação preservando "a confirmar"; 16 caminhos privados (planilha, banco, código, `.env`, `node_modules`,
  comprovantes…) respondendo 404/redirect sem login; 7 APIs respondendo 401 sem login; cookie `HttpOnly`+`Secure`+
  `SameSite=Strict`; HSTS; proteção contra requisição de outro site; logout; **reinício do app mantendo lançamentos e
  comprovante idêntico**; backup baixado e **restauração** devolvendo exatamente o estado salvo; bloqueio após 5 senhas
  erradas por IP.
