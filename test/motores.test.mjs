// Engine tests: a task running on Codex, Gemini (agy) and opencode — each fake speaks the engine's REAL output format —
// and the baton pass when an engine runs out of quota mid-task. This is the path that runs at night, when nobody watches.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { criarCaixa, criarProjeto, subirBoard, esperarStatus, chamadas, limparCaixa, esperar } from "./ajuda.mjs";

let atual = [];
afterEach(async () => { for (const [b, c] of atual) { await b.fim(); limparCaixa(c); } atual = []; });

async function preparar({ cenario = {}, env = {} } = {}) {
  const caixa = criarCaixa();
  criarProjeto(caixa, "demo");
  caixa.cenario(cenario);
  const b = await subirBoard(caixa, env);
  atual.push([b, caixa]);
  return { caixa, b, demo: join(caixa.dev, "demo") };
}
const criar = async (b, text, extra = {}) => (await b.api("POST", "/api/tasks", { text, project: "demo", queue: true, ...extra })).json.tasks;
const log = async (b, id) => (await b.api("GET", `/api/tasks/${id}/log`)).json.events;
const tarefa = async (b, id) => (await b.api("GET", `/api/tasks/${id}`)).json.task;
const arg = (c, f) => { const i = c.args.indexOf(f); return i >= 0 ? c.args[i + 1] : undefined; };
const doMotor = (caixa, motor, papel = "agente") => chamadas(caixa).filter((c) => (c.motor || "claude") === motor && c.papel === papel);
async function ate(fn, limite = 15000) { const t0 = Date.now(); let v; while (Date.now() - t0 < limite) { v = await fn(); if (v) return v; await esperar(200); } return v; }

test("Codex: roda na pasta, com as regras no prompt, sandbox liberando .git — e o revisor continua no Claude (conferência cruzada)", async () => {
  const { caixa, b, demo } = await preparar({ cenario: { codex: [{ texto: "criei a.txt pelo codex", escreve: { arquivo: "a.txt" } }], revisor: ["APROVADO"], qa: ["APROVADO"] } });
  const [t] = await criar(b, "crie a.txt", { motor: "codex" });
  const fim = await esperarStatus(b, t.id, ["executada", "erro"]);
  assert.equal(fim.status, "executada", fim.error);
  assert.equal((await tarefa(b, t.id)).result, "criei a.txt pelo codex");
  const [c] = doMotor(caixa, "codex");
  assert.equal(c.cwd, demo);
  assert.deepEqual(c.args.slice(0, 2), ["exec", "--json"]);
  assert.equal(arg(c, "--sandbox"), "workspace-write");
  assert.ok(c.args.includes(`sandbox_workspace_write.writable_roots=["${join(demo, ".git")}"]`), "sem isso o agente não commita (#127)");
  assert.match(c.args.at(-1), /^Você está executando a tarefa #\d+ do BOARD[\s\S]*\n\n---\n\ncrie a\.txt$/, "Codex não tem system prompt: regras + --- + tarefa");
  assert.match(fim.sessionId, /^01a0c9ec-/, "a sessão é o thread_id do Codex");
  const r = (await log(b, t.id)).find((e) => e.t === "resultado" && e.motor === "codex");
  assert.equal(r.tokens, 54710 + 269, "o Codex conta tokens…");
  assert.ok(!r.custo, "…e não dólar (o board não inventa a conversão)");
  assert.ok((await log(b, t.id)).some((e) => e.t === "ferramenta" && e.nome === "Bash" && e.quem === "agente"));
  assert.equal(doMotor(caixa, "claude", "revisor").length, 1, "revisor no Claude");
  assert.equal(doMotor(caixa, "claude", "qa").length, 1, "QA no Claude");
});

test("Codex: o chat retoma a MESMA sessão com `exec resume`, sem --sandbox (o resume recusa, #127)", async () => {
  const { caixa, b } = await preparar({ cenario: { codex: ["primeira", "respondi o chat"] } });
  const [t] = await criar(b, "pergunta", { motor: "codex" });
  const fim = await esperarStatus(b, t.id, "executada");
  await b.api("POST", `/api/tasks/${t.id}/chat`, { text: "e o detalhe?" });
  await ate(async () => doMotor(caixa, "codex").length === 2 && !(await tarefa(b, t.id)).busy);
  const r = doMotor(caixa, "codex")[1];
  assert.deepEqual(r.args.slice(0, 2), ["exec", "resume"]);
  assert.equal(r.args.at(-2), fim.sessionId);
  assert.ok(!r.args.includes("--sandbox"));
  assert.ok((await log(b, t.id)).some((e) => e.t === "texto" && e.texto === "respondi o chat"));
});

test("Gemini (agy): texto que chega aos pedaços vira UM resumo, --add-dir na pasta do projeto, escrita liga a esteira", async () => {
  const texto = "Corrigi o arquivo b.txt e conferi com cuidado, linha por linha.";
  const { caixa, b, demo } = await preparar({ cenario: { gemini: [{ texto, escreve: { arquivo: "b.txt" } }, "respondi"], revisor: ["APROVADO"], qa: ["APROVADO"] } });
  const [t] = await criar(b, "corrija b.txt", { motor: "gemini" });
  const fim = await esperarStatus(b, t.id, ["executada", "erro"]);
  assert.equal(fim.status, "executada", fim.error);
  assert.equal((await tarefa(b, t.id)).result, texto);
  const [c] = doMotor(caixa, "gemini");
  assert.equal(arg(c, "--add-dir"), demo, "sem --add-dir o agy trabalha no workspace dele, em silêncio");
  assert.equal(arg(c, "--output-format"), "stream-json");
  assert.match(fim.sessionId, /^ecd6b494-/);
  assert.equal(fim.tokens, 42753 + 666);
  assert.ok((await log(b, t.id)).some((e) => e.t === "ferramenta" && e.nome === "replace_file_content"));
  assert.equal(doMotor(caixa, "claude", "revisor").length, 1, "a escrita do agy ligou revisor e QA");
  await b.api("POST", `/api/tasks/${t.id}/chat`, { text: "e agora?" });
  await ate(async () => doMotor(caixa, "gemini").length === 2 && !(await tarefa(b, t.id)).busy);
  assert.equal(arg(doMotor(caixa, "gemini")[1], "--conversation"), fim.sessionId);
});

test("opencode: texto, ferramenta de escrita, tokens E dólar do step_finish; retoma com -s", async () => {
  const { caixa, b } = await preparar({ cenario: { opencode: [{ texto: "feito pelo opencode", escreve: { arquivo: "c.txt" } }, "respondi"], revisor: ["APROVADO"], qa: ["APROVADO"] } });
  const [t] = await criar(b, "crie c.txt", { motor: "opencode" });
  const fim = await esperarStatus(b, t.id, ["executada", "erro"]);
  assert.equal(fim.status, "executada", fim.error);
  assert.equal((await tarefa(b, t.id)).result, "feito pelo opencode");
  const [c] = doMotor(caixa, "opencode");
  assert.deepEqual(c.args.slice(0, 4), ["run", "--format", "json", "--auto"], "sem --auto o opencode recusa a pasta do projeto");
  const r = (await log(b, t.id)).find((e) => e.t === "resultado" && e.motor === "opencode");
  assert.equal(r.tokens, 30257, "o opencode conta tokens…");
  assert.equal(r.custo, 0.0123, "…e dólar");
  assert.ok((await log(b, t.id)).some((e) => e.t === "ferramenta" && e.nome === "write"));
  assert.equal(doMotor(caixa, "claude", "revisor").length, 1, "a escrita ligou a esteira");
  await b.api("POST", `/api/tasks/${t.id}/chat`, { text: "e agora?" });
  await ate(async () => doMotor(caixa, "opencode").length === 2 && !(await tarefa(b, t.id)).busy);
  assert.equal(arg(doMotor(caixa, "opencode")[1], "-s"), fim.sessionId);
});

test("opencode sem cota: a mensagem aparece legível (não JSON cru) e a cota é reconhecida → outro motor assume", async () => {
  const msg = "You exceeded your current quota, please check your plan and billing details. Rate limit reached for requests on this organization, try again later.";
  const { caixa, b } = await preparar({ env: { BOARD_MOTORES_RESERVA: "codex" }, cenario: { opencode: [{ erro: msg }], codex: ["terminei no codex"] } });
  const [t] = await criar(b, "faça algo", { motor: "opencode" });
  const fim = await esperarStatus(b, t.id, ["executada", "erro"], 25000);
  assert.equal(fim.status, "executada", fim.error);
  assert.equal(fim.motor, "codex");
  const ev = await log(b, t.id);
  const aviso = ev.find((e) => e.t === "solto" && /limite de uso/.test(e.texto || ""));
  assert.ok(aviso, "a cota foi reconhecida");
  assert.match(aviso.texto, /limite de uso: You exceeded your current quota/, "a tela mostra a mensagem, não o envelope JSON");
});

test("Gemini sem cota (erro real do agy) → o Codex assume com o bastão escrito e termina", async () => {
  const { caixa, b } = await preparar({ env: { BOARD_MOTORES_RESERVA: "codex" }, cenario: {
    gemini: [{ erro: "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 8m58s.", escreve: { arquivo: "meio.txt" } }],
    codex: ["terminei o que o gemini começou"], revisor: ["APROVADO"], qa: ["APROVADO"] } });
  const [t] = await criar(b, "tarefa longa", { motor: "gemini" });
  const fim = await esperarStatus(b, t.id, ["executada", "erro"], 25000);
  assert.equal(fim.status, "executada", fim.error);
  assert.equal(fim.motor, "codex");
  const p = doMotor(caixa, "codex")[0].args.at(-1);
  assert.match(p, /PASSAGEM DE BASTÃO: esta tarefa foi começada por outro agente \(Gemini\) e ele ficou SEM COTA/);
  assert.match(p, /A tarefa original:\ntarefa longa/);
  assert.match(p, /Como está a pasta AGORA \(git status\):\n\?\? meio\.txt/, "o bastão diz como está a pasta (o arquivo que o gemini deixou)");
  assert.match(p, /replace_file_content/, "e os últimos passos do agente anterior");
  assert.ok((await log(b, t.id)).some((e) => e.t === "retentativa" && e.estado === "passagem"));
});

test("Claude sem cota → Codex assume; a tarefa termina e o revisor segue no Claude", async () => {
  const { caixa, b } = await preparar({ env: { BOARD_MOTORES_RESERVA: "codex" }, cenario: {
    agente: [{ texto: "You've hit your limit · resets 3pm" }], codex: [{ texto: "terminei", escreve: { arquivo: "d.txt" } }], revisor: ["APROVADO"], qa: ["APROVADO"] } });
  const [t] = await criar(b, "faça d.txt");
  const fim = await esperarStatus(b, t.id, ["executada", "erro"], 25000);
  assert.equal(fim.status, "executada", fim.error);
  assert.equal(fim.motor, "codex");
  assert.match(doMotor(caixa, "codex")[0].args.at(-1), /começada por outro agente \(Claude\)/);
  assert.equal(doMotor(caixa, "claude", "revisor").length, 1);
});

test("conversa do projeto no Codex: responde e a segunda mensagem retoma o mesmo fio", async () => {
  const { caixa, b } = await preparar({ cenario: { codex: ["primeira no codex", "segunda no codex"] } });
  await b.api("POST", "/api/conversa/demo", { texto: "oi", motor: "codex" });
  await ate(async () => { const x = (await b.api("GET", "/api/conversa/demo")).json; return x.events.some((e) => e.t === "resultado") && !x.busy; });
  await b.api("POST", "/api/conversa/demo", { texto: "e agora?" });
  const c = await ate(async () => { const x = (await b.api("GET", "/api/conversa/demo")).json; return x.events.filter((e) => e.t === "resultado").length === 2 && !x.busy && x; });
  assert.deepEqual(c.events.filter((e) => e.t === "resultado").map((e) => e.texto), ["primeira no codex", "segunda no codex"]);
  const cs = doMotor(caixa, "codex");
  assert.deepEqual(cs[1].args.slice(0, 2), ["exec", "resume"]);
  assert.equal(cs[1].args.at(-2).slice(0, 9), "01a0c9ec-");
});
