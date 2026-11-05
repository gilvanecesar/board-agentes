// #288: tarefa reprovada e consertada pelo CHAT. Na #286 (31/10) o conserto terminou às 22:53 e portão, revisor e QA nunca
// rodaram: a tarefa seguiu em erro por ~10 h, calada. A conferência agora vem pela fila, sem rodar o agente de novo.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { chamadas, criarCaixa, criarProjeto, envDaCaixa, subirBoard, limparCaixa, esperar, esperarStatus } from "./ajuda.mjs";
import { abrirNavegador, CHROME } from "./navegador.mjs";

let atual = [];
afterEach(async () => { for (const [b, c] of atual) { await b.fim(); limparCaixa(c); } atual = []; });

const CONTA = { BOARD_REVISOES: "0", BOARD_RETENTATIVAS: "0" };
async function preparar(cenario, env = {}, antes) {
  const caixa = criarCaixa();
  criarProjeto(caixa, "demo");
  caixa.cenario(cenario);
  if (antes) antes(caixa);
  const b = await subirBoard(caixa, { ...CONTA, ...env });
  atual.push([b, caixa]);
  return { caixa, b, demo: join(caixa.dev, "demo") };
}
const criar = async (b, text, extra = {}) => (await b.api("POST", "/api/tasks", { text, project: "demo", queue: true, ...extra })).json.tasks[0];
const tarefa = async (b, id) => (await b.api("GET", `/api/tasks/${id}`)).json.task;
const log = async (b, id) => (await b.api("GET", `/api/tasks/${id}/log`)).json.events;
const papeis = (caixa) => chamadas(caixa).map((c) => c.papel);
const arg = (c, f) => { const i = c.args.indexOf(f); return i >= 0 ? c.args[i + 1] : undefined; };
const chat = (b, id, text) => b.api("POST", `/api/tasks/${id}/chat`, { text });
async function ate(fn, limite = 15000) { const t0 = Date.now(); let v; while (Date.now() - t0 < limite) { v = await fn(); if (v) return v; await esperar(150); } return v; }
const terminouChat = (b, id) => ate(async () => { const t = await tarefa(b, id); return !t.busy && (await log(b, id)).filter((e) => e.t === "dono").length && t; });
/** Uma volta de runner a mais, para o que NÃO devia acontecer ter tido a chance de acontecer. */
const umaVolta = () => esperar(2500);
const reprovadaQa = async (b) => { const t = await criar(b, "faça a.txt"); const fim = await esperarStatus(b, t.id, "erro"); assert.match(fim.error, /QA reprovou/); return t; };

test("conserto pelo chat numa tarefa reprovada: portão, revisor e QA rodam, sem o agente de novo, e a tarefa sai do erro", async () => {
  const { caixa, b, demo } = await preparar({
    agente: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }, { texto: "consertei no chat", escreve: { arquivo: "b.txt" } }],
    revisor: ["APROVADO"], qa: ["REPROVADO\n- defeito", "APROVADO"] });
  writeFileSync(join(demo, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
  execFileSync("git", ["-C", demo, "add", "-A"]); execFileSync("git", ["-C", demo, "commit", "-qm", "scripts"]);
  const t = await reprovadaQa(b);
  assert.equal((await chat(b, t.id, "conserte o defeito")).status, 202);
  const fim = await esperarStatus(b, t.id, ["executada"], 20000);
  assert.deepEqual(papeis(caixa), ["agente", "revisor", "qa", "agente", "revisor", "qa"]);
  assert.equal(fim.error, null); assert.ok(!fim.conferir); assert.ok(!fim.reprovaPendente);
  assert.equal(fim.gate?.ok, true, "o portão rodou");
  assert.match(arg(chamadas(caixa)[4], "-p"), /consertei no chat/, "o revisor recebe o que o agente disse no chat");
  const ev = await log(b, t.id);
  assert.ok(ev.some((e) => e.t === "inicio" && /conferir o conserto do chat/.test(e.titulo)));
  assert.equal(ev.filter((e) => e.t === "portao" && e.estado === "passou").length, 2);
});

test("rodada do chat que muda a pasta só por comando (sem Write/Edit) também confere", async () => {
  const { caixa, b } = await preparar({
    agente: [{ texto: "fiz", escreve: { arquivo: "CLAUDE.md", conteudo: "# mudei\n" } }, { texto: "voltei atrás", apaga: "CLAUDE.md" }],
    revisor: ["APROVADO"], qa: ["REPROVADO", "APROVADO"] });
  const t = await reprovadaQa(b);
  await chat(b, t.id, "apague");
  await esperarStatus(b, t.id, ["executada"], 20000);
  assert.equal(papeis(caixa).filter((p) => p === "qa").length, 2);
});

test("arquivo NOVO, sem commit, alterado só por comando: o nome não muda e mesmo assim confere", async () => {
  const { caixa, b } = await preparar({
    agente: [{ texto: "fiz", escreve: { arquivo: "novo.txt", conteudo: "antes\n" } }, { texto: "corrigi por sed", altera: { arquivo: "novo.txt", conteudo: "depois\n" } }],
    revisor: ["APROVADO"], qa: ["REPROVADO", "APROVADO"] });
  const t = await reprovadaQa(b);
  await chat(b, t.id, "corrija");
  await esperarStatus(b, t.id, ["executada"], 20000);
  assert.equal(papeis(caixa).filter((p) => p === "qa").length, 2);
});

test("pergunta no chat (a pasta não muda): segue em erro, sem conferência", async () => {
  const { caixa, b } = await preparar({ agente: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }, "é por causa disso"], revisor: ["APROVADO"], qa: ["REPROVADO"] });
  const t = await reprovadaQa(b);
  await chat(b, t.id, "por que reprovou?");
  const fim = await terminouChat(b, t.id);
  await umaVolta();
  assert.equal(fim.status, "erro"); assert.equal((await tarefa(b, t.id)).status, "erro");
  assert.deepEqual(papeis(caixa), ["agente", "revisor", "qa", "agente"]);
});

test("tarefa sem reprovação: o chat que mexe em arquivo segue como sempre foi", async () => {
  const { caixa, b } = await preparar({ agente: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }, { texto: "ajustei", escreve: { arquivo: "b.txt" } }], revisor: ["APROVADO"], qa: ["APROVADO"] });
  const t = await criar(b, "faça a.txt");
  await esperarStatus(b, t.id, "executada");
  await chat(b, t.id, "ajuste");
  await terminouChat(b, t.id);
  await umaVolta();
  assert.equal((await tarefa(b, t.id)).status, "executada");
  assert.deepEqual(papeis(caixa), ["agente", "revisor", "qa", "agente"]);
});

test("a conferência reprova de novo: volta para erro, nunca para executada", async () => {
  const { b } = await preparar({ agente: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }, { texto: "tentei", escreve: { arquivo: "b.txt" } }], revisor: ["APROVADO"], qa: ["REPROVADO", "REPROVADO\n- ainda quebra"] });
  const t = await reprovadaQa(b);
  await chat(b, t.id, "conserte");
  await ate(async () => (await log(b, t.id)).filter((e) => e.t === "qa").length === 2);
  const fim = await esperarStatus(b, t.id, "erro");
  assert.match(fim.error, /QA reprovou/); assert.equal(fim.reprovaPendente, true);
});

test("portão vermelho sem mais rodadas também é reprovação: conserto no chat confere", async () => {
  const { caixa, b } = await preparar({ agente: [{ texto: "fiz", escreve: { arquivo: "ok.txt", conteudo: "ruim\n" } }, { texto: "consertei", escreve: { arquivo: "ok.txt", conteudo: "bom\n" } }], revisor: ["APROVADO"], qa: ["APROVADO"] }, {},
    (c) => { writeFileSync(join(c.dev, "demo", "package.json"), JSON.stringify({ scripts: { test: "grep -q bom ok.txt" } })); });
  const t = await criar(b, "faça ok.txt");
  const fim = await esperarStatus(b, t.id, "erro");
  assert.match(fim.error, /portão reprovou/);
  await chat(b, t.id, "conserte");
  await esperarStatus(b, t.id, ["executada"], 20000);
  assert.deepEqual(papeis(caixa), ["agente", "agente", "revisor", "qa"]);
});

test("retentativa agendada: o conserto do chat a troca pela conferência, sem 'continue de onde parou'", async () => {
  const { caixa, b } = await preparar({ agente: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }, { texto: "consertei", escreve: { arquivo: "b.txt" } }], revisor: ["APROVADO"], qa: ["REPROVADO", "APROVADO"] }, { BOARD_RETENTATIVAS: "2", BOARD_RETENTATIVA_MIN: "60" });
  const t = await reprovadaQa(b);
  assert.ok((await tarefa(b, t.id)).retentativa, "a retentativa ficou agendada");
  await chat(b, t.id, "conserte");
  const fim = await esperarStatus(b, t.id, ["executada"], 20000);
  assert.equal(fim.retentativa, null);
  assert.equal(chamadas(caixa).filter((c) => c.papel === "agente").length, 2);
  assert.ok(!chamadas(caixa).some((c) => /Continue de onde parou/.test(arg(c, "-p") || "")));
});

test("concluída não volta; chat parado pelo dono não enfileira; os dois dizem o que ficou sem conferir", async () => {
  const { caixa, b } = await preparar({ agente: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }, { texto: "mudei", escreve: { arquivo: "b.txt" } }, { texto: "cortado", dorme: 1500, escreve: { arquivo: "c.txt" } }], revisor: ["APROVADO"], qa: ["REPROVADO"] });
  const t = await reprovadaQa(b);
  await b.api("PATCH", `/api/tasks/${t.id}`, { status: "concluida" });
  await chat(b, t.id, "mais uma coisa");
  await ate(async () => (await log(b, t.id)).some((e) => /tarefa concluída com reprovação/.test(e.texto || "")));
  await umaVolta();
  assert.equal((await tarefa(b, t.id)).status, "concluida");
  assert.equal(papeis(caixa).filter((p) => p === "revisor").length, 1);

  // Parado no meio: o claude falso morto não escreve, então a pasta muda por fora durante o chat.
  await b.api("PATCH", `/api/tasks/${t.id}`, { status: "erro" });
  const demo = join(caixa.dev, "demo");
  await chat(b, t.id, "mais uma");
  await ate(async () => (await tarefa(b, t.id)).busy);
  writeFileSync(join(demo, "CLAUDE.md"), "# mudou durante o chat\n");
  assert.equal((await b.api("POST", `/api/tasks/${t.id}/stop`)).status, 200);
  await ate(async () => (await log(b, t.id)).some((e) => /você parou o chat e a pasta mudou/.test(e.texto || "")));
  await umaVolta();
  const fim = await tarefa(b, t.id);
  assert.equal(fim.status, "pendente"); assert.ok(!fim.conferir);
  assert.equal(papeis(caixa).filter((p) => p === "revisor").length, 1);
});

test("QA reprova, o chat conserta, o QA da conferência cai e outro chat conserta: confere de novo", async () => {
  const { caixa, b } = await preparar({ agente: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }, { texto: "1", escreve: { arquivo: "b.txt" } }, { texto: "2", escreve: { arquivo: "c.txt" } }],
    revisor: ["APROVADO"], qa: ["REPROVADO", { texto: "API fora", erro: true }, "APROVADO"] });
  const t = await reprovadaQa(b);
  await chat(b, t.id, "conserte");
  const cortada = await esperarStatus(b, t.id, "erro", 20000);
  assert.match(cortada.error, /QA não rodou/); assert.equal(cortada.reprovaPendente, true, "o revisor aprovar não apaga a reprova do QA");
  await chat(b, t.id, "conserte de novo");
  await esperarStatus(b, t.id, ["executada"], 20000);
  assert.equal(papeis(caixa).filter((p) => p === "qa").length, 3);
});

test("QA caído sem reprova nenhuma e conserto no chat: a conferência devida vai à fila", async () => {
  const { caixa, b } = await preparar({ agente: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }, { texto: "ajustei", escreve: { arquivo: "b.txt" } }], revisor: ["APROVADO"], qa: [{ texto: "API fora", erro: true }, "APROVADO"] });
  const t = await criar(b, "faça a.txt");
  const cortada = await esperarStatus(b, t.id, "erro");
  assert.ok(!cortada.reprovaPendente); assert.equal(cortada.conferenciaPendente, true);
  await chat(b, t.id, "ajuste");
  await esperarStatus(b, t.id, ["executada"], 20000);
  assert.equal(papeis(caixa).filter((p) => p === "qa").length, 2);
});

for (const sinal of ["SIGTERM", "SIGKILL"]) {
  test(`board cai (${sinal}) no meio do chat de conserto: ao subir, a conferência vai à fila e roda`, async () => {
    const { caixa, b, demo } = await preparar({ agente: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }, { texto: "nunca chega", dorme: 30000 }], revisor: ["APROVADO"], qa: ["REPROVADO", "APROVADO"] });
    const t = await reprovadaQa(b);
    await chat(b, t.id, "conserte");
    await ate(async () => chamadas(caixa).filter((c) => c.papel === "agente").length === 2);
    writeFileSync(join(demo, "conserto.txt"), "conserto\n");
    b.cp.kill(sinal);
    await ate(() => b.cp.exitCode !== null || b.cp.signalCode !== null);
    const b2 = await subirBoard(caixa, CONTA); atual.at(-1)[0] = b2;
    const fim = await esperarStatus(b2, t.id, ["executada"], 20000);
    assert.equal(fim.chatAberto, null); assert.ok(!fim.reprovaPendente);
    assert.deepEqual(papeis(caixa).slice(-2), ["revisor", "qa"]);
    assert.equal(papeis(caixa).filter((p) => p === "agente").length, 2, "o agente não roda de novo");
    assert.ok((await log(b2, t.id)).some((e) => /o board caiu no meio do chat e a pasta mudou/.test(e.texto || "")));
  });
}

test("board cai no meio de um chat que não mudou nada: ao subir, nada de conferência", async () => {
  const { caixa, b } = await preparar({ agente: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }, { texto: "nunca chega", dorme: 30000 }], revisor: ["APROVADO"], qa: ["REPROVADO"] });
  const t = await reprovadaQa(b);
  await chat(b, t.id, "por que reprovou?");
  await ate(async () => chamadas(caixa).filter((c) => c.papel === "agente").length === 2);
  b.cp.kill("SIGKILL");
  await ate(() => b.cp.signalCode !== null);
  const b2 = await subirBoard(caixa, CONTA); atual.at(-1)[0] = b2;
  await umaVolta();
  const fim = await tarefa(b2, t.id);
  assert.equal(fim.status, "erro"); assert.ok(!fim.conferir); assert.equal(fim.chatAberto, null);
  assert.equal(papeis(caixa).filter((p) => p === "qa").length, 1);
});

test("conserto na pasta sem conferência: o chat seguinte que não muda nada confere, porque a pasta não é a reprovada", async () => {
  const { caixa, b, demo } = await preparar({ agente: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }, "já está feito"], revisor: ["APROVADO"], qa: ["REPROVADO", "APROVADO"] });
  const t = await reprovadaQa(b);
  writeFileSync(join(demo, "conserto.txt"), "de um chat que não fechou\n");
  await chat(b, t.id, "e o conserto?");
  await esperarStatus(b, t.id, ["executada"], 20000);
  assert.equal(papeis(caixa).filter((p) => p === "qa").length, 2);
});

test("⏹ no chat e outro chat na hora: o primeiro, terminando por trás, não solta a tarefa nem enfileira", async () => {
  const { caixa, b, demo } = await preparar({ agente: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }, { texto: "cortado", dorme: 1500 }, { texto: "respondendo", dorme: 3000 }], revisor: ["APROVADO"], qa: ["REPROVADO", "APROVADO"] });
  const t = await reprovadaQa(b);
  await chat(b, t.id, "um");
  await ate(async () => chamadas(caixa).filter((c) => c.papel === "agente").length === 2);
  writeFileSync(join(demo, "mudou.txt"), "x\n");
  // No mesmo instante: o 2º tem de chegar antes de o processo do 1º acabar de sair, senão não há corrida.
  const [, dois] = await Promise.all([b.api("POST", `/api/tasks/${t.id}/stop`), chat(b, t.id, "dois")]);
  assert.equal(dois.status, 202);
  await esperar(1000); // o processo do 1º já saiu; o 2º ainda responde
  const meio = await tarefa(b, t.id);
  assert.equal(meio.busy, true, "o 2º chat continua dono da tarefa");
  assert.equal(meio.status, "pendente"); assert.ok(!meio.conferir);
  assert.equal(papeis(caixa).filter((p) => p === "qa").length, 1);
});

test("⏹ na conferência que esperava na fila não deixa a marca para trás", async () => {
  const { b } = await preparar({ agente: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }, { texto: "consertei", escreve: { arquivo: "b.txt" } }], revisor: ["APROVADO"], qa: ["REPROVADO", "APROVADO"] });
  const t = await reprovadaQa(b);
  await b.api("POST", "/api/fila/pausar");
  await chat(b, t.id, "conserte");
  await ate(async () => (await tarefa(b, t.id)).conferir);
  await b.api("POST", `/api/tasks/${t.id}/stop`);
  const fim = await tarefa(b, t.id);
  assert.equal(fim.status, "pendente"); assert.ok(!fim.conferir);
});

test("⚡ em cópia: confere na cópia e, aprovada, junta na pasta", async () => {
  const { caixa, b, demo } = await preparar({ agente: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }, { texto: "consertei", escreve: { arquivo: "b.txt", conteudo: "conserto\n" } }], revisor: ["APROVADO"], qa: ["REPROVADO", "APROVADO"] });
  const t = await criar(b, "faça a.txt", { paralelo: true });
  await esperarStatus(b, t.id, "erro");
  await chat(b, t.id, "conserte");
  await esperarStatus(b, t.id, ["executada"], 20000);
  assert.match(chamadas(caixa).filter((c) => c.papel === "qa")[1].cwd, /\/\.board-agentes\/demo-/);
  await ate(async () => (await tarefa(b, t.id)).worktree?.juntar === "ok");
  assert.equal(readFileSync(join(demo, "b.txt"), "utf8"), "conserto\n");
});

test("fila pausada: a conferência espera e AVISA (ficha, Central, quadro, CLI)", { skip: !CHROME && "sem Chrome nesta máquina" }, async () => {
  const { caixa, b } = await preparar({ agente: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }, { texto: "consertei", escreve: { arquivo: "b.txt" } }], revisor: ["APROVADO"], qa: ["REPROVADO", "APROVADO"] });
  const t = await reprovadaQa(b);
  await b.api("POST", "/api/fila/pausar");
  await chat(b, t.id, "conserte");
  await ate(async () => (await tarefa(b, t.id)).conferir);
  assert.equal((await tarefa(b, t.id)).status, "fila");
  const cli = execFileSync(process.execPath, [join(caixa.board, "board-cli.mjs"), "list"], { encoding: "utf8", env: { ...envDaCaixa(caixa), BOARD_URL: b.url } });
  assert.match(cli, new RegExp(`#${t.id}\\s+A CONFERIR`));
  const nav = await abrirNavegador();
  const texto = async (sel, rx) => { let txt = ""; for (let i = 0; i < 60 && !rx.test(txt); i++) { await esperar(150); txt = await nav.avaliar(`document.querySelector(${JSON.stringify(sel)})?.innerText || ''`); } return txt; };
  try {
    await nav.carregar(b.url + `/#/t/${t.id}`);
    await nav.quieto();
    assert.match(await texto("#app", /Falta conferir/), /Falta conferir[\s\S]*Portão, revisor e QA/);
    await nav.carregar(b.url + "/#/central");
    await nav.quieto();
    assert.match(await texto("body", /FALTA CONFERIR/), new RegExp(`FALTA CONFERIR[\\s\\S]*#${t.id}[\\s\\S]*SESSÕES ABERTAS`));
    await nav.carregar(b.url + "/#/");
    await nav.quieto();
    assert.match(await texto("#app", /falta conferir/), /falta conferir/);
    assert.deepEqual(nav.erros, []);
  } finally { await nav.fechar(); }
  await b.api("POST", "/api/fila/retomar");
  await esperarStatus(b, t.id, ["executada"], 20000);
  assert.equal(papeis(caixa).filter((p) => p === "qa").length, 2);
  assert.ok(existsSync(join(caixa.dev, "demo", "b.txt")));
});

test("mexer no status à mão cancela a conferência que esperava na fila", async () => {
  const { caixa, b } = await preparar({ agente: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }, { texto: "consertei", escreve: { arquivo: "b.txt" } }], revisor: ["APROVADO"], qa: ["REPROVADO", "APROVADO"] });
  const t = await reprovadaQa(b);
  await b.api("POST", "/api/fila/pausar");
  await chat(b, t.id, "conserte");
  await ate(async () => (await tarefa(b, t.id)).conferir);
  await b.api("PATCH", `/api/tasks/${t.id}`, { status: "pendente" });
  await b.api("POST", "/api/fila/retomar");
  await umaVolta();
  const fim = await tarefa(b, t.id);
  assert.equal(fim.status, "pendente"); assert.ok(!fim.conferir);
  assert.equal(papeis(caixa).filter((p) => p === "qa").length, 1);
});
