// #333 (03–04/11): tarefa sem mudança de código em projeto de PRODUÇÃO entrava em laço de "entrega sem PR". A #325 (diagnóstico
// só de leitura, movida para o ERP) rodou o agente 4 vezes: cada volta terminava "a entrega terminou sem URL de PR" e o ▶ pedia
// refazer e entregar de novo. E o aviso de pasta errada empurrava operação (aprovação, banco, envio) para produção.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { criarCaixa, criarProjeto, subirBoard, esperarStatus, limparCaixa, chamadas, esperar } from "./ajuda.mjs";

let atual = [];
afterEach(async () => { for (const [b, c] of atual) { await b.fim(); limparCaixa(c); } atual = []; });

async function producao(cenario, env = {}) {
  const caixa = criarCaixa();
  criarProjeto(caixa, "prod", { origem: true });
  caixa.cenario(cenario);
  const b = await subirBoard(caixa, { BOARD_PRODUCAO: "prod", BOARD_RETENTATIVAS: "0", ...env });
  atual.push([b, caixa]);
  return { caixa, b };
}
const criar = async (b, text, extra = {}) => (await b.api("POST", "/api/tasks", { text, project: "prod", queue: true, ...extra })).json.tasks[0];
const log = async (b, id) => (await b.api("GET", `/api/tasks/${id}/log`)).json.events;
const papeis = (caixa) => chamadas(caixa).map((c) => c.papel);

test("produção: rodada que mexeu só em rascunho (pasta limpa no fim) fecha executada, sem rodada de entrega nem erro", async () => {
  // O agente escreve e apaga (como instalar dependência ignorada, ou um rascunho): a conferência roda, mas não há o que pôr num PR.
  const { caixa, b } = await producao({ agente: [{ texto: "Diagnóstico: a licença liberou sozinha.", escreve: { arquivo: "rascunho.txt" }, apaga: "rascunho.txt" }] });
  const t = await criar(b, "conferir na produção o pagamento da cliente");
  assert.equal(t.entrega, "pr", "produção entrega por PR");
  const fim = await esperarStatus(b, t.id, ["executada", "erro"], 20000);
  assert.equal(fim.status, "executada", fim.error);
  assert.equal(fim.error, null);
  assert.equal(fim.prUrl, null);
  assert.deepEqual(papeis(caixa), ["agente", "revisor", "qa"], "nenhuma rodada de entrega pedindo PR");
  assert.equal(fim.result, "Diagnóstico: a licença liberou sozinha.", "o resumo é o do agente");
  assert.ok(!fim.entregaPendente && !fim.retentativa);
  assert.ok((await log(b, t.id)).some((e) => e.t === "solto" && /nada para entregar/.test(e.texto)));
  // ▶ de novo: não volta a pedir entrega
  await b.api("PATCH", `/api/tasks/${t.id}`, { status: "fila" });
  for (let i = 0; i < 80 && chamadas(caixa).filter((c) => c.papel === "agente").length < 2; i++) await esperar(150);
  const fim2 = await esperarStatus(b, t.id, ["executada", "erro"], 20000);
  await esperar(1000);
  assert.equal(fim2.status, "executada", fim2.error);
  assert.equal(chamadas(caixa).filter((c) => c.papel === "agente").length, 2, "uma rodada por ▶, sem a de entrega");
});

test("produção: com mudança de verdade e entrega sem URL, continua erro (não fecha o que tinha o que entregar)", async () => {
  const { caixa, b } = await producao({ agente: [{ texto: "fiz", escreve: { arquivo: "feito.txt" } }, { texto: "não consegui abrir o PR" }] });
  const t = await criar(b, "mude algo em produção");
  const fim = await esperarStatus(b, t.id, ["executada", "erro"], 20000);
  assert.equal(fim.status, "erro");
  assert.match(fim.error, /sem URL de PR/);
  assert.deepEqual(papeis(caixa), ["agente", "revisor", "qa", "agente"]);
});

// ── classificador: operação não vai para produção ────────────────────────────────────────────────────────────────────────
async function classificar(resposta) {
  const caixa = criarCaixa();
  criarProjeto(caixa, "alfa"); criarProjeto(caixa, "prod", { origem: true });
  caixa.cenario({ porte: resposta });
  writeFileSync(join(caixa.board, "data", "projetos.json"), JSON.stringify({ visiveis: ["alfa", "prod"] }));
  const b = await subirBoard(caixa, { BOARD_CLASSIFICAR: "1", BOARD_PRODUCAO: "prod" });
  atual.push([b, caixa]);
  return { caixa, b };
}
const tarefaDe = async (b, id) => (await b.api("GET", `/api/tasks/${id}`)).json.task;
async function classificada(b, id) { for (let i = 0; i < 60; i++) { const x = await tarefaDe(b, id); if (!x.classificando) return x; await esperar(150); } return tarefaDe(b, id); }

test("pasta errada: operação (tipo do classificador) não é empurrada para projeto de produção", async () => {
  const { caixa, b } = await classificar('{"porte":"leve","projeto":"prod","certeza":"alta","tipo":"operacao"}');
  const [t] = (await b.api("POST", "/api/tasks", { text: "gravar o dado da cliente no banco", project: "alfa" })).json.tasks;
  const x = await classificada(b, t.id);
  assert.equal(x.projetoSugerido ?? null, null);
  assert.equal(x.project, "alfa");
  assert.ok((await log(b, t.id)).some((e) => e.t === "solto" && /é operação, não código/.test(e.texto)));
  const p = chamadas(caixa).find((c) => c.papel === "porte").args;
  assert.match(p[p.indexOf("-p") + 1], /"tipo":"codigo\|operacao"/, "o classificador é perguntado");
});

test("pasta errada: tarefa com aprovação da Central não vai para produção mesmo sem o tipo; código continua sugerido", async () => {
  const { b } = await classificar('{"porte":"leve","projeto":"prod","certeza":"alta"}');
  const [t] = (await b.api("POST", "/api/tasks", { text: "Aprovado pelo dono na Central: aprovação #5938bd2aebba, ação: conferir o pagamento", project: "alfa" })).json.tasks;
  assert.equal((await classificada(b, t.id)).projetoSugerido ?? null, null);
  const [u] = (await b.api("POST", "/api/tasks", { text: "corrigir a tela de pagamento", project: "alfa" })).json.tasks;
  for (let i = 0; i < 60 && !(await tarefaDe(b, u.id)).projetoSugerido; i++) await esperar(150);
  assert.deepEqual((await tarefaDe(b, u.id)).projetoSugerido, { slug: "prod", label: "prod" }, "mudança de código segue com o aviso");
});
