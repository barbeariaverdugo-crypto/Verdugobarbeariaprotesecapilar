#!/usr/bin/env python3
"""
Teste de interface (navegador real, Chromium) no celular e no computador.
Uso:  BASE=http://127.0.0.1:3100 python3 tests/ui_teste.py
Pré-requisito: app rodando com a conta dono@verdugo.test / SenhaForte2026 e a planilha importada.
Salva capturas de tela em docs/evidencias/.
"""
import os, re, json, sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("BASE", "http://127.0.0.1:3100")
EMAIL, SENHA = "dono@verdugo.test", "SenhaForte2026"
OUT = Path(__file__).resolve().parent.parent / "docs" / "evidencias"
OUT.mkdir(parents=True, exist_ok=True)
resultados = []


def ok(nome, cond, detalhe=""):
    resultados.append((nome, bool(cond), detalhe))
    print(("OK   " if cond else "FALHA"), nome, detalhe)


def login(page):
    page.goto(BASE + "/")
    page.wait_for_url("**/login")
    page.fill("input[name=email]", EMAIL)
    page.fill("input[name=senha]", SENHA)
    page.click("button[type=submit]")
    page.wait_for_url(BASE + "/")
    page.wait_for_selector(".kpi")


def pick(loc, prefix):
    """Seleciona a opção cujo texto começa com o prefixo."""
    val = loc.evaluate("(el, p) => [...el.options].find(o => o.text.startsWith(p))?.value", prefix)
    assert val, f"opção não encontrada: {prefix}"
    loc.select_option(val)


def api(page, path):
    return page.evaluate("p => fetch('/api' + p).then(r => r.json())", path)


with sync_playwright() as p:
    browser = p.chromium.launch()
    for modo, vp, mobile in (("celular", {"width": 390, "height": 844}, True), ("computador", {"width": 1366, "height": 860}, False)):
        ctx = browser.new_context(viewport=vp, is_mobile=mobile, has_touch=mobile, locale="pt-BR", timezone_id="America/Sao_Paulo")
        page = ctx.new_page()
        erros_console = []
        page.on("console", lambda m: m.type == "error" and erros_console.append(m.text))
        page.on("pageerror", lambda e: erros_console.append(str(e)))

        # --- acesso sem login ---
        page.goto(BASE + "/#/financeiro")
        ok(f"[{modo}] sem login vai para a tela de entrada", "/login" in page.url, page.url)
        page.screenshot(path=str(OUT / f"{modo}-01-login.png"))
        page.fill("input[name=email]", EMAIL)
        page.fill("input[name=senha]", "senha-errada-123")
        page.click("button[type=submit]")
        expect(page.locator("#erro")).to_be_visible()
        ok(f"[{modo}] senha errada é recusada", "incorretos" in page.inner_text("#erro"))
        login(page)
        page.screenshot(path=str(OUT / f"{modo}-02-inicio.png"), full_page=True)
        nav = page.locator("#bottomnav") if mobile else page.locator("#sidebar")
        ok(f"[{modo}] menu de navegação visível", nav.is_visible())
        largura = page.evaluate("document.documentElement.scrollWidth")
        ok(f"[{modo}] sem rolagem horizontal", largura <= vp["width"] + 1, f"scrollWidth={largura}")

        if modo == "celular":
            # --- atendimento com principal + 2 adicionais pela tela ---
            page.click("#bottomnav a[href='#/atendimentos']")
            page.click("[data-novo]")
            f = page.locator(".sheet form")
            f.locator("select[name=barber_id]").select_option(label="André")
            page.wait_for_selector("[data-notas] [data-salvar-nota]")
            f.locator("[data-nova-nota]").fill("André pediu para trocar a folga de sábado.")
            f.locator("[data-salvar-nota]").click()
            page.wait_for_selector("text=André pediu para trocar a folga de sábado.")
            ok("[celular] anotação salva no painel do barbeiro selecionado", True)
            pick(f.locator("[data-item] [data-svc]").first, "Corte — ")
            f.locator("[data-add]").click()
            pick(f.locator("[data-item] [data-svc]").nth(1), "Barba — ")
            f.locator("[data-add]").click()
            pick(f.locator("[data-item] [data-svc]").nth(2), "Sombrancelha — ")
            # texto em campo numérico: fica vermelho e não salva
            f.locator("[data-item] [data-preco]").nth(2).fill("Haver")
            ok("[celular] texto no preço fica marcado em vermelho", "invalido" in (f.locator("[data-item] [data-preco]").nth(2).get_attribute("class") or ""))
            f.locator("select[name=payment_method]").select_option("Pix")
            f.locator("button[type=submit]").click()
            page.wait_for_selector(".toast.erro")
            ok("[celular] envio bloqueado com aviso", "valor inválido" in page.inner_text(".toast"))
            f.locator("[data-item] [data-preco]").nth(2).fill("30,00")
            f.locator("input[name=discount]").fill("5,00")
            resumo = f.locator("[data-resumo]").inner_text()
            ok("[celular] resumo calcula 55+45+30−5 = 125", "125,00" in resumo, resumo.replace("\n", " | "))
            page.screenshot(path=str(OUT / "celular-03-atendimento-varios-servicos.png"), full_page=True)
            f.locator("button[type=submit]").click()
            page.wait_for_selector(".toast:not(.erro)")
            lista = api(page, "/atendimentos")
            a = lista[0]
            ok("[celular] atendimento salvo com 3 serviços e total 125", len(a["items"]) == 3 and a["total_cents"] == 12500 and a["barber_name"] == "André",
               f'{[i["service_name"] for i in a["items"]]} total={a["total_cents"]}')
            notas = api(page, f'/barbeiros/{a["barber_id"]}/anotacoes')
            outras = api(page, "/barbeiros/1/anotacoes") if a["barber_id"] != 1 else []
            ok("[celular] anotação ficou só no barbeiro André", any("folga de sábado" in n["text"] for n in notas) and not any("folga de sábado" in n["text"] for n in outras))
            page.screenshot(path=str(OUT / "celular-04-lista-atendimentos.png"), full_page=True)

            # --- venda de balcão ---
            antes = next(x for x in api(page, "/produtos") if x["sku"] == "ARG-001")["saldo"]
            page.click("#bottomnav a[href='#/vendas']")
            page.click("[data-novo]")
            f = page.locator(".sheet form")
            pick(f.locator("[data-prod]").first, "ARG-001")
            f.locator("[data-qtd]").first.fill("2")
            f.locator("select[name=payment_method]").select_option("Dinheiro")
            page.screenshot(path=str(OUT / "celular-05-venda-balcao.png"), full_page=True)
            f.locator("button[type=submit]").click()
            page.wait_for_selector(".toast")
            depois = next(x for x in api(page, "/produtos") if x["sku"] == "ARG-001")["saldo"]
            ok("[celular] venda de balcão baixou 2 do estoque do ARG-001", depois == antes - 2, f"{antes} -> {depois}")

            # --- pedido online manual ---
            page.goto(BASE + "/#/vendas/online")
            page.click("[data-novo]")
            f = page.locator(".sheet form")
            f.locator("select[name=channel]").select_option("tiktok_shop")
            f.locator("input[name=order_number]").fill("TT-UI-1")
            f.locator("[data-sku]").first.select_option("ARG-001")
            f.locator("input[name=fees]").fill("7,20")
            f.locator("button[type=submit]").click()
            page.wait_for_selector(".toast")
            final = next(x for x in api(page, "/produtos") if x["sku"] == "ARG-001")["saldo"]
            ok("[celular] pedido TikTok Shop baixou o MESMO estoque", final == depois - 1, f"{depois} -> {final}")
            page.screenshot(path=str(OUT / "celular-06-vendas-online.png"), full_page=True)

        else:
            for rota, nome in (("#/atendimentos", "07-atendimentos"), ("#/vendas/importar", "08-importar"), ("#/estoque", "09-estoque"),
                               ("#/financeiro/contas", "10-contas"), ("#/financeiro/relatorio", "11-relatorio"),
                               ("#/financeiro/fechamentos", "12-fechamentos"), ("#/cadastros/barbeiros", "13-cadastros")):
                page.goto(BASE + "/" + rota)
                page.wait_for_selector("main .page-head")
                page.wait_for_timeout(400)
                page.screenshot(path=str(OUT / f"computador-{nome}.png"), full_page=True)
            # abrir um produto com preço a confirmar
            page.goto(BASE + "/#/estoque/confirmar")
            page.wait_for_selector("[data-list] .row")
            page.locator("[data-list] .row").first.click()
            page.wait_for_selector(".sheet .alert.amber")
            page.screenshot(path=str(OUT / "computador-14-produto-a-confirmar.png"))
            page.keyboard.press("Escape")
            # sair encerra o acesso
            page.click("#btn-sair")
            page.wait_for_url("**/login")
            st = page.evaluate("fetch('/api/inicio').then(r => r.status)")
            ok("[computador] depois de sair a API recusa (401)", st == 401, str(st))

        reais = [e for e in erros_console if "status of 401" not in e]  # 401 esperados: senha errada e teste após sair
        ok(f"[{modo}] nenhum erro no console (inclui bloqueios de segurança/CSP)", not reais, "; ".join(reais[:3]))
        ctx.close()
    browser.close()

falhas = [r for r in resultados if not r[1]]
(OUT / "resultado-ui.json").write_text(json.dumps([{"teste": n, "ok": o, "detalhe": d} for n, o, d in resultados], ensure_ascii=False, indent=1))
print(f"\n{len(resultados) - len(falhas)}/{len(resultados)} verificações OK")
sys.exit(1 if falhas else 0)
