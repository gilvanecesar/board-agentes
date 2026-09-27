// Screen tests: a headless Chrome uses the board like the owner does — create a task, open it, chat, talk to a project,
// search, attach a file, filter. Same isolated sandbox and fake `claude`. Skipped only if there is no Chrome.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { criarCaixa, criarProjeto, subirBoard, limparCaixa, esperar, chamadas } from "./ajuda.mjs";
import { montarDemo } from "./demo.mjs";
import { abrirNavegador, CHROME } from "./navegador.mjs";

const pular = !CHROME && "sem Chrome nesta máquina";
let caixa, b, nav;

before(async () => {
  if (pular) return;
  caixa = criarCaixa();
  montarDemo(caixa.dev, join(caixa.raiz, "memoria"), join(caixa.board, "data"));
  criarProjeto(caixa, "demo");
  caixa.cenario({
    agente: [{ quando: "crie o arquivo a.txt", texto: "**Pronto.**\n\n| arquivo | mudança |\n|---|---|\n| a.txt | criado |\n\n<img src=x onerror=\"window.__xss=1\"> <script>window.__xss=2</script>" },
      { quando: "e o detalhe", texto: "respondi no chat" }, "feito"],
    conversa: ["resposta da **conversa**"],
  });
  b = await subirBoard(caixa, { BOARD_REVISOR: "0", BOARD_QA: "0" });
  nav = await abrirNavegador();
});
after(async () => { if (nav) await nav.fechar(); if (b) await b.fim(); if (caixa) limparCaixa(caixa); });

async function abrir(hash = "", local = {}) {
  await nav.carregar("about:blank");
  await nav.carregar(b.url + "/?x=" + Math.random().toString(36).slice(2));
  await nav.avaliar(`localStorage.clear(); ${Object.entries(local).map(([k, v]) => `localStorage.setItem("board.${k}", ${JSON.stringify(JSON.stringify(v))});`).join(" ")}`);
  await nav.carregar(b.url + "/?y=" + Math.random().toString(36).slice(2) + hash);
  await nav.quieto();
  nav.erros.length = 0;
}
const texto = () => nav.avaliar("document.body.innerText");
async function ate(expr, limite = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < limite) { if (await nav.avaliar(expr)) return true; await esperar(150); }
  throw new Error("a tela não chegou em: " + expr + "\n" + (await texto()).slice(0, 1500));
}
const digitar = (sel, valor, enter = true) => nav.avaliar(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.focus(); e.value = ${JSON.stringify(valor)};
  e.dispatchEvent(new Event("input", { bubbles: true }));
  ${enter ? `e.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));` : ""} return true; })()`);
const clicar = (sel) => nav.avaliar(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);

test("todas as telas abrem sem erro de JavaScript, no computador e no celular", { skip: pular }, async () => {
  const telas = [["ativas", ""], ["pendentes", ""], ["executadas", ""], ["concluidas", ""], ["consumo", ""], ["monitoring", ""], ["controle", ""], ["memoria", ""]];
  const rotas = ["#/t/12", "#/t/14", "#/t/3", "#/c/loja-online", "#/busca"];
  for (const [l, a] of [[1440, 1000], [390, 844]]) {
    await nav.tamanho(l, a);
    for (const [tab] of telas) { await abrir("", { tab }); await nav.quieto({ min: 400 }); assert.deepEqual(nav.erros, [], `aba ${tab} (${l}px)`); }
    for (const r of rotas) { await abrir(r); await nav.quieto({ min: 400 }); assert.deepEqual(nav.erros, [], `${r} (${l}px)`); }
    for (const modo of ["grafo", "galpao"]) { await abrir("", { tab: "memoria", memoriaModo: modo }); await nav.quieto({ min: 400 }); assert.deepEqual(nav.erros, [], `memória ${modo} (${l}px)`); }
  }
  await nav.tamanho(1440, 1000);
});

test("incluir tarefa pela caixa: entra na fila, roda, e a resposta do agente vira markdown SEM executar o HTML dele", { skip: pular }, async () => {
  await abrir("", { tab: "ativas", project: "demo", autoQueue: true });
  await digitar("#newTask", "crie o arquivo a.txt");
  // Confere no SERVIDOR que a tela criou a tarefa: na lista ela pode já ter passado de Ativas para Executadas
  // (o claude falso responde em milissegundos) — olhar a lista aqui era um teste instável.
  await ate(`(async () => (await (await fetch("/api/state")).json()).tasks.some((x) => x.title === "crie o arquivo a.txt"))()`);
  assert.equal(await nav.avaliar(`document.querySelector("#newTask").value`), "", "a caixa limpa depois de incluir");
  const st = await b.api("GET", "/api/state");
  const t = st.json.tasks.find((x) => x.title === "crie o arquivo a.txt");
  assert.ok(t, "a tarefa foi criada no servidor");
  assert.equal(t.project, "demo");
  await ate(`(async () => (await (await fetch("/api/tasks/${t.id}")).json()).task.status === "executada")()`);
  await abrir(`#/t/${t.id}`);
  await ate(`!!document.querySelector("#timeline table")`);
  assert.ok(await nav.avaliar(`!!document.querySelector("#timeline strong")`), "negrito do markdown");
  assert.equal(await nav.avaliar(`document.querySelectorAll("#timeline img, #timeline script").length`), 0, "HTML do agente não vira elemento");
  assert.equal(await nav.avaliar("window.__xss"), undefined, "nenhum script do agente rodou");
  // chat na mesma tarefa
  await digitar("#chatIn", "e o detalhe?");
  await ate(`document.querySelector("#timeline").innerText.includes("e o detalhe?")`);
  await ate(`document.querySelector("#timeline").innerText.includes("respondi no chat")`);
  assert.deepEqual(nav.erros, []);
});

test("conversa do projeto: pergunta e resposta na tela, com markdown", { skip: pular }, async () => {
  await abrir("#/c/demo");
  await digitar("#convIn", "o que tem aqui?");
  await ate(`document.body.innerText.includes("o que tem aqui?")`);
  await ate(`[...document.querySelectorAll("strong")].some((e) => e.textContent === "conversa")`);
  assert.equal(chamadas(caixa).filter((c) => c.papel === "conversa").length, 1);
  assert.deepEqual(nav.erros, []);
});

test("busca: acha a tarefa pelo assunto e o clique abre a ficha", { skip: pular }, async () => {
  await abrir("#/busca");
  await digitar("#buscaIn", "webhook do pix");
  await ate(`!!document.querySelector(".bres")`);
  assert.match(await texto(), /Pix pago não libera o pedido/);
  await clicar(".bres");
  await ate(`location.hash.startsWith("#/t/")`);
});

test("pendentes: ▶ põe a tarefa na fila", { skip: pular }, async () => {
  await b.api("POST", "/api/fila/pausar"); // a fila não pode pegar a tarefa antes de conferirmos
  try {
    await abrir("", { tab: "pendentes" });
    await ate(`!!document.querySelector('.task[data-id="1"] button[title="Colocar na fila"]')`);
    await clicar('.task[data-id="1"] button[title="Colocar na fila"]');
    await ate(`(async () => (await (await fetch("/api/tasks/1")).json()).task.status === "fila")()`);
  } finally { await b.api("PATCH", "/api/tasks/1", { status: "pendente" }); await b.api("POST", "/api/fila/retomar"); }
});

test("filtro por projeto: só as tarefas daquele projeto", { skip: pular }, async () => {
  await abrir("", { tab: "concluidas" });
  await clicar('.chip[data-proj="api-pagamentos"]');
  await ate(`document.querySelectorAll("#list .task").length > 0`);
  const projs = await nav.avaliar(`[...document.querySelectorAll("#list .task .proj")].map((e) => e.textContent)`);
  assert.ok(projs.length && projs.every((p) => p === "api-pagamentos"), projs.join(","));
});

test("📎 anexar: imagem entra; tipo não aceito AVISA (nunca recusa calado)", { skip: pular }, async () => {
  const png = join(caixa.raiz, "print.png");
  writeFileSync(png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]));
  const docx = join(caixa.raiz, "contrato.docx"); writeFileSync(docx, "PK não sou aceito");
  await abrir("", { tab: "ativas" });
  const { root } = await nav.cmd("DOM.getDocument");
  const { nodeId } = await nav.cmd("DOM.querySelector", { nodeId: root.nodeId, selector: "#arqBtn" });
  await nav.cmd("DOM.setFileInputFiles", { nodeId, files: [png] });
  await ate(`!document.querySelector("#anexosIncluir").hidden && !!document.querySelector('#anexosIncluir .anexo[title="print.png"] img')`);
  const { root: r2 } = await nav.cmd("DOM.getDocument");
  const { nodeId: n2 } = await nav.cmd("DOM.querySelector", { nodeId: r2.nodeId, selector: "#arqBtn" });
  await nav.cmd("DOM.setFileInputFiles", { nodeId: n2, files: [docx] });
  await ate(`document.body.innerText.includes("não aceito contrato.docx")`);
});

test("curva de giro: o servidor conta por onde cada memória passou", { skip: pular }, async () => {
  const g = (await b.api("GET", "/api/memoria/grafo")).json;
  assert.ok(g.giroDesde, "desde quando há romaneio");
  const no = (k) => g.nos.find((n) => n.chave === k);
  assert.equal(no("_global/respostas-curtas").giro.saidas, 4);
  assert.equal(no("_global/respostas-curtas").giro.conserto, 1, "a #9 passou depois de conserto");
  assert.equal(no("_global/respostas-curtas").giro.primeira, 3);
  assert.deepEqual(no("api-pagamentos/pix-webhook-idempotente").giro.tarefas.map((t) => t.id), [12]);
  assert.equal(no("app-entregas/rota-recalcula").giro, undefined, "memória que nunca saiu não tem giro");
});

test("galpão por GIRO: o que mais sai fica no nível 1, a legenda muda e a ficha mostra as tarefas (sem prometer que ajudou)", { skip: pular }, async () => {
  await nav.tamanho(1440, 1000);
  await abrir("", { tab: "memoria", memoriaModo: "galpao", galpaoNivel: "giro", galpaoPP: "tipo" });
  await ate(`!!document.querySelector('[data-nivel="giro"].on')`);
  assert.match(await texto(), /nunca saiu/);
  assert.match(await texto(), /nunca foram a uma tarefa/);
  // idade e giro discordam: "dinheiro em centavos" saiu 1 vez e tem 90 dias; "estorno" nunca saiu e tem 42 dias
  const ordem = (k) => nav.avaliar(`(() => { const e = document.querySelector('.gp-p[data-chave="${k}"]').dataset.end.match(/-N(\\d+)-(\\d+)$/); return Number(e[1]) * 100 + Number(e[2]); })()`);
  assert.ok(await ordem("api-pagamentos/dinheiro-em-centavos") < await ordem("api-pagamentos/estorno-mesmo-meio"), "por giro, a que saiu vem antes (mais perto da doca)");
  const primeiro = await nav.avaliar(`document.querySelector('.gp-p[data-chave="_global/respostas-curtas"]').dataset.end`);
  assert.match(primeiro, /-N1-01$/, "respostas-curtas (4 saídas) está na frente da doca: " + primeiro);
  await ate(`(() => { const b = document.querySelector('[data-nivel="idade"]'); if (!b) return false; b.click(); return true; })()`);
  await ate(`!!document.querySelector('[data-nivel="idade"].on')`);
  assert.ok(await ordem("api-pagamentos/dinheiro-em-centavos") > await ordem("api-pagamentos/estorno-mesmo-meio"), "por idade, a mais nova vem antes");
  await ate(`(() => { const b = document.querySelector('[data-nivel="giro"]'); if (!b) return false; b.click(); return true; })()`);
  await ate(`!!document.querySelector('[data-nivel="giro"].on')`);
  await ate(`(() => { const b = document.querySelector('.gp-p[data-chave="_global/respostas-curtas"]'); if (!b) return false; b.click(); return true; })()`);
  await ate(`document.querySelector("#grafoPagina") && /saiu em 4 tarefas/i.test(document.querySelector("#grafoPagina").innerText)`); // o título sai em maiúsculas (CSS)
  const ficha = await nav.avaliar(`document.querySelector("#grafoPagina").innerText`);
  assert.match(ficha, /não prova que ela ajudou/);
  assert.match(ficha, /3 passaram de primeira · 1 passou depois de conserto/, "com o plural certo");
  assert.match(ficha, /#12 .*passou de primeira/);
  assert.match(ficha, /#9 .*passou depois de conserto/);
  await ate(`(() => { const b = [...document.querySelectorAll("#grafoPagina .giro button")].find((x) => x.textContent.startsWith("#12")); if (!b) return false; b.click(); return true; })()`);
  await ate(`location.hash === "#/t/12"`);
  assert.deepEqual(nav.erros, []);
});
