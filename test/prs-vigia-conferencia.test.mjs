// A vigia dos PRs (#279) com conferência devendo: conserto pelo chat (#288) e QA cortado na volta (#290). O PR sair da marca
// nunca fecha sem veredito nem libera o merge. Separado de prs-vigia.test.mjs porque os dois juntos estouravam os 180 s por arquivo.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, existsSync } from "node:fs";
import { esperar, esperarStatus } from "./ajuda.mjs";
import { faxina, URL_, PR, CONFLITO, github, ghLog, log, tarefa, agentes, preparar, conserto, esperarVigia } from "./prs-vigia-ajuda.mjs";

afterEach(faxina);
test("🔴 modo 'mesclar e publicar': volta da vigia reprovada e consertada pelo chat (#288) confere e não mescla", async () => {
  const { caixa, b, id } = await preparar({ env: { BOARD_PR_TENTATIVAS: "9", BOARD_REVISOES: "0" } });
  await b.api("PATCH", `/api/tasks/${id}`, { entrega: "deploy" });
  writeFileSync(join(caixa.board, "data", "deploy.json"), JSON.stringify({ alfa: "echo publicou > publicou.txt" }));
  caixa.cenario({ agente: ["já rodou", { texto: `tentei ${URL_(12)}`, dorme: 1500, escreve: { arquivo: "m.txt", conteudo: "1\n" } }, { texto: "consertei", escreve: { arquivo: "m.txt", conteudo: "2\n" } }], revisor: ["APROVADO", "REPROVADO", "APROVADO"], qa: ["APROVADO"] });
  github(caixa, [PR(12, CONFLITO)]);
  await esperarVigia(b, id, "atualizando");
  github(caixa, [PR(12, { mergeable: "UNKNOWN" })]); // o GitHub calculando: a marca fica e a vigia não devolve de novo
  const reprovada = await esperarStatus(b, id, "erro", 20000);
  assert.equal(reprovada.prVigia?.estado, "atualizando", "a marca da vigia segue de pé");
  assert.equal((await b.api("POST", `/api/tasks/${id}/chat`, { text: "conserte" })).status, 202);
  await esperarStatus(b, id, ["executada"], 20000);
  assert.ok((await log(b, id)).some((e) => e.t === "inicio" && /conferir o conserto do chat/.test(e.titulo)));
  assert.doesNotMatch(ghLog(caixa), /pr merge/);
  assert.ok(!existsSync(join(caixa.dev, "alfa", "publicou.txt")), "nada publicado");
});

for (const [caso, github2] of [["PR sadio", (c) => github(c, [PR(12)])], ["PR fechado", (c) => github(c, [])]]) {
  test(`conserto do chat esperando vaga, ${caso}: a vigia tira a marca e portão, revisor e QA rodam mesmo assim (#288)`, async () => {
    const { caixa, b, id } = await preparar({ env: { BOARD_PR_TENTATIVAS: "9", BOARD_REVISOES: "0" } });
    writeFileSync(join(caixa.board, "data", "portao.json"), JSON.stringify({ alfa: "true" }));
    caixa.cenario({ agente: ["já rodou", { texto: `tentei ${URL_(12)}`, dorme: 1500, escreve: { arquivo: "m.txt", conteudo: "1\n" } }, { quando: "segura a vaga", texto: "ocupando a pasta", dorme: 9000 }, { quando: "conserte", texto: "consertei", escreve: { arquivo: "m.txt", conteudo: "2\n" } }],
      revisor: ["APROVADO", "REPROVADO", "APROVADO"], qa: ["APROVADO"] });
    github(caixa, [PR(12, CONFLITO)]);
    await esperarVigia(b, id, "atualizando");
    github(caixa, [PR(12, { mergeable: "UNKNOWN" })]);
    await esperarStatus(b, id, "erro", 20000);
    const [outra] = (await b.api("POST", "/api/tasks", { text: "segura a vaga do projeto", project: "alfa", queue: true })).json.tasks;
    for (let i = 0; i < 60 && (await tarefa(b, outra.id)).status !== "rodando"; i++) await esperar(150);
    assert.equal((await tarefa(b, outra.id)).status, "rodando");
    assert.equal((await b.api("POST", `/api/tasks/${id}/chat`, { text: "conserte" })).status, 202);
    for (let i = 0; i < 40 && !(await tarefa(b, id)).conferir; i++) await esperar(150);
    assert.ok((await tarefa(b, id)).conferir, "o conserto ficou esperando a vaga");
    github2(caixa);
    await esperarVigia(b, id, null);
    const esperando = await tarefa(b, id);
    assert.equal(esperando.status, "fila", "sem a marca da vigia, a conferência segue na fila");
    assert.ok(esperando.conferir);
    await esperarStatus(b, id, ["executada"], 25000);
    const ev = await log(b, id); // pelo log DESTA tarefa: a outra acha a pasta mudada e passa pela esteira dela
    assert.ok(ev.some((e) => e.t === "inicio" && /conferir o conserto do chat/.test(e.titulo)));
    assert.equal(ev.filter((e) => e.t === "revisor").length, 3);
    assert.equal(ev.filter((e) => e.t === "qa").length, 2);
    assert.ok(!(await tarefa(b, id)).reprovaPendente);
  });
}

const CORTADO = { texto: "", codigo: 143 };
const CAIU = { texto: "API fora", erro: true };
async function voltaCortada(entrega, agenteExtra = []) {
  const p = await preparar({ env: { BOARD_PR_TENTATIVAS: "9", BOARD_REVISOES: "0", BOARD_RETENTATIVAS: "1", BOARD_RETENTATIVA_MIN: "0.1" } });
  const { caixa, b, id } = p;
  if (entrega === "deploy") { await b.api("PATCH", `/api/tasks/${id}`, { entrega: "deploy" }); writeFileSync(join(caixa.board, "data", "deploy.json"), JSON.stringify({ alfa: "echo publicou > publicou.txt" })); }
  caixa.cenario({ agente: ["já rodou", { quando: "gh pr checkout", texto: `atualizei ${URL_(12)}`, escreve: { arquivo: "m.txt", conteudo: "1\n" } }, { quando: "segura a vaga", texto: "ocupando", dorme: 12000 }, ...agenteExtra],
    revisor: ["APROVADO"], qa: ["APROVADO", CAIU, "APROVADO"] });
  github(caixa, [PR(12, CONFLITO)]);
  await esperarVigia(b, id, "atualizando");
  github(caixa, [PR(12, { mergeable: "UNKNOWN" })]);
  const erro = await esperarStatus(b, id, "erro", 20000);
  assert.match(erro.error, /QA não rodou/);
  assert.ok(erro.conferenciaPendente);
  return p;
}
const semMerge = (caixa) => { assert.doesNotMatch(ghLog(caixa), /pr merge/); assert.ok(!existsSync(join(caixa.dev, "alfa", "publicou.txt")), "nada publicado"); };

for (const entrega of ["pr", "deploy"]) {
  test(`volta da vigia com o QA cortado, esperando vaga na fila, e PR sadio (${entrega}): roda a conferência, nunca fecha sem veredito (#290)`, async () => {
    const { caixa, b, id } = await voltaCortada(entrega);
    const [outra] = (await b.api("POST", "/api/tasks", { text: "segura a vaga do projeto", project: "alfa", queue: true })).json.tasks;
    for (let i = 0; i < 60 && (await tarefa(b, outra.id)).status !== "rodando"; i++) await esperar(150);
    for (let i = 0; i < 80 && (await tarefa(b, id)).status !== "fila"; i++) await esperar(150);
    assert.equal((await tarefa(b, id)).status, "fila", "a retentativa pôs de volta na fila, e a vaga está ocupada");
    const antes = agentes(caixa).length;
    github(caixa, [PR(12)]);
    await esperarVigia(b, id, null);
    const esperando = await tarefa(b, id);
    assert.equal(esperando.status, "fila", "não volta para executada sem conferir");
    assert.ok(esperando.conferir);
    const fim = await esperarStatus(b, id, ["executada"], 25000);
    assert.equal(fim.qa?.veredito, "APROVADO");
    assert.ok(!fim.conferenciaPendente);
    assert.equal(agentes(caixa).length, antes, "só a esteira: a tarefa não é refeita");
    assert.equal((await log(b, id)).filter((e) => e.t === "qa").length, 2);
    semMerge(caixa);
  });
}

test("🔴 'mesclar e publicar': PR sadio com a retomada ainda agendada: confere de novo e continua sem mesclar (#290)", async () => {
  const { caixa, b, id } = await voltaCortada("deploy", [{ quando: "terminou em ERRO", texto: "nada a mudar" }]);
  github(caixa, [PR(12)]);
  await esperarVigia(b, id, null);
  assert.equal((await tarefa(b, id)).status, "erro", "a retomada segue agendada");
  for (let i = 0; i < 100 && (await tarefa(b, id)).status === "erro"; i++) await esperar(150);
  const fim = await esperarStatus(b, id, ["executada"], 20000);
  assert.equal(fim.qa?.veredito, "APROVADO");
  semMerge(caixa);
});
