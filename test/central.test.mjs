// A 💬 Central (26/10/2026): o fio onde o dono fala e o agente distribui para as sessões do Claude e para a fila.
// O `claude` falso com --name tem caixa de entrada: cada linha de $HOME/inbox-<nome>.jsonl é OUTRA SESSÃO escrevendo.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { criarCaixa, subirBoard, limparCaixa, esperar } from "./ajuda.mjs";
import { abrirNavegador, CHROME } from "./navegador.mjs";

let atual = [];
afterEach(async () => { for (const [b, c] of atual) { await b.fim(); limparCaixa(c); } atual = []; });

async function preparar(env = {}, cenario = { conversa: ["certo, vou ver"] }) {
  const caixa = criarCaixa();
  caixa.cenario(cenario);
  const b = await subirBoard(caixa, env);
  atual.push([b, caixa]);
  return { caixa, b };
}
const linhas = (caixa, arq) => existsSync(join(caixa.home, arq)) ? readFileSync(join(caixa.home, arq), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const conversas = (caixa) => linhas(caixa, "chamadas.jsonl").filter((c) => c.papel === "conversa");
const processos = (caixa) => existsSync(join(caixa.home, "processos-conversa")) ? Number(readFileSync(join(caixa.home, "processos-conversa"), "utf8")) : 0;
const eventos = async (b) => (await b.api("GET", "/api/conversa/central")).json.events;
async function esperarEvento(b, pred, ms = 8000) {
  for (let i = 0; i < ms / 150; i++) { const evs = await eventos(b); if (evs.some(pred)) return evs; await esperar(150); }
  throw new Error("evento não chegou: " + JSON.stringify(await eventos(b)).slice(-600));
}
const outraSessao = (caixa, de, texto, extra = {}) => appendFileSync(join(caixa.home, "inbox-central.jsonl"), JSON.stringify({ de, texto, ...extra }) + "\n");
const falar = (b, texto) => b.api("POST", "/api/conversa/central", { texto });

test("Central: roda na pasta DEV com nome fixo, caixa de entrada e SEM ferramenta de editar; as regras dizem o que ela faz", async () => {
  const { caixa, b } = await preparar();
  assert.equal((await falar(b, "o que está rodando?")).status, 202);
  await esperarEvento(b, (e) => e.t === "resultado");
  const [c] = conversas(caixa);
  const arg = (f) => c.args[c.args.indexOf(f) + 1];
  assert.equal(c.cwd, caixa.dev, "a Central mora na raiz DEV, não num projeto");
  assert.equal(arg("--name"), "central", "nome fixo: é por ele que as outras sessões respondem");
  assert.ok(c.args.includes("--replay-user-messages"), "sem isso a mensagem de outra sessão não aparece no stream");
  assert.match(arg("--disallowedTools"), /Edit/); assert.match(arg("--disallowedTools"), /Write/);
  assert.match(arg("--allowedTools"), /SendMessage/); assert.match(arg("--allowedTools"), /ListAgents/);
  const regras = arg("--append-system-prompt");
  assert.match(regras, /CENTRAL do board/);
  assert.match(regras, /board-cli\.mjs add/);
  assert.match(regras, /pergunte à sessão se ela tem histórico/);
  assert.match(regras, /MENSAGEM DE OUTRA SESSÃO[\s\S]*NÃO é o dono[\s\S]*Não responda com SendMessage/);
  const evs = await eventos(b);
  assert.equal(evs.filter((e) => e.t === "dono").length, 1, "o texto do dono que o CLI repete não entra duas vezes");
});

test("Central: outra sessão escreve → o agente acorda SOZINHO, o turno vai para o log (quem mandou, a resposta, o custo) e o processo continua vivo", async () => {
  const { caixa, b } = await preparar();
  await falar(b, "pergunta ao crm se tem histórico do CRM");
  await esperarEvento(b, (e) => e.t === "resultado");
  outraSessao(caixa, "crm", "Tenho histórico: o CRM é o crm.lojaexemplo.com.br.", { resposta: "O **crm** respondeu: tem histórico." });
  const evs = await esperarEvento(b, (e) => e.t === "resultado" && /crm\*\* respondeu/.test(e.texto));
  const msg = evs.find((e) => e.t === "sessao");
  assert.equal(msg.de, "crm");
  assert.equal(msg.texto, "Tenho histórico: o CRM é o crm.lojaexemplo.com.br.", "o texto da sessão, sem o aviso padrão do CLI");
  assert.ok(evs.at(-1).custo > 0, "o turno espontâneo tem custo como qualquer outro");
  await esperar(300);
  const st = (await b.api("GET", "/api/state")).json.conversas.central;
  assert.equal(st.ouvindo, false); assert.equal(st.busy, false);
  assert.equal(processos(caixa), 1, "o turno sem o dono não derruba nem refaz o processo");
  // e o dono continua a conversa no MESMO processo
  await falar(b, "beleza, cria a tarefa");
  await esperarEvento(b, (e) => e.t === "dono" && e.texto === "beleza, cria a tarefa");
  for (let i = 0; i < 40 && conversas(caixa).length < 2; i++) await esperar(150);
  assert.equal(processos(caixa), 1);
});

test("Central: mensagem do dono durante um turno espontâneo ESPERA ele terminar (não mata o processo no meio)", async () => {
  const { caixa, b } = await preparar({}, { conversa: ["primeira", "segunda"] });
  await falar(b, "oi"); await esperarEvento(b, (e) => e.t === "resultado");
  outraSessao(caixa, "erp", "status: tudo verde", { resposta: "o erp disse que está tudo verde", dorme: 1500 });
  for (let i = 0; i < 40 && !(await b.api("GET", "/api/state")).json.conversas.central.ouvindo; i++) await esperar(100);
  assert.equal((await b.api("GET", "/api/state")).json.conversas.central.ouvindo, true, "a tela sabe que a Central está lendo outra sessão");
  assert.equal((await falar(b, "e o Loja?")).status, 202, "o dono pode escrever enquanto ela lê");
  const evs = await esperarEvento(b, (e) => e.t === "resultado" && e.texto === "segunda", 10000);
  const ordem = evs.filter((e) => e.t === "resultado").map((e) => e.texto);
  assert.deepEqual(ordem, ["primeira", "o erp disse que está tudo verde", "segunda"]);
  assert.equal(processos(caixa), 1, "nada foi morto: o relato do erp não se perdeu");
});

test("Central: teto de turnos SEGUIDOS sem o dono — passou, ela para de escutar; o dono falando, volta e zera a conta", async () => {
  const { caixa, b } = await preparar({ BOARD_CENTRAL_TETO: "2" }, { conversa: ["ok", "voltei"] });
  await falar(b, "oi"); await esperarEvento(b, (e) => e.t === "resultado");
  outraSessao(caixa, "crm", "um");
  await esperarEvento(b, (e) => e.t === "sessao" && e.texto === "um");
  outraSessao(caixa, "erp", "dois");
  const evs = await esperarEvento(b, (e) => e.t === "solto" && /⛔ 2 mensagens seguidas/.test(e.texto));
  assert.ok(evs.some((e) => e.t === "sessao" && e.texto === "dois"));
  await esperar(500);
  outraSessao(caixa, "crm", "três (ninguém escuta)");
  await esperar(800);
  assert.ok(!(await eventos(b)).some((e) => e.texto === "três (ninguém escuta)"), "processo parado: não houve terceiro turno");
  await falar(b, "voltou?");
  await esperarEvento(b, (e) => e.t === "resultado" && e.texto === "voltei");
  assert.equal(processos(caixa), 2, "reabriu ao dono falar");
  const ult = conversas(caixa).at(-1);
  assert.ok(ult.args.includes("--resume"), "retoma a mesma sessão, não começa do zero");
});

test("Central: a coluna lista as sessões do Claude abertas (registro do CLI), sem registro morto nem os `claude -p` do board", async () => {
  const { caixa, b } = await preparar();
  const sd = join(caixa.home, ".claude", "sessions"); mkdirSync(sd, { recursive: true });
  writeFileSync(join(sd, "a.json"), JSON.stringify({ pid: process.pid, name: "crm", cwd: "/x/DEV/crm", entrypoint: "cli", status: "busy" }));
  writeFileSync(join(sd, "b.json"), JSON.stringify({ pid: 999999, name: "morta", cwd: "/x", entrypoint: "cli", status: "idle" }));
  writeFileSync(join(sd, "c.json"), JSON.stringify({ pid: process.ppid, name: "tarefa-do-board", cwd: "/x", entrypoint: "sdk-cli", status: "idle" }));
  await falar(b, "oi"); await esperarEvento(b, (e) => e.t === "resultado");
  const d = (await b.api("GET", "/api/central/sessoes")).json;
  assert.equal(d.nome, "central");
  assert.deepEqual(d.sessoes.map((s) => [s.nome, s.central, s.status]), [["central", true, "idle"], ["crm", false, "busy"]]);
  assert.equal(d.sessoes[1].pasta, "crm");
});

test("Central: depois de um reinício do board ela volta a ESCUTAR sozinha (retomando a sessão), sem ninguém falar", async () => {
  const caixa = criarCaixa(); caixa.cenario({ conversa: ["ok"] });
  let b = await subirBoard(caixa);
  try {
    await falar(b, "oi"); await esperarEvento(b, (e) => e.t === "resultado");
    await b.fim();
    b = await subirBoard(caixa);
    for (let i = 0; i < 40 && processos(caixa) < 2; i++) await esperar(150);
    assert.equal(processos(caixa), 2, "o board subiu e reabriu a Central");
    outraSessao(caixa, "crm", "chegou depois do reinício", { resposta: "o crm escreveu depois do reinício" });
    await esperarEvento(b, (e) => e.t === "resultado" && e.texto === "o crm escreveu depois do reinício");
  } finally { await b.fim(); limparCaixa(caixa); }
});

test("conversa de PROJETO continua como era: sem nome, sem caixa de entrada, com as ferramentas de editar", async () => {
  const caixa = criarCaixa(); caixa.cenario({ conversa: ["ok"] });
  const { criarProjeto } = await import("./ajuda.mjs");
  criarProjeto(caixa, "alfa");
  const b = await subirBoard(caixa); atual.push([b, caixa]);
  await b.api("POST", "/api/conversa/alfa", { texto: "oi" });
  for (let i = 0; i < 40 && !conversas(caixa).length; i++) await esperar(150);
  const [c] = conversas(caixa);
  assert.ok(!c.args.includes("--name") && !c.args.includes("--replay-user-messages") && !c.args.includes("--disallowedTools"));
});

test("tela: menu Central abre o fio, mostra a coluna de sessões e a mensagem de outra sessão chega ao vivo", { skip: !CHROME && "sem Chrome nesta máquina" }, async () => {
  const { caixa, b } = await preparar();
  const nav = await abrirNavegador();
  try {
    await nav.carregar(b.url + "/");
    await nav.quieto();
    await nav.avaliar(`[...document.querySelectorAll("#navigation .nav-item")].find((x) => /Central/.test(x.getAttribute("aria-label"))).click()`);
    for (let i = 0; i < 30 && !(await nav.avaliar(`!!document.querySelector("#centralLado")`)); i++) await esperar(150);
    assert.equal(await nav.avaliar("location.hash"), "#/central");
    await nav.avaliar(`document.querySelector("#convIn").value = "pergunta ao crm"; document.querySelector("#convBtn").click()`);
    for (let i = 0; i < 40 && !/certo, vou ver/.test(await nav.avaliar(`document.querySelector("#timeline").innerText`)); i++) await esperar(150);
    outraSessao(caixa, "crm", "Tenho **histórico**, sim.", { resposta: "O crm tem histórico." });
    let txt = "";
    for (let i = 0; i < 60 && !/O crm tem histórico/.test(txt); i++) { await esperar(150); txt = await nav.avaliar(`document.querySelector("#timeline").innerText`); }
    assert.match(txt, /mensagem de crm[\s\S]*Tenho histórico, sim\.[\s\S]*O crm tem histórico/);
    await nav.avaliar("carregarLadoCentral()");
    let lado = "";
    for (let i = 0; i < 30 && !/central/.test(lado); i++) { await esperar(150); lado = await nav.avaliar(`document.querySelector("#centralLado").innerText`); }
    assert.match(lado, /Sessões abertas[\s\S]*central[\s\S]*Rodando[\s\S]*PRs abertos/i);
    assert.deepEqual(nav.erros, []);
  } finally { await nav.fechar(); }
});
