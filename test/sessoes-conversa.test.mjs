// 🖥→💬 Trazer uma sessão do terminal para a Conversa do projeto (#234): sem terminal nenhum, a Conversa retoma a MESMA
// sessão (claude -p --resume <sessionId>) e mostra o histórico do transcrito. A "sessão de fora" é um processo `sleep`
// registrado em $HOME/.claude/sessions como o CLI real faz; o /exit é matar esse processo e apagar o registro (o que o
// CLI faz ao sair). O transcrito fica em $HOME/.claude/projects/<pasta>/<sessionId>.jsonl, no formato real.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { criarCaixa, criarProjeto, subirBoard, limparCaixa, esperar, chamadas } from "./ajuda.mjs";
import { abrirNavegador, CHROME } from "./navegador.mjs";

let atual = [];
afterEach(async () => {
  for (const { b, caixa, filho, nav } of atual) { nav?.fechar?.(); try { filho?.kill("SIGKILL"); } catch { /* saiu */ } await b?.fim(); limparCaixa(caixa); }
  atual = [];
});

const SID = "7da4aec1-7f28-4862-9c86-c8e724685ae5";
const linha = (o) => JSON.stringify(o) + "\n";
const TRANSCRITO = [
  { type: "user", message: { role: "user", content: "<command-name>/model</command-name>" } }, // comando: fica de fora
  { type: "user", message: { role: "user", content: "o rate limit do nginx está com balde único?" } },
  { type: "assistant", message: { content: [{ type: "text", text: "Está: um balde só para a plataforma inteira." }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "x" } }] } },
  { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "segredo-do-arquivo" }] } },
  { type: "assistant", message: { content: [{ type: "text", text: "Proponho um balde por IP." }] } },
  { type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "fala de subagente" }] } },
  { type: "user", message: { role: "user", content: [{ type: "text", text: "pode seguir" }] } },
  { type: "assistant", message: { content: [{ type: "text", text: "Feito." }] } },
].map(linha).join("");

async function preparar({ cenario = {} } = {}) {
  const caixa = criarCaixa();
  const demo = criarProjeto(caixa, "demo");
  caixa.cenario(cenario);
  const filho = spawn("sleep", ["120"], { stdio: "ignore" });
  const regDir = join(caixa.home, ".claude", "sessions"); mkdirSync(regDir, { recursive: true });
  const reg = join(regDir, `${filho.pid}.json`);
  writeFileSync(reg, JSON.stringify({ pid: filho.pid, sessionId: SID, cwd: demo, entrypoint: "cli", kind: "interactive", name: "erp", status: "idle" }));
  const tdir = join(caixa.home, ".claude", "projects", "-pasta-de-outro-lugar"); mkdirSync(tdir, { recursive: true });
  writeFileSync(join(tdir, SID + ".jsonl"), TRANSCRITO);
  const b = await subirBoard(caixa);
  const ctx = { caixa, demo, filho, reg, b };
  // O /exit no terminal: o processo sai e o CLI apaga o registro dele.
  ctx.sair = async () => { const foi = new Promise((ok) => filho.once("exit", ok)); filho.kill("SIGKILL"); await foi; rmSync(reg, { force: true }); };
  atual.push(ctx);
  return ctx;
}
const trazer = (b, corpo, headers = { origin: b.url }) =>
  fetch(`${b.url}/api/sessoes/trazer`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(corpo) })
    .then(async (r) => ({ status: r.status, json: await r.json() }));
const lista = async (b) => (await b.api("GET", "/api/sessoes?fresco")).json;
async function ate(fn, limite = 15000) { const t0 = Date.now(); let v; while (Date.now() - t0 < limite) { if ((v = await fn())) return v; await esperar(150); } throw new Error("não aconteceu a tempo"); }
const logSessoes = (caixa) => readFileSync(join(caixa.board, "data", "logs", "sessoes.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("trazer para a Conversa: viva recusa sem tocar nela; depois do /exit, a Conversa retoma a MESMA sessão com o histórico", async () => {
  const { b, caixa, filho, sair } = await preparar({ cenario: { conversa: ["continuei de onde paramos"] } });
  const d0 = await lista(b);
  assert.deepEqual(d0.sessoes.map((s) => [s.nome, s.projeto?.slug]), [["erp", "demo"]], "a sessão aberta, ligada ao projeto da pasta dela");

  assert.equal((await trazer(b, { sessionId: SID }, {})).status, 403, "sem o Origin da tela (CLI, curl de agente)");
  assert.equal((await trazer(b, { sessionId: SID }, { origin: "http://mal.example" })).status, 403);
  const viva = await trazer(b, { sessionId: SID });
  assert.equal(viva.status, 409); assert.equal(viva.json.viva, filho.pid); assert.match(viva.json.error, /\/exit/);
  assert.equal(filho.exitCode, null, "o board nunca fecha a sessão de fora");
  assert.equal((await trazer(b, { sessionId: "nao-vi-esta-sessao" })).status, 404, "só sessão que o board viu no registro");

  await sair();
  const d1 = await lista(b);
  assert.equal(d1.sessoes.length, 0, "saiu do registro…");
  assert.deepEqual(d1.encerradas.map((s) => [s.nome, s.historico, s.projeto?.slug]), [["erp", true, "demo"]], "…mas o board lembra e oferece trazer");

  const r = await trazer(b, { sessionId: SID });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.url, "#/c/demo"); assert.equal(r.json.mensagens, 4);
  const d2 = await lista(b);
  assert.equal(d2.encerradas.length, 0, "trazida, some da lista de fora");
  assert.deepEqual(d2.trazidas.map((t) => [t.nome, t.slug]), [["erp", "demo"]], "e o menu aponta para a Conversa");

  const ev = (await b.api("GET", "/api/conversa/demo")).json.events;
  assert.deepEqual(ev.filter((e) => e.importado).map((e) => [e.t, e.texto]), [
    ["dono", "o rate limit do nginx está com balde único?"],
    ["resultado", "Está: um balde só para a plataforma inteira.\n\nProponho um balde por IP."],
    ["dono", "pode seguir"], ["resultado", "Feito."]], "texto do dono e do agente; comando, ferramenta e subagente de fora");
  assert.deepEqual(ev.filter((e) => e.t === "resultado").map((e) => e.n), [1, 2], "as respostas trazidas ganham número (dá para citar)");
  assert.doesNotMatch(JSON.stringify(ev), /segredo-do-arquivo|fala de subagente/);
  const st = (await b.api("GET", "/api/state")).json.conversas.demo;
  assert.equal(st.motor, "claude");

  assert.equal((await b.api("POST", "/api/conversa/demo", { texto: "e agora?" })).status, 202);
  await ate(async () => (await b.api("GET", "/api/conversa/demo")).json.events.some((e) => e.t === "resultado" && !e.importado));
  const conv = chamadas(caixa).filter((c) => c.papel === "conversa");
  assert.equal(conv.length, 1);
  const args = conv[0].args;
  assert.equal(args[args.indexOf("--resume") + 1], SID, "o processo vivo retoma a sessão do terminal");
  assert.ok(args.includes("--permission-prompt-tool"), "pedido de permissão vira cartão na tela (#232)");
  assert.equal(conv[0].msg, "e agora?", "nada do histórico é reenviado: a sessão já tem tudo");

  const reg = logSessoes(caixa).filter((e) => e.t === "trazida");
  assert.equal(reg.length, 1); assert.equal(reg[0].quem, "dono (tela)"); assert.equal(reg[0].projeto, "demo"); assert.equal(reg[0].sessionId, SID);
  assert.equal((await trazer(b, { sessionId: SID })).json.jaEstava, true, "trazer de novo não refaz nada");
});

test("a Conversa já tem fio: pergunta qual fica; 'manter' não muda nada, 'substituir' arquiva o fio antigo (não apaga)", async () => {
  const { b, caixa, sair } = await preparar({ cenario: { conversa: ["resposta do fio antigo"] } });
  await lista(b);
  assert.equal((await b.api("POST", "/api/conversa/demo", { texto: "fio antigo" })).status, 202);
  await ate(async () => { const x = (await b.api("GET", "/api/conversa/demo")).json; return !x.busy && x.events.some((e) => e.t === "resultado"); });
  const antigo = (await b.api("GET", "/api/state")).json.conversas.demo;
  await sair();

  const c = await trazer(b, { sessionId: SID });
  assert.equal(c.status, 409);
  assert.equal(c.json.conflito.mensagens, 2); assert.equal(c.json.conflito.nova, "erp"); assert.match(c.json.conflito.trecho, /fio antigo/);
  assert.equal((await b.api("GET", "/api/conversa/demo")).json.events.filter((e) => e.t === "dono").length, 1, "sem confirmar, nada muda");

  const r = await trazer(b, { sessionId: SID, substituir: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const arq = readdirSync(join(caixa.board, "data", "logs")).filter((f) => f.startsWith("conversa-demo.arquivo-"));
  assert.equal(arq.length, 1, "o fio antigo foi para o arquivo");
  assert.match(readFileSync(join(caixa.board, "data", "logs", arq[0]), "utf8"), /fio antigo/);
  const reg = logSessoes(caixa).find((e) => e.t === "trazida");
  assert.ok(reg.substituiu && reg.arquivado, "o registro guarda a sessão de antes e o arquivo: dá para voltar a ela");
  void antigo;
});

test("projeto fora da seleção da tela: pergunta antes de pôr em 'visiveis'; pasta que não é projeto e sessão sem histórico recusam", async () => {
  const { b, caixa, sair } = await preparar();
  const cat = join(caixa.board, "data", "projetos.json");
  writeFileSync(cat, JSON.stringify({ visiveis: [] }));
  await lista(b);
  await sair();
  const d = await lista(b);
  assert.equal(d.encerradas[0].projeto.visivel, false);
  const p = await trazer(b, { sessionId: SID });
  assert.equal(p.status, 409); assert.equal(p.json.precisaVisivel.slug, "demo");
  assert.deepEqual(JSON.parse(readFileSync(cat, "utf8")).visiveis, [], "sem o dono aceitar, a seleção não muda");
  assert.equal((await trazer(b, { sessionId: SID, porVisivel: true })).status, 200);
  assert.deepEqual(JSON.parse(readFileSync(cat, "utf8")).visiveis, ["demo"]);

  // Uma sessão de pasta que não é projeto, e outra sem transcrito.
  const regDir = join(caixa.home, ".claude", "sessions");
  const outros = [spawn("sleep", ["120"], { stdio: "ignore" }), spawn("sleep", ["120"], { stdio: "ignore" })];
  atual.push({ filho: outros[0] }, { filho: outros[1] });
  writeFileSync(join(regDir, `${outros[0].pid}.json`), JSON.stringify({ pid: outros[0].pid, sessionId: "fora-do-dev-01", cwd: caixa.home, entrypoint: "cli", name: "solta" }));
  writeFileSync(join(regDir, `${outros[1].pid}.json`), JSON.stringify({ pid: outros[1].pid, sessionId: "sem-historico-1", cwd: join(caixa.dev, "demo"), entrypoint: "cli", name: "nova" }));
  await lista(b);
  await Promise.all(outros.map((f) => { const foi = new Promise((ok) => f.once("exit", ok)); f.kill("SIGKILL"); return foi; }));
  for (const f of outros) rmSync(join(regDir, `${f.pid}.json`), { force: true });
  const d2 = await lista(b);
  assert.equal(d2.encerradas.find((s) => s.nome === "solta").projeto, null);
  assert.equal(d2.encerradas.find((s) => s.nome === "nova").historico, false);
  assert.match((await trazer(b, { sessionId: "fora-do-dev-01" })).json.error, /não é um projeto/);
  assert.match((await trazer(b, { sessionId: "sem-historico-1" })).json.error, /não achei o histórico/);
});

test("tela: a sessão que saiu tem 'Trazer para a Conversa'; o conflito pergunta; termina na Conversa com o histórico", { skip: !CHROME && "sem Chrome nesta máquina" }, async () => {
  const ctx = await preparar({ cenario: { conversa: ["resposta do fio antigo"] } });
  const { b, sair } = ctx;
  await lista(b);
  assert.equal((await b.api("POST", "/api/conversa/demo", { texto: "fio antigo" })).status, 202);
  await ate(async () => { const x = (await b.api("GET", "/api/conversa/demo")).json; return !x.busy && x.events.some((e) => e.t === "resultado"); });
  const nav = ctx.nav = await abrirNavegador();
  await nav.carregar(b.url + "/#/sessoes");
  const espera = async (expr, oque) => { for (let i = 0; i < 80; i++) { if (await nav.avaliar(expr)) return; await esperar(150); } throw new Error("a tela não mostrou: " + oque + "\n" + await nav.avaliar(`document.querySelector('#app')?.innerText`)); };
  await espera(`document.querySelector('#sesLista')?.innerText.includes('/exit')`, "o aviso para dar /exit na sessão aberta");
  await sair();
  await espera(`document.querySelector('#sesLista')?.innerText.includes('saiu do terminal')`, "a sessão que saiu");
  await nav.avaliar(`document.querySelector('[data-trazer]').click()`);
  await espera(`location.hash === '#/c/demo'`, "a Conversa do projeto");
  assert.ok(nav.dialogos.some((m) => /Qual fica\?/.test(m)), "perguntou qual fio fica: " + JSON.stringify(nav.dialogos));
  await espera(`document.querySelector('#app').innerText.includes('Proponho um balde por IP')`, "o histórico trazido");
  await espera(`document.querySelector('#app').innerText.includes('do terminal')`, "a marca do terminal nas respostas trazidas");
  await nav.carregar(b.url + "/#/sessoes");
  await espera(`!!document.querySelector('.ses-trazidas a[href="#/c/demo"]')`, "o link para a Conversa no menu");
  assert.deepEqual(nav.erros, []);
});
