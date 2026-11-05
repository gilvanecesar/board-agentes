// #299: com as rodadas de conserto esgotadas, o parecer só ia para o log, e a retomada dizia "o QA reprovou (REPROVADO)".
// Nas #286 e #289 o agente disse que o parecer não chegou e foi procurar no log, ou consertou outra coisa no escuro.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { chamadas, criarCaixa, criarProjeto, subirBoard, limparCaixa, esperar, esperarStatus } from "./ajuda.mjs";

let atual = [];
afterEach(async () => { for (const [b, c] of atual) { await b.fim(); limparCaixa(c); } atual = []; });

const VOLTA = { BOARD_REVISOES: "0", BOARD_RETENTATIVAS: "1", BOARD_RETENTATIVA_MIN: "0.02" };
const QA = "REPROVADO\n\n**Defeito: UF em minúsculo trava a emissão.**\n- **Passo:** digite `sc` em Início e clique Emitir.\n- **Aconteceu:** erro 500.\n- **Devia:** aceitar SC.";
const REV = "REPROVADO\n- **🔴 Envio cortado derruba o board:** `servidor/http.mjs:137` sem `await`.\n- Reproduza com `curl --max-time 0.1`.";
async function preparar(cenario, env = VOLTA, antes) {
  const caixa = criarCaixa();
  criarProjeto(caixa, "demo");
  caixa.cenario(cenario);
  if (antes) antes(caixa);
  const b = await subirBoard(caixa, env);
  atual.push([b, caixa]);
  return { caixa, b };
}
const criar = async (b, text = "faça a.txt") => (await b.api("POST", "/api/tasks", { text, project: "demo", queue: true })).json.tasks[0];
const faz = (arquivo, texto = "fiz") => ({ texto, escreve: { arquivo } });
const agentes = (caixa) => chamadas(caixa).filter((c) => c.papel === "agente");
const pedido = (c) => c.args[c.args.indexOf("-p") + 1];
const log = async (b, id) => (await b.api("GET", `/api/tasks/${id}/log`)).json.events;
async function ate(fn, limite = 20000) { const t0 = Date.now(); let v; while (Date.now() - t0 < limite) { v = await fn(); if (v) return v; await esperar(150); } return v; }

test("QA reprova com as rodadas esgotadas: a retomada leva o parecer inteiro, na mesma sessão", async () => {
  const { caixa, b } = await preparar({ agente: [faz("a.txt"), faz("b.txt", "consertei")], revisor: ["APROVADO"], qa: [QA, "APROVADO"] });
  const t = await criar(b);
  await esperarStatus(b, t.id, ["executada"], 20000);
  const [primeira, volta] = agentes(caixa);
  assert.ok(!pedido(primeira).includes("Defeito"), "a 1ª rodada não tem parecer nenhum");
  assert.ok(pedido(volta).includes(QA.slice("REPROVADO\n\n".length)), "o parecer vai inteiro, com o passo de reprodução");
  assert.match(pedido(volta), /terminou em ERRO:\no QA reprovou/);
  assert.match(pedido(volta), /deixe um teste que morda o defeito/);
  assert.equal(volta.args[volta.args.indexOf("--resume") + 1], (await b.api("GET", `/api/tasks/${t.id}`)).json.task.sessionId, "mesma sessão");
  assert.ok((await log(b, t.id)).some((e) => e.t === "solto" && /parecer da reprovação vai inteiro/.test(e.texto)), "a linha do tempo diz que ele foi");
});

test("revisor reprova com as rodadas esgotadas: a retomada leva o parecer dele", async () => {
  const { caixa, b } = await preparar({ agente: [faz("a.txt"), faz("b.txt", "consertei")], revisor: [REV, "APROVADO"], qa: ["APROVADO"] });
  const t = await criar(b);
  await esperarStatus(b, t.id, ["executada"], 20000);
  const volta = pedido(agentes(caixa)[1]);
  assert.ok(volta.includes(REV.slice("REPROVADO\n".length)));
  assert.match(volta, /O REVISOR do board reprovou/);
});

test("portão vermelho com as rodadas esgotadas: a retomada leva a saída do comando", async () => {
  const { caixa, b } = await preparar({ agente: [{ texto: "fiz", escreve: { arquivo: "ok.txt", conteudo: "ruim\n" } }, { texto: "consertei", escreve: { arquivo: "ok.txt", conteudo: "bom\n" } }], revisor: ["APROVADO"], qa: ["APROVADO"] }, VOLTA,
    (c) => { writeFileSync(join(c.dev, "demo", "package.json"), JSON.stringify({ scripts: { test: "echo saida-do-teste-99; grep -q bom ok.txt" } })); });
  const t = await criar(b, "faça ok.txt");
  await esperarStatus(b, t.id, ["executada"], 20000);
  const volta = pedido(agentes(caixa)[1]);
  assert.match(volta, /O PORTÃO do board reprovou/);
  assert.match(volta, /saida-do-teste-99/);
});

test("a volta seguinte, depois de 'nada mudou', ainda leva o parecer (o erro da 2ª já não fala dele: a #286)", async () => {
  const { caixa, b } = await preparar({ agente: [faz("a.txt"), "olhei e não mudei", faz("b.txt", "agora consertei")], revisor: ["APROVADO"], qa: [QA, "APROVADO"] },
    { ...VOLTA, BOARD_RETENTATIVAS: "2" });
  const t = await criar(b);
  await esperarStatus(b, t.id, ["executada"], 30000);
  const terceira = pedido(agentes(caixa)[2]);
  assert.match(terceira, /esta rodada não mexeu em nada/);
  assert.ok(terceira.includes("digite `sc` em Início"));
});

test("reprovas de etapas diferentes vão juntas; a etapa que aprovou depois sai do pedido", async () => {
  const { caixa, b } = await preparar({ agente: [faz("a.txt"), faz("b.txt"), faz("c.txt"), faz("d.txt")], revisor: ["APROVADO", REV, "APROVADO"], qa: [QA, "APROVADO"] },
    { ...VOLTA, BOARD_RETENTATIVAS: "2" });
  const t = await criar(b);
  await esperarStatus(b, t.id, ["executada"], 30000);
  const volta = pedido(agentes(caixa)[2]);
  assert.match(volta, /Envio cortado derruba o board/, "a reprova do revisor");
  assert.match(volta, /UF em minúsculo/, "e a do QA, que ainda não reconferiu");
});

test("revisor reprova, revisor aprova, QA reprova: a volta leva só o QA", async () => {
  const { caixa, b } = await preparar({ agente: [faz("a.txt"), faz("b.txt"), faz("c.txt")], revisor: [REV, "APROVADO", "APROVADO"], qa: [QA, "APROVADO"] },
    { ...VOLTA, BOARD_RETENTATIVAS: "2" });
  const t = await criar(b);
  await esperarStatus(b, t.id, ["executada"], 30000);
  const volta = pedido(agentes(caixa)[2]);
  assert.match(volta, /UF em minúsculo/);
  assert.doesNotMatch(volta, /Envio cortado/);
});

test("retomada por erro do motor sem reprova nenhuma não ganha parecer", async () => {
  const { caixa, b } = await preparar({ agente: [{ erro: "o motor caiu" }, faz("a.txt")], revisor: ["APROVADO"], qa: ["APROVADO"] });
  const t = await criar(b);
  await esperarStatus(b, t.id, ["executada"], 20000);
  const volta = pedido(agentes(caixa)[1]);
  assert.match(volta, /terminou em ERRO/, "é mesmo a retomada");
  assert.doesNotMatch(volta, /A conferência do board reprovou/);
});

test("a rodada de conserto da esteira continua levando o parecer (revisor e QA)", async () => {
  const { caixa, b } = await preparar({ agente: [faz("a.txt"), faz("b.txt"), faz("c.txt")], revisor: [REV, "APROVADO", "APROVADO"], qa: [QA, "APROVADO"] },
    { BOARD_REVISOES: "2", BOARD_RETENTATIVAS: "0" });
  const t = await criar(b);
  await esperarStatus(b, t.id, ["executada"], 20000);
  const [, doRevisor, doQa] = agentes(caixa);
  assert.ok(pedido(doRevisor).includes(REV.slice("REPROVADO\n".length)));
  assert.ok(pedido(doQa).includes(QA.slice("REPROVADO\n\n".length)));
});

test("rodar de novo à mão, com as tentativas esgotadas: o pedido da tarefa leva o parecer junto", async () => {
  const { caixa, b } = await preparar({ agente: [faz("a.txt"), faz("b.txt")], revisor: ["APROVADO"], qa: [QA, "APROVADO"] }, { BOARD_REVISOES: "0", BOARD_RETENTATIVAS: "0" });
  const t = await criar(b);
  await esperarStatus(b, t.id, "erro");
  await b.api("PATCH", `/api/tasks/${t.id}`, { status: "fila" });
  await esperarStatus(b, t.id, ["executada"], 20000);
  const volta = pedido(agentes(caixa)[1]);
  assert.match(volta, /^faça a\.txt/);
  assert.ok(volta.includes("digite `sc` em Início"));
});

test("bastão: o motor que assume uma tarefa reprovada recebe o parecer, que a sessão dele nunca viu", async () => {
  const { caixa, b } = await preparar({ agente: [faz("a.txt")], revisor: ["APROVADO"], qa: [QA], codex: [faz("b.txt")] }, { BOARD_REVISOES: "0", BOARD_RETENTATIVAS: "0" });
  const t = await criar(b);
  await esperarStatus(b, t.id, "erro");
  await b.api("POST", `/api/tasks/${t.id}/passar`, { motor: "codex" });
  const c = await ate(async () => chamadas(caixa).find((x) => x.motor === "codex" && x.papel === "agente"));
  // Os "últimos passos" do bastão cortam o texto; o que garante o parecer inteiro é o bloco dele.
  assert.match(c.args.at(-1), /A conferência do board reprovou[\s\S]*Devia:\*\* aceitar SC/);
});

test("chat numa tarefa reprovada: a 1ª mensagem leva o parecer como contexto, a 2ª não repete", async () => {
  const { caixa, b } = await preparar({ agente: [faz("a.txt"), "é por causa disso", "certo"], revisor: ["APROVADO"], qa: [QA] }, { BOARD_REVISOES: "0", BOARD_RETENTATIVAS: "0" });
  const t = await criar(b);
  await esperarStatus(b, t.id, "erro");
  await b.api("POST", `/api/tasks/${t.id}/chat`, { text: "por que reprovou?" });
  await ate(async () => agentes(caixa).length >= 2 && !(await b.api("GET", `/api/tasks/${t.id}`)).json.task.busy);
  await b.api("POST", `/api/tasks/${t.id}/chat`, { text: "e agora?" });
  await ate(async () => agentes(caixa).length >= 3);
  const [, a, c] = agentes(caixa).map(pedido);
  assert.match(a, /^por que reprovou\?/);
  assert.match(a, /Quem manda nesta conversa é o dono/);
  assert.ok(a.includes("digite `sc` em Início"));
  assert.equal(c, "e agora?");
});
