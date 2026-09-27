// The everyday parts: the `board` CLI (what the conversation uses for "vira tarefa"), board.sh bringing the server back
// after ↻, deleting a task, the automatic size, a hung gate being killed with its whole process group, task search by
// meaning — and, on screen, the side menu and the buttons of the list and of the task card.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, existsSync, cpSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { criarCaixa, criarProjeto, subirBoard, limparCaixa, esperar, esperarStatus, chamadas, envDaCaixa, portaLivre, servidorDeSentido } from "./ajuda.mjs";
import { abrirNavegador, CHROME } from "./navegador.mjs";

let atual = [];
afterEach(async () => { for (const f of atual.reverse()) await f(); atual = []; });
async function preparar({ cenario = {}, env = {}, antes } = {}) {
  const caixa = criarCaixa(); criarProjeto(caixa, "demo"); caixa.cenario(cenario); if (antes) antes(caixa);
  const b = await subirBoard(caixa, env);
  atual.push(async () => { await b.fim(); limparCaixa(caixa); });
  return { caixa, b };
}
const tarefa = async (b, id) => (await b.api("GET", `/api/tasks/${id}`)).json.task;
async function ate(fn, limite = 15000) { const t0 = Date.now(); let v; while (Date.now() - t0 < limite) { v = await fn(); if (v) return v; await esperar(150); } return v; }

test("CLI: o ciclo de uma tarefa pelo terminal (add, list, show, run, say, done, rm)", async () => {
  const { caixa, b } = await preparar({ cenario: { agente: [{ quando: "^crie", texto: "criei pela CLI" }, { quando: "detalhe", texto: "respondi pela CLI" }, "ok"] } });
  const cli = (...a) => execFileSync(process.execPath, [join(caixa.board, "board-cli.mjs"), ...a], { env: { ...envDaCaixa(caixa), BOARD_URL: b.url }, encoding: "utf8" });
  assert.match(cli("add", "crie o relatório", "demo", "--pr"), /#1/);
  const t = (await b.api("GET", "/api/state")).json.tasks[0];
  assert.equal(t.project, "demo"); assert.equal(t.entrega, "pr"); assert.equal(t.status, "pendente");
  assert.match(cli("list"), /crie o relatório/);
  cli("run", "1");
  await esperarStatus(b, 1, ["executada", "erro"]);
  assert.match(cli("show", "1"), /criei pela CLI/);
  cli("say", "1", "e o detalhe?");
  await ate(async () => chamadas(caixa).filter((c) => c.papel === "agente").length === 2 && !(await tarefa(b, 1)).busy);
  cli("done", "1");
  assert.equal((await tarefa(b, 1)).status, "concluida");
  cli("rm", "1");
  assert.equal((await b.api("GET", "/api/tasks/1")).status, 404);
  const fora = execFileSync(process.execPath, [join(caixa.board, "board-cli.mjs"), "list"], { env: { ...envDaCaixa(caixa), BOARD_URL: `http://127.0.0.1:${await portaLivre()}` }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(fora, "", "sem servidor: avisa no stderr e sai 0 (não quebra quem chamou)");
});

test("board.sh: o ↻ reinicia e o servidor volta sozinho, com o quadro intacto", async () => {
  const caixa = criarCaixa(); criarProjeto(caixa, "demo");
  const porta = await portaLivre(); const url = `http://127.0.0.1:${porta}`;
  cpSync(join(process.cwd(), "board.sh"), join(caixa.board, "board.sh"));
  const sh = spawn("bash", [join(caixa.board, "board.sh")], { env: { ...envDaCaixa(caixa), BOARD_PORT: String(porta) }, stdio: "ignore", detached: true });
  atual.push(async () => { try { process.kill(-sh.pid, "SIGTERM"); } catch { /* já saiu */ } await esperar(500); limparCaixa(caixa); });
  const estado = async () => { try { return await (await fetch(url + "/api/state")).json(); } catch { return null; } };
  const s1 = await ate(estado);
  assert.ok(s1, "o board.sh subiu o servidor");
  await fetch(url + "/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "sobrevive ao reinício", project: "demo" }) });
  await fetch(url + "/api/reiniciar", { method: "POST" });
  const s2 = await ate(async () => { const s = await estado(); return s && s.config.iniciadoEm !== s1.config.iniciadoEm && s; });
  assert.ok(s2, "voltou com outro processo");
  assert.deepEqual(s2.tasks.map((t) => t.title), ["sobrevive ao reinício"]);
});

test("excluir tarefa: some do quadro, o log e o log cru vão junto, e a cópia ⚡ também", async () => {
  const { caixa, b } = await preparar({ env: { BOARD_LOG_CRU: "1" }, cenario: { agente: [{ texto: "fiz", escreve: { arquivo: "x.txt" } }] } });
  const [t] = (await b.api("POST", "/api/tasks", { text: "faça x", project: "demo", queue: true, paralelo: true })).json.tasks;
  const fim = await esperarStatus(b, t.id, "executada");
  await ate(async () => (await tarefa(b, t.id)).worktree?.juntar === "ok");
  const log = join(caixa.board, "data", "logs", t.id + ".jsonl"), cru = join(caixa.board, "data", "raw", t.id + ".jsonl");
  assert.ok(existsSync(log) && existsSync(cru) && existsSync(fim.worktree.dir));
  assert.equal((await b.api("DELETE", `/api/tasks/${t.id}`)).status, 200);
  assert.equal((await b.api("GET", `/api/tasks/${t.id}`)).status, 404);
  assert.ok(!existsSync(log) && !existsSync(cru), "logs apagados");
  assert.ok(!existsSync(fim.worktree.dir), "cópia removida");
});

test("porte automático: classifica antes de rodar, NUNCA escolhe 'pesado' sozinho, e leve vira esforço low", async () => {
  const { caixa, b } = await preparar({ env: { BOARD_CLASSIFICAR: "1" }, cenario: { porte: "pesado", agente: ["ok"] } });
  const [t] = (await b.api("POST", "/api/tasks", { text: "migração grande", project: "demo", queue: true })).json.tasks;
  const fim = await esperarStatus(b, t.id, "executada");
  assert.equal(fim.porte, "normal", "o automático só baixa ou mantém — pesado (xhigh) é escolha do dono");
  assert.equal(fim.porteAuto, true);
  assert.ok(fim.cost >= 0.001, "o custo da classificação entra no da tarefa");
  caixa.cenario({ porte: "leve", agente: ["ok"] });
  const [t2] = (await b.api("POST", "/api/tasks", { text: "troque a cor do botão", project: "demo", queue: true })).json.tasks;
  const f2 = await esperarStatus(b, t2.id, "executada");
  assert.equal(f2.porte, "leve");
  const ag = chamadas(caixa).filter((c) => c.papel === "agente").at(-1);
  assert.equal(ag.args[ag.args.indexOf("--effort") + 1], "low");
  assert.ok((await b.api("GET", `/api/tasks/${t.id}/log`)).json.events.some((e) => /porte normal \(automático/.test(e.texto || "")));
});

test("portão pendurado: é morto no tempo, com o GRUPO de processos (sem órfão), e reprova", async () => {
  const marca = "47." + process.pid;
  const { b } = await preparar({ env: { BOARD_PORTAO_TIMEOUT_MIN: "0.03", BOARD_REVISOES: "0" }, cenario: { agente: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }] },
    antes: (c) => writeFileSync(join(c.dev, "demo", "package.json"), JSON.stringify({ name: "demo", scripts: { check: `bash -c 'sleep ${marca}'` } })) });
  const [t] = (await b.api("POST", "/api/tasks", { text: "faça", project: "demo", queue: true })).json.tasks;
  const fim = await esperarStatus(b, t.id, ["executada", "erro"], 20000);
  assert.equal(fim.status, "erro"); assert.match(fim.error, /portão reprovou/);
  const ev = (await b.api("GET", `/api/tasks/${t.id}/log`)).json.events.find((e) => e.t === "portao" && e.estado === "falhou");
  assert.match(ev.saida, /passou de 0.03 min e foi interrompido/);
  await esperar(300);
  let vivos = ""; try { vivos = execFileSync("pgrep", ["-f", `sleep ${marca}`], { encoding: "utf8" }); } catch { /* nenhum: certo */ }
  assert.equal(vivos.trim(), "", "o sleep do portão não ficou órfão");
});

test("busca de tarefas por sentido: acha pelo assunto dito com outras palavras; sem o provedor, cai na palavra e avisa", async () => {
  const fake = await servidorDeSentido(["pix|webhook|idempot|notifica|repetid|em dobro|duas vezes|pagou", "tela|layout|css|estilo"]);
  atual.push(() => fake.fechar().catch(() => {}));
  const { b } = await preparar({ env: { BOARD_BUSCA_PROVEDOR: "ollama", BOARD_OLLAMA_URL: fake.url } });
  for (const text of ["Webhook do Pix idempotente: o banco reenvia o aviso", "Classe de CSS global quebrou as telas", "Relatório mensal de vendas"])
    await b.api("POST", "/api/tasks", { text, project: "demo" });
  const r = (await b.api("GET", "/api/busca?q=" + encodeURIComponent("o cliente pagou e a notificação chegou repetida"))).json;
  assert.equal(r.modo, "semantica");
  assert.equal(r.resultados[0].title, "Webhook do Pix idempotente: o banco reenvia o aviso");
  await fake.fechar();
  const r2 = (await b.api("GET", "/api/busca?q=" + encodeURIComponent("webhook pix"))).json;
  assert.equal(r2.modo, "lexico"); assert.match(r2.aviso, /sem embeddings/);
  assert.equal(r2.resultados[0].title, "Webhook do Pix idempotente: o banco reenvia o aviso");
});

test("tela: o menu lateral leva a cada lugar; ✓ ⏹ 🗑 na linha; Virar PR, passar o bastão, publicar e pausar na ficha", { skip: !CHROME && "sem Chrome" }, async () => {
  const { b } = await preparar({ cenario: { agente: [{ quando: "demora", texto: "ok", dorme: 20000 }, "ok"] } });
  const nav = await abrirNavegador(); atual.push(() => nav.fechar());
  const ir = async (hash = "", local = {}) => { await nav.carregar("about:blank"); await nav.carregar(b.url + "/?a" + Math.random()); await nav.avaliar(`localStorage.clear(); ${Object.entries(local).map(([k, v]) => `localStorage.setItem("board.${k}", ${JSON.stringify(JSON.stringify(v))});`).join(" ")}`); await nav.carregar(b.url + "/?b" + Math.random() + hash); await nav.quieto({ min: 400 }); };
  const espera = async (expr) => { for (let i = 0; i < 100; i++) { if (await nav.avaliar(expr)) return; await esperar(120); } throw new Error("não chegou: " + expr); };
  // menu lateral
  await ir("", { tab: "ativas" });
  for (const [chave, prova] of [["controle", `!!document.querySelector("#controle")`], ["consumo", `!!document.querySelector("#consumo")`], ["memoria", `!!document.querySelector("#memoria")`],
    ["monitoring", `!!document.querySelector("#monitoring")`], ["busca", `location.hash === "#/busca"`], ["conversa", `location.hash.startsWith("#/c/")`], ["board", `!!document.querySelector("#newTask")`]]) {
    await espera(`(() => { const b = document.querySelector('.nav-item[onclick="navigateBoard(\\'${chave}\\')"]'); if (!b) return false; b.click(); return true; })()`);
    await espera(prova);
  }
  // linha: ✓ concluir, ⏹ parar, 🗑 excluir (com confirmação, porque tem sessão)
  const [ok1] = (await b.api("POST", "/api/tasks", { text: "rápida", project: "demo", queue: true })).json.tasks;
  await esperarStatus(b, ok1.id, "executada");
  await ir("", { tab: "executadas" });
  await espera(`(() => { const b = document.querySelector('.task[data-id="${ok1.id}"] .chk'); if (!b) return false; b.click(); return true; })()`);
  await ate(async () => (await tarefa(b, ok1.id)).status === "concluida");
  const [lenta] = (await b.api("POST", "/api/tasks", { text: "demora bastante", project: "demo", queue: true })).json.tasks;
  await ate(async () => (await tarefa(b, lenta.id)).status === "rodando");
  await ir("", { tab: "ativas" });
  await espera(`!!document.querySelector('.task[data-id="${lenta.id}"] button[title="Parar"]')`);
  await espera(`(() => { const b = document.querySelector('.task[data-id="${lenta.id}"] button[title="Parar"]'); if (!b) return false; b.click(); return true; })()`);
  await ate(async () => (await tarefa(b, lenta.id)).status === "pendente");
  await ir("", { tab: "concluidas" });
  await espera(`(() => { const b = document.querySelector('.task[data-id="${ok1.id}"] .del'); if (!b) return false; b.click(); return true; })()`);
  await ate(async () => (await b.api("GET", `/api/tasks/${ok1.id}`)).status === 404);
  assert.match(nav.dialogos.join("\n"), new RegExp(`Excluir a tarefa #${ok1.id}`), "pediu confirmação (tinha sessão)");
  // ficha: virar PR, passar o bastão, publicar sem e com comando, pausar a fila
  const [t] = (await b.api("POST", "/api/tasks", { text: "pronta para PR", project: "demo", queue: true })).json.tasks;
  await esperarStatus(b, t.id, "executada");
  await b.api("POST", "/api/fila/pausar");
  await ir(`#/t/${t.id}`);
  await espera(`(() => { const b = [...document.querySelectorAll("button")].find((x) => /Virar PR/.test(x.textContent)); if (!b) return false; b.click(); return true; })()`);
  await ate(async () => (await tarefa(b, t.id)).acao === "pr");
  await b.api("PATCH", `/api/tasks/${t.id}`, { status: "executada" });
  await ir(`#/t/${t.id}`);
  await espera(`(() => { const b = [...document.querySelectorAll("button")].find((x) => /Mesclar e publicar/.test(x.textContent)); if (!b) return false; b.click(); return true; })()`);
  await espera(`document.body.innerText.includes("Publicação desligada para demo")`);
  await espera(`(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim().startsWith("Codex")); if (!b) return false; b.click(); return true; })()`);
  await ate(async () => (await tarefa(b, t.id)).motor === "codex");
  await espera(`(() => { const b = document.querySelector('[onclick="filaPausar(false)"]'); if (!b) return false; b.click(); return true; })()`);
  await ate(async () => !(await b.api("GET", "/api/state")).json.config.filaPausada);
  assert.deepEqual(nav.erros, []);
});

test("tela: trocar de tela ANTES de a anterior terminar de carregar não quebra nada (todas as telas que buscam dados)", { skip: !CHROME && "sem Chrome" }, async () => {
  const { b } = await preparar();
  const nav = await abrirNavegador(); atual.push(() => nav.fechar());
  await nav.carregar(b.url + "/?a"); await nav.quieto({ min: 300 }); nav.erros.length = 0;
  const telas = ["memoria", "controle", "consumo", "monitoring", "busca", "board", "memoria", "consumo", "controle", "monitoring", "memoria", "board"];
  for (let volta = 0; volta < 3; volta++)
    for (const k of telas) { await nav.avaliar(`navigateBoard("${k}")`); await esperar(volta * 15); } // sem esperar a tela carregar
  await esperar(2500); // as respostas atrasadas chegam depois de a tela ter mudado
  assert.deepEqual(nav.erros, [], "nenhuma tela escreve em elemento que já não existe");
});

test("tmux por dentro: a barra (agentes, fila, plano) e a aba de cada agente (board seguir) mostram o que está acontecendo", async () => {
  const uso = "Current session: 34% used · resets Sep 27 at 1pm (America/Sao_Paulo)\nCurrent week (all models): 72% used · resets Oct 1 at 10am (America/Sao_Paulo)";
  const { caixa, b } = await preparar({ cenario: { usoClaude: uso, agente: [{ quando: "longa", texto: "terminei a longa", dorme: 2500 }, "ok"] } });
  await b.api("GET", "/api/claude-uso?fresco");
  const [longa] = (await b.api("POST", "/api/tasks", { text: "tarefa longa", project: "demo", queue: true })).json.tasks;
  await b.api("POST", "/api/tasks", { text: "espera na fila", project: "demo", queue: true });
  await ate(async () => (await tarefa(b, longa.id)).status === "rodando");
  const cli = (...a) => execFileSync(process.execPath, [join(caixa.board, "board-cli.mjs"), ...a], { env: { ...envDaCaixa(caixa), BOARD_URL: b.url }, encoding: "utf8" });
  const barra = cli("barra");
  assert.match(barra, /1 trabalhando · 1 na fila/);
  assert.match(barra, /Claude sessão 34% · semana 72%/);
  assert.match(barra, /#\[bg=/, "no formato da barra do tmux");
  assert.match(cli("resumo"), /1 trabalhando · 1 na fila/);
  const seg = spawn(process.execPath, [join(caixa.board, "board-cli.mjs"), "seguir", String(longa.id)], { env: { ...envDaCaixa(caixa), BOARD_URL: b.url } });
  let saida = ""; seg.stdout.on("data", (d) => (saida += d));
  await esperarStatus(b, longa.id, "executada");
  await esperar(2500); seg.kill("SIGKILL");
  const limpo = saida.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  assert.match(limpo, /#eng01/, "cabeçalho com o agente");
  assert.match(limpo, /começou em demo/);
  assert.match(limpo, /terminei a longa/, "o resultado aparece ao vivo");
});
