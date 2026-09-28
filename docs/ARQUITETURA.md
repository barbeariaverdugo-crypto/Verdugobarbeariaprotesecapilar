# Arquitetura

## Visão geral

```
Celular / computador (navegador)
        │  HTTPS (link privado)
        ▼
┌──────────────────────────────┐
│ Servidor Node.js (Express)   │  um único processo
│  • tela de login             │
│  • API /api/* (só com sessão)│
│  • regras de estoque/caixa   │
└──────────────┬───────────────┘
               │
     Supabase (Postgres): todas as tabelas + comprovantes (tabela receipts ou Storage)
```

**Por que assim:** o site fica na Vercel (HTTPS, sem servidor para manter) e os dados no Supabase, porque a Vercel não
guarda arquivos entre um acesso e outro. O código continua escrevendo as consultas de forma direta: a conversa com o
Postgres acontece numa thread à parte e cada requisição é atendida por inteiro antes da próxima, então as transações
ficam isoladas como antes. Nomes e SKU usam CITEXT (sem diferença de maiúscula).

| Peça | Escolha | Motivo |
|---|---|---|
| Servidor | Node.js 22 + Express (1 dependência) | leve, roda em qualquer lugar |
| Banco | Postgres no Supabase (driver `pg`, numa thread própria — `server/db-worker.js`) | dados fora da Vercel, que não guarda arquivos; backup em JSON pela tela |
| Telas | HTML + CSS + JavaScript puro (sem etapa de build) | abre rápido no celular, fácil de manter |
| Dinheiro | sempre em **centavos inteiros** | sem erro de arredondamento |
| Datas | `AAAA-MM-DD` no fuso **America/Sao_Paulo**; exibidas `DD/MM/AAAA` | |

## Segurança

- **Uma conta só** (tabela `owner` com `CHECK (id = 1)`): não existe rota de cadastro. A conta é criada uma única vez na tela `/configurar` (exige o código `SETUP_TOKEN`) ou pelo comando `npm run definir-senha`.
- Senha guardada com **scrypt** + sal; nunca em texto.
- Sessão por cookie `HttpOnly`, `SameSite=Strict` e `Secure` (quando em HTTPS); o banco guarda só o **hash** do token. Sessão dura 14 dias; trocar a senha derruba todas.
- **Tudo** exige login: a própria tela (`/` e `app.js`) redireciona para `/login`; a API responde 401. Só a tela de login e o logotipo são públicos.
- Bloqueio após 5 senhas erradas em 15 minutos (por IP).
- Ações que gravam dados exigem um cabeçalho próprio do app (proteção contra requisições forjadas por outros sites).
- Cabeçalhos de segurança (CSP sem scripts externos, sem iframe, `nosniff`, `no-referrer`, HSTS em HTTPS).
- Credenciais de marketplace, quando houver, ficam em **variáveis de ambiente do servidor** — nunca no navegador nem no código.

## Modelo de dados (resumo)

- **Cadastros:** `barbers` (com % própria opcional e ativo/inativo), `barber_notes`, `services`, `lists` (formas de pagamento, categorias, responsáveis), `settings`.
- **Atendimentos:** `appointments` (cabeçalho: barbeiro, pagamento, desconto, recebido, taxa, % e valor da comissão **congelados**) + `appointment_items` (serviço principal + adicionais, com **nome e preço praticados** copiados — mudar o catálogo não mexe no passado).
- **Estoque central por SKU:** `products` (SKU único, sem diferença de maiúscula) + `stock_movements`. O saldo é **sempre a soma das movimentações** (saldo inicial, compra, ajuste, venda balcão, venda online, cancelamento, devolução, estorno). Nada é “digitado por cima”.
- **Vendas de balcão:** `counter_sales` + `counter_sale_items` (responsável opcional).
- **Vendas online:** `online_orders` com **identificador único (canal + número do pedido)** + `online_order_items`; guarda bruto, taxas, frete, descontos, líquido, status e **data do repasse**.
- **Financeiro:** `payables` (contas), `cash_outs` (cada saída individual; conta paga gera **uma** saída vinculada — `payable_id UNIQUE`), `cash_accounts` (saldos iniciais), `closings` (fechamentos com “foto” dos números).
- **Histórico:** `audit_log` registra antes/depois de toda criação, edição, cancelamento, importação e fechamento.

## Regras que garantem os números

1. **Estoque idempotente.** Cada item de venda tem um “efeito desejado” no estoque (ex.: pedido pago = −2; cancelado = 0). O sistema compara com o que já lançou para aquele item e grava só a diferença. Por isso reimportar o mesmo pedido, editar ou mudar o status nunca baixa duas vezes, e o histórico mostra a venda **e** o cancelamento.
2. **Status online:** pago/enviado/entregue baixam; cancelado devolve; devolvido devolve se “o produto voltou ao estoque” (padrão sim, configurável por pedido).
3. **Venda × caixa:** relatórios separam *venda* (pela data da venda: bruto, descontos, taxas, líquido) de *caixa* (pela data em que o dinheiro entrou: serviços e balcão na data do lançamento, online na **data do repasse**). Venda online sem repasse aparece como **“a receber”**.
4. **Conta paga uma vez:** pagar gera a saída vinculada; pagar de novo é recusado; desfazer o pagamento cancela a mesma saída (e pagar de novo a reativa — continua uma só).
5. **Fechamento não trava nada:** guarda a foto dos números; correções posteriores continuam permitidas, ficam no histórico, e o fechamento mostra “o que mudou depois”.
6. **Validação no servidor:** todo número passa por conversão estrita (`45`, `45,00`, `1.234,56`, `1234.56`). Texto é recusado com mensagem clara (a tela também marca em vermelho antes de enviar). Na importação, só o pedido com erro é recusado; o resto entra.
7. **Dados duvidosos** vindos da planilha ficam com `needs_review = 1` e ficam fora de todos os totais até serem confirmados.

## Onde ficam os dados e como restaurar

- Banco: Supabase (`DATABASE_URL`). Comprovantes: tabela `receipts` ou Supabase Storage.
- Backup pela tela: **Cadastros → Backup → Baixar backup completo** (arquivo `.json`) e CSVs para Excel.
- Backup pelo computador: `DATABASE_URL=... npm run backup` (guarda os 60 mais recentes em `dados/backups/`).
- **Restaurar:** `DATABASE_URL=... npm run restaurar-backup arquivo.json`.
