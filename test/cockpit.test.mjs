// A reforma "Cockpit" (#364, Proposta A da #360): tema escuro com contraste AA, o logo "B", o quadro em KANBAN por estado
// (com a lista a um clique) e a esteira da tarefa em 4 passos na ficha. Os dados são os da demonstração (fictícios).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { criarCaixa, subirBoard, limparCaixa, esperar } from "./ajuda.mjs";
import { montarDemo } from "./demo.mjs";
import { abrirNavegador, CHROME } from "./navegador.mjs";

const pular = !CHROME && "sem Chrome nesta máquina";
let caixa, b, nav;
const COLUNAS = ["pendentes", "fila", "rodando", "conferir", "concluidas"];

before(async () => {
  caixa = criarCaixa();
  montarDemo(caixa.dev, join(caixa.raiz, "memoria"), join(caixa.board, "data"));
  b = await subirBoard(caixa, { BOARD_REVISOR: "0", BOARD_QA: "0" });
  await b.api("POST", "/api/fila/pausar").catch(() => {});
  if (!pular) nav = await abrirNavegador({ visao: null }); // sem escolher a visão: vale o padrão do board
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
const coluna = (t) => t.status === "pendente" && !t.busy ? "pendentes" : t.status === "fila" ? "fila"
  : t.status === "rodando" || t.busy ? "rodando" : t.status === "concluida" ? "concluidas" : "conferir";

test("o quadro abre em kanban: 5 colunas por estado, cada tarefa numa só, contador certo; a lista continua a um clique", { skip: pular }, async () => {
  const { tasks } = JSON.parse((await b.api("GET", "/api/state")).txt);
  await nav.tamanho(1440, 1000);
  await abrir();
  const cols = await nav.avaliar(`[...document.querySelectorAll("#kanban .kcol")].map((c) => ({ id: c.dataset.col, n: Number(c.querySelector("h3 b").innerText), ids: [...c.querySelectorAll(".kcard")].map((k) => Number(k.dataset.id)) }))`);
  assert.deepEqual(cols.map((c) => c.id), COLUNAS);
  for (const c of cols) {
    const esperadas = tasks.filter((t) => coluna(t) === c.id).map((t) => t.id).sort((a, b) => a - b);
    assert.equal(c.n, esperadas.length, `contador de ${c.id}`);
    assert.deepEqual([...c.ids].sort((a, b) => a - b), esperadas.slice(0, 30).length === esperadas.length ? esperadas : [...c.ids].sort((a, b) => a - b), `tarefas de ${c.id}`);
  }
  const todas = cols.flatMap((c) => c.ids);
  assert.equal(new Set(todas).size, todas.length, "nenhuma tarefa em duas colunas");
  assert.equal(await nav.avaliar(`!!document.querySelector(".composer #newTask")`), true, "a caixa de nova tarefa continua");
  assert.equal(await nav.avaliar(`!!document.querySelector(".overview")`), false, "o resumo some: as colunas já contam");
  // o cartão abre a ficha
  const id = cols.find((c) => c.ids.length).ids[0];
  await nav.avaliar(`document.querySelector('.kcard[data-id="${id}"] .kt').click()`);
  await ate(`location.hash === "#/t/${id}" && !!document.querySelector(".dhead")`);
  // ☰ Lista: as abas de sempre, com a lista e a paginação; ▦ Kanban volta
  await abrir();
  await nav.avaliar(`document.querySelector('.visao-btn[data-visao="lista"]').click()`);
  await ate(`!!document.querySelector("#list") && !document.querySelector("#kanban")`);
  assert.equal(await nav.avaliar(`localStorage.getItem("board.visao")`), '"lista"', "a escolha fica guardada");
  await nav.avaliar(`document.querySelector('.visao-btn[data-visao="kanban"]').click()`);
  await ate(`!!document.querySelector("#kanban") && !document.querySelector("#list")`);
  // clicar numa aba (Pendentes) é ir para a lista dela
  await nav.avaliar(`document.querySelector('.tab[data-tab="pendentes"]').click()`);
  await ate(`!!document.querySelector("#list.pendentes")`);
  assert.deepEqual(nav.erros, []);
});

test("▶ no cartão pendente põe a tarefa na fila; ela muda de coluna sozinha", { skip: pular }, async () => {
  await abrir();
  const id = await nav.avaliar(`Number(document.querySelector('.kcol[data-col="pendentes"] .kcard')?.dataset.id || 0)`);
  assert.ok(id, "a demonstração tem pendente");
  await nav.avaliar(`document.querySelector('.kcard[data-id="${id}"] .ka .ib').click()`);
  await ate(`!!document.querySelector('.kcol[data-col="fila"] .kcard[data-id="${id}"]') || !!document.querySelector('.kcol[data-col="rodando"] .kcard[data-id="${id}"]')`);
});

test("celular: as colunas passam de lado, a página não rola de lado, e o topo traz o logo B sem nome de outra empresa", { skip: pular }, async () => {
  await nav.tamanho(390, 844);
  await abrir();
  const m = await nav.avaliar(`(() => { const k = document.querySelector("#kanban"); return { pagina: document.documentElement.scrollWidth, kan: k.scrollWidth, vis: k.clientWidth, logo: document.querySelector(".brand-logo")?.innerText, txt: document.body.innerText }; })()`);
  assert.ok(m.pagina <= 390, "a página não passa da largura: " + m.pagina);
  assert.ok(m.kan > m.vis, "o kanban rola de lado");
  assert.equal(m.logo, "B");
  assert.doesNotMatch(m.txt, /acme/i);
  await nav.tamanho(1440, 1000);
});

test("ficha: a esteira em 5 passos (agente, portão, revisor, QA, PR), cada um com o estado escrito", { skip: pular }, async () => {
  const { tasks } = JSON.parse((await b.api("GET", "/api/state")).txt);
  const t = tasks.find((x) => x.gate && x.status === "executada") || tasks.find((x) => x.status === "executada");
  await abrir("#/t/" + t.id);
  await ate(`document.querySelectorAll(".esteira .passo").length === 5`);
  const passos = await nav.avaliar(`[...document.querySelectorAll(".esteira .passo")].map((p) => p.innerText.replace(/\\s+/g, " ").trim())`);
  assert.deepEqual(passos.map((p) => p.split(" ")[1]), ["Agente", "Portão", "Revisor", "QA", "PR"]);
  for (const p of passos) assert.match(p, /passou|reprovou|rodando agora|ainda não|aberto/, "estado por escrito, não só cor: " + p);
  if (t.gate) assert.match(passos[1], t.gate.ok ? /passou/ : /reprovou/);
  assert.match(passos[0], /passou/, "tarefa executada: o agente terminou");
});

test("contraste AA no escuro: texto, texto apagado e o verde dos botões", { skip: pular }, async () => {
  await abrir();
  const r = await nav.avaliar(`(() => {
    const cs = getComputedStyle(document.documentElement), v = (n) => cs.getPropertyValue(n).trim();
    const lum = (h) => { const c = h.replace("#", "").match(/../g).map((x) => parseInt(x, 16) / 255).map((x) => x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
    const k = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    return { txt: k(v("--txt"), v("--panel2")), dim: k(v("--dim"), v("--panel2")), dim2: k(v("--dim2"), v("--panel2")), dim2bg: k(v("--dim2"), v("--bg")), btn: k("#03130a", v("--green")), run: k(v("--run"), v("--panel2")) };
  })()`);
  for (const [nome, x] of Object.entries(r)) assert.ok(x >= 4.5, `${nome}: ${x.toFixed(2)}:1`);
});

test("as outras telas no cockpit: cabeçalho de painel e inspetor (Conversa, Buscar, Sessões), PRs em painéis, Controle com cabeçalho", { skip: pular }, async () => {
  await nav.tamanho(1440, 1000);
  for (const [hash, titulo, inspetor] of [["#/c/loja-online", null, "#convLado"], ["#/busca", "Buscar", "#buscaHist"], ["#/sessoes", "Sessões", ".ses-lado"], ["#/prs", "Pull Requests", null]]) {
    await abrir(hash);
    if (titulo) await ate(`document.querySelector(".mhead h2")?.innerText === ${JSON.stringify(titulo)}`);
    if (inspetor) {
      await ate(`!!document.querySelector(${JSON.stringify(inspetor)})`);
      const r = await nav.avaliar(`(() => { const a = document.querySelector(${JSON.stringify(inspetor)}).getBoundingClientRect(); return { esq: a.left, larg: a.width }; })()`);
      assert.ok(r.esq > 900 && r.larg >= 280, `${hash}: o inspetor à direita (${JSON.stringify(r)})`);
    }
  }
  // a Conversa lista as conversas dos projetos e as tarefas do projeto, com link
  await abrir("#/c/loja-online");
  await ate(`!!document.querySelector('#convLado a[href="#/c/api-pagamentos"]') && !!document.querySelector('#convLado a[href^="#/t/"]')`);
  await abrir("", { tab: "controle" });
  await ate(`document.querySelector(".mhead h2")?.innerText === "Controle" && !!document.querySelector("#controle")`);
  assert.deepEqual(nav.erros, []);
});

test("kanban: as abas de estado do celular e o 🖥 do cabeçalho não mexem no filtro de projeto (eram tratados como filtro)", { skip: pular }, async () => {
  await nav.tamanho(390, 844);
  await abrir();
  await nav.avaliar(`document.querySelector('.kchips .chip[data-kcol="concluidas"]').click()`);
  await ate(`document.querySelector('.kchips .chip.on')?.dataset.kcol === "concluidas"`);
  assert.equal(await nav.avaliar(`localStorage.getItem("board.filtro")`), null, "o filtro não mudou");
  await nav.tamanho(1440, 1000);
});

test("letra: 16 px no corpo por padrão, A+/A− mudam o board inteiro e o tamanho fica guardado no aparelho", { skip: pular }, async () => {
  await nav.tamanho(1440, 1000);
  await abrir("#/central");
  const medir = () => nav.avaliar(`({ html: parseFloat(getComputedStyle(document.documentElement).fontSize), corpo: parseFloat(getComputedStyle(document.body).fontSize), titulo: parseFloat(getComputedStyle(document.querySelector(".central-nome")).fontSize) })`);
  const antes = await medir();
  assert.equal(antes.corpo, 16, "corpo em 16 px");
  assert.ok(antes.titulo > antes.corpo, "título maior que o corpo");
  await nav.avaliar(`document.querySelector('.fonte-ctl [aria-label="Letra maior"]').click()`);
  const maior = await medir();
  assert.ok(maior.corpo > 16 && maior.titulo > antes.titulo, JSON.stringify(maior));
  assert.equal(await nav.avaliar(`localStorage.getItem("board.fonte")`), String(maior.html));
  await nav.carregar(b.url + "/?z=" + Math.random() + "#/central"); await nav.quieto();
  assert.equal((await medir()).html, maior.html, "o tamanho escolhido volta ao recarregar");
  await nav.avaliar(`document.querySelector('.fonte-ctl [aria-label="Letra menor"]').click()`);
  assert.equal((await medir()).html, 16);
  // no celular o maior tamanho não faz a página rolar de lado
  await nav.avaliar(`localStorage.setItem("board.fonte", "22")`);
  await nav.tamanho(390, 844);
  for (const hash of ["", "#/central", "#/t/12"]) {
    await nav.carregar(b.url + "/?w=" + Math.random() + hash); await nav.quieto({ min: 400 });
    assert.ok(await nav.avaliar(`document.documentElement.scrollWidth <= innerWidth`), "sem rolar de lado em " + (hash || "quadro"));
  }
  await nav.avaliar(`localStorage.removeItem("board.fonte")`);
  await nav.tamanho(1440, 1000);
  assert.deepEqual(nav.erros, []);
});
