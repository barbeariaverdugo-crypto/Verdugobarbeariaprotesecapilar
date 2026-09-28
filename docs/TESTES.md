# Testes realizados e evidências

Três baterias, todas automáticas e repetíveis:

- **Regras (API)** — `npm test` → **23/23 ok** (`docs/evidencias/testes-api.txt`): 14 dos fluxos exigidos + 9 de regressão. Cada arquivo de teste roda num banco novo com a planilha importada.
- **Tela no navegador** — `tests/rodar_ui.sh` → **19/19 ok** (Chromium real, celular 390×844 e computador 1366×860; `docs/evidencias/resultado-ui.json` + capturas `*.png`).
- **Reconciliação com a planilha** — `tests/reconciliacao.py` → **13/13 totais iguais** (`docs/evidencias/reconciliacao.txt`).

| # | Exigência | Como foi validado | Resultado |
|---|---|---|---|
| 1 | Atendimento com serviço principal + vários adicionais | API: Corte + Barba + Sobrancelha (preço praticado 30 em vez de 35), desconto 10, recebido 115,50 → subtotal 130, total 120, taxa 4,50, comissão 65. Mudar o preço do Corte no catálogo **não** alterou o atendimento. Tela: mesmo fluxo no celular (captura `celular-03`). | ok |
| 2 | Barbeiro novo aparece nos lançamentos e relatórios | Cadastrei “Lucas” (40%), lancei atendimento, apareceu no relatório com comissão 22,00. Desativado: some da lista de lançamento, continua no relatório. | ok |
| 3 | Anotações ligadas ao barbeiro | Notas do Pedro e do André ficam separadas; sem login a API recusa (401). Tela: ao escolher “André” no atendimento, o painel de anotações dele aparece e a nota fica só nele. | ok |
| 4 | Balcão baixa o mesmo estoque do online | ARG-001: balcão −2 e Shopee −1 no mesmo saldo; cancelar a venda devolve, reativar baixa de novo. Tela: balcão 25→23 e TikTok Shop 23→22. | ok |
| 5 | Quatro canais distintos nos relatórios | Um pedido em cada canal; relatório mostra Mercado Livre, Shopee, TikTok Shop e Amazon separados com bruto/taxas/frete/líquido corretos. | ok |
| 6 | Reimportar não duplica | Importei o mesmo CSV duas vezes: 2 criados, depois 0 criados/2 sem alteração, estoque igual. Reimportar com a data do repasse só **atualizou** o pedido. Mesmo número em outro canal = outro pedido. | ok |
| 7 | Cancelado/devolvido | Cancelado: estoque volta e o histórico mostra `venda_online −2` e `cancelamento +2`; o pedido aparece em “cancelados” no relatório e não soma no faturamento. Devolvido sem retorno mantém a baixa; com retorno repõe. | ok |
| 8 | Conta paga entra uma vez no caixa | Pagar gera 1 saída; pagar de novo → recusado (409); desfazer e pagar de novo continua 1 saída. Contas-exemplo da planilha não podem ser pagas nem entram nas saídas sem confirmação. | ok |
| 9 | Fechamento separa bruto, taxas, líquido e repasse | Semana 21–27/09: bruto 1.050,00, taxas 168,05 (maquininha 3,00 + ML 142,50 + frete 22,55), líquido 881,95; repasse de uma venda do dia 10 entrou **pela data do repasse** (23/09); venda sem repasse aparece “a receber”. Bônus 10% sobre a comissão guardado. Correção depois do fechamento: continua editável e o fechamento mostra a diferença. | ok |
| 10 | Texto em campo numérico não quebra totais | 7 tentativas (“Haver”, “abc”, “dois”, “dez reais”…) em atendimento, balcão, online, saída e conta → todas recusadas com mensagem, totais intactos. Importação: só o pedido com “Haver” foi recusado, o outro entrou. Tela: campo fica vermelho e o envio é bloqueado. | ok |
| 11 | Celular e computador, só a sua conta | Sem login: `/` redireciona para `/login`, `app.js` e API respondem 302/401, não existe cadastro público, requisição forjada é recusada (403), 5 senhas erradas bloqueiam o login (429), após “Sair” a API recusa. Tela sem rolagem horizontal nos dois tamanhos e sem erros de console/segurança. | ok |
| 12 | Totais reconciliam com a planilha | Os mesmos 5 atendimentos, 3 vendas de balcão, 3 pedidos ML/Shopee e 2 saídas lançados na planilha (recalculada no LibreOffice) e no app: valor cheio 420,00, recebido 414,30, comissão 210,00, saídas 100,90, balcão 390,00 (6 itens), ML bruto 629,64 / taxas 114,16 / frete 22,55 / líquido 492,93, Shopee bruto 170,00 / líquido 114,20 e o saldo dos 47 SKUs — **tudo igual**. | ok |
| extra | Backup e restauração | Backup baixado pela tela abre como banco completo; restauração testada (apaguei dados, copiei o backup, tudo voltou). | ok |

Observação sobre o item 12: nos pedidos online o app usa as **tarifas efetivamente cobradas** (no teste, as mesmas que a planilha calculou). Os totais batem com os mesmos insumos; a diferença de propósito é que o app não assume tabelas de tarifa fixas.

## Capturas de tela (docs/evidencias)

`celular-01-login` · `celular-02-inicio` · `celular-03-atendimento-varios-servicos` · `celular-04-lista-atendimentos` ·
`celular-05-venda-balcao` · `celular-06-vendas-online` · `computador-02-inicio` · `computador-07-atendimentos` ·
`computador-08-importar` · `computador-09-estoque` · `computador-10-contas` · `computador-11-relatorio` ·
`computador-12-fechamentos` · `computador-13-cadastros` · `computador-14-produto-a-confirmar`

## Revisão independente

Depois dos testes passarem, pedi uma revisão adversarial separada do código (sem acesso ao meu raciocínio). Ela
rodou ~2.000 operações aleatórias de estoque sem encontrar divergência, mas confirmou 8 defeitos que os testes não
pegavam. Todos foram corrigidos e cada um ganhou um teste (`tests/regressao.test.js`, R1–R9):

| Defeito encontrado | Correção |
|---|---|
| Reimportar um CSV apagava repasse/observação e o “não voltou ao estoque” lançados à mão | a importação só muda esses campos se o arquivo trouxer valor |
| Pedido com SKU ainda não cadastrado nunca baixava estoque depois do cadastro | ao cadastrar (ou corrigir) o SKU, os pedidos pendentes são ligados e baixados uma vez |
| Porcentagem “1” virava 100% | porcentagem é sempre lida em % (1 = 1%, 0,5 = 0,5%) |
| Mudar a regra da comissão recalculava atendimentos antigos ao editá-los | a forma de cálculo fica gravada em cada atendimento |
| Repasse com data futura contava como dinheiro já recebido | só conta a partir do dia do repasse; antes disso fica “a receber” |
| “Não pago” era lido como “pago” | status negativo/ambíguo é recusado com mensagem; tarifas negativas do extrato entram como taxa |
| SKU transferido para outro produto deixava a baixa no produto errado | a baixa é desfeita no produto antigo e refeita no novo |
| Algumas entradas estranhas causavam erro 500 (cookie malformado, linha vazia, parâmetros inválidos) | tratadas com mensagem; CSV exportado também neutraliza textos que virariam fórmula no Excel |
