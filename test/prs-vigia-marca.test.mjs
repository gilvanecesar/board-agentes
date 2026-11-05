// A marca da vigia sai (#290) com a tarefa no meio do caminho: conferência devendo de tarefa concluída não roda na pasta do dono,
// e a volta da vigia continua sem mesclar em qualquer status, com ou sem conferência devendo.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { esperar, esperarStatus } from "./ajuda.mjs";
import { CONFLITO, PR, URL_, esperarVigia, faxina, ghLog, github, log, preparar, tarefa } from "./prs-vigia-ajuda.mjs";

afterEach(faxina);

const CORTADO = { texto: "", codigo: 143 };
const CAIU = { texto: "API fora", erro: true };
const semMerge = (caixa) => { assert.doesNotMatch(ghLog(caixa), /pr merge/); assert.ok(!existsSync(join(caixa.dev, "alfa", "publicou.txt")), "nada publicado"); };
const ate = async (fn, n = 80) => { for (let i = 0; i < n; i++) { if (await fn()) return true; await esperar(150); } return false; };

test("tarefa concluída, de produção, com conferência devendo e sem cópia: PR sadio esperando vaga volta a concluída, nada roda na pasta do dono", async () => {
  const { caixa, b, id } = await preparar({
    env: { BOARD_PRODUCAO: "alfa", BOARD_PR_TENTATIVAS: "9", BOARD_REVISOES: "0" },
    antes: (c) => { const d = join(c.dev, "alfa"); execFileSync("git", ["-C", d, "update-ref", "refs/remotes/origin/main", "HEAD"]); } });
  caixa.cenario({ agente: ["já rodou", { quando: "gh pr checkout", texto: `atualizei ${URL_(12)}`, escreve: { arquivo: "m.txt", conteudo: "1\n" } }, { quando: "segura a vaga", texto: "ocupando", dorme: 9000 }],
    revisor: ["APROVADO"], qa: ["APROVADO", CAIU] });
  github(caixa, [PR(12, CONFLITO)]);
  await esperarVigia(b, id, "atualizando");
  github(caixa, [PR(12, { mergeable: "UNKNOWN" })]);
  assert.ok((await esperarStatus(b, id, "erro", 20000)).conferenciaPendente);
  await b.api("PATCH", `/api/tasks/${id}`, { status: "concluida" });
  assert.ok(await ate(async () => (await tarefa(b, id)).worktree?.removida), "concluir removeu a cópia");
  const [outra] = (await b.api("POST", "/api/tasks", { text: "segura a vaga do projeto", project: "alfa", queue: true })).json.tasks;
  assert.ok(await ate(async () => (await tarefa(b, outra.id)).status === "rodando"));
  const antes = (await log(b, id)).filter((e) => e.t === "inicio").length;
  github(caixa, [PR(12, CONFLITO)]);
  assert.ok(await ate(async () => (await tarefa(b, id)).status === "fila"), "a vigia devolveu a concluída");
  github(caixa, [PR(12)]);
  await esperarVigia(b, id, null);
  const fim = await tarefa(b, id);
  assert.equal(fim.status, "concluida", "a rodada nem começou: volta a como o dono deixou");
  assert.ok(!fim.conferir);
  await esperarStatus(b, outra.id, ["executada", "erro"], 20000);
  await esperar(2000);
  assert.equal((await log(b, id)).filter((e) => e.t === "inicio").length, antes, "nenhuma conferência na pasta do dono");
  semMerge(caixa);
});

/** Volta da vigia em "mesclar e publicar", com o agente cortado SEM escrever: não há conferência devendo. */
async function voltaSemDivida(agenteRetomada, { dorme = 0 } = {}) {
  const p = await preparar({ env: { BOARD_PR_TENTATIVAS: "9", BOARD_REVISOES: "0", BOARD_RETENTATIVAS: "1", BOARD_RETENTATIVA_MIN: "0.1" } });
  const { caixa, b, id } = p;
  await b.api("PATCH", `/api/tasks/${id}`, { entrega: "deploy" });
  writeFileSync(join(caixa.board, "data", "deploy.json"), JSON.stringify({ alfa: "echo publicou > publicou.txt" }));
  caixa.cenario({ agente: ["já rodou", { quando: "gh pr checkout", ...CORTADO, dorme }, { quando: "terminou em ERRO", ...agenteRetomada }], revisor: ["APROVADO"], qa: ["APROVADO"] });
  github(caixa, [PR(12, CONFLITO)]);
  await esperarVigia(b, id, "atualizando");
  return p;
}

for (const [caso, retomada, conferidas] of [["retomada que não escreve", { texto: "nada a mudar" }, 1], ["retomada que escreve", { texto: "mudei", escreve: { arquivo: "m.txt", conteudo: "1\n" } }, 2]]) {
  test(`🔴 'mesclar e publicar': agente da vigia cortado sem escrever, PR sadio, ${caso}: não mescla e não vira erro falso`, async () => {
    const { caixa, b, id } = await voltaSemDivida(retomada);
    github(caixa, [PR(12, { mergeable: "UNKNOWN" })]);
    const erro = await esperarStatus(b, id, "erro", 20000);
    assert.ok(!erro.conferenciaPendente, "a rodada não mexeu em nada");
    github(caixa, [PR(12)]);
    await esperarVigia(b, id, null);
    assert.ok(await ate(async () => (await tarefa(b, id)).status !== "erro"), "a retomada veio");
    const fim = await esperarStatus(b, id, ["executada"], 20000);
    assert.equal(fim.error, null);
    assert.ok(!fim.semMesclar, "executada zera a marca");
    assert.equal((await log(b, id)).filter((e) => e.t === "qa").length, conferidas);
    semMerge(caixa);
  });
}

test("🔴 'mesclar e publicar': PR fica sadio com a rodada da vigia no meio e ela é cortada: a retomada não mescla", async () => {
  const { caixa, b, id } = await voltaSemDivida({ texto: "mudei", escreve: { arquivo: "m.txt", conteudo: "1\n" } }, { dorme: 4000 });
  assert.ok(await ate(async () => (await tarefa(b, id)).status === "rodando"));
  github(caixa, [PR(12)]);
  await esperarVigia(b, id, null);
  await esperarStatus(b, id, "erro", 20000);
  await esperarStatus(b, id, ["executada"], 25000);
  semMerge(caixa);
});
