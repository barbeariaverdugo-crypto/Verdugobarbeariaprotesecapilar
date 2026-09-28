-- Verdugo — esquema do banco (SQLite). Valores em dinheiro sempre em CENTAVOS (inteiro).
-- Datas de negócio em 'AAAA-MM-DD' (horário de São Paulo); carimbos de hora em ISO UTC.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),          -- só existe UMA conta: a do proprietário
  email TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,                            -- hash SHA-256 do token (o token em si só fica no cookie)
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT, user_agent TEXT
);

CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT NOT NULL, at TEXT NOT NULL, ok INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(ip, at);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- ---------- Cadastros ----------
CREATE TABLE IF NOT EXISTS barbers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  commission_pct REAL,                            -- NULL = usa a % padrão das configurações
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS barber_notes (
  id INTEGER PRIMARY KEY,
  barber_id INTEGER NOT NULL REFERENCES barbers(id),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

-- listas simples: formas de pagamento, categorias de produto/despesa, responsáveis por saídas
CREATE TABLE IF NOT EXISTS lists (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('pagamento','cat_produto','cat_despesa','responsavel')),
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  UNIQUE (kind, name)
);

-- ---------- Produtos e estoque (SKU único em todos os canais) ----------
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  category TEXT,
  cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  price_cents INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  min_stock INTEGER NOT NULL DEFAULT 0,
  supplier TEXT, notes TEXT,
  cost_pending INTEGER NOT NULL DEFAULT 0,        -- 1 = custo não confirmado (veio zerado/ilegível da planilha)
  price_pending INTEGER NOT NULL DEFAULT 0,       -- 1 = preço não confirmado
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

-- O saldo de estoque é SEMPRE a soma das movimentações (nunca um número digitado por cima).
CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('saldo_inicial','compra','ajuste','venda_balcao','venda_online',
                                      'cancelamento','devolucao','estorno')),
  qty INTEGER NOT NULL CHECK (qty <> 0),          -- positivo = entrada, negativo = saída
  unit_cost_cents INTEGER,
  source TEXT,                                    -- 'balcao' | 'online' | 'manual' | 'planilha'
  source_id INTEGER, source_item_id INTEGER,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mov_product ON stock_movements(product_id);
CREATE INDEX IF NOT EXISTS idx_mov_source ON stock_movements(source, source_item_id);

-- ---------- Atendimentos (serviço principal + vários adicionais) ----------
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  barber_id INTEGER NOT NULL REFERENCES barbers(id),
  payment_method TEXT NOT NULL,
  subtotal_cents INTEGER NOT NULL,                -- soma dos itens (preços praticados)
  discount_cents INTEGER NOT NULL DEFAULT 0,      -- desconto dado ao cliente
  total_cents INTEGER NOT NULL,                   -- subtotal - desconto
  received_cents INTEGER NOT NULL,                -- o que de fato entrou (após taxa de maquininha)
  card_fee_cents INTEGER NOT NULL DEFAULT 0,      -- total - recebido
  commission_pct REAL NOT NULL,                   -- % congelada no momento do lançamento
  commission_base_mode TEXT,                      -- 'tabela' | 'apos_desconto', congelado no lançamento
  commission_base_cents INTEGER NOT NULL,
  commission_cents INTEGER NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo','cancelado')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_appt_date ON appointments(date);

CREATE TABLE IF NOT EXISTS appointment_items (
  id INTEGER PRIMARY KEY,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  service_id INTEGER REFERENCES services(id),
  service_name TEXT NOT NULL,                     -- cópia do nome e do preço praticados (não muda se o catálogo mudar)
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  is_main INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0
);

-- ---------- Vendas de balcão (produto, separado de serviço) ----------
CREATE TABLE IF NOT EXISTS counter_sales (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  payment_method TEXT NOT NULL,
  seller_barber_id INTEGER REFERENCES barbers(id),   -- opcional
  subtotal_cents INTEGER NOT NULL,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  received_cents INTEGER NOT NULL,
  card_fee_cents INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo','cancelado')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_counter_date ON counter_sales(date);

CREATE TABLE IF NOT EXISTS counter_sale_items (
  id INTEGER PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES counter_sales(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  sku TEXT NOT NULL, product_name TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  position INTEGER NOT NULL DEFAULT 0
);

-- ---------- Vendas online (Mercado Livre, Shopee, TikTok Shop, Amazon) ----------
CREATE TABLE IF NOT EXISTS online_orders (
  id INTEGER PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('mercado_livre','shopee','tiktok_shop','amazon')),
  order_number TEXT NOT NULL,
  date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pago','enviado','entregue','cancelado','devolvido')),
  restock_on_return INTEGER NOT NULL DEFAULT 1,   -- devolução: 1 = produto voltou ao estoque
  gross_cents INTEGER NOT NULL,                   -- valor bruto da venda
  fees_cents INTEGER NOT NULL DEFAULT 0,          -- tarifas/comissões efetivamente cobradas
  shipping_cents INTEGER NOT NULL DEFAULT 0,      -- frete pago pelo vendedor
  discount_cents INTEGER NOT NULL DEFAULT 0,      -- descontos/cupons bancados pelo vendedor
  net_cents INTEGER NOT NULL,                     -- valor líquido (a receber / recebido)
  payout_date TEXT,                               -- data do repasse (quando o dinheiro caiu)
  note TEXT,
  source TEXT NOT NULL DEFAULT 'manual',          -- 'manual' | 'importacao'
  import_batch_id INTEGER,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (channel, order_number)                  -- identificador único: reimportar não duplica
);
CREATE INDEX IF NOT EXISTS idx_online_date ON online_orders(date);

CREATE TABLE IF NOT EXISTS online_order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES online_orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id),     -- NULL = SKU não cadastrado (fica sinalizado)
  sku TEXT NOT NULL, product_name TEXT,
  qty INTEGER NOT NULL CHECK (qty > 0),
  unit_price_cents INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS import_batches (
  id INTEGER PRIMARY KEY,
  channel TEXT NOT NULL, filename TEXT,
  created_at TEXT NOT NULL,
  rows_total INTEGER, created_orders INTEGER, updated_orders INTEGER, unchanged_orders INTEGER,
  errors_json TEXT
);

-- ---------- Financeiro ----------
CREATE TABLE IF NOT EXISTS payables (
  id INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  supplier TEXT,
  category TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','pago','cancelado')),
  paid_date TEXT, payment_method TEXT,
  note TEXT,
  needs_review INTEGER NOT NULL DEFAULT 0,        -- 1 = importado da planilha, parece exemplo: confirmar
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

-- Cada gasto é uma saída individual. Conta paga gera UMA saída vinculada (payable_id UNIQUE).
CREATE TABLE IF NOT EXISTS cash_outs (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  payment_method TEXT,
  responsible TEXT,
  note TEXT,
  receipt_path TEXT,
  payable_id INTEGER UNIQUE REFERENCES payables(id),
  status TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo','cancelado')),
  needs_review INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cashout_date ON cash_outs(date);

CREATE TABLE IF NOT EXISTS cash_accounts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  opening_cents INTEGER NOT NULL DEFAULT 0,
  opening_date TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  needs_review INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

-- Fechamento guarda uma "foto" dos números; não apaga nem trava lançamentos.
CREATE TABLE IF NOT EXISTS closings (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('semana','mes')),
  start_date TEXT NOT NULL, end_date TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  bonus_json TEXT,
  note TEXT,
  closed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  before_json TEXT, after_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);
