// Menu Pull Requests (23/10/2026): os PRs de cada projeto da seleção e o "Mesclar" que o dono clica.
// `gh` falso: lê $HOME/gh-prs-<dono_repo>-<state>.json e anota tudo em $HOME/gh.log.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { criarCaixa, criarProjeto, subirBoard, limparCaixa, esperar, esperarStatus } from "./ajuda.mjs";
import { abrirNavegador, CHROME } from "./navegador.mjs";

let atual = [];
afterEach(async () => { for (const [b, c] of atual) { await b.fim(); limparCaixa(c); } atual = []; });

const PR = (n, extra = {}) => ({ number: n, title: `PR ${n}`, url: `https://github.com/dono/alfa/pull/${n}`, headRefName: `board/${n}-x`,
  author: { login: "dono" }, createdAt: "2026-10-22T10:00:00Z", updatedAt: "2026-10-23T10:00:00Z", isDraft: false,
  mergeable: "MERGEABLE", reviewDecision: "", statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: "SUCCESS" }], ...extra });

async function preparar({ abertos = [], mesclados = [], cenario } = {}) {
  const caixa = criarCaixa();
  for (const p of ["alfa", "beta"]) criarProjeto(caixa, p);
  execFileSync("git", ["-C", join(caixa.dev, "alfa"), "remote", "add", "origin", "git@github.com:dono/alfa.git"]); // beta: sem GitHub
  writeFileSync(join(caixa.board, "data", "projetos.json"), JSON.stringify({ visiveis: ["alfa", "beta"], rotulos: { alfa: "Alfa" } }));
  writeFileSync(join(caixa.home, "gh-prs-dono_alfa-open.json"), JSON.stringify(abertos));
  writeFileSync(join(caixa.home, "gh-prs-dono_alfa-merged.json"), JSON.stringify(mesclados));
  if (cenario) caixa.cenario(cenario);
  const b = await subirBoard(caixa);
  atual.push([b, caixa]);
  return { caixa, b };
}
const ghLog = (caixa) => existsSync(join(caixa.home, "gh.log")) ? readFileSync(join(caixa.home, "gh.log"), "utf8") : "";

test("lista os PRs abertos por projeto da seleção, com checks, conflito e os mesclados; projeto sem GitHub diz isso", async () => {
  const { b } = await preparar({
    abertos: [PR(7), PR(8, { mergeable: "CONFLICTING", statusCheckRollup: [{ conclusion: "FAILURE" }, { status: "IN_PROGRESS" }] })],
    mesclados: [{ number: 5, title: "PR 5", url: "https://github.com/dono/alfa/pull/5", headRefName: "b5", mergedAt: "2026-10-21T10:00:00Z" }],
  });
  const d = (await b.api("GET", "/api/prs")).json;
  const [alfa, beta] = d.projetos;
  assert.equal(alfa.label, "Alfa"); assert.equal(alfa.repo, "dono/alfa");
  assert.deepEqual(alfa.abertos.map((p) => [p.numero, p.checks.estado, p.conflito]), [[7, "ok", false], [8, "falhou", true]]);
  assert.equal(alfa.abertos[0].checks.texto, "2 passaram");
  assert.equal(alfa.mesclados[0].numero, 5);
  assert.equal(beta.repo, null);
  assert.match(beta.erro, /sem repositório no GitHub/);
});

test("Mesclar: squash + apaga a branch, FORA da pasta do dono; só PR aberto da seleção; conflito e rascunho recusados", async () => {
  const { caixa, b } = await preparar({ abertos: [PR(7), PR(8, { mergeable: "CONFLICTING" }), PR(9, { isDraft: true })] });
  assert.equal((await b.api("POST", "/api/prs/mesclar", { url: "https://github.com/outro/repo/pull/1" })).status, 404, "URL qualquer não");
  assert.equal((await b.api("POST", "/api/prs/mesclar", { url: PR(8).url })).status, 409);
  assert.equal((await b.api("POST", "/api/prs/mesclar", { url: PR(9).url })).status, 409);
  assert.doesNotMatch(ghLog(caixa), /pr merge/);
  const r = await b.api("POST", "/api/prs/mesclar", { url: PR(7).url });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(ghLog(caixa), /gh pr merge https:\/\/github\.com\/dono\/alfa\/pull\/7 --squash --delete-branch/);
  assert.equal(execFileSync("git", ["-C", join(caixa.dev, "alfa"), "branch", "--show-current"], { encoding: "utf8" }).trim(), "main", "a pasta do dono não foi tocada");
  writeFileSync(join(caixa.home, "gh-merge-falha"), "");
  const f = await b.api("POST", "/api/prs/mesclar", { url: PR(7).url });
  assert.equal(f.status, 502); assert.match(f.json.error, /GitHub recusou o merge: merge recusado/);
});

test("⚠️ trava da #188: PR de tarefa ainda conferindo (ou reprovada) pede confirmação; com ela, mescla e anota na tarefa", async () => {
  const { caixa, b } = await preparar({ abertos: [PR(12)], cenario: { agente: [{ texto: `abri ${PR(12).url}`, dorme: 6000 }] } });
  const [t] = (await b.api("POST", "/api/tasks", { text: "tarefa com PR", project: "alfa", queue: true })).json.tasks;
  const fim = await esperarStatus(b, t.id, ["executada", "erro"], 25000);
  assert.equal(fim.prUrl, PR(12).url);
  // o agente volta a trabalhar na tarefa (chat): do ponto de vista do PR ela está sendo conferida de novo
  caixa.cenario({ agente: [{ texto: "pensando", dorme: 4000 }] });
  await b.api("POST", `/api/tasks/${t.id}/chat`, { text: "mais uma coisa" });
  await esperar(500);
  const bloq = await b.api("POST", "/api/prs/mesclar", { url: PR(12).url });
  assert.equal(bloq.status, 409);
  assert.equal(bloq.json.precisaConfirmar, true);
  assert.match(bloq.json.error, /tarefa #\d+ ainda está sendo conferida.*#188/);
  assert.doesNotMatch(ghLog(caixa), /pr merge/);
  const ok = await b.api("POST", "/api/prs/mesclar", { url: PR(12).url, forcar: true });
  assert.equal(ok.status, 200);
  const log = (await b.api("GET", `/api/tasks/${t.id}/log`)).json.events.map((e) => e.texto || "").join("\n");
  assert.match(log, /PR mesclado pelo dono no menu Pull Requests.*passando por cima da conferência/);
});

test("trava da #188 (#300): QA que disse APROVADO sem classificação conta como reprova, embora o veredito não diga REPROVADO", async () => {
  const { caixa, b } = await preparar({ abertos: [PR(13)], cenario: { agente: [{ texto: `abri ${PR(13).url}`, escreve: { arquivo: "a.txt" } }], qa: ["APROVADO\ntudo certo"] } });
  const [t] = (await b.api("POST", "/api/tasks", { text: "tarefa com PR", project: "alfa", queue: true })).json.tasks;
  const fim = await esperarStatus(b, t.id, ["erro"], 25000);
  assert.equal(fim.qa.veredito, "SEM CLASSIFICAÇÃO");
  const bloq = await b.api("POST", "/api/prs/mesclar", { url: PR(13).url });
  assert.equal(bloq.status, 409);
  assert.equal(bloq.json.precisaConfirmar, true);
  assert.doesNotMatch(ghLog(caixa), /pr merge/);
});

test("tela: menu Pull Requests mostra os PRs e o Mesclar pede confirmação e mescla", { skip: !CHROME && "sem Chrome nesta máquina" }, async () => {
  const { caixa, b } = await preparar({ abertos: [PR(7)] });
  const nav = await abrirNavegador();
  try {
    await nav.carregar(b.url + "/");
    await nav.quieto();
    await nav.avaliar(`[...document.querySelectorAll("#navigation .nav-item")].find((x) => /Pull Requests/.test(x.getAttribute("aria-label"))).click()`);
    let txt = "";
    for (let i = 0; i < 40 && !/#7 PR 7/.test(txt); i++) { await esperar(200); txt = await nav.avaliar("document.querySelector('#prsLista')?.innerText || ''"); }
    assert.match(txt, /Alfa[\s\S]*#7 PR 7[\s\S]*2 passaram[\s\S]*sem tarefa do board/i);
    assert.match(txt, /sem repositório no GitHub/);
    await nav.avaliar(`document.querySelector('[data-mesclar]').click()`);
    for (let i = 0; i < 40 && !/pr merge/.test(ghLog(caixa)); i++) await esperar(200);
    assert.match(nav.dialogos.join("\n"), /MESCLAR na main de Alfa:[\s\S]*#7 PR 7[\s\S]*só mescla/);
    assert.match(ghLog(caixa), /pr merge https:\/\/github\.com\/dono\/alfa\/pull\/7/);
    assert.deepEqual(nav.erros, []);
  } finally { await nav.fechar(); }
});
