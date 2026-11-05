// A vigia dos PRs (#279): PR da tarefa em conflito ou com check falhando volta sozinho para a mesma sessão atualizar o MESMO PR.
// `gh` falso: lê $HOME/gh-prs-dono_alfa-<state>.json (o teste troca o arquivo para o GitHub "mudar") e anota tudo em $HOME/gh.log.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { chamadas, esperar, esperarStatus } from "./ajuda.mjs";
import { abrirNavegador, CHROME } from "./navegador.mjs";
import { faxina, URL_, PR, CONFLITO, github, ghLog, log, tarefa, agentes, preparar, conserto, esperarVigia } from "./prs-vigia-ajuda.mjs";

afterEach(faxina);
test("PR em conflito: a tarefa volta sozinha com o pedido fixo, na mesma sessão; portão, revisor e QA de novo; nunca cria PR nem mescla", async () => {
  const { caixa, b, id } = await preparar({ env: { BOARD_PR_VIGIA_S: "1" } });
  const sessao = (await tarefa(b, id)).sessionId, antes = agentes(caixa).length;
  writeFileSync(join(caixa.board, "data", "portao.json"), JSON.stringify({ alfa: "true" }));
  caixa.cenario(conserto());
  github(caixa, [PR(12, CONFLITO)]);
  const t = await esperarVigia(b, id, "atualizando");
  await esperarStatus(b, id, ["executada"], 20000);
  const novas = agentes(caixa).slice(antes);
  assert.equal(novas.length, 1, "uma rodada só");
  const pedido = novas[0].prompt;
  assert.match(pedido, /CONFLITO com a main depois do merge do PR #90/, "o último merge, não o último criado");
  for (const rx of [/gh pr checkout https:\/\/github\.com\/dono\/alfa\/pull\/12/, /git fetch origin/, /git merge origin\/main/, /sem rebase/, /MANTENDO AS DUAS MUDANÇAS/, /Rode os testes/, /MESMA branch, sem --force/, /gh pr view .*--json mergeable/, /Nunca abra outro PR, nunca mescle, nunca force push/]) assert.match(pedido, rx);
  assert.doesNotMatch(pedido, /tarefa com PR\n/, "não repete o texto da tarefa");
  assert.ok(String(novas[0].args).includes(sessao), "mesma sessão");
  assert.equal(t.prVigia.n, 1);
  const papeis = chamadas(caixa).map((c) => c.papel);
  assert.ok(papeis.filter((p) => p === "revisor").length >= 2 && papeis.filter((p) => p === "qa").length >= 2, "revisor e QA rodaram de novo");
  const eventos = await log(b, id);
  assert.ok(eventos.some((e) => e.t === "portao" && e.estado === "passou"), "portão rodou");
  assert.ok(eventos.some((e) => /PR #12 ficou em conflito depois do merge de #90; devolvida para atualizar \(tentativa 1 de 2\)/.test(e.texto || "")), "linha do tempo");
  const registro = readFileSync(join(caixa.board, "data", "logs", "prs-vigia.jsonl"), "utf8");
  assert.match(registro, /"t":"devolvida".*"mesclado":90/);
  // o GitHub confirma: a marca sai sozinha
  github(caixa, [PR(12)]);
  await esperarVigia(b, id, null);
  assert.match((await log(b, id)).map((e) => e.texto || "").join("\n"), /✓ PR #12 sem conflito e sem check falhando/);
  assert.doesNotMatch(ghLog(caixa), /pr create|pr merge/);
  assert.equal((await tarefa(b, id)).prUrl, URL_(12));
});

test("tarefa rodando: a vigia espera ela terminar e só aí devolve", async () => {
  const { caixa, b, id } = await preparar();
  caixa.cenario({ agente: ["já rodou", { texto: "ainda pensando", dorme: 3500 }] });
  await b.api("POST", `/api/tasks/${id}/chat`, { text: "mais uma coisa" });
  await esperar(300);
  github(caixa, [PR(12, CONFLITO)]);
  const t = await esperarVigia(b, id, "esperando");
  assert.equal(t.status, "executada");
  assert.ok(t.busy, "a tarefa ainda está respondendo");
  const antes = agentes(caixa).length;
  assert.equal(antes, 2, "nenhuma rodada nova enquanto ela anda");
  caixa.cenario(conserto());
  await esperarVigia(b, id, "atualizando");
  await esperarStatus(b, id, ["executada"], 20000);
  assert.equal(agentes(caixa).length, antes + 1);
  assert.match(agentes(caixa).at(-1).prompt, /CONFLITO com a main/);
});

test("limite: duas tentativas, depois 'precisa de você' com o motivo; não roda mais; resolvido, o aviso some", async () => {
  const { caixa, b, id } = await preparar();
  const antes = agentes(caixa).length;
  caixa.cenario({ agente: ["já rodou", { texto: "as duas mudanças não convivem: a main apagou a função", escreve: { arquivo: "m.txt", conteudo: "1\n" } }, { texto: "continuo sem conseguir", escreve: { arquivo: "m.txt", conteudo: "2\n" } }],
    revisor: [{ texto: "APROVADO" }, { texto: "APROVADO" }], qa: [{ texto: "APROVADO" }, { texto: "APROVADO" }] });
  github(caixa, [PR(12, CONFLITO)]);
  const t = await esperarVigia(b, id, "esgotado", 30000);
  assert.equal(agentes(caixa).length, antes + 2, "duas devoluções, nem uma a mais");
  assert.match(t.prVigia.porque, /2 tentativa\(s\).*continuo sem conseguir/);
  assert.equal(t.status, "executada");
  await esperar(2500);
  assert.equal(agentes(caixa).length, antes + 2, "esgotado não volta");
  assert.match((await log(b, id)).map((e) => e.texto || "").join("\n"), /PR #12 ficou em conflito depois do merge de #90 — precisa de você/);
  assert.match(readFileSync(join(caixa.board, "data", "logs", "prs-vigia.jsonl"), "utf8"), /"t":"esgotado"/);
  assert.equal((await b.api("POST", "/api/prs/mesclar", { url: URL_(12) })).status, 409, "Mesclar continua recusando");
  assert.doesNotMatch(ghLog(caixa), /pr create|pr merge/);
  github(caixa, [PR(12)]);
  await esperarVigia(b, id, null);
});

test("check do CI falhando em tarefa executada: mesmo caminho; cancelado e rodando não voltam", async () => {
  const { caixa, b, id } = await preparar();
  const antes = agentes(caixa).length;
  github(caixa, [PR(12, { statusCheckRollup: [{ name: "ci", conclusion: "CANCELLED" }, { name: "lint", status: "IN_PROGRESS" }] })]);
  await esperar(2500);
  assert.equal(agentes(caixa).length, antes, "cancelado não é código a consertar");
  caixa.cenario(conserto());
  github(caixa, [PR(12, { statusCheckRollup: [{ name: "testes", conclusion: "FAILURE" }, { context: "lint", state: "ERROR" }, { name: "ok", conclusion: "SUCCESS" }] })]);
  await esperarVigia(b, id, "atualizando");
  await esperarStatus(b, id, ["executada"], 20000);
  const pedido = agentes(caixa).at(-1).prompt;
  assert.match(pedido, /check do CI FALHANDO: testes, lint/);
  assert.match(pedido, /gh pr checks/);
  assert.match(pedido, /Não desligue teste/);
  assert.match((await log(b, id)).map((e) => e.texto || "").join("\n"), /PR #12 com check falhando \(testes, lint\); devolvida para consertar no mesmo PR \(tentativa 1 de 2\)/);
  assert.doesNotMatch(ghLog(caixa), /pr create|pr merge/);
});

test("não devolve: GitHub calculando (UNKNOWN), PR sem tarefa, tarefa 'direto' que só citou o PR, fila pausada; PR fechado limpa a marca", async () => {
  const { caixa, b, id } = await preparar({ entrega: "direto" });
  const antes = agentes(caixa).length;
  github(caixa, [PR(12, CONFLITO), PR(13, CONFLITO)]);
  await esperar(2500);
  assert.equal(agentes(caixa).length, antes, "tarefa direto proíbe push: a vigia não a devolve");
  assert.equal((await tarefa(b, id)).prVigia ?? null, null);
  await b.api("PATCH", `/api/tasks/${id}`, { entrega: "pr" });
  github(caixa, [PR(12, { mergeable: "UNKNOWN" })]);
  await esperar(2500);
  assert.equal(agentes(caixa).length, antes, "UNKNOWN não é conflito");
  await b.api("POST", "/api/fila/pausar");
  github(caixa, [PR(12, CONFLITO)]);
  await esperar(2500);
  assert.equal((await tarefa(b, id)).status, "executada", "com a fila pausada (o outro board pode estar com ela) nada volta");
  assert.equal((await tarefa(b, id)).prVigia ?? null, null);
  caixa.cenario(conserto());
  await b.api("POST", "/api/fila/retomar");
  await esperarVigia(b, id, "atualizando");
  await esperarStatus(b, id, ["executada"], 20000);
  github(caixa, []);
  await esperarVigia(b, id, null);
  assert.match((await log(b, id)).map((e) => e.texto || "").join("\n"), /PR #12 não está mais aberto/);
});

test("🔴 modo 'mesclar e publicar': a volta da vigia nunca mescla", async () => {
  const { caixa, b, id } = await preparar({ cenario: { agente: [{ texto: `abri ${URL_(12)}`, escreve: { arquivo: "a.txt" } }], revisor: [{ texto: "APROVADO" }], qa: [{ texto: "APROVADO" }] } });
  await b.api("PATCH", `/api/tasks/${id}`, { entrega: "deploy" });
  writeFileSync(join(caixa.board, "data", "deploy.json"), JSON.stringify({ alfa: "echo publicou > publicou.txt" }));
  caixa.cenario(conserto());
  github(caixa, [PR(12, CONFLITO)]);
  await esperarVigia(b, id, "atualizando");
  await esperarStatus(b, id, ["executada"], 20000);
  assert.doesNotMatch(ghLog(caixa), /pr merge/);
  assert.ok(!existsSync(join(caixa.dev, "alfa", "publicou.txt")));
});

test("rodada parada no meio não recomeça sozinha: vira 'precisa de você'", async () => {
  const { caixa, b, id } = await preparar();
  caixa.cenario({ agente: ["já rodou", { texto: "demorando", dorme: 6000 }] });
  github(caixa, [PR(12, CONFLITO)]);
  await esperarVigia(b, id, "atualizando");
  for (let i = 0; i < 50 && (await tarefa(b, id)).status !== "rodando"; i++) await esperar(100);
  await b.api("POST", `/api/tasks/${id}/stop`);
  const t = await esperarVigia(b, id, "esgotado");
  assert.match(t.prVigia.porque, /parada no meio/);
  assert.equal(t.status, "pendente");
});

test("tela: 'atualizando (conflito)' no menu PRs e na Central; esgotado na ficha, na Central e no Controle; Mesclar segue travado", { skip: !CHROME && "sem Chrome nesta máquina" }, async () => {
  const { caixa, b, id } = await preparar({ env: { BOARD_PR_TENTATIVAS: "1" } });
  caixa.cenario({ agente: ["já rodou", { texto: "demorando", dorme: 12000, escreve: { arquivo: "m.txt", conteudo: "1\n" } }, { texto: "não deu", escreve: { arquivo: "m.txt", conteudo: "2\n" } }], revisor: [{ texto: "APROVADO" }], qa: [{ texto: "APROVADO" }] });
  github(caixa, [PR(12, CONFLITO)]);
  await esperarVigia(b, id, "atualizando");
  const nav = await abrirNavegador();
  const texto = async (sel, rx) => { let txt = ""; for (let i = 0; i < 60 && !rx.test(txt); i++) { await esperar(150); txt = await nav.avaliar(`document.querySelector(${JSON.stringify(sel)})?.innerText || ''`); } return txt; };
  try {
    await nav.carregar(b.url + "/#/prs");
    assert.match(await texto("#prsLista", /atualizando \(conflito\)/), /#12 PR 12[\s\S]*atualizando \(conflito\)/);
    assert.equal(await nav.avaliar(`document.querySelector('[data-mesclar]').disabled`), true, "Mesclar recusa PR em conflito");
    await nav.carregar(b.url + "/#/central");
    await nav.quieto();
    assert.match(await texto("body", /atualizando \(conflito\)/), /atualizando \(conflito\)/);
    await esperarVigia(b, id, "esgotado", 30000);
    assert.match(await texto("body", /PR em conflito — precisa de você/), /PR em conflito — precisa de você/);
    await nav.carregar(b.url + `/#/t/${id}`);
    await nav.quieto();
    assert.match(await texto("#app", /tentativa/), /PR em conflito — precisa de você[\s\S]*1 tentativa\(s\)/);
    assert.deepEqual(nav.erros, []);
  } finally { await nav.fechar(); }
  assert.doesNotMatch(ghLog(caixa), /pr create|pr merge/);
});
