// Integration tests: the WHOLE board (HTTP, queue, pipeline) running isolated, with a fake `claude` that follows a
// script. Each test gets its own sandbox and its own board on a free port. Costs nothing, touches nothing real.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { criarCaixa, criarProjeto, subirBoard, esperarStatus, chamadas, limparCaixa, envDaCaixa, esperar } from "./ajuda.mjs";

let atual = [];
afterEach(async () => { for (const [b, c] of atual) { await b.fim(); limparCaixa(c); } atual = []; });

async function preparar({ cenario = {}, env = {}, projetos = ["demo"] } = {}) {
  const caixa = criarCaixa();
  for (const p of projetos) criarProjeto(caixa, p);
  caixa.cenario(cenario);
  const b = await subirBoard(caixa, env);
  atual.push([b, caixa]);
  return { caixa, b };
}
const criar = async (b, text, extra = {}) => (await b.api("POST", "/api/tasks", { text, project: "demo", queue: true, ...extra })).json.tasks;
const log = async (b, id) => (await b.api("GET", `/api/tasks/${id}/log`)).json.events;
const arg = (c, f) => { const i = c.args.indexOf(f); return i >= 0 ? c.args[i + 1] : undefined; };

test("pergunta que não mexe em arquivo: responde e não passa pela conferência", async () => {
  const { caixa, b } = await preparar({ cenario: { agente: [{ texto: "a resposta é 42", custo: 0.05 }] } });
  const [t] = await criar(b, "quanto é 6 x 7?");
  const fim = await esperarStatus(b, t.id, ["executada", "erro"]);
  assert.equal(fim.status, "executada");
  assert.equal((await b.api("GET", `/api/tasks/${t.id}`)).json.task.result, "a resposta é 42");
  assert.equal(fim.cost, 0.05);
  assert.deepEqual(chamadas(caixa).map((c) => c.papel), ["agente"]);
  assert.ok(!(await log(b, t.id)).some((e) => e.t === "portao"));
});

test("mexeu em arquivo: portão → revisor → QA, e revisor/QA rodam sem captura de memória", async () => {
  const { caixa, b } = await preparar({ cenario: {
    agente: [{ texto: "criei ok.txt", escreve: { arquivo: "ok.txt" } }], revisor: ["APROVADO\nsem defeito"], qa: ["APROVADO\nnão quebrou"] } });
  const [t] = await criar(b, "crie o arquivo ok.txt");
  const fim = await esperarStatus(b, t.id, ["executada", "erro"]);
  assert.equal(fim.status, "executada", fim.error);
  const cs = chamadas(caixa);
  assert.deepEqual(cs.map((c) => c.papel), ["agente", "revisor", "qa"]);
  const ev = await log(b, t.id);
  assert.ok(ev.some((e) => e.t === "portao" && e.estado === "passou"));
  assert.equal(fim.revisor.veredito, "APROVADO"); assert.equal(fim.qa.veredito, "APROVADO");
  assert.equal(arg(cs[1], "--setting-sources"), "project,local", "revisor sem os ganchos de captura");
  assert.equal(arg(cs[2], "--setting-sources"), "project,local", "QA sem os ganchos de captura");
  assert.equal(arg(cs[0], "--setting-sources"), undefined, "o agente continua com captura");
  assert.match(fim.sessionId, /^sessao-agente-/, "a sessão da tarefa é a do agente, nunca a do revisor");
});

test("revisor reprova: o agente conserta NA MESMA sessão, com o parecer, e a esteira roda de novo", async () => {
  const { caixa, b } = await preparar({ cenario: {
    agente: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }, { texto: "consertei", escreve: { arquivo: "b.txt" } }],
    revisor: ["REPROVADO\n- falta tratar entrada vazia", "APROVADO"], qa: ["APROVADO"] } });
  const [t] = await criar(b, "faça a.txt");
  const fim = await esperarStatus(b, t.id, ["executada", "erro"]);
  assert.equal(fim.status, "executada", fim.error);
  const ag = chamadas(caixa).filter((c) => c.papel === "agente");
  assert.equal(ag.length, 2);
  assert.equal(arg(ag[1], "--resume"), fim.sessionId);
  assert.match(arg(ag[1], "-p"), /falta tratar entrada vazia/);
  assert.deepEqual(chamadas(caixa).map((c) => c.papel), ["agente", "revisor", "agente", "revisor", "qa"]);
});

test("revisor sem veredito legível = reprovado (fail-closed)", async () => {
  const { caixa, b } = await preparar({ env: { BOARD_REVISOES: "0" }, cenario: {
    agente: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }], revisor: ["parece bom para mim"] } });
  const [t] = await criar(b, "faça a.txt");
  const fim = await esperarStatus(b, t.id, ["executada", "erro"]);
  assert.equal(fim.status, "erro");
  assert.match(fim.error, /revisor reprovou \(sem veredito\)/);
  assert.ok(!chamadas(caixa).some((c) => c.papel === "qa"), "com o revisor reprovando, o QA nem roda");
});

test("QA reprova depois do revisor aprovar: volta pro agente", async () => {
  const { caixa, b } = await preparar({ cenario: {
    agente: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }, { texto: "consertei", escreve: { arquivo: "a.txt", conteudo: "y" } }],
    revisor: ["APROVADO"], qa: ["REPROVADO\n1. rodar X quebra", "APROVADO"] } });
  const [t] = await criar(b, "faça a.txt");
  const fim = await esperarStatus(b, t.id, ["executada", "erro"]);
  assert.equal(fim.status, "executada", fim.error);
  assert.deepEqual(chamadas(caixa).map((c) => c.papel), ["agente", "revisor", "qa", "agente", "revisor", "qa"]);
  assert.match(arg(chamadas(caixa)[3], "-p"), /rodar X quebra/);
});

test("portão reprova (a verificação do projeto): o agente conserta e o portão roda de novo", async () => {
  const { caixa, b } = await preparar({ cenario: {
    agente: [{ texto: "fiz", escreve: { arquivo: "quebrado.txt" } }, { texto: "arrumei", apaga: "quebrado.txt", escreve: { arquivo: "certo.txt" } }],
    revisor: ["APROVADO"], qa: ["APROVADO"] } });
  const [t] = await criar(b, "faça algo");
  const fim = await esperarStatus(b, t.id, ["executada", "erro"]);
  assert.equal(fim.status, "executada", fim.error);
  const portao = (await log(b, t.id)).filter((e) => e.t === "portao" && e.estado !== "rodando").map((e) => e.estado);
  assert.deepEqual(portao, ["falhou", "passou"]);
  assert.match(arg(chamadas(caixa).filter((c) => c.papel === "agente")[1], "-p"), /PORTÃO do board reprovou/);
});

test("portão reprova e não há mais rodada de conserto: erro, e revisor/QA nem são chamados", async () => {
  const { caixa, b } = await preparar({ env: { BOARD_REVISOES: "0" }, cenario: { agente: [{ texto: "fiz", escreve: { arquivo: "quebrado.txt" } }] } });
  const [t] = await criar(b, "faça algo");
  const fim = await esperarStatus(b, t.id, ["executada", "erro"]);
  assert.equal(fim.status, "erro");
  assert.match(fim.error, /portão reprovou/);
  assert.deepEqual(chamadas(caixa).map((c) => c.papel), ["agente"]);
});

test("resposta vazia sem mexer em nada não vira 'executada'", async () => {
  const { b } = await preparar({ cenario: { agente: [{ texto: "" }] } });
  const [t] = await criar(b, "faça algo");
  const fim = await esperarStatus(b, t.id, ["executada", "erro"]);
  assert.equal(fim.status, "erro");
  assert.match(fim.error, /não produziu resposta nem mexeu em arquivo/);
});

test("um agente por projeto: da mesma pasta um espera o outro; de projetos diferentes rodam juntos", async () => {
  const { caixa, b } = await preparar({ projetos: ["demo", "outro"], cenario: { agente: [{ texto: "ok", dorme: 4000 }] } });
  const [a1] = await criar(b, "tarefa 1");
  const [a2] = await criar(b, "tarefa 2");
  const [o1] = await criar(b, "tarefa do outro", { project: "outro" });
  for (const t of [a1, a2, o1]) await esperarStatus(b, t.id, "executada", 30000);
  const cs = chamadas(caixa);
  const inicio = (proj, n) => cs.filter((c) => c.cwd.endsWith("/" + proj))[n].t;
  assert.ok(inicio("demo", 1) - inicio("demo", 0) >= 4000, "a 2ª do demo só começou depois da 1ª terminar");
  assert.ok(Math.abs(inicio("outro", 0) - inicio("demo", 0)) < 4000, "o outro projeto rodou junto");
});

test("sem cota no Claude: outro motor assume com o bastão por escrito", async () => {
  const { b } = await preparar({ cenario: { agente: [{ texto: "You've hit your limit · resets 3pm" }] } });
  const [t] = await criar(b, "faça algo");
  let task;
  for (let i = 0; i < 60; i++) { task = (await b.api("GET", `/api/tasks/${t.id}`)).json.task; if (task.motor !== "claude") break; await esperar(200); }
  assert.notEqual(task.motor, "claude");
  const ev = await log(b, t.id);
  assert.ok(ev.some((e) => e.t === "retentativa" && e.estado === "passagem"));
  assert.ok(ev.some((e) => e.t === "solto" && /limite de uso/.test(e.texto)));
});

test("parar no meio: o agente morre e a tarefa volta a pendente", async () => {
  const { caixa, b } = await preparar({ cenario: { agente: [{ texto: "demorei", dorme: 20000 }] } });
  const [t] = await criar(b, "tarefa longa");
  for (let i = 0; i < 50 && !chamadas(caixa).length; i++) await esperar(100); // o agente já começou
  const t0 = Date.now();
  await b.api("POST", `/api/tasks/${t.id}/stop`);
  const fim = await esperarStatus(b, t.id, "pendente", 8000);
  assert.equal(fim.status, "pendente");
  assert.ok(Date.now() - t0 < 5000, "parou na hora, não esperou o agente terminar");
  assert.ok(!fim.result, "o resultado do agente morto não entrou");
});

test("produção roda numa CÓPIA a partir do origin: a pasta do dono (com trabalho sem commit) não é tocada", async () => {
  const caixa = criarCaixa();
  const prod = criarProjeto(caixa, "prod", { origem: true });
  writeFileSync(join(prod, "CLAUDE.md"), "# prod\nanotação do dono sem commit\n");
  caixa.cenario({ agente: [{ texto: "PR aberto: https://github.com/o/prod/pull/1", escreve: { arquivo: "feito.txt" } }], revisor: ["APROVADO"], qa: ["APROVADO"] });
  const b = await subirBoard(caixa, { BOARD_PRODUCAO: "prod" });
  atual.push([b, caixa]);
  const [t] = await criar(b, "mude algo em produção", { project: "prod", entrega: "pr" });
  const fim = await esperarStatus(b, t.id, ["executada", "erro"]);
  assert.equal(fim.status, "executada", fim.error);
  assert.equal(fim.prUrl, "https://github.com/o/prod/pull/1");
  const ag = chamadas(caixa).find((c) => c.papel === "agente");
  assert.match(ag.cwd, /\/\.board-agentes\/prod-/, "o agente trabalhou na cópia");
  assert.ok(!existsSync(join(prod, "feito.txt")), "nada entrou na pasta do dono");
  assert.equal(readFileSync(join(prod, "CLAUDE.md"), "utf8"), "# prod\nanotação do dono sem commit\n");
  assert.match(arg(ag, "--append-system-prompt"), /NUNCA rode `git checkout main`/);
});

test("anexos: aceita imagem e PDF pela assinatura, recusa o resto, e o agente recebe o caminho", async () => {
  const { caixa, b } = await preparar({ cenario: { agente: [{ texto: "vi a imagem" }] } });
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
  const sobe = (buf, nome) => fetch(`${b.url}/api/anexos?nome=${nome}`, { method: "POST", body: buf });
  const ok = await sobe(png, "print.png");
  assert.equal(ok.status, 201);
  const { anexo } = await ok.json();
  assert.equal((await sobe(Buffer.from("%PDF-1.4 x"), "doc.pdf")).status, 201);
  assert.equal((await sobe(Buffer.from("<script>alert(1)</script>"), "x.png")).status, 400);
  assert.equal((await fetch(`${b.url}/api/anexos/${anexo.id}`)).status, 200);
  assert.equal((await fetch(`${b.url}/api/anexos/..%2F..%2Fboard.json`)).status, 404);
  const [t] = await criar(b, "olhe o print", { anexos: [anexo, { id: "../../board.json" }] });
  await esperarStatus(b, t.id, "executada");
  const p = arg(chamadas(caixa).find((c) => c.papel === "agente"), "-p");
  assert.match(p, /ABRA cada um com a ferramenta Read/);
  assert.ok(p.includes(anexo.id)); assert.ok(!p.includes("board.json"));
});

test("HTTP: tela com ETag/304, validação de entrada, várias tarefas numa mensagem", async () => {
  const { b } = await preparar();
  const r1 = await fetch(b.url + "/");
  assert.equal(r1.status, 200);
  assert.equal(r1.headers.get("cache-control"), "no-cache");
  assert.equal((await fetch(b.url + "/", { headers: { "if-none-match": r1.headers.get("etag") } })).status, 304);
  assert.equal((await b.api("POST", "/api/tasks", { text: "  " })).status, 400);
  assert.equal((await b.api("GET", "/api/nao-existe")).status, 404);
  assert.equal((await b.api("GET", "/api/tasks/9999")).status, 404);
  const r = await b.api("POST", "/api/tasks", { text: "- primeira\n- segunda\n- terceira", project: "demo" });
  assert.deepEqual(r.json.tasks.map((t) => t.title), ["primeira", "segunda", "terceira"]);
  assert.ok(r.json.tasks.every((t) => t.status === "pendente"), "sem 'queue', não entra na fila");
  assert.equal((await b.api("PATCH", `/api/tasks/${r.json.tasks[0].id}`, { status: "rodando" })).status, 400, "só o runner põe pra rodar");
});

test("fila pausada: nada começa até retomar", async () => {
  const { caixa, b } = await preparar({ cenario: { agente: [{ texto: "ok" }] } });
  await b.api("POST", "/api/fila/pausar");
  const [t] = await criar(b, "espere");
  await esperar(3500);
  assert.equal((await b.api("GET", `/api/tasks/${t.id}`)).json.task.status, "fila");
  assert.equal(chamadas(caixa).length, 0);
  await b.api("POST", "/api/fila/retomar");
  assert.equal((await esperarStatus(b, t.id, "executada")).status, "executada");
});

test("só UM board por quadro: o segundo no mesmo data/ recusa subir", async () => {
  const { caixa } = await preparar();
  const cp = spawn(process.execPath, ["board.mjs"], { cwd: caixa.board, env: envDaCaixa(caixa, { BOARD_PORT: "0" }), stdio: ["ignore", "pipe", "pipe"] });
  let saida = ""; cp.stderr.on("data", (d) => (saida += d)); cp.stdout.on("data", (d) => (saida += d));
  const code = await new Promise((ok) => cp.on("close", ok));
  assert.equal(code, 1);
  assert.match(saida, /já existe um board rodando/);
});
