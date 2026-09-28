# Análise da planilha `2016 verdugo app.xlsx`

Arquivo analisado em 27/09/2026: 34 abas, 33.974 fórmulas. Recalculei a planilha com o LibreOffice e ela
abre **sem erros de fórmula** — mas, como você previu, isso não garante que as regras estejam certas.
Para verificar as regras, lancei dados de teste numa cópia e recalculei (os números abaixo vêm desse teste).

## O que existe em cada aba

| Aba | Conteúdo | Situação dos dados |
|---|---|---|
| Painel | 15 indicadores + ranking top 3 | só fórmulas |
| Produtos | 47 produtos com SKU, custo, preço, estoque, mínimo | **dados reais** (sincronizados do seu Google Planilhas em 28/07) |
| Barbeiro e Comissão | tabela de produtos vendidos na loja + ranking | vazia (nenhuma venda lançada) |
| Agosto 2026 … Julho 2028 (24 abas) | 5 semanas × 60 linhas de atendimentos + saídas do dia a dia | todas vazias |
| Resumo Mensal | soma de cada aba de mês | só fórmulas |
| Contas a Pagar | 6 contas (jun–jul/2026) | **parecem exemplo** (ex.: “Fornecedor A – lote próteses”) |
| Capital e Fluxo de Caixa | 4 saldos de banco/caixa + fluxo semanal/mensal | saldos **parecem exemplo** (4.200 / 1.850 / 320 / 600) |
| Vendas Mercado Livre / Vendas Shopee | 200 linhas cada, com fórmulas de tarifa | vazias |
| Listas (oculta) | 3 barbeiros, 46 serviços com preço, formas de pagamento, categorias, comissão padrão 50% | **dados reais** |

**Conclusão:** o que dá para aproveitar são os cadastros (barbeiros, 46 serviços, 47 produtos com saldo, listas e a
regra de 50%). Não há lançamentos de venda/atendimento no arquivo. As 6 contas e os 4 saldos de banco foram
importados **marcados como “a confirmar”** — não entram em nenhum total até você confirmar que são reais.
17 produtos têm preço ou custo zerado e ficaram marcados como “preço/custo a confirmar”.

## Verificação dos pontos levantados

| # | Ponto | Resultado | Evidência |
|---|---|---|---|
| 1 | Atendimento aceita só um serviço por linha | **Confirmado.** Cada linha da aba do mês tem um único campo “Serviço/Produto”. Combos existem só como itens fixos da lista (“Corte e Barba”). | validação de dados `C7:C66 = Listas!G2:G47` |
| 2 | Venda de produto exige barbeiro e entra no ranking junto com serviço | **Confirmado.** O ranking soma “Valor Recebido” dos serviços do mês + “Valor Total” dos produtos por barbeiro. Venda sem barbeiro não entra em ranking nem no resumo por barbeiro. Detalhe extra: os produtos entram no ranking “do mês” **sem filtro de data** (somam o ano todo). | fórmula `Barbeiro e Comissão!N2` |
| 3 | Baixa física usa nome; marketplaces usam SKU | **Confirmado.** A baixa da loja compara o **nome** do produto; ML/Shopee comparam o **SKU**. Renomear um produto quebra a baixa das vendas da loja sem aviso. | fórmula `Produtos!M2` |
| 4 | Só Mercado Livre e Shopee | **Confirmado.** Não há TikTok Shop nem Amazon. Também não existe coluna de número do pedido — não dá para evitar venda duplicada. | cabeçalhos das abas de venda |
| 5 | Estoque ignora o status do pedido | **Confirmado.** Lancei um pedido do Mercado Livre com status “Cancelado”: o estoque do PC-001 baixou 1 e o Painel somou R$ 950 no faturamento. Não há regra para devolução. | teste com LibreOffice |
| 6 | Caixa não separa bruto de líquido nem data do repasse | **Confirmado.** O fluxo de caixa soma o **valor bruto** das vendas online **pela data da venda**; não existe data de repasse. As saídas do dia a dia lançadas nas abas de mês **não entram** no fluxo de caixa (só contas pagas). O Painel mistura valor recebido (serviços, já sem taxa) com valor bruto (marketplaces). | fórmulas `Capital e Fluxo de Caixa!C22:H49`, `Painel!D6` |
| 7 | Números do painel formatados como data | **Não reproduzi no arquivo.** Os cartões de valor usam formato de moeda; só “Próximo vencimento” e “Conta vencida há mais tempo” são datas por intenção (e mostram 01/07/2026, vindo das contas-exemplo). É provável que a conversão para o Google Planilhas tenha trocado formatos. No app cada campo tem tipo fixo (dinheiro, quantidade, data). | leitura de `number_format` de todas as células do Painel |
| 8 | Sem erro de fórmula ≠ regras corretas | **Confirmado — encontrei falhas que não aparecem como erro.** Além dos itens acima: texto digitado em “Valor Recebido” nas abas de mês gera `#VALUE!` que se espalha até o Resumo Mensal (essa coluna não tem trava numérica); a comissão é calculada sobre o valor cheio mesmo quando o cliente não pagou (ex.: recebido inválido); a mesma despesa pode ser lançada em “Contas a Pagar” **e** em “Saídas” e contar duas vezes; as abas de mês começam em agosto/2026, então o fluxo de julho não pega serviços. | teste com LibreOffice |

## Regras de negócio que o app herdou da planilha (e que você pode mudar em Cadastros → Regras)

- Comissão padrão de **50%**, calculada sobre o **valor dos serviços antes do desconto** (como na planilha). Opção: calcular após o desconto. Cada barbeiro pode ter % própria.
- “Desconto maquininha” da planilha = valor cheio − valor recebido. No app isso foi separado em **desconto dado ao cliente** e **taxa da maquininha** (total − recebido).
- Bônus por meta = % sobre a comissão, definido no **fechamento da semana**.
- Tabelas de tarifa do Mercado Livre/Shopee (custo fixo por faixa de preço) **não** foram copiadas como regra fixa: o app grava as tarifas **efetivamente cobradas** em cada pedido (lançadas ou importadas do extrato do canal).
