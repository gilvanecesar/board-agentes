// As telas que saíram do menu em 04/11 (pedido do dono, por voz): Navegador, Memória e Monitoramento; o Consumo virou o
// número compacto do plano no topo. O que funcionava por baixo fica: as rotas que o painel do monitor (painel.mjs) e os
// agentes usam continuam respondendo, e a página da memória clicada (📦, Busca, Controle) abre numa janela.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { criarCaixa, criarProjeto, subirBoard, limparCaixa, esperar } from "./ajuda.mjs";
import { montarDemo } from "./demo.mjs";
import { abrirNavegador, CHROME } from "./navegador.mjs";

const pular = !CHROME && "sem Chrome nesta máquina";
let caixa, b, nav;
const MENU = ["Central", "Meu quadro", "Conversas", "Sessões", "Buscar", "Pull Requests", "Controle"];
// O rótulo curto do trilho do Cockpit (#364, Proposta A); o nome inteiro fica no aria-label/title.
const CURTO = ["Central", "Quadro", "Conv.", "Sessões", "Buscar", "PRs", "Contr."];
const NO_CELULAR = ["Central", "Meu quadro", "Conversas", "Sessões", "Pull Requests"]; // Buscar e Controle ficam no "⋯ Mais"

before(async () => {
  caixa = criarCaixa();
  montarDemo(caixa.dev, join(caixa.raiz, "memoria"), join(caixa.board, "data"));
  criarProjeto(caixa, "demo");
  b = await subirBoard(caixa, { BOARD_REVISOR: "0", BOARD_QA: "0" });
  if (!pular) nav = await abrirNavegador();
});
after(async () => { if (nav) await nav.fechar(); if (b) await b.fim(); if (caixa) limparCaixa(caixa); });

async function abrir(hash = "", local = {}) {
  await nav.carregar("about:blank");
  await nav.carregar(b.url + "/?x=" + Math.random().toString(36).slice(2));
  await nav.avaliar(`localStorage.clear(); ${Object.entries(local).map(([k, v]) => `localStorage.setItem("board.${k}", ${JSON.stringify(JSON.stringify(v))});`).join(" ")}`);
  await nav.carregar(b.url + "/?y=" + Math.random().toString(36).slice(2) + hash);
  await nav.quieto({ min: 400 });
}
async function ate(expr, limite = 15000) { const t0 = Date.now(); while (Date.now() - t0 < limite) { if (await nav.avaliar(expr)) return; await esperar(150); } throw new Error("não chegou: " + expr); }

test("o que funcionava por baixo continua: rotas do painel do monitor, memória, navegador e plano; os scripts das telas não são mais servidos", async () => {
  for (const r of ["/api/state", "/api/monitoring", "/api/central/sessoes", "/api/claude-uso", "/api/usage", "/api/memoria/grafo", "/api/memoria/mentes", "/api/navegador", "/api/controle"])
    assert.equal((await b.api("GET", r)).status, 200, r);
  assert.equal((await b.api("GET", "/api/memoria/pagina?chave=api-pagamentos/pix-webhook-idempotente")).status, 200);
  for (const f of ["consumo", "memoria", "monitoramento", "navegador"]) assert.equal((await fetch(`${b.url}/js/${f}.js`)).status, 404, f);
  const html = await (await fetch(b.url + "/")).text();
  assert.doesNotMatch(html, /\/js\/(consumo|memoria|monitoramento|navegador)\.js/);
});

test("menu: só o que resta, na ordem, sem buraco, no computador e no celular; cada item abre sem erro", { skip: pular }, async () => {
  for (const [l, a] of [[1440, 1000], [390, 844]]) {
    await nav.tamanho(l, a);
    await abrir("", { tab: "ativas" });
    const itens = await nav.avaliar(`[...document.querySelectorAll("#navigation .nav-item")].map((e) => { const r = e.getBoundingClientRect(); return { t: e.getAttribute("aria-label"), curto: e.querySelector(".nav-rot")?.innerText.trim(), x: r.left, y: r.top, w: r.width, h: r.height, svg: !!e.querySelector("svg path, svg rect, svg circle") }; })`);
    assert.deepEqual(itens.map((i) => i.t), MENU, `${l}px`);
    const vistos = itens.filter((i) => i.w > 0 && i.h > 0);
    assert.deepEqual(vistos.map((i) => i.t), l > 760 ? MENU : NO_CELULAR, `à vista (${l}px)`);
    assert.deepEqual(vistos.map((i) => i.curto), CURTO.filter((c, k) => vistos.some((v) => v.t === MENU[k])), `rótulo curto (${l}px)`);
    assert.ok(vistos.every((i) => i.svg), `todo item com ícone (${l}px)`);
    // sem buraco: a distância entre itens vizinhos é a mesma (no computador, o trilho em coluna; no celular, a barra de baixo em linha)
    const passo = vistos.slice(1).map((i, k) => l > 760 ? Math.round(i.y - vistos[k].y - vistos[k].h) : Math.round(i.x - vistos[k].x - vistos[k].w));
    assert.ok(Math.max(...passo) - Math.min(...passo) <= 1, `espaços iguais entre os itens (${l}px): ${passo}`);
    if (l <= 760) {
      await nav.avaliar(`document.querySelector(".nav-mais").click()`);
      await ate(`[...document.querySelectorAll(".mais-folha .btn")].map((b) => b.innerText).join("|").includes("Buscar") && document.querySelector(".mais-folha").getBoundingClientRect().height > 0`);
      await nav.avaliar(`document.querySelector(".nav-mais").click()`);
    }
    for (const rotulo of MENU) {
      await nav.avaliar(`[...document.querySelectorAll("#navigation .nav-item")].find((e) => e.getAttribute("aria-label") === ${JSON.stringify(rotulo)}).click()`);
      await ate(`document.querySelector("#navigation .nav-item.active")?.getAttribute("aria-label") === ${JSON.stringify(rotulo)}`);
    }
    // a barra de abas do quadro também perdeu 🖧 Status e Consumo
    await abrir("", { tab: "ativas" });
    assert.equal(await nav.avaliar(`document.querySelectorAll('.tabs [data-tab="monitoring"], .tabs [data-tab="consumo"]').length`), 0);
    // o quadro abre no kanban com a caixa de nova tarefa; o Controle, sem eles
    assert.equal(await nav.avaliar(`!!document.querySelector("#kanban") && !document.querySelector(".composer").hidden`), true, "kanban e nova tarefa no quadro");
    await nav.avaliar(`navigateBoard("controle")`);
    await ate(`!!document.querySelector("#controle") && !document.querySelector("#kanban") && document.querySelector(".composer").hidden`);
    assert.deepEqual(nav.erros, [], `${l}px`);
  }
  await nav.tamanho(1440, 1000);
});

test("aba guardada ou endereço antigo de tela removida cai no quadro, sem erro", { skip: pular }, async () => {
  for (const tab of ["memoria", "monitoring", "consumo", "navegador"]) {
    await abrir("", { tab });
    await ate(`!!document.querySelector("#newTask")`);
    assert.equal(await nav.avaliar(`document.querySelector("#navigation .nav-item.active")?.getAttribute("aria-label")`), "Meu quadro", tab);
    assert.equal(await nav.avaliar(`JSON.parse(localStorage.getItem("board.tab"))`), "ativas", tab);
    await nav.avaliar(`navigateBoard(${JSON.stringify(tab)})`);
    await ate(`!!document.querySelector("#newTask")`);
  }
  // o endereço antigo (favorito, histórico): ao chegar ele é trocado pelo do quadro
  await abrir("#/prs");
  await nav.avaliar(`location.hash = "#/navegador"`);
  await ate(`!!document.querySelector("#newTask") && location.hash === ""`);
  await nav.avaliar(`history.replaceState(null, "", "/#/navegador"); route()`);
  await ate(`!!document.querySelector("#newTask") && location.hash === ""`);
  assert.deepEqual(nav.erros, []);
});

test("a página da memória abre numa janela: da Busca (Na memória), sem sair da tela (o 📦 da ficha: interacoes.test.mjs)", { skip: pular }, async () => {
  await abrir("#/busca");
  await nav.avaliar(`(() => { const i = document.querySelector("#buscaIn"); i.value = "pix webhook"; i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
  await ate(`!!document.querySelector(".mem-hit")`);
  await nav.avaliar(`document.querySelector(".mem-hit").click()`);
  await ate(`!!document.querySelector("#memDialogo[open] h3")`);
  assert.equal(await nav.avaliar(`location.hash`), "#/busca");
  assert.ok((await nav.avaliar(`document.querySelector("#memDialogo .md").innerText`)).length > 20, "o texto da página");
  await nav.cmd("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await ate(`!document.querySelector("#memDialogo[open]")`);
  assert.deepEqual(nav.erros, []);
});
