# Pendências e decisões

## Funciona agora

Login com conta única · Início com poucos indicadores e alertas · Atendimentos com vários serviços, desconto, taxa, comissão congelada e anotações por barbeiro · Vendas de balcão (responsável opcional) · Pedidos online dos 4 canais (manual e importação CSV sem duplicar) · Estoque central por SKU com histórico, compras, ajustes, cancelamento e devolução · Contas a pagar, saídas com comprovante, caixa e bancos · Relatório por período (venda × caixa, por canal, por barbeiro) · Fechamentos semanal/mensal com bônus e “o que mudou depois” · Cadastros, regras, histórico de alterações · Exportação CSV e backup completo.

## Ainda não funciona (e por quê)

1. **Conexão automática com os marketplaces** — não está ligada. Mercado Livre, Shopee, TikTok Shop e Amazon exigem cadastro de aplicativo/desenvolvedor e credenciais de cada loja. Não simulei integração. Hoje: importar o CSV/planilha exportado de cada canal ou lançar manualmente. Com as credenciais, dá para puxar pedidos, taxas e repasses automaticamente.
2. **Formato real dos arquivos de cada canal** — o importador reconhece nomes comuns de colunas e o **modelo** do app, mas não testei com arquivos reais exportados por você. Pontos a confirmar com um arquivo real: se o canal repete o total do pedido em cada linha de item (o app soma linha a linha), e se as datas vêm no formato brasileiro (DD/MM/AAAA — datas no formato americano seriam lidas errado). Hoje o importador lê CSV; se o canal só exporta .xlsx, abra e salve como CSV (ou peço para aceitar .xlsx direto). Me envie um arquivo de cada canal (pode apagar dados de cliente) e eu ajusto o mapeamento.
3. **Publicação** — o app roda localmente; publicar com HTTPS depende da sua escolha e autorização (README, seção 2).
4. **Backup automático fora do servidor** — o comando existe (`npm run backup`); agendar e copiar para um lugar externo depende de onde o app for hospedado.
5. **Recuperação de senha por e-mail** — não existe (não há serviço de e-mail). Troca pelo servidor: `npm run definir-senha`.

## Decisões que dependem de você

| # | Decisão | Como está hoje (padrão) |
|---|---|---|
| 1 | Onde hospedar (VPS, plataforma ou computador da loja + túnel) e domínio | nada contratado |
| 2 | 6 contas a pagar e 4 saldos de banco da planilha parecem **exemplo**: confirmar ou cancelar cada um | marcados “a confirmar”, fora dos totais |
| 3 | 17 produtos com preço ou custo zerado na planilha (pomadas, fitas, leave-in…) | marcados “a confirmar”; na venda o app pede o preço |
| 4 | Comissão sobre o valor antes ou depois do desconto ao cliente | antes (igual à planilha) |
| 5 | Devolução online: produto volta ao estoque? | sim, com opção “não voltou” em cada pedido |
| 6 | Quem são os **três responsáveis** pelas saídas | começou com Pedro, André e Christopher — ajuste em Cadastros → Listas |
| 7 | Pagamento de comissão/bônus aos barbeiros deve virar saída de caixa automática? | não; lance como saída na categoria “Pagamento de barbeiro” |
| 8 | Cartão: registrar a data em que a maquininha repassa (D+1, D+30)? | hoje o valor recebido do cartão conta no dia do atendimento |
| 9 | Produtos vendidos no balcão devem entrar no ranking dos barbeiros? | ranking do Início = serviços; vendas por responsável aparecem separadas no relatório |
