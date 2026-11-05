// 🖥 "ver no tmux" (#248): no Mac abre o Terminal; no board sem tela (o Atena) a sessão board-agentes — painel + uma aba
// por agente, montada pelo `board agentes` — aparece NA TELA, com a tela crua das Sessões (#233). E nunca calado: falhou,
// a resposta diz por quê. Um tmux DE VERDADE num servidor próprio (BOARD_TMUX_SOCKET = -L <nome>), como em sessoes.test.mjs.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { request } from "node:http";
import { criarCaixa, criarProjeto, subirBoard, limparCaixa, esperar } from "./ajuda.mjs";
import { abrirNavegador, CHROME } from "./navegador.mjs";

const TMUX = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].find((p) => existsSync(p));
const SEM_TMUX = { skip: !TMUX && "sem tmux nesta máquina" };
const SEM_TELA = { skip: (!TMUX && "sem tmux nesta máquina") || (!CHROME && "sem Chrome nesta máquina") };

let atual = [];
afterEach(async () => { for (const f of atual.reverse()) await f(); atual = []; });

async function preparar({ env = {}, antes } = {}) {
  const caixa = criarCaixa(); criarProjeto(caixa, "demo");
  caixa.cenario({ agente: [{ quando: "longa", texto: "terminei", dorme: 60000 }, "ok"] });
  if (antes) antes(caixa);
  const sock = "ag" + process.pid + "-" + Math.random().toString(36).slice(2, 7);
  const b = await subirBoard(caixa, { BOARD_TMUX: TMUX || "/nao/existe/tmux", BOARD_TMUX_SOCKET: sock, BOARD_SESSOES_INTERVALO_MS: "150", ...env });
  const ctx = { caixa, b, sock, nav: null };
  atual.push(async () => {
    ctx.nav?.fechar?.(); await b.fim();
    if (TMUX) try { execFileSync(TMUX, ["-L", sock, "kill-server"], { stdio: "ignore" }); } catch { /* já saiu */ }
    limparCaixa(caixa);
  });
  return ctx;
}
async function ate(fn, limite = 15000) { const t0 = Date.now(); let v; while (Date.now() - t0 < limite) { v = await fn(); if (v) return v; await esperar(150); } return v; }
const abrir = (b, headers = { origin: b.url }) => fetch(`${b.url}/api/agentes/tmux`, { method: "POST", headers }).then(async (r) => ({ status: r.status, json: await r.json() }));
async function rodando(b) {
  const [t] = (await b.api("POST", "/api/tasks", { text: "tarefa longa", project: "demo", queue: true })).json.tasks;
  assert.ok(await ate(async () => (await b.api("GET", `/api/tasks/${t.id}`)).json.task.agente), "o agente começou");
  return t;
}
async function telaDa(b, n, re) {
  let html = "";
  for (let i = 0; i < 80; i++) { html = (await b.api("GET", `/api/agentes/tmux/${n}/tela`)).json?.html || ""; if (re.test(html)) return html; await esperar(150); }
  throw new Error(`a aba ${n} não mostrou ${re}:\n${html}`);
}

test("sem tela: o 🖥 monta a sessão board-agentes e a lê pelo board — painel, aba do agente, ao vivo; a 2ª vez não refaz", SEM_TMUX, async () => {
  const { b, sock } = await preparar({ env: { BOARD_AGENTES_TELA: "navegador" } });
  const t = await rodando(b);
  assert.deepEqual((await b.api("GET", "/api/agentes/tmux")).json, { modo: "navegador", sessao: "board-agentes", existe: false, janelas: [] });
  const r = await abrir(b);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.modo, "navegador"); assert.equal(r.json.url, "#/agentes");
  assert.equal(execFileSync(TMUX, ["-L", sock, "list-sessions", "-F", "#{session_name}"], { encoding: "utf8" }).trim(), "board-agentes", "no tmux do board, sem janela");
  const lista = await ate(async () => { const j = (await b.api("GET", "/api/agentes/tmux")).json; return j.janelas.find((x) => x.tarefa === t.id) && j; });
  assert.ok(lista, "o painel abriu a aba do agente");
  assert.equal(lista.janelas[0].nome, "painel");
  const aba = lista.janelas.find((x) => x.tarefa === t.id);
  assert.match(aba.nome, /eng01 demo/);
  assert.match(await telaDa(b, lista.janelas[0].janela, /agentes agora/), /#eng01/, "o painel mostra quem trabalha");
  assert.match(await telaDa(b, aba.janela, new RegExp("tarefa #" + t.id)), /tarefa longa/, "a aba do agente mostra o board seguir");
  assert.match(await telaDa(b, aba.janela, /tarefa/), /<span style=/, "com as cores");
  // ao vivo: o SSE manda a tela
  const html = await new Promise((ok, nao) => {
    const req = request(`${b.url}/api/agentes/tmux/${aba.janela}/ao-vivo`, (res) => {
      let buf = ""; res.on("data", (d) => { buf += d; const m = buf.match(/event: tela\ndata: (.*)\n\n/); if (m) { req.destroy(); ok(JSON.parse(m[1]).html); } });
    });
    req.on("error", nao); req.end(); setTimeout(() => nao(new Error("o ao vivo não mandou a tela")), 8000);
  });
  assert.match(html, new RegExp("tarefa #" + t.id));
  // 2º clique: a sessão que existe fica (quem assiste não perde a aba)
  const pane = lista.janelas[0].pane;
  assert.equal((await abrir(b)).status, 200);
  assert.equal((await b.api("GET", "/api/agentes/tmux")).json.janelas[0].pane, pane, "não matou e refez a sessão");
  assert.equal((await b.api("GET", "/api/agentes/tmux/99/tela")).status, 404, "aba que não existe");
});

test("travas: página de outro site não abre nem lê; não há rota de teclas", SEM_TMUX, async () => {
  const { b } = await preparar({ env: { BOARD_AGENTES_TELA: "navegador" } });
  assert.equal((await abrir(b, { origin: "http://mal.exemplo" })).status, 403);
  assert.equal((await fetch(`${b.url}/api/agentes/tmux`, { headers: { origin: "http://mal.exemplo" } })).status, 403);
  assert.equal((await fetch(`${b.url}/api/agentes/tmux/0/teclas`, { method: "POST", headers: { origin: b.url } })).status, 404);
});

test("nunca calado: sem tmux, ou o Terminal (Mac) falhando, a resposta diz o motivo", async () => {
  const sem = await preparar({ env: { BOARD_AGENTES_TELA: "navegador", BOARD_TMUX: "/nao/existe/tmux" } });
  const r = await abrir(sem.b);
  assert.equal(r.status, 502); assert.match(r.json.error, /não achei o tmux/);
  const mac = await preparar({ env: { BOARD_AGENTES_TELA: "terminal" }, antes: (caixa) => {
    writeFileSync(join(caixa.bin, "osascript"), `#!/bin/sh\necho "$*" >> "$HOME/osascript.log"\n[ -f "$HOME/osascript-falha" ] && { echo "execution error: Terminal não abriu (-600)" >&2; exit 1; }\nexit 0\n`);
    chmodSync(join(caixa.bin, "osascript"), 0o755);
  } });
  const ok = await abrir(mac.b);
  assert.equal(ok.status, 200, JSON.stringify(ok.json)); assert.equal(ok.json.modo, "terminal");
  assert.match(readFileSync(join(mac.caixa.home, "osascript.log"), "utf8"), /tmux attach -t board-agentes/, "no Mac continua abrindo o Terminal");
  writeFileSync(join(mac.caixa.home, "osascript-falha"), "");
  const falhou = await abrir(mac.b);
  assert.equal(falhou.status, 502); assert.match(falhou.json.error, /Terminal não abriu/);
});

test("tela: o 🖥 ver no tmux leva à vista dos agentes, com as abas clicáveis e a tela ao vivo", SEM_TELA, async () => {
  const ctx = await preparar({ env: { BOARD_AGENTES_TELA: "navegador" } });
  const { b } = ctx;
  const t = await rodando(b);
  const nav = ctx.nav = await abrirNavegador();
  await nav.carregar(b.url + "/");
  const espera = async (expr, oque) => { for (let i = 0; i < 100; i++) { if (await nav.avaliar(expr)) return; await esperar(150); } throw new Error("a tela não mostrou: " + oque + " (em " + await nav.avaliar("location.hash") + "; " + await nav.avaliar(`[...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | ')`) + ")\n" + await nav.avaliar(`document.querySelector('#app')?.innerText`)); };
  await espera(`[...document.querySelectorAll('.agente-chip')].some(x => x.innerText.includes('ver no tmux'))`, "o botão 🖥");
  await nav.avaliar(`[...document.querySelectorAll('.agente-chip')].find(x => x.innerText.includes('ver no tmux')).click()`);
  await espera(`location.hash === '#/agentes'`, "foi para #/agentes");
  // Abre na aba ativa do tmux (o painel leva a ela o agente que começou); as outras, num clique.
  await espera(`[...document.querySelectorAll('[data-agt-janela]')].some(a => a.innerText.includes('eng01'))`, "a aba do agente");
  await nav.avaliar(`[...document.querySelectorAll('[data-agt-janela]')].find(a => a.innerText.includes('painel')).click()`);
  await espera(`/agentes agora/.test(document.querySelector('#agtTerm')?.innerText || '')`, "o painel ao vivo");
  assert.equal(await nav.avaliar(`location.hash`), "#/agentes/0");
  await nav.avaliar(`[...document.querySelectorAll('[data-agt-janela]')].find(a => a.innerText.includes('eng01')).click()`);
  await espera(`/tarefa #${t.id}/.test(document.querySelector('#agtTerm')?.innerText || '')`, "a tela do agente");
  assert.match(await nav.avaliar(`location.hash`), /^#\/agentes\/[1-9]\d*$/);
  assert.equal(await nav.avaliar(`!!document.querySelector('#agtTerm a, .ses-cab a[href="#/t/${t.id}"]')`), true, "link para a tarefa");
  assert.equal(await nav.avaliar(`!!document.querySelector('#agtLista input, #agtLista [data-tecla]')`), false, "só leitura");
  assert.deepEqual(nav.erros, [], "sem erro de JS");
});

test("só a sessão board-agentes EXATA: outra com o mesmo começo (board-agentes-x) nunca é lida, e o 🖥 monta a certa", SEM_TMUX, async () => {
  // QA da #248: `list-panes -s -t =board-agentes` lê o alvo como janela e casa por prefixo — devolvia a board-agentes-x.
  const { b, sock } = await preparar({ env: { BOARD_AGENTES_TELA: "navegador" } });
  execFileSync(TMUX, ["-L", sock, "new-session", "-d", "-s", "board-agentes-x", "-x", "80", "-y", "10", "sh", "-c", "echo SEGREDO; sleep 60"]);
  const antes = (await b.api("GET", "/api/agentes/tmux")).json;
  assert.equal(antes.existe, false, "a outra sessão não conta como a dos agentes");
  assert.deepEqual(antes.janelas, []);
  assert.equal((await b.api("GET", "/api/agentes/tmux/0/tela")).status, 404, "nem a tela dela");
  const r = await abrir(b);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(r.json.janelas.some((j) => j.nome === "painel"), "montou a board-agentes, com o painel");
  const sessoes = execFileSync(TMUX, ["-L", sock, "list-sessions", "-F", "#{session_name}"], { encoding: "utf8" }).trim().split("\n").sort();
  assert.deepEqual(sessoes, ["board-agentes", "board-agentes-x"], "a outra ficou intacta");
  assert.doesNotMatch(await telaDa(b, 0, /agentes agora/), /SEGREDO/);
});

test("clique duplo (4 pedidos juntos, sem a sessão aberta): todos 200, uma sessão só", SEM_TMUX, async () => {
  const { b, sock } = await preparar({ env: { BOARD_AGENTES_TELA: "navegador" } });
  const rs = await Promise.all([1, 2, 3, 4].map(() => abrir(b)));
  assert.deepEqual(rs.map((r) => r.status), [200, 200, 200, 200], JSON.stringify(rs.map((r) => r.json)));
  assert.equal(execFileSync(TMUX, ["-L", sock, "list-sessions", "-F", "#{session_name}"], { encoding: "utf8" }).trim(), "board-agentes");
  assert.equal(execFileSync(TMUX, ["-L", sock, "list-windows", "-t", "=board-agentes:", "-F", "#{window_name}"], { encoding: "utf8" }).trim().split("\n").filter((n) => n === "painel").length, 1, "um painel só");
});
