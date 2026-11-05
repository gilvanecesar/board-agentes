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
    conversa: ["resposta da **conversa**", "começo\n\n" + "linha da resposta longa\n\n".repeat(150) + "FIM-LONGO",
      { texto: "chegou enquanto eu lia", dorme: 1500 }, "respondi citando"],
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
  const telas = [["ativas", ""], ["pendentes", ""], ["executadas", ""], ["concluidas", ""], ["controle", ""]];
  const rotas = ["#/t/12", "#/t/14", "#/t/3", "#/c/loja-online", "#/busca", "#/prs", "#/central"];
  for (const [l, a] of [[1440, 1000], [390, 844]]) {
    await nav.tamanho(l, a);
    for (const [tab] of telas) { await abrir("", { tab }); await nav.quieto({ min: 400 }); assert.deepEqual(nav.erros, [], `aba ${tab} (${l}px)`); }
    for (const r of rotas) { await abrir(r); await nav.quieto({ min: 400 }); assert.deepEqual(nav.erros, [], `${r} (${l}px)`); }
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

test("conversa: rolagem automática acompanha resposta longa, e não puxa quem subiu para ler", { skip: pular }, async () => {
  const noFim = `window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4`;
  await abrir("#/c/demo");
  await digitar("#convIn", "manda uma resposta longa");
  await ate(`document.querySelector("#timeline").innerText.includes("FIM-LONGO")`);
  await nav.quieto({ min: 300 });
  assert.ok(await nav.avaliar(`document.documentElement.scrollHeight > window.innerHeight * 2`), "a resposta é maior que a tela");
  assert.ok(await nav.avaliar(noFim), "a resposta longa chegou e a tela desceu até o fim");
  // O dono sobe para ler enquanto a próxima resposta demora: ela chega SEM puxar a tela, com o aviso para descer.
  await digitar("#convIn", "mais uma");
  await ate(`!!document.querySelector("#timeline .thinking")`);
  await nav.avaliar(`window.scrollTo(0, 0), true`);
  await ate(`document.querySelector("#timeline").innerText.includes("chegou enquanto eu lia")`);
  await nav.quieto({ min: 300 });
  assert.equal(await nav.avaliar(`window.scrollY`), 0, "não puxou quem estava lendo lá em cima");
  await ate(`!!document.querySelector(".chatbox .descer")`);
  await clicar(".chatbox .descer");
  await ate(noFim);
  assert.ok(!(await nav.avaliar(`!!document.querySelector(".chatbox .descer")`)), "o aviso some no fim");
  assert.deepEqual(nav.erros, []);
});

test("conversa: cada resposta mostra R1, R2… e ↩ responder cita a resposta acima do texto, como no WhatsApp", { skip: pular }, async () => {
  await abrir("#/c/demo");
  await ate(`[...document.querySelectorAll("#timeline .rnum")].map((e) => e.textContent).join(",") === "R1,R2,R3"`);
  await clicar('#r-1 .responder');
  await ate(`!document.querySelector("#responderA").hidden && document.querySelector("#responderA").innerText.includes("R1")`);
  assert.equal(await nav.avaliar(`document.activeElement.id`), "convIn", "o foco vai para a caixa");
  await digitar("#convIn", "explica melhor");
  await ate(`document.querySelector("#responderA").hidden`);
  await ate(`[...document.querySelectorAll("#timeline .ev.dono")].some((e) => e.querySelector(".citacao")?.innerText.includes("R1") && e.innerText.includes("explica melhor"))`);
  await ate(`document.querySelector("#timeline").innerText.includes("respondi citando")`);
  assert.match(chamadas(caixa).filter((c) => c.papel === "conversa").at(-1).msg, /Sobre R1 \(sua resposta que começava assim: "resposta da \*\*conversa\*\*"\):\nexplica melhor/);
  // ✕ desiste da citação; Esc também.
  await clicar('#r-2 .responder');
  await ate(`!document.querySelector("#responderA").hidden`);
  await clicar('#responderA button');
  await ate(`document.querySelector("#responderA").hidden`);
  await clicar('#r-2 .responder');
  await nav.avaliar(`document.querySelector("#convIn").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`);
  await ate(`document.querySelector("#responderA").hidden`);
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
    await abrir("", { tab: "pendentes", visao: "lista" }); // a aba Pendentes é da ☰ Lista (o kanban tem o ▶ no cartão, em test/cockpit.test.mjs)
    await ate(`!!document.querySelector('.task[data-id="1"] button[title="Colocar na fila"]')`);
    await clicar('.task[data-id="1"] button[title="Colocar na fila"]');
    await ate(`(async () => (await (await fetch("/api/tasks/1")).json()).task.status === "fila")()`);
  } finally { await b.api("PATCH", "/api/tasks/1", { status: "pendente" }); await b.api("POST", "/api/fila/retomar"); }
});

test("filtro por projeto: só as tarefas daquele projeto", { skip: pular }, async () => {
  await abrir("", { tab: "concluidas", visao: "lista" });
  await clicar('.chip[data-proj="api-pagamentos"]');
  await ate(`document.querySelectorAll("#list .task").length > 0`);
  const projs = await nav.avaliar(`[...document.querySelectorAll("#list .task .proj")].map((e) => e.textContent)`);
  assert.ok(projs.length && projs.every((p) => p === "api-pagamentos"), projs.join(","));
});

test("paginação: a lista mostra uma página por vez, navega, troca o tamanho e guarda a página", { skip: pular }, async () => {
  // 23 pendentes novas no projeto demo (fora da fila): passa das 20 por página da aba Pendentes.
  const r = await b.api("POST", "/api/tasks", { text: Array.from({ length: 23 }, (_, i) => `- paginar item ${i + 1}`).join("\n"), project: "demo" });
  const ids = r.json.tasks.map((t) => t.id);
  try {
    const linhas = `document.querySelectorAll("#list .task").length`;
    await abrir("", { tab: "pendentes", visao: "lista" }); // paginação é da ☰ Lista
    await ate(`!!document.querySelector(".paginacao")`);
    const total = (await (await fetch(b.url + "/api/state")).json()).tasks.filter((t) => t.status === "pendente").length;
    assert.equal(await nav.avaliar(linhas), 20, "20 por página por padrão");
    assert.match(await nav.avaliar(`document.querySelector(".pag-info").textContent`), new RegExp(`^1–20 de ${total}$`));
    assert.ok(await nav.avaliar(`document.querySelector('.pag[title="Página anterior"]').disabled`), "na 1ª, ‹ desligado");
    // o número do grupo conta o projeto todo, não só o que coube na página
    assert.ok(await nav.avaliar(`[...document.querySelectorAll(".grupo")].some((g) => g.textContent.includes("demo") && g.querySelector("b").textContent === "23")`));
    await clicar('.pag[title="Próxima página"]');
    await ate(`document.querySelector(".pag.on")?.textContent === "2"`);
    assert.equal(await nav.avaliar(linhas), total - 20);
    // a página fica guardada: reabrir a tela continua nela
    assert.equal(await nav.avaliar(`localStorage.getItem("board.pagina.pendentes")`), "2");
    // trocar o tamanho volta para a 1ª
    await nav.avaliar(`(() => { const s = document.querySelector("#porPagina"); s.value = "10"; s.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
    await ate(`document.querySelector(".pag.on")?.textContent === "1"`);
    assert.equal(await nav.avaliar(linhas), 10);
    // página que deixou de existir (tarefas saíram) cai na última, sem lista vazia
    await abrir("", { tab: "pendentes", visao: "lista", porPagina: 20, "pagina.pendentes": 99 });
    await ate(`!!document.querySelector(".paginacao")`);
    assert.equal(await nav.avaliar(`document.querySelector(".pag.on").textContent`), String(Math.ceil(total / 20)));
    assert.ok(await nav.avaliar(linhas) > 0);
    // lista que cabe numa página pequena não mostra paginação
    await abrir("", { tab: "executadas", visao: "lista" });
    await ate(`!!document.querySelector("#list")`);
    assert.equal(await nav.avaliar(`!!document.querySelector(".paginacao")`), false);
    assert.deepEqual(nav.erros, []);
  } finally { for (const id of ids) await b.api("DELETE", `/api/tasks/${id}`); }
});

test("🎤 ditar: o botão existe na nova tarefa, na conversa e no chat da tarefa, e o falado entra na caixa certa", { skip: pular }, async () => {
  // Microfone e transcrição falsos: o que se prova aqui é a tela (estado do botão e a caixa de destino).
  const falsos = `(() => {
    navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop() { window.__micSolto = true; } }] });
    window.MediaRecorder = class { constructor() { this.mimeType = "audio/webm"; }
      start() {} stop() { this.ondataavailable({ data: new Blob(["x"]) }); this.onstop(); } };
    const f = window.fetch; window.fetch = (u, o) => String(u).includes("/api/transcrever-audio")
      ? Promise.resolve(new Response(JSON.stringify({ texto: "falado no microfone" }), { status: 200 })) : f(u, o);
    return true; })()`;
  const { tasks } = await (await fetch(b.url + "/api/state")).json();
  for (const [hash, local, alvo] of [["", { tab: "ativas" }, "newTask"], ["#/c/demo", {}, "convIn"], [`#/t/${tasks[0].id}`, {}, "chatIn"]]) {
    await abrir(hash, local);
    await ate(`!!document.querySelector('.ib.microfone[data-alvo="${alvo}"]')`);
    await nav.avaliar(falsos);
    await clicar(`.ib.microfone[data-alvo="${alvo}"]`);
    await ate(`document.querySelector('.ib.microfone[data-alvo="${alvo}"]').classList.contains("gravando")`);
    await clicar(`.ib.microfone[data-alvo="${alvo}"]`);
    await ate(`document.querySelector("#${alvo}").value.includes("falado no microfone")`);
    assert.ok(await nav.avaliar("window.__micSolto === true"), `${alvo}: o microfone é solto ao parar`);
    assert.equal(await nav.avaliar(`document.querySelector('.ib.microfone[data-alvo="${alvo}"]').textContent`), "🎤", `${alvo}: volta ao 🎤`);
    assert.deepEqual(nav.erros, [], alvo);
  }
  // Atalho: Shift duas vezes na caixa da conversa. Shift + letra (maiúscula) não pode disparar.
  await abrir("#/c/demo");
  await nav.avaliar(falsos);
  const tecla = (k) => nav.avaliar(`(() => { for (const t of ["keydown", "keyup"]) document.activeElement.dispatchEvent(new KeyboardEvent(t, { key: ${JSON.stringify(k)}, bubbles: true })); return true; })()`);
  const maiuscula = () => nav.avaliar(`(() => { const a = document.activeElement, o = { bubbles: true };
    a.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", ...o })); a.dispatchEvent(new KeyboardEvent("keydown", { key: "A", shiftKey: true, ...o }));
    a.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", ...o })); return true; })()`);
  await nav.avaliar(`document.querySelector("#convIn").focus(), true`);
  await maiuscula(); await maiuscula();
  await esperar(300);
  assert.ok(!(await nav.avaliar(`document.querySelector('.ib.microfone[data-alvo="convIn"]').classList.contains("gravando")`)), "Shift+letra duas vezes não liga o microfone");
  await esperar(500);
  await tecla("Shift"); await tecla("Shift");
  await ate(`document.querySelector('.ib.microfone[data-alvo="convIn"]').classList.contains("gravando")`);
  await tecla("Shift"); await tecla("Shift");
  await ate(`document.querySelector("#convIn").value.includes("falado no microfone")`);
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

test("rascunho não some ao trocar de aba (nova tarefa, conversa, Central, chat da tarefa) e só sai ao enviar", { skip: pular }, async () => {
  const st = await b.api("GET", "/api/state");
  const t = st.json.tasks.find((x) => !["rodando", "fila"].includes(x.status));
  const caixas = [["", "#newTask", "rascunho da tarefa"], ["#/c/demo", "#convIn", "rascunho da conversa"],
    ["#/central", "#convIn", "rascunho da central"], [`#/t/${t.id}`, "#chatIn", "rascunho do chat"]];
  await abrir("", { tab: "ativas", project: "demo" });
  const irPara = async (hash, sel) => { await nav.avaliar(`location.hash = ${JSON.stringify(hash || "#")}, true`); await ate(`!!document.querySelector(${JSON.stringify(sel)})`); await nav.quieto({ min: 200 }); };
  for (const [hash, sel, valor] of caixas) { await irPara(hash, sel); await digitar(sel, valor, false); }
  // Volta a cada caixa (troca de aba refaz a tela) e o texto está lá; depois, recarregar a página também não apaga.
  for (const [hash, sel, valor] of caixas) { await irPara(hash, sel); assert.equal(await nav.avaliar(`document.querySelector(${JSON.stringify(sel)}).value`), valor, `voltou o texto em ${hash || "nova tarefa"}`); }
  await nav.carregar(b.url + "/?z=" + Math.random().toString(36).slice(2) + "#/c/demo"); await nav.quieto();
  assert.equal(await nav.avaliar(`document.querySelector("#convIn").value`), "rascunho da conversa", "sobrevive ao recarregar");
  // Enviar limpa SÓ o rascunho daquela caixa.
  await nav.avaliar(`(() => { const e = document.querySelector("#convIn"); e.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); return true; })()`);
  await ate(`localStorage.getItem("board.rascunho.conversa.demo") === null`);
  await irPara("#/central", "#convIn");
  assert.equal(await nav.avaliar(`document.querySelector("#convIn").value`), "rascunho da central", "a Central tem o rascunho dela");
  await irPara("#/c/demo", "#convIn");
  assert.equal(await nav.avaliar(`document.querySelector("#convIn").value`), "", "a conversa enviada não volta");
  assert.deepEqual(nav.erros, []);
});

test("caixa de escrever cresce com o texto (1, 5 e 30 linhas) até o teto, sem esconder nada, em toda caixa", { skip: pular }, async () => {
  const st = await b.api("GET", "/api/state");
  const t = st.json.tasks.find((x) => !["rodando", "fila"].includes(x.status));
  const caixas = [["", "#newTask"], ["#/c/demo", "#convIn"], ["#/central", "#convIn"], [`#/t/${t.id}`, "#chatIn"]];
  const linhas = (n) => Array.from({ length: n }, (_, i) => "linha " + (i + 1)).join("\n");
  // Mede como o dono veria: linhas visíveis, o que fica escondido e se a altura é um número inteiro de linhas.
  const medir = (sel) => nav.avaliar(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); const cs = getComputedStyle(e);
    const lh = parseFloat(cs.lineHeight), pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    return { rows: e.rows, alto: e.clientHeight, cheio: e.scrollHeight, topo: e.scrollTop, rola: cs.overflowY,
      inteiras: Math.abs(((e.clientHeight - pad) / lh) - Math.round((e.clientHeight - pad) / lh)) < 0.05,
      visiveis: Math.round((e.clientHeight - pad) / lh), janela: innerHeight, lh }; })()`);
  await abrir("", { tab: "ativas", project: "demo" });
  const irPara = async (hash, sel) => { await nav.avaliar(`location.hash = ${JSON.stringify(hash || "#")}, true`); await ate(`!!document.querySelector(${JSON.stringify(sel)})`); await nav.quieto({ min: 200 }); };
  for (const [l, a] of [[1440, 1000], [1440, 500], [390, 844]]) {
    await nav.tamanho(l, a);
    for (const [hash, sel] of caixas) {
      const onde = `${hash || "nova tarefa"} (${l}×${a})`;
      await irPara(hash, sel);
      await digitar(sel, "uma linha", false);
      let m = await medir(sel);
      assert.equal(m.rows, 1, `1 linha em ${onde}`); assert.ok(m.cheio <= m.alto, `1 linha sem nada escondido em ${onde}`);
      await digitar(sel, linhas(5), false);
      m = await medir(sel);
      assert.equal(m.visiveis, 5, `5 linhas à vista em ${onde}`); assert.ok(m.cheio <= m.alto && m.rola === "hidden", `5 linhas sem rolar em ${onde}`);
      // Frase longa SEM quebra de linha (o caso do print): quebra sozinha e a caixa acompanha.
      await digitar(sel, "palavra ".repeat(25).trim(), false);
      m = await medir(sel);
      assert.ok(m.rows > 1 && m.cheio <= m.alto, `frase longa cresce a caixa em ${onde}`);
      await digitar(sel, linhas(30), false);
      m = await medir(sel);
      const teto = Math.min(12, Math.floor(m.janela * 0.4 / m.lh));
      assert.equal(m.visiveis, teto, `30 linhas param no teto (${teto}) em ${onde}`);
      assert.ok(m.inteiras, `teto em linhas inteiras em ${onde}`);
      assert.equal(m.rola, "auto", `passou do teto, rola por dentro em ${onde}`);
      assert.ok(m.topo + m.alto >= m.cheio - 1, `cursor no fim fica à vista em ${onde}`);
      await digitar(sel, "", false);
      assert.equal((await medir(sel)).rows, 1, `apagou, volta a 1 linha em ${onde}`);
    }
  }
  await nav.tamanho(1440, 1000);
  // Enviar volta ao tamanho mínimo; rascunho restaurado já abre do tamanho certo.
  await irPara("#/c/demo", "#convIn");
  await digitar("#convIn", linhas(5));
  await ate(`document.querySelector("#convIn").value === "" && document.querySelector("#convIn").rows === 1`);
  await abrir("#/central", { "rascunho.conversa.central": linhas(6) });
  await ate(`!!document.querySelector("#convIn")`);
  assert.equal((await medir("#convIn")).visiveis, 6, "rascunho de 6 linhas abre com 6 linhas");
  assert.deepEqual(nav.erros, []);
});

test("som de envio: toca no envio que deu certo (nova tarefa, conversa, Central, chat da tarefa), não no que falhou, e 🔕 cala", { skip: pular }, async () => {
  const st = await b.api("GET", "/api/state");
  const t = st.json.tasks.find((x) => !["rodando", "fila"].includes(x.status));
  await abrir("", { tab: "ativas", project: "demo" });
  // Espiona o sintetizador de verdade: cada swoosh cria um oscilador no AudioContext.
  const espiar = () => nav.avaliar(`(() => { if (!window.__osc) { window.__osc = 0; const AC = window.AudioContext || window.webkitAudioContext;
    const orig = AC.prototype.createOscillator; AC.prototype.createOscillator = function () { window.__osc++; return orig.call(this); }; } return true; })()`);
  await espiar();
  assert.equal(await nav.avaliar(`document.querySelector(".som-envio").textContent`), "🔔", "ligado por padrão");
  const irPara = async (hash, sel) => { await nav.avaliar(`location.hash = ${JSON.stringify(hash || "#")}, true`); await ate(`!!document.querySelector(${JSON.stringify(sel)})`); await nav.quieto({ min: 200 }); };
  await nav.avaliar(`document.querySelector("#autoQueue").checked = false, true`);
  const casos = [["", "#newTask", "tarefa com som"], ["#/c/demo", "#convIn", "conversa com som"], ["#/central", "#convIn", "central com som"], [`#/t/${t.id}`, "#chatIn", "chat com som"]];
  for (const [hash, sel, valor] of casos) {
    await irPara(hash, sel);
    // O swoosh conta em somEnvio.vezes; a resposta que chega depois toca o sininho (outros osciladores), então aqui
    // basta o envio ter tocado UMA vez e o sintetizador ter rodado.
    const antes = await nav.avaliar("window.__osc"), vezes = await nav.avaliar("somEnvio.vezes");
    await digitar(sel, valor);
    await ate(`somEnvio.vezes === ${vezes + 1} && window.__osc > ${antes}`);
  }
  // Envio que falha: nada de som (e o texto volta para a caixa).
  await irPara("#/c/demo", "#convIn");
  await nav.avaliar(`window.__fetch = window.fetch; window.fetch = (u, o) => o && o.method === "POST" ? Promise.resolve(new Response('{"error":"falhou de propósito"}', { status: 500 })) : window.__fetch(u, o), true`);
  const antes = await nav.avaliar("window.__osc"), vezes = await nav.avaliar("somEnvio.vezes");
  await digitar("#convIn", "isto vai falhar");
  await ate(`document.querySelector("#convIn").value === "isto vai falhar"`);
  await nav.quieto({ min: 300 });
  assert.equal(await nav.avaliar("window.__osc"), antes, "erro não toca");
  assert.equal(await nav.avaliar("somEnvio.vezes"), vezes);
  await nav.avaliar(`window.fetch = window.__fetch, true`);
  // 🔕: desligado fica guardado no navegador e o envio certo não toca.
  await clicar(".som-envio");
  assert.equal(await nav.avaliar(`document.querySelector(".som-envio").textContent`), "🔕");
  assert.equal(await nav.avaliar(`localStorage.getItem("board.somEnvio")`), "false");
  const calado = await nav.avaliar("window.__osc");
  await nav.avaliar(`document.querySelector("#convIn").value = "", true`);
  await digitar("#convIn", "enviado sem som");
  await ate(`localStorage.getItem("board.rascunho.conversa.demo") === null && document.querySelector("#convIn").value === ""`);
  await nav.quieto({ min: 300 });
  assert.equal(await nav.avaliar("window.__osc"), calado, "🔕 não toca");
  assert.deepEqual(nav.erros.filter((e) => !/falhou de propósito/.test(e)), []);
});

test("som de recebimento: o sininho toca na resposta nova (conversa, chat da tarefa), não no histórico, na mensagem do dono nem na rodada da fila", { skip: pular }, async () => {
  const st = await b.api("GET", "/api/state");
  const t = st.json.tasks.find((x) => !["rodando", "fila"].includes(x.status));
  // Respostas dos testes anteriores ainda a caminho tocariam de verdade: espera os fios pararem antes de abrir.
  for (const slug of ["demo", "central"]) {
    for (let i = 0; i < 100 && (await b.api("GET", "/api/conversa/" + slug)).json.busy; i++) await esperar(150);
  }
  await esperar(300);
  // A conversa já tem histórico (testes anteriores): abrir e recarregar não toca nada.
  await abrir("#/c/demo", { project: "demo" });
  await ate(`!!document.querySelector("#convIn") && document.querySelectorAll("#timeline .ev").length > 0`);
  await nav.quieto({ min: 400 });
  assert.equal(await nav.avaliar("somEnvio.recebidas"), 0, "histórico não toca");
  assert.ok(await nav.avaliar(`!!document.querySelector(".som-volume")`), "o volume está ao lado do 🔔");
  await nav.avaliar(`(() => { window.__osc = 0; const AC = window.AudioContext || window.webkitAudioContext;
    const orig = AC.prototype.createOscillator; AC.prototype.createOscillator = function () { window.__osc++; return orig.call(this); }; return true; })()`);
  // Conversa: o dono manda (swoosh, não sininho) e a resposta chega (sininho, uma vez).
  await digitar("#convIn", "uma pergunta com sininho");
  await ate(`somEnvio.recebidas === 1`);
  await nav.quieto({ min: 500 });
  assert.equal(await nav.avaliar("somEnvio.recebidas"), 1, "uma resposta = um sininho; a mensagem do dono não toca");
  assert.ok(await nav.avaliar("window.__osc") >= 1 + 6, "swoosh (1 oscilador) + sininho (3 notas × 2 parciais)");
  // Chat da tarefa: a resposta do agente ao chat toca.
  await nav.avaliar(`location.hash = "#/t/${t.id}", true`); await ate(`!!document.querySelector("#chatIn")`); await nav.quieto({ min: 300 });
  await digitar("#chatIn", "e o sininho no chat?");
  await ate(`somEnvio.recebidas === 2`);
  // Rodada da fila (sem mensagem do dono): o resultado chega pelo SSE e NÃO toca.
  await nav.avaliar(`location.hash = "#", true`); await nav.quieto({ min: 300 });
  const nova = await b.api("POST", "/api/tasks", { text: "rodada sem chat", project: "demo", queue: true });
  const id = nova.json.tasks[0].id;
  await ate(`(async () => (await (await fetch("/api/tasks/${id}")).json()).task.status === "executada")()`, 30000);
  await nav.quieto({ min: 500 });
  assert.equal(await nav.avaliar("somEnvio.recebidas"), 2, "rodada da fila não toca");
  // A regra, caso a caso (inclusive o ✉ da Central, que o claude falso não manda).
  assert.deepEqual(await nav.avaliar(`[
    deveTocarRecebida("conversa-central", { t: "sessao", texto: "oi" }, []),
    deveTocarRecebida("conversa-central", { t: "resultado", texto: "li", quem: "agente" }, [{ t: "resultado" }, { t: "sessao" }]),
    deveTocarRecebida("conversa-central", { t: "resultado", texto: "respondo", quem: "agente" }, [{ t: "sessao" }, { t: "resultado" }, { t: "dono" }]),
    deveTocarRecebida("conversa-demo", { t: "dono", texto: "eu" }, []),
    deveTocarRecebida("conversa-demo", { t: "resultado", texto: "" }, [{ t: "dono" }]),
    deveTocarRecebida("7", { t: "resultado", texto: "ok", quem: "agente" }, [{ t: "dono" }, { t: "ferramenta" }]),
    deveTocarRecebida("7", { t: "resultado", texto: "ok", quem: "agente" }, [{ t: "texto" }]),
    deveTocarRecebida("7", { t: "resultado", texto: "APROVADO", quem: "revisor" }, [{ t: "dono" }]),
  ]`), [true, false, true, false, false, true, false, false]);
  // 🔕 cala os dois; volume 0 também não sintetiza nada.
  await nav.avaliar(`store.set("somEnvio", false), true`);
  const r = await nav.avaliar("somEnvio.recebidas"); await nav.avaliar("somEnvio.receber(), true");
  assert.equal(await nav.avaliar("somEnvio.recebidas"), r, "🔕 não toca o sininho");
  await nav.avaliar(`store.set("somEnvio", true), store.set("somVolume", 0), window.__osc = 0, somEnvio.receber(), somEnvio.tocar(), true`);
  assert.equal(await nav.avaliar("window.__osc"), 0, "volume 0 não sintetiza");
  assert.deepEqual(nav.erros, []);
});
