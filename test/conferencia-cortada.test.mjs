// #290: "a rodada mexeu?" era pergunta sobre UMA rodada, e a conferência é dívida da TAREFA. Cortada no meio (o QA da #286
// saiu com código 143 em 01/11, sem veredito), a retomada que não muda arquivo fechava como "executada" sem revisor nem QA.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { chamadas, criarCaixa, criarProjeto, subirBoard, limparCaixa, esperar, esperarStatus } from "./ajuda.mjs";

let atual = [];
afterEach(async () => { for (const [b, c] of atual) { await b.fim(); limparCaixa(c); } atual = []; });

const VOLTA = { BOARD_REVISOES: "0", BOARD_RETENTATIVAS: "1", BOARD_RETENTATIVA_MIN: "0.02" };
async function preparar(cenario, { env = {}, portao = null, antes = null } = {}) {
  const caixa = criarCaixa();
  criarProjeto(caixa, "demo");
  caixa.cenario(cenario);
  const demo = join(caixa.dev, "demo");
  if (portao) { // portão de verdade: `npm test` do próprio projeto
    writeFileSync(join(demo, "package.json"), JSON.stringify({ scripts: { test: portao } }));
    execFileSync("git", ["-C", demo, "add", "-A"]); execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", demo, "commit", "-qm", "scripts"]);
  }
  if (antes) antes(caixa);
  const b = await subirBoard(caixa, { ...VOLTA, ...env });
  atual.push([b, caixa]);
  return { caixa, b, demo };
}
const criar = async (b, extra = {}) => (await b.api("POST", "/api/tasks", { text: "faça a.txt", project: "demo", queue: true, ...extra })).json.tasks[0];
const log = async (b, id) => (await b.api("GET", `/api/tasks/${id}/log`)).json.events;
const papeis = (caixa) => chamadas(caixa).map((c) => c.papel);
const CORTADO = { texto: "", codigo: 143 };
/** O papel que caiu por falha do motor vai à retentativa (o corte sem resposta repete sozinho antes: test/sem-veredito.test.mjs, #306). */
const CAIU = { texto: "API fora do ar", erro: true };
/** Depois do "Virar PR" a tarefa passa por rodando, erro e fila: o fim é a entrega corrida e nada mais agendado. */
async function esperarEntrega(b, id) {
  let t;
  for (let i = 0; i < 150; i++) {
    t = (await b.api("GET", `/api/tasks/${id}`)).json.task;
    if (t.status === "executada" && !t.busy && (await log(b, id)).some((e) => e.t === "fim" && e.status === "erro")) return t;
    if (t.status === "erro" && !t.busy && !t.retentativa) return t;
    await esperar(200);
  }
  throw new Error(`a tarefa #${id} não terminou a entrega (está ${t?.status})`);
}
const avisou = (ev) => ev.some((e) => e.t === "solto" && /conferência .*cortada/.test(e.texto));

test("QA caído, sem veredito, e retomada sem mudança: revisor e QA rodam de novo antes de fechar", async () => {
  const { caixa, b } = await preparar({
    agente: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }, { texto: "nada a fazer: o código continua pronto" }],
    revisor: ["APROVADO"], qa: [CAIU, "APROVADO"] });
  const t = await criar(b);
  const fim = await esperarStatus(b, t.id, ["executada"], 20000);
  assert.deepEqual(papeis(caixa), ["agente", "revisor", "qa", "agente", "revisor", "qa"]);
  assert.equal(fim.qa?.veredito, "APROVADO", "a tarefa só fecha com o veredito do QA");
  assert.equal(fim.revisor?.veredito, "APROVADO");
  assert.ok(!fim.conferenciaPendente, "aprovada, a dívida acaba");
  const ev = await log(b, t.id);
  assert.ok(ev.some((e) => e.t === "fim" && e.status === "erro" && /QA não rodou.*API fora/.test(e.motivo)));
  assert.ok(avisou(ev), "a linha do tempo diz por que a conferência voltou");
});

test("revisor cortado e retomada sem mudança: a conferência inteira roda de novo", async () => {
  const { caixa, b } = await preparar({
    agente: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }, { texto: "sem nada a mudar" }],
    revisor: [CAIU, "APROVADO"], qa: ["APROVADO"] });
  const t = await criar(b);
  const fim = await esperarStatus(b, t.id, ["executada"], 20000);
  assert.deepEqual(papeis(caixa), ["agente", "revisor", "agente", "revisor", "qa"]);
  assert.equal(fim.qa?.veredito, "APROVADO");
});

test("portão cortado por tempo e retomada sem mudança: o portão roda de novo, e não fecha sem ele", async () => {
  // A 1ª passada do portão pendura; a 2ª passa. A marca fica no $HOME da caixa, fora do projeto: não conta como mudança.
  const { caixa, b } = await preparar({
    agente: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }, { texto: "sem nada a mudar" }],
    revisor: ["APROVADO"], qa: ["APROVADO"] },
  { env: { BOARD_PORTAO_TIMEOUT_MIN: "0.03" }, portao: 'if [ -f "$HOME/portao-1" ]; then exit 0; fi; touch "$HOME/portao-1"; sleep 30' });
  const t = await criar(b);
  const fim = await esperarStatus(b, t.id, ["executada"], 30000);
  assert.deepEqual(papeis(caixa), ["agente", "agente", "revisor", "qa"]);
  assert.equal(fim.gate?.ok, true);
  assert.equal((await log(b, t.id)).filter((e) => e.t === "portao" && e.estado === "passou").length, 1);
});

test("portão VERMELHO e retomada sem mudança: não vira executada por não ter mexido", async () => {
  const { caixa, b } = await preparar({
    agente: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }, { texto: "acho que está certo" }] },
  { portao: "exit 1" });
  const t = await criar(b);
  // Com o portão não dá para esperar um status só: ela passa por "erro" duas vezes. O fim é a tentativa esgotada ou "executada".
  const parou = async () => (await log(b, t.id)).some((e) => e.t === "retentativa" && e.estado === "esgotada") || (await b.api("GET", `/api/tasks/${t.id}`)).json.task.status === "executada";
  for (let i = 0; i < 100 && !(await parou()); i++) await esperar(200);
  const fim = (await b.api("GET", `/api/tasks/${t.id}`)).json.task;
  assert.equal(fim.status, "erro");
  assert.match(fim.error, /portão reprovou/);
  assert.ok(fim.conferenciaPendente);
  assert.deepEqual(papeis(caixa), ["agente", "agente"]);
});

test("agente cortado depois de escrever e retomada sem mudança: o que ele escreveu passa pela conferência", async () => {
  const { caixa, b } = await preparar({
    agente: [{ ...CORTADO, escreve: { arquivo: "a.txt" } }, { texto: "o arquivo já estava pronto" }],
    revisor: ["APROVADO"], qa: ["APROVADO"] });
  const t = await criar(b);
  const fim = await esperarStatus(b, t.id, ["executada"], 20000);
  assert.deepEqual(papeis(caixa), ["agente", "agente", "revisor", "qa"]);
  assert.equal(fim.qa?.veredito, "APROVADO");
});

test("modo PR: QA cortado antes de entregar e retomada sem mudança ainda abre o PR", async () => {
  const { caixa, b } = await preparar({
    agente: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }, { texto: "nada a mudar" }, { texto: "PR aberto: https://github.com/dono/demo/pull/7" }],
    revisor: ["APROVADO"], qa: [CAIU, "APROVADO"] });
  const t = await criar(b, { entrega: "pr" });
  const fim = await esperarStatus(b, t.id, ["executada"], 20000);
  assert.equal(fim.prUrl, "https://github.com/dono/demo/pull/7");
  assert.equal(papeis(caixa).filter((p) => p === "qa").length, 2);
});

test("entrega por PR cortada e retomada sem mudança: a entrega roda de novo, e não fecha sem PR nem repete a conferência", async () => {
  const { caixa, b } = await preparar({
    agente: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }, CORTADO, { texto: "nada a mudar" }, { texto: "PR aberto: https://github.com/dono/demo/pull/7" }],
    revisor: ["APROVADO"], qa: ["APROVADO"] });
  const t = await criar(b, { entrega: "pr" });
  const fim = await esperarStatus(b, t.id, ["executada"], 20000);
  assert.equal(fim.prUrl, "https://github.com/dono/demo/pull/7");
  assert.deepEqual(papeis(caixa), ["agente", "revisor", "qa", "agente", "agente", "agente"]);
  assert.ok(!fim.entregaPendente);
});

test("Virar PR com a entrega cortada e retomada sem mudança: entrega de novo, e não fecha sem PR", async () => {
  const { caixa, b } = await preparar({
    agente: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }, CORTADO, { texto: "nada a mudar" }, { texto: "PR aberto: https://github.com/dono/demo/pull/8" }],
    revisor: ["APROVADO"], qa: ["APROVADO"] });
  const t = await criar(b);
  await esperarStatus(b, t.id, ["executada"], 15000);
  assert.equal((await b.api("POST", `/api/tasks/${t.id}/pr`, {})).status < 300, true);
  const fim = await esperarEntrega(b, t.id);
  assert.equal(fim.status, "executada");
  assert.equal(fim.prUrl, "https://github.com/dono/demo/pull/8");
  assert.deepEqual(papeis(caixa), ["agente", "revisor", "qa", "revisor", "qa", "agente", "agente", "agente"]);
  assert.ok(!fim.entregaPendente);
});

test("Virar PR sem nada a entregar, com a entrega cortada: a retomada não vira erro falso de PR", async () => {
  const { caixa, b } = await preparar({
    agente: [{ texto: "respondi" }, CORTADO, { texto: "nada a mudar" }, { texto: "não há o que entregar" }],
    revisor: ["APROVADO"], qa: ["APROVADO"] });
  const t = await criar(b);
  await esperarStatus(b, t.id, ["executada"], 15000);
  await b.api("POST", `/api/tasks/${t.id}/pr`, {});
  const fim = await esperarEntrega(b, t.id);
  assert.equal(fim.status, "executada");
  assert.equal(fim.error, null);
  assert.equal(papeis(caixa).filter((p) => p === "agente").length, 4, "a entrega rodou de novo na retomada");
  assert.ok((await log(b, t.id)).some((e) => e.t === "solto" && /nada para entregar/.test(e.texto)));
});

test("Virar PR com o QA cortado e nada a entregar: a retomada confere de novo e não vira erro falso de PR", async () => {
  const { caixa, b } = await preparar({
    agente: [{ texto: "respondi" }, { texto: "nada a mudar" }, { texto: "não há o que entregar" }],
    revisor: ["APROVADO"], qa: [CAIU, "APROVADO"] });
  const t = await criar(b);
  await esperarStatus(b, t.id, ["executada"], 15000);
  await b.api("POST", `/api/tasks/${t.id}/pr`, {});
  const fim = await esperarEntrega(b, t.id);
  assert.equal(fim.status, "executada");
  assert.equal(fim.error, null);
  assert.deepEqual(papeis(caixa), ["agente", "revisor", "qa", "agente", "revisor", "qa", "agente"]);
});

const COM_CONSERTO = { BOARD_REVISOES: "1" };
const ACABA = async (b, id) => { let t; for (let i = 0; i < 150; i++) { t = (await b.api("GET", `/api/tasks/${id}`)).json.task;
  if (!t.busy && (t.status === "executada" || (t.status === "erro" && !t.retentativa))) return t; await esperar(200); } throw new Error(`#${id} não terminou (está ${t?.status})`); };

test("QA reprova, o conserto muda a pasta, o revisor aprova e o QA é cortado: a retomada confere, não diz 'o defeito continua'", async () => {
  const { caixa, b } = await preparar({
    agente: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }, { texto: "consertei", escreve: { arquivo: "a.txt", conteudo: "y\n" } }, { texto: "nada a mudar" }],
    revisor: ["APROVADO"], qa: ["REPROVADO\n\ndefeito", CAIU, "APROVADO"] }, { env: COM_CONSERTO });
  const t = await criar(b);
  const fim = await ACABA(b, t.id);
  assert.equal(fim.status, "executada", fim.error);
  assert.equal(papeis(caixa).filter((p) => p === "qa").length, 3);
  assert.ok(!(await log(b, t.id)).some((e) => /defeito continua/.test(e.motivo || "")), "não gasta tentativa com motivo falso");
  assert.ok(!fim.reprovaPendente); assert.ok(!fim.reprovaArvore);
});

test("revisor aprovar não apaga a reprova do QA: conserto que não mudou nada e QA cortado continuam 'o defeito continua'", async () => {
  const { caixa, b } = await preparar({
    agente: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }, { texto: "discordo, está certo" }, { texto: "nada a mudar" }],
    revisor: ["APROVADO"], qa: ["REPROVADO\n\ndefeito", CAIU, "APROVADO"] }, { env: COM_CONSERTO });
  const t = await criar(b);
  const fim = await ACABA(b, t.id);
  assert.equal(fim.status, "erro");
  assert.match(fim.error, /defeito continua/);
  assert.equal(papeis(caixa).filter((p) => p === "qa").length, 2);
});

const COM_DEPLOY = { antes: (c) => writeFileSync(join(c.board, "data", "deploy.json"), JSON.stringify({ demo: "touch publicado.txt" })) };
test("mesclar e publicar com a entrega cortada e retomada sem mudança: a aprovação vale e mescla", async () => {
  const { caixa, b } = await preparar({
    agente: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }, CORTADO, { texto: "nada" }, { texto: "PR aberto: https://github.com/dono/demo/pull/7" }],
    revisor: ["APROVADO"], qa: ["APROVADO"] }, COM_DEPLOY);
  const t = await criar(b, { entrega: "deploy" });
  const fim = await ACABA(b, t.id);
  assert.equal(fim.status, "executada", fim.error);
  assert.ok(fim.merged, "mesclou");
  assert.equal(fim.revisor?.veredito, "APROVADO"); assert.equal(fim.qa?.veredito, "APROVADO");
  assert.equal(papeis(caixa).filter((p) => p === "qa").length, 1, "não repete a conferência aprovada");
});

test("modo PR com a entrega cortada: os vereditos ficam na ficha", async () => {
  const { b } = await preparar({
    agente: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }, CORTADO, { texto: "nada" }, { texto: "PR aberto: https://github.com/dono/demo/pull/7" }],
    revisor: ["APROVADO"], qa: ["APROVADO"] });
  const t = await criar(b, { entrega: "pr" });
  const fim = await ACABA(b, t.id);
  assert.equal(fim.revisor?.veredito, "APROVADO"); assert.equal(fim.qa?.veredito, "APROVADO");
});

test("mesclar e publicar: retomada da entrega que MUDOU arquivo não mescla com a aprovação velha", async () => {
  const { caixa, b } = await preparar({
    agente: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }, CORTADO, { texto: "mudei mais", escreve: { arquivo: "b.txt" } }, { texto: "PR aberto: https://github.com/dono/demo/pull/7" }],
    revisor: ["APROVADO", "REPROVADO\n\nb.txt errado"], qa: ["APROVADO"] }, COM_DEPLOY);
  const t = await criar(b, { entrega: "deploy" });
  const fim = await ACABA(b, t.id);
  assert.equal(fim.status, "erro");
  assert.ok(!fim.merged, "o que mudou depois da aprovação passa pela conferência antes de mesclar");
  assert.deepEqual(papeis(caixa).filter((p) => p !== "agente"), ["revisor", "qa", "revisor"]);
});

test("mesclar e publicar: chat muda a pasta depois da entrega cortada e a retomada não muda nada: não mescla com a aprovação velha", async () => {
  const { caixa, b, demo } = await preparar({
    agente: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }, CORTADO, { texto: "mudei no chat", altera: { arquivo: "a.txt", conteudo: "z\n" } }, { texto: "nada" }, { texto: "PR aberto: https://github.com/dono/demo/pull/7" }],
    revisor: ["APROVADO", "REPROVADO\n\nerrado"], qa: ["APROVADO"] }, { ...COM_DEPLOY, env: { BOARD_RETENTATIVAS: "0" } });
  const t = await criar(b, { entrega: "deploy" });
  await ACABA(b, t.id);
  await b.api("POST", `/api/tasks/${t.id}/chat`, { text: "troque" });
  for (let i = 0; i < 50 && !readFileSync(join(demo, "a.txt"), "utf8").startsWith("z"); i++) await esperar(100);
  for (let i = 0; i < 50 && (await b.api("GET", `/api/tasks/${t.id}`)).json.task.busy; i++) await esperar(100);
  await b.api("PATCH", `/api/tasks/${t.id}`, { status: "fila" });
  await esperar(500);
  const fim = await ACABA(b, t.id);
  assert.equal(fim.status, "erro");
  assert.ok(!fim.merged, "mudança depois da aprovação nunca mescla sem conferir");
  assert.deepEqual(papeis(caixa).filter((p) => p !== "agente"), ["revisor", "qa", "revisor"]);
});

test("mesclar e publicar: o agente da entrega escreve e é cortado, retomada sem mudança: confere antes de mesclar", async () => {
  const { caixa, b } = await preparar({
    agente: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }, { ...CORTADO, escreve: { arquivo: "b.txt" } }, { texto: "nada" }],
    revisor: ["APROVADO", "REPROVADO\n\nb.txt errado"], qa: ["APROVADO"] }, COM_DEPLOY);
  const t = await criar(b, { entrega: "deploy" });
  const fim = await ACABA(b, t.id);
  assert.equal(fim.status, "erro");
  assert.ok(!fim.merged);
  assert.deepEqual(papeis(caixa).filter((p) => p !== "agente"), ["revisor", "qa", "revisor"]);
});

/** O board cai com o agente no meio, a tarefa volta à fila e a retomada não muda nada. `escreve` = o que o agente fez antes de cair. */
async function boardCaiu(sinal, escreve) {
  const { caixa, b, demo } = await preparar({ agente: [{ texto: "fiz", dorme: 6000 }, { texto: "já estava pronto" }], revisor: ["APROVADO"], qa: ["APROVADO"] });
  const t = await criar(b);
  for (let i = 0; i < 100 && !papeis(caixa).includes("agente"); i++) await esperar(100);
  await esperar(300);
  if (escreve) writeFileSync(join(demo, "a.txt"), "escrito pelo agente\n");
  b.cp.kill(sinal);
  for (let i = 0; i < 50 && b.cp.exitCode === null && b.cp.signalCode === null; i++) await esperar(100);
  const b2 = await subirBoard(caixa, VOLTA); atual.at(-1)[0] = b2;
  await b2.api("PATCH", `/api/tasks/${t.id}`, { status: "fila" });
  const fim = await esperarStatus(b2, t.id, ["executada", "erro"], 15000);
  return { caixa, fim };
}
for (const sinal of ["SIGTERM", "SIGKILL"]) {
  test(`board caiu (${sinal}) com o agente no meio, depois de ele escrever: o que ficou na pasta passa pela conferência`, async () => {
    const { caixa, fim } = await boardCaiu(sinal, true);
    assert.equal(fim.status, "executada");
    assert.deepEqual(papeis(caixa), ["agente", "agente", "revisor", "qa"]);
    assert.ok(!fim.conferenciaPendente); assert.ok(!fim.rodadaAberta);
  });
}
test("board caiu com o agente no meio e a pasta não mudou: não inventa conferência", async () => {
  const { caixa, fim } = await boardCaiu("SIGTERM", false);
  assert.equal(fim.status, "executada");
  assert.deepEqual(papeis(caixa), ["agente", "agente"]);
});

test("sem conferência cortada nada muda: pergunta que não mexe em arquivo não passa pela esteira", async () => {
  const { caixa, b } = await preparar({ agente: [{ texto: "a resposta é 42" }] });
  const t = await criar(b);
  const fim = await esperarStatus(b, t.id, ["executada"], 15000);
  assert.deepEqual(papeis(caixa), ["agente"]);
  assert.ok(!fim.conferenciaPendente);
});

test("quem confere recebe a regra: nada de pkill -f, a linha de comando do agente traz o pedido inteiro", async () => {
  const { caixa, b } = await preparar({ agente: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }], revisor: ["APROVADO"], qa: ["APROVADO"] });
  const t = await criar(b);
  await esperarStatus(b, t.id, ["executada"], 15000);
  for (const c of chamadas(caixa)) assert.match(c.args[c.args.indexOf("--append-system-prompt") + 1], /pkill -f/, c.papel);
});
