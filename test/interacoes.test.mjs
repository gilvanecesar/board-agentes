// The remaining screen interactions: reviewing the addressing (move, confirm, approve), a new conversation thread and the
// stop button, re-running a past search, the 📦 link to a memory, attaching a PDF and removing it, the container cards in
// Status, and "Mesclar e publicar" asking for confirmation with the exact command. (↻ and "ver no tmux" are covered below
// the screen — clicking them here would restart the test board or open a Terminal on the owner's Mac.)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
import { criarCaixa, criarProjeto, subirBoard, limparCaixa, esperar, esperarStatus, chamadas } from "./ajuda.mjs";
import { montarDemo } from "./demo.mjs";
import { abrirNavegador, CHROME } from "./navegador.mjs";

const pular = !CHROME && "sem Chrome nesta máquina";
let caixa, b, nav;
const DOCKER_PS = [
  { Names: "loja-api-1", Image: "loja/api:3", State: "running", Status: "Up 2 hours (healthy)", Labels: "com.docker.compose.project=loja" },
  { Names: "loja-migrar-1", Image: "loja/api:3", State: "exited", Status: "Exited (0) 2 hours ago", Labels: "com.docker.compose.project=loja" },
  { Names: "loja-fila-1", Image: "redis:7", State: "running", Status: "Up 5 minutes (unhealthy)", Labels: "com.docker.compose.project=loja" },
  { Names: "loja-worker-1", Image: "loja/worker:3", State: "exited", Status: "Exited (137) 1 minute ago", Labels: "com.docker.compose.project=loja" },
].map((x) => JSON.stringify(x)).join("\n");
const DOCKER_STATS = [{ Name: "loja-api-1", CPUPerc: "0,41%", MemUsage: "25MiB / 7.6GiB" }, { Name: "loja-fila-1", CPUPerc: "0,10%", MemUsage: "9MiB / 7.6GiB" }].map((x) => JSON.stringify(x)).join("\n");

before(async () => {
  if (pular) return;
  caixa = criarCaixa();
  montarDemo(caixa.dev, join(caixa.raiz, "memoria"), join(caixa.board, "data"));
  criarProjeto(caixa, "demo");
  writeFileSync(join(caixa.home, "docker-ps.txt"), DOCKER_PS + "\n");
  writeFileSync(join(caixa.home, "docker-stats.txt"), DOCKER_STATS + "\n");
  writeFileSync(join(caixa.board, "data", "deploy.json"), JSON.stringify({ "api-pagamentos": "./publicar.sh --producao" }));
  caixa.cenario({ conversa: [{ texto: "pensando muito", dorme: 8000 }, "ok"] });
  b = await subirBoard(caixa);
  nav = await abrirNavegador();
});
after(async () => { if (nav) await nav.fechar(); if (b) await b.fim(); if (caixa) limparCaixa(caixa); });

async function abrir(hash = "", local = {}) {
  await nav.carregar("about:blank");
  await nav.carregar(b.url + "/?x=" + Math.random());
  await nav.avaliar(`localStorage.clear(); ${Object.entries(local).map(([k, v]) => `localStorage.setItem("board.${k}", ${JSON.stringify(JSON.stringify(v))});`).join(" ")}`);
  await nav.carregar(b.url + "/?y=" + Math.random() + hash);
  await nav.quieto({ min: 400 });
  nav.erros.length = 0;
}
async function ate(expr, limite = 15000) { const t0 = Date.now(); while (Date.now() - t0 < limite) { if (await nav.avaliar(expr)) return; await esperar(150); } throw new Error("não chegou: " + expr); }
const mentes = () => JSON.parse(readFileSync(join(caixa.board, "data", "mentes.json"), "utf8"));

test("conferir o endereçamento pela tela: mover de mente, conferir e aprovar", { skip: pular }, async () => {
  await abrir("", { tab: "memoria", memoriaModo: "galpao", galpaoPP: "mente" });
  // A tela se redesenha quando o inventário termina de carregar: espera o SELETOR (não o texto) e repete a ação até ela pegar.
  await ate(`(() => { const s = document.querySelector('[data-mover="api-pagamentos/estorno-mesmo-meio"]'); if (!s) return false; s.value = "produto"; s.dispatchEvent(new Event("change")); return true; })()`);
  await ate(`!!document.querySelector("[data-aprovar]")`);
  const m = mentes();
  assert.equal(m.mapa["api-pagamentos/estorno-mesmo-meio"].mente, "produto");
  assert.equal(m.mapa["api-pagamentos/estorno-mesmo-meio"].confianca, "dono");
  assert.equal(m.status, "proposta", "mexeu: precisa aprovar de novo");
  await ate(`(() => { const b = document.querySelector("[data-aprovar]"); if (!b) return false; b.click(); return true; })()`);
  for (let i = 0; i < 40 && mentes().status !== "aprovada"; i++) await esperar(100);
  assert.equal(mentes().status, "aprovada");
  assert.deepEqual(nav.erros, []);
});

test("conversa: ⏹ para a resposta que demora; 🧹 começa fio novo (com confirmação) e limpa a tela", { skip: pular }, async () => {
  await abrir("#/c/demo");
  await nav.avaliar(`(() => { const e = document.querySelector("#convIn"); e.value = "pense bastante"; e.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
  await ate(`[...document.querySelectorAll("button")].some((x) => /parar/.test(x.textContent))`);
  await ate(`(() => { const b = [...document.querySelectorAll("button")].find((x) => /parar/.test(x.textContent)); if (!b) return false; b.click(); return true; })()`);
  await ate(`(async () => !(await (await fetch("/api/conversa/demo")).json()).busy)()`);
  await ate(`[...document.querySelectorAll("button")].some((x) => /novo fio/.test(x.textContent))`);
  await ate(`(() => { const b = [...document.querySelectorAll("button")].find((x) => /novo fio/.test(x.textContent)); if (!b) return false; b.click(); return true; })()`);
  await ate(`(async () => (await (await fetch("/api/conversa/demo")).json()).events.length === 0)()`);
  assert.match(nav.dialogos.join("\n"), /Começar um fio novo\?/);
  await ate(`!document.querySelector("#timeline") || !document.querySelector("#timeline").innerText.includes("pense bastante")`);
  assert.deepEqual(nav.erros, []);
});

test("busca: clicar numa busca recente refaz a consulta", { skip: pular }, async () => {
  await abrir("#/busca");
  await ate(`!!document.querySelector(".bh")`);
  const q = await nav.avaliar(`document.querySelector(".bh").innerText`);
  await ate(`(() => { const b = document.querySelector(".bh"); if (!b) return false; b.click(); return true; })()`);
  await ate(`document.querySelector("#buscaIn").value.length > 0`);
  assert.ok(q.includes(await nav.avaliar(`document.querySelector("#buscaIn").value`)), "a consulta do histórico voltou para o campo");
  await ate(`!!document.querySelector(".bres") || document.body.innerText.includes("Nada")`);
});

test("📦 na ficha: clicar numa memória do romaneio abre ela na Memória", { skip: pular }, async () => {
  await abrir("#/t/12");
  await ate(`!!document.querySelector(".ev.romaneio")`);
  await ate(`(() => { const d = document.querySelector(".ev.romaneio"); if (!d) return false; d.open = true; const b = document.querySelector(".rom-lista button"); if (!b) return false; b.click(); return true; })()`);
  await ate(`!!document.querySelector("#memoria") && !!document.querySelector("#grafoPagina h3")`);
  assert.match(await nav.avaliar(`document.querySelector("#grafoPagina h3").textContent`), /Webhook do Pix tem que ser idempotente/);
});

test("📎 PDF entra como ícone + nome, e o × tira o anexo antes de enviar", { skip: pular }, async () => {
  const pdf = join(caixa.raiz, "contrato.pdf"); writeFileSync(pdf, "%PDF-1.4\n1 0 obj\n");
  await abrir("", { tab: "ativas" });
  const { root } = await nav.cmd("DOM.getDocument");
  const { nodeId } = await nav.cmd("DOM.querySelector", { nodeId: root.nodeId, selector: "#arqBtn" });
  await nav.cmd("DOM.setFileInputFiles", { nodeId, files: [pdf] });
  await ate(`!!document.querySelector('#anexosIncluir .anexo .pdf')`);
  assert.match(await nav.avaliar(`document.querySelector("#anexosIncluir").innerText`), /📄 PDF[\s\S]*contrato\.pdf/);
  await ate(`(() => { const b = document.querySelector("#anexosIncluir .x"); if (!b) return false; b.click(); return true; })()`);
  await ate(`!document.querySelector("#anexosIncluir .anexo")`);
});

test("Status: cada container com o estado certo (saudável, concluído, doente, parado com erro)", { skip: pular }, async () => {
  await abrir("", { tab: "monitoring" });
  await ate(`document.querySelectorAll('.service-card[title^="loja-"]').length === 4`, 20000);
  const cartoes = await nav.avaliar(`Object.fromEntries([...document.querySelectorAll('.service-card[title^="loja-"]')].map((c) => [c.title.split(" · ")[0], c.dataset.state + " | " + c.innerText.replace(/\\s+/g, " ")]))`);
  assert.match(cartoes["loja-api-1"], /Saudável.*0,41% · 25 MB/);
  assert.match(cartoes["loja-migrar-1"], /Concluído/, "exited(0) é serviço de rodar uma vez, não problema");
  assert.match(cartoes["loja-fila-1"], /^offline|doente|Doente/i);
  assert.match(cartoes["loja-worker-1"], /Parado · erro 137/);
  assert.deepEqual(nav.erros, []);
});

test("⇪ Mesclar e publicar: com comando declarado, pede confirmação MOSTRANDO o comando — e só então entra na fila", { skip: pular }, async () => {
  // o botão só aparece em tarefa que já rodou (tem sessão com o trabalho)
  const [t] = (await b.api("POST", "/api/tasks", { text: "ajuste pequeno", project: "api-pagamentos", queue: true })).json.tasks;
  await esperarStatus(b, t.id, "executada");
  await b.api("POST", "/api/fila/pausar");
  await abrir(`#/t/${t.id}`);
  await ate(`[...document.querySelectorAll("button")].some((x) => /Mesclar e publicar/.test(x.textContent))`);
  await ate(`(() => { const b = [...document.querySelectorAll("button")].find((x) => /Mesclar e publicar/.test(x.textContent)); if (!b) return false; b.click(); return true; })()`);
  for (let i = 0; i < 40 && (await b.api("GET", `/api/tasks/${t.id}`)).json.task.acao !== "deploy"; i++) await esperar(100);
  assert.match(nav.dialogos.join("\n"), /MESCLAR o PR e PUBLICAR o projeto api-pagamentos:\s+\$ \.\/publicar\.sh --producao/);
  assert.equal((await b.api("GET", `/api/tasks/${t.id}`)).json.task.acao, "deploy", "só depois do 'sim' entra na fila");
});
