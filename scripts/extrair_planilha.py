#!/usr/bin/env python3
"""
Lê a planilha da Verdugo (.xlsx) e gera um JSON com os dados aproveitáveis para o aplicativo.

Uso:  python3 scripts/extrair_planilha.py "2016 verdugo app.xlsx" dados/planilha_extraida.json

Regras:
- Cadastros (barbeiros, serviços, listas, produtos/SKU, estoque) são extraídos como estão.
- Preço/custo zerado vira "a confirmar" (não é tratado como preço real).
- Contas a pagar e saldos de banco/caixa que parecem EXEMPLO são marcados "needs_review" (a confirmar):
  não entram nos totais do app até o proprietário confirmar.
- Lançamentos (atendimentos, vendas de balcão, vendas ML/Shopee, saídas) são extraídos se existirem.
"""
import sys, json, datetime
import openpyxl

MONTHS = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto",
          "Setembro", "Outubro", "Novembro", "Dezembro"]


def iso(v):
    if isinstance(v, datetime.datetime):
        return v.date().isoformat()
    if isinstance(v, datetime.date):
        return v.isoformat()
    return None


def num(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    return None


def s(v):
    if v is None:
        return None
    t = str(v).strip()
    return t or None


def main(src, dst):
    wb = openpyxl.load_workbook(src, data_only=True)
    out = {"origem": src, "extraido_em": datetime.datetime.now().isoformat(timespec="seconds"),
           "listas": {}, "barbeiros": [], "servicos": [], "produtos": [], "contas": [], "caixas": [],
           "atendimentos": [], "saidas": [], "vendas_balcao": [], "vendas_online": [], "avisos": []}

    # ---------- Listas ----------
    ls = wb["Listas"]
    col = lambda c: [s(ls.cell(r, c).value) for r in range(2, ls.max_row + 1) if s(ls.cell(r, c).value)]
    out["listas"] = {"cat_produto": col(1), "pagamento": col(3), "cat_despesa": col(6)}
    out["barbeiros"] = col(2)
    pct = num(ls["K2"].value)
    out["comissao_padrao"] = pct if pct is not None else 0.5
    for r in range(2, ls.max_row + 1):
        name, price = s(ls.cell(r, 7).value), num(ls.cell(r, 8).value)
        if name:
            out["servicos"].append({"nome": name, "preco": price or 0, "preco_a_confirmar": not price})

    # ---------- Produtos / estoque ----------
    ps = wb["Produtos"]
    hdr = [s(ps.cell(1, c).value) for c in range(1, ps.max_column + 1)]
    for r in range(2, ps.max_row + 1):
        sku = s(ps.cell(r, 1).value)
        if not sku:
            continue
        cost, price = num(ps.cell(r, 4).value) or 0, num(ps.cell(r, 5).value) or 0
        inicial = num(ps.cell(r, 6).value) or 0
        vendido = num(ps.cell(r, 13).value)   # coluna M (oculta) = vendido histórico
        if vendido is None:
            vendido = 0
            out["avisos"].append(f"{sku}: sem valor calculado de vendido na planilha; considerado 0.")
        out["produtos"].append({
            "sku": sku.upper(), "nome": s(ps.cell(r, 2).value), "categoria": s(ps.cell(r, 3).value),
            "custo": cost, "preco": price, "custo_a_confirmar": cost == 0, "preco_a_confirmar": price == 0,
            "saldo": int(inicial - vendido), "minimo": int(num(ps.cell(r, 8).value) or 0),
            "fornecedor": s(ps.cell(r, 10).value), "obs": s(ps.cell(r, 11).value)})

    # ---------- Contas a pagar (parecem exemplos → a confirmar) ----------
    cp = wb["Contas a Pagar"]
    for r in range(2, cp.max_row + 1):
        desc, val = s(cp.cell(r, 2).value), num(cp.cell(r, 4).value)
        if not desc or not val:
            continue
        out["contas"].append({"vencimento": iso(cp.cell(r, 1).value), "descricao": desc, "categoria": s(cp.cell(r, 3).value),
                              "valor": val, "status": (s(cp.cell(r, 5).value) or "Pendente").lower(),
                              "pago_em": iso(cp.cell(r, 6).value), "forma": s(cp.cell(r, 7).value), "obs": s(cp.cell(r, 8).value),
                              "linha": r, "a_confirmar": True})

    # ---------- Saldos de banco/caixa (parecem exemplos → a confirmar) ----------
    cf = wb["Capital e Fluxo de Caixa"]
    for r in range(7, 17):
        name, val = s(cf.cell(r, 2).value), num(cf.cell(r, 3).value)
        if name and val is not None and not name.startswith("("):
            out["caixas"].append({"nome": name, "saldo": val, "a_confirmar": True})

    # ---------- Lançamentos das abas de mês (serviços e saídas) ----------
    for ws in wb.worksheets:
        parts = ws.title.split(" ")
        if len(parts) != 2 or parts[0] not in MONTHS:
            continue
        for r in range(1, ws.max_row + 1):
            a, b, c = ws.cell(r, 1).value, s(ws.cell(r, 2).value), s(ws.cell(r, 3).value)
            if b and c and b not in ("Barbeiro",) and c not in ("Serviço/Produto",):
                out["atendimentos"].append({"aba": ws.title, "linha": r, "data": iso(a), "barbeiro": b, "servico": c,
                                            "valor_cheio": num(ws.cell(r, 4).value), "forma": s(ws.cell(r, 5).value),
                                            "recebido_bruto": ws.cell(r, 6).value if not isinstance(ws.cell(r, 6).value, datetime.datetime) else None})
            k, l, n = ws.cell(r, 11).value, s(ws.cell(r, 12).value), ws.cell(r, 14).value
            if l and l != "Descrição/Item" and n is not None:
                out["saidas"].append({"aba": ws.title, "linha": r, "data": iso(k), "descricao": l, "categoria": s(ws.cell(r, 13).value),
                                      "valor_bruto": n, "forma": s(ws.cell(r, 15).value), "obs": s(ws.cell(r, 16).value)})

    # ---------- Vendas de produto na barbearia ----------
    bc = wb["Barbeiro e Comissão"]
    for r in range(12, 72):
        prod = s(bc.cell(r, 3).value)
        if prod:
            out["vendas_balcao"].append({"linha": r, "data": iso(bc.cell(r, 1).value), "barbeiro": s(bc.cell(r, 2).value),
                                         "produto_nome": prod, "qtd_bruta": bc.cell(r, 4).value, "preco_bruto": bc.cell(r, 5).value,
                                         "forma": s(bc.cell(r, 6).value)})

    # ---------- Vendas Mercado Livre / Shopee ----------
    for sheet, canal, cols in (("Vendas Mercado Livre", "mercado_livre", {"qtd": 4, "preco": 5, "status": 15}),
                               ("Vendas Shopee", "shopee", {"qtd": 4, "preco": 5, "status": 17})):
        ws = wb[sheet]
        for r in range(2, ws.max_row + 1):
            sku = s(ws.cell(r, 2).value)
            if sku:
                out["vendas_online"].append({"canal": canal, "linha": r, "data": iso(ws.cell(r, 1).value), "sku": sku,
                                             "qtd_bruta": ws.cell(r, cols["qtd"]).value, "preco_bruto": ws.cell(r, cols["preco"]).value,
                                             "status": s(ws.cell(r, cols["status"]).value)})

    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1, default=str)
    resumo = {k: len(v) for k, v in out.items() if isinstance(v, list)}
    print(json.dumps(resumo, ensure_ascii=False))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1], sys.argv[2])
