// Listas padrão (as mesmas da aba "Listas" da planilha), usadas numa instalação nova.
export const DEFAULT_LISTS = {
  pagamento: ['Dinheiro', 'Pix', 'Cartão de Débito', 'Cartão de Crédito', 'Transferência'],
  cat_produto: ['Próteses', 'Acessórios', 'Cuidados', 'Barbearia', 'Outros'],
  cat_despesa: ['Aluguel', 'Fornecedor', 'Compra de estoque', 'Utilidades', 'Suprimentos', 'Impostos', 'Pagamento de barbeiro', 'Outros'],
  responsavel: [],
};

export function seedDefaults(db) {
  const n = db.prepare('SELECT COUNT(*) n FROM lists').get().n;
  if (n > 0) return false;
  const ins = db.prepare('INSERT OR IGNORE INTO lists(kind, name, active, position) VALUES (?,?,1,?)');
  for (const [kind, names] of Object.entries(DEFAULT_LISTS)) names.forEach((name, i) => ins.run(kind, name, i + 1));
  return true;
}
