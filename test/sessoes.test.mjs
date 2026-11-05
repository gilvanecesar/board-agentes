// 🖥 Sessões (#233): o terminal cru de cada sessão do Claude no tmux, ao vivo, e as teclas mandadas pela tela.
// Um tmux DE VERDADE num servidor próprio (BOARD_TMUX_SOCKET = -L <nome>): o tmux do dono não é visto nem tocado.
// A "sessão do Claude" é um bash que imita um pedido de permissão (cores + "1. Sim 2. Não") e ecoa o que recebe;
// o registro do CLI ($HOME/.claude/sessions/<pid>.json) aponta para o pid dele, como o claude real faz.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { request } from "node:http";
import { criarCaixa, subirBoard, limparCaixa, esperar } from "./ajuda.mjs";
import { abrirNavegador, CHROME } from "./navegador.mjs";

const TMUX = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].find((p) => existsSync(p));
const SEM_TMUX = { skip: !TMUX && "sem tmux nesta máquina" };
const SEM_TELA = { skip: (!TMUX && "sem tmux nesta máquina") || (!CHROME && "sem Chrome nesta máquina") };

let atual = [];
afterEach(async () => {
  for (const { b, caixa, sock, nav } of atual) {
    nav?.fechar?.(); await b?.fim();
    try { execFileSync(TMUX, ["-L", sock, "kill-server"], { stdio: "ignore" }); } catch { /* já saiu */ }
    limparCaixa(caixa);
  }
  atual = [];
});

const SESSAO = `printf '\\033[31mPermitir?\\033[0m \\033[1;38;5;82m1. Sim\\033[0m 2. Não <b>x</b>\\n'; trap 'echo pegou-ctrl-c' INT; while true; do read -e -r l && echo "recebi:$l"; done`;

async function preparar({ foraDoTmux = false } = {}) {
  const caixa = criarCaixa();
  const sock = "bt" + process.pid + "-" + Math.random().toString(36).slice(2, 7);
  const t = (...a) => execFileSync(TMUX, ["-L", sock, ...a], { encoding: "utf8" }).trim();
  // O bash 5.1+ (Ubuntu) liga o "bracketed paste" no readline: a colagem ficava parada na linha até um Enter e o teste
  // não via "recebi:linha a/b" (falha só no Atena, 28/10). A sessão falsa lê linha a linha, como o bash do Mac.
  const inputrc = join(caixa.home, ".inputrc-sessao"); writeFileSync(inputrc, "set enable-bracketed-paste off\n");
  t("new-session", "-d", "-s", "erp", "-x", "100", "-y", "20", "-e", `INPUTRC=${inputrc}`, "bash", "--norc", "-c", SESSAO);
  const pid = Number(t("display-message", "-p", "-t", "erp", "#{pane_pid}"));
  const dir = join(caixa.home, ".claude", "sessions"); mkdirSync(dir, { recursive: true });
  const reg = (p, extra) => writeFileSync(join(dir, `${p}.json`), JSON.stringify({ pid: p, sessionId: "sess-" + p, cwd: "/x/DEV/ERP", entrypoint: "cli", kind: "interactive", name: "erp", status: "idle", ...extra }));
  reg(pid);
  // A sessão de fora do tmux é o próprio processo do teste (vivo, sem painel); a do board (`claude -p`) não entra.
  if (foraDoTmux) reg(process.pid, { name: "crm", cwd: "/x/DEV/crm", sessionId: "c-r-m" });
  writeFileSync(join(dir, "1.json"), JSON.stringify({ pid: 1, sessionId: "board", entrypoint: "sdk-cli", cwd: "/" }));
  const b = await subirBoard(caixa, { BOARD_TMUX: TMUX, BOARD_TMUX_SOCKET: sock, BOARD_SESSOES_INTERVALO_MS: "150" });
  const ctx = { b, caixa, sock, pid, t };
  atual.push(ctx);
  return ctx;
}
const teclas = (b, pid, corpo, headers = { origin: b.url }) =>
  fetch(`${b.url}/api/sessoes/${pid}/teclas`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(corpo) })
    .then(async (r) => ({ status: r.status, json: await r.json() }));
async function esperarTela(b, pid, re) {
  let html = "";
  for (let i = 0; i < 50; i++) { html = (await b.api("GET", `/api/sessoes/${pid}/tela`)).json?.html || ""; if (re.test(html)) return html; await esperar(100); }
  throw new Error(`a tela não mostrou ${re}:\n${html}`);
}

test("ANSI vira HTML: cores básicas, 256, RGB, negrito, inverso; texto escapado; outras sequências descartadas", async () => {
  // Num processo à parte, de uma caixa: o módulo importa o estado, que tem o lock de um board por quadro (o do dono pode
  // estar no ar) e timers que deixariam este processo de teste vivo para sempre.
  const caixa = criarCaixa(); atual.push({ caixa, sock: "nenhum" });
  const casos = ["\x1b[31mvermelho\x1b[0m normal", "\x1b[1;38;5;82mverde\x1b[22m", "\x1b[38;2;10;20;30;48;5;232mrgb", "\x1b[38:2::1:2:3mx",
    "\x1b[7minv\x1b[27m", "<script>alert(1)</script> & \"'", "\x1b]0;título\x07a\x1b[2Kb\x1b(Bc\x07\x1b[?25ld\n", "\x1b[4:0mnada\x1b[4:3mx\x1b[0m", "\x1b[4;9msub\x1b[0m"];
  const saida = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e",
    `const m = await import(${JSON.stringify(join(caixa.board, "servidor", "sessoes.mjs"))}); console.log(JSON.stringify(JSON.parse(process.argv[1]).map(m.ansiParaHtml))); process.exit(0);`,
    JSON.stringify(casos)], { encoding: "utf8", env: { ...process.env, HOME: caixa.home } }).trim().split("\n").pop());
  const html = Object.fromEntries(casos.map((c, i) => [c, saida[i]]));
  const ansiParaHtml = (t) => html[t];
  assert.equal(ansiParaHtml("\x1b[31mvermelho\x1b[0m normal"), '<span style="color:#e5534b">vermelho</span> normal');
  assert.equal(ansiParaHtml("\x1b[1;38;5;82mverde\x1b[22m"), '<span style="color:#5fff00;font-weight:700">verde</span>');
  assert.equal(ansiParaHtml("\x1b[38;2;10;20;30;48;5;232mrgb"), '<span style="color:#0a141e;background:#080808">rgb</span>');
  assert.equal(ansiParaHtml("\x1b[38:2::1:2:3mx"), '<span style="color:#010203">x</span>', "cor com ':' (o tmux manda assim)");
  assert.equal(ansiParaHtml("\x1b[7minv\x1b[27m"), '<span style="color:#0c0f0e;background:#d7dad8">inv</span>');
  assert.equal(ansiParaHtml("<script>alert(1)</script> & \"'"), "&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;&#39;");
  assert.equal(ansiParaHtml("\x1b]0;título\x07a\x1b[2Kb\x1b(Bc\x07\x1b[?25ld\n"), "abcd\n", "OSC, cursor, charset e BEL não aparecem");
  assert.equal(ansiParaHtml("\x1b[4:0mnada\x1b[4:3mx\x1b[0m"), 'nada<span style="text-decoration:underline">x</span>');
  assert.equal(ansiParaHtml("\x1b[4;9msub\x1b[0m"), '<span style="text-decoration:underline line-through">sub</span>');
});

test("lista as sessões do registro com o painel do tmux; a de fora ganha o comando para reabrir com a mesma conversa", SEM_TMUX, async () => {
  const { b, pid } = await preparar({ foraDoTmux: true });
  const d = (await b.api("GET", "/api/sessoes")).json;
  assert.equal(d.tmuxNoAr, true);
  assert.deepEqual(d.sessoes.map((s) => [s.nome, !!s.tmux]), [["erp", true], ["crm", false]], "o claude -p do board (entrypoint sdk-cli) fica de fora");
  const [erp, crm] = d.sessoes;
  assert.equal(erp.pid, pid); assert.equal(erp.tmux.sessao, "erp"); assert.equal(erp.pasta, "ERP"); assert.equal(erp.reabrir, undefined);
  assert.match(crm.reabrir, /^tmux -L \S+ new-session -A -s crm -c \/x\/DEV\/crm claude --resume c-r-m --name crm$/);
});

test("a tela do painel com as cores, e as teclas: texto + Enter, o 2 da permissão, Ctrl+C, setas e colagem de várias linhas", SEM_TMUX, async () => {
  const { b, caixa, pid } = await preparar();
  const html = await esperarTela(b, pid, /Permitir/);
  assert.match(html, /<span style="color:#e5534b">Permitir\?<\/span>/);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/, "o texto do terminal nunca vira HTML");

  let r = await teclas(b, pid, { texto: "2", enter: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.enviado, ["texto (1 caractere)", "Enter"]);
  await esperarTela(b, pid, /recebi:2/);
  assert.equal((await teclas(b, pid, { teclas: ["C-c"] })).status, 200);
  await esperarTela(b, pid, /pegou-ctrl-c/);
  assert.equal((await teclas(b, pid, { texto: "segredo123", teclas: ["Left", "BSpace"], enter: true })).status, 200);
  await esperarTela(b, pid, /recebi:segredo13/);
  assert.equal((await teclas(b, pid, { texto: "linha a\nlinha b\n" })).status, 200);
  await esperarTela(b, pid, /recebi:linha a[\s\S]*recebi:linha b/);

  // O registro diz quem mandou o quê, mas nunca o TEXTO (pode ser senha).
  const log = readFileSync(join(caixa.board, "data", "logs", "sessoes.jsonl"), "utf8");
  assert.match(log, /"texto":"texto \(10 caracteres\) \+ ← \+ ⌫ \+ Enter"/);
  assert.doesNotMatch(log, /segredo/);
});

test("travas: tecla só pela tela (Origin), outra página não lê nem escreve, Host de fora recusado, só sessão do registro, só tecla conhecida", SEM_TMUX, async () => {
  const { b, pid, t } = await preparar({ foraDoTmux: true });
  await esperarTela(b, pid, /Permitir/);
  assert.equal((await teclas(b, pid, { texto: "1", enter: true }, {})).status, 403, "sem Origin (CLI, curl de agente)");
  assert.equal((await teclas(b, pid, { texto: "1", enter: true }, { origin: "http://mal.example" })).status, 403);
  const ler = await fetch(`${b.url}/api/sessoes/${pid}/tela`, { headers: { origin: "http://mal.example" } });
  assert.equal(ler.status, 403, "página de outro site não lê a tela");
  // DNS rebinding: um nome de fora apontando para 127.0.0.1 chega com outro Host.
  const host = await new Promise((ok) => request({ host: "127.0.0.1", port: b.porta, path: "/api/sessoes", headers: { host: "mal.example:" + b.porta } }, (res) => ok(res.statusCode)).end());
  assert.equal(host, 403);
  assert.equal((await teclas(b, pid, { teclas: ["C-d"] })).status, 400, "tecla fora da lista");
  assert.equal((await teclas(b, pid, { texto: "a\x1b[A" })).status, 400, "controle escondido no texto");
  assert.equal((await teclas(b, 999999, { texto: "x" })).status, 404, "pid que não é sessão do registro");
  const fora = await teclas(b, process.pid, { texto: "x" });
  assert.equal(fora.status, 409); assert.match(fora.json.reabrir, /claude --resume c-r-m/);
  // Um painel de OUTRO programa no mesmo tmux não é sessão: não aparece e não recebe nada.
  t("new-window", "-d", "-t", "erp", "bash", "--norc", "-c", "while read -r l; do echo outro:$l; done");
  assert.equal((await b.api("GET", "/api/sessoes?fresco")).json.sessoes.length, 2);
  assert.doesNotMatch(await esperarTela(b, pid, /Permitir/), /recebi:1/, "nada do que foi recusado chegou");
});

test("tela: aba por sessão, terminal ao vivo com cores, botões de tecla, caixa de texto, digitar no terminal e o comando de reabrir", SEM_TELA, async () => {
  const ctx = await preparar({ foraDoTmux: true });
  const { b, pid } = ctx;
  const nav = ctx.nav = await abrirNavegador();
  await nav.carregar(b.url + "/#/sessoes");
  const espera = async (expr, oque) => { for (let i = 0; i < 60; i++) { if (await nav.avaliar(expr)) return; await esperar(150); } throw new Error("a tela não mostrou: " + oque + "\n" + await nav.avaliar(`document.querySelector('#sesLista')?.innerText`)); };
  await espera(`[...document.querySelectorAll('.ses-aba')].map(a => a.innerText).join('|').includes('erp')`, "a aba erp");
  assert.match(await nav.avaliar(`document.querySelector('.nav-item.active')?.getAttribute('aria-label')`), /Sessões/);
  await espera(`!!document.querySelector('#sesTerm span[style*="#e5534b"]')`, "o terminal com a cor vermelha");

  await nav.avaliar(`document.querySelector('[data-texto="2"]').click()`);
  await nav.avaliar(`document.querySelector('[data-tecla="Enter"]').click()`);
  await espera(`document.querySelector('#sesTerm').innerText.includes('recebi:2')`, "o 2 + Enter chegando à sessão");

  await nav.avaliar(`document.querySelector('#sesTexto').value = 'pela caixa'; document.querySelector('#sesForm').requestSubmit()`);
  await espera(`document.querySelector('#sesTerm').innerText.includes('recebi:pela caixa')`, "o texto da caixa com Enter");
  assert.equal(await nav.avaliar(`document.querySelector('#sesTexto').value`), "", "enviou, a caixa esvazia");

  await nav.avaliar(`(() => { const t = document.querySelector('#sesTerm'); t.focus(); for (const k of ['o','k','Enter']) t.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); })()`);
  await espera(`document.querySelector('#sesTerm').innerText.includes('recebi:ok')`, "a tecla digitada no terminal");

  await nav.avaliar(`[...document.querySelectorAll('.ses-aba')].find(a => a.innerText.includes('crm')).click()`);
  await espera(`!!document.querySelector('.ses-cmd')`, "o comando de reabrir");
  assert.match(await nav.avaliar(`document.querySelector('.ses-cmd').textContent`), /claude --resume c-r-m/);
  assert.equal(await nav.avaliar(`!!document.querySelector('[data-tmux]')`), true, "e o botão de abrir no tmux");
  assert.equal(await nav.avaliar(`!!document.querySelector('#sesTerm')`), false, "fora do tmux não há terminal nem teclas");
  assert.deepEqual(nav.erros, []);
  void pid;
});

// ── #234: Trazer para cá e Nova sessão, sem janela ─────────────────────────────
// O "claude" das sessões é um script que faz o que o real faz ao abrir: grava o registro ($HOME/.claude/sessions/<pid>.json,
// com a conversa do --resume e o --name) e fica esperando o que se digita. Anota os argumentos e o PATH com que nasceu.
const CLAUDE_SESSAO = `#!/bin/bash
sid="novo-$$"; nome=""; a=("$@")
for ((i=0;i<\${#a[@]};i++)); do case "\${a[$i]}" in --resume) sid="\${a[$((i+1))]}";; --name) nome="\${a[$((i+1))]}";; esac; done
[ -f "$HOME/atraso" ] && sleep "$(cat "$HOME/atraso")" # o claude real também leva um tempo para aparecer no registro
mkdir -p "$HOME/.claude/sessions"
printf '{"pid":%s,"sessionId":"%s","cwd":"%s","entrypoint":"cli","kind":"interactive","name":"%s","status":"idle"}' $$ "$sid" "$PWD" "$nome" > "$HOME/.claude/sessions/$$.json"
echo "args:$* path-ok:$([[ ":$PATH:" == *":/opt/homebrew/bin:"* ]] && echo sim)" >> "$HOME/claude-sessoes.log"
echo "claude falso: conversa $sid"
trap 'rm -f "$HOME/.claude/sessions/$$.json"' EXIT
while read -r l; do echo "recebi:$l"; done
`;
async function prepararAbrir({ fora } = {}) {
  const caixa = criarCaixa();
  const sock = "bt" + process.pid + "-" + Math.random().toString(36).slice(2, 7);
  const t = (...a) => execFileSync(TMUX, ["-L", sock, ...a], { encoding: "utf8" }).trim();
  const bin = join(caixa.raiz, "claude-sessao"); writeFileSync(bin, CLAUDE_SESSAO, { mode: 0o755 });
  for (const p of ["ERP", "crm"]) mkdirSync(join(caixa.dev, p, ".git"), { recursive: true });
  writeFileSync(join(caixa.board, "data", "projetos.json"), JSON.stringify({ visiveis: ["ERP", "crm"], rotulos: { crm: "CRM" } }));
  const dir = join(caixa.home, ".claude", "sessions"); mkdirSync(dir, { recursive: true });
  let filho = null;
  if (fora) { // uma sessão "fora do tmux": um processo vivo de verdade, que o teste pode encerrar (/exit = o registro some)
    filho = (await import("node:child_process")).spawn("sleep", ["300"], { stdio: "ignore" });
    writeFileSync(join(dir, `${filho.pid}.json`), JSON.stringify({ pid: filho.pid, sessionId: "conversa-crm", cwd: join(caixa.dev, "crm"), entrypoint: "cli", name: "crm", status: "idle" }));
  }
  const b = await subirBoard(caixa, { BOARD_TMUX: TMUX, BOARD_TMUX_SOCKET: sock, BOARD_SESSOES_CLAUDE: bin, BOARD_SESSOES_INTERVALO_MS: "150" });
  const ctx = { b, caixa, sock, t, filho, dir, nav: { fechar: () => filho?.kill() } };
  atual.push(ctx);
  return ctx;
}
const post = (b, rota, corpo, headers = { origin: b.url }) =>
  fetch(b.url + rota, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(corpo || {}) })
    .then(async (r) => ({ status: r.status, json: await r.json() }));

test("abrir no tmux: com a cópia de fora viva, recusa sem tocar nela; depois do /exit, reabre no tmux com a mesma conversa", SEM_TMUX, async () => {
  const { b, caixa, t, filho, dir } = await prepararAbrir({ fora: true });
  let d = (await b.api("GET", "/api/sessoes?fresco")).json;
  assert.deepEqual(d.sessoes.map((s) => [s.nome, !!s.tmux, s.projeto?.slug]), [["crm", false, "crm"]]);
  const pedir = (corpo, h) => post(b, "/api/sessoes/tmux", corpo, h);
  assert.equal((await pedir({ sessionId: "conversa-crm" }, {})).status, 403, "sem Origin da tela (CLI, curl de agente)");
  assert.equal((await pedir({ sessionId: "conversa-crm" }, { origin: "http://mal.example" })).status, 403);
  assert.equal((await pedir({ sessionId: "nunca-vi-esta" })).status, 404, "só sessão que o board viu no registro");
  const viva = await pedir({ sessionId: "conversa-crm" });
  assert.equal(viva.status, 409); assert.equal(viva.json.viva, filho.pid); assert.match(viva.json.error, /\/exit/);
  assert.equal(filho.exitCode, null, "o board nunca mata a sessão de fora"); assert.equal(filho.signalCode, null);
  assert.throws(() => t("has-session", "-t", "=crm"), "e não abriu nada no tmux");

  // O dono dá /exit: o processo sai e o CLI apaga o registro. O board lembra dela entre as que saíram.
  filho.kill(); await new Promise((ok) => filho.once("exit", ok)); rmSync(join(dir, `${filho.pid}.json`));
  d = (await b.api("GET", "/api/sessoes?fresco")).json;
  assert.equal(d.sessoes.length, 0);
  assert.deepEqual(d.encerradas.map((s) => [s.nome, s.sessionId]), [["crm", "conversa-crm"]]);
  assert.match(d.encerradas[0].reabrir, /claude --resume conversa-crm/);
  const r = await pedir({ sessionId: "conversa-crm" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.tmux, "crm"); assert.ok(r.json.pid > 0);
  assert.match(readFileSync(join(caixa.home, "claude-sessoes.log"), "utf8"), /args:--resume conversa-crm --name crm path-ok:sim/);
  assert.equal(t("display-message", "-p", "-t", "crm", "#{pane_current_path}"), join(caixa.dev, "crm"));
  d = (await b.api("GET", "/api/sessoes?fresco")).json;
  assert.deepEqual(d.sessoes.map((s) => [s.nome, s.tmux?.sessao]), [["crm", "crm"]], "agora está no tmux");
  assert.equal(d.encerradas.length, 0, "e saiu das que saíram");
  // E o board lê e escreve nela como na #233 — sem cliente do tmux ligado (nenhuma janela).
  assert.equal(t("list-clients"), "");
  await esperarTela(b, r.json.pid, /conversa conversa-crm/);
  assert.equal((await teclas(b, r.json.pid, { texto: "oi", enter: true })).status, 200);
  await esperarTela(b, r.json.pid, /recebi:oi/);
  const log = readFileSync(join(caixa.board, "data", "logs", "sessoes.jsonl"), "utf8");
  assert.match(log, /"t":"recusou","modo":"tmux"/);
  assert.match(log, /"t":"abriu","modo":"tmux","sessao":"crm","tmux":"crm".*"quem":"dono \(tela\)"/);
});

test("abrir no tmux: sessão que já virou o fio de uma Conversa não abre uma 2ª cópia", SEM_TMUX, async () => {
  const { b, caixa, filho, dir } = await prepararAbrir({ fora: true });
  await b.api("GET", "/api/sessoes?fresco");
  filho.kill(); await new Promise((ok) => filho.once("exit", ok)); rmSync(join(dir, `${filho.pid}.json`));
  const tdir = join(caixa.home, ".claude", "projects", "-x"); mkdirSync(tdir, { recursive: true });
  writeFileSync(join(tdir, "conversa-crm.jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: "oi" } }) + "\n");
  assert.equal((await post(b, "/api/sessoes/trazer", { sessionId: "conversa-crm", porVisivel: true })).status, 200);
  const r = await post(b, "/api/sessoes/tmux", { sessionId: "conversa-crm" });
  assert.equal(r.status, 409); assert.equal(r.json.conversa, "#/c/crm");
});

test("abrir no tmux: dois pedidos seguidos (duas abas) abrem UMA cópia só; e o trazer para a Conversa recusa enquanto ela está no tmux", SEM_TMUX, async () => {
  const { b, caixa, t, filho, dir } = await prepararAbrir({ fora: true });
  await b.api("GET", "/api/sessoes?fresco");
  filho.kill(); await new Promise((ok) => filho.once("exit", ok)); rmSync(join(dir, `${filho.pid}.json`));
  writeFileSync(join(caixa.home, "atraso"), "1.5");
  const um = post(b, "/api/sessoes/tmux", { sessionId: "conversa-crm" });
  await esperar(300);
  const dois = await post(b, "/api/sessoes/tmux", { sessionId: "conversa-crm" });
  assert.equal(dois.status, 409, "o 2º pedido chega com o 1º ainda abrindo: " + JSON.stringify(dois.json));
  assert.equal(dois.json.abrindo, true);
  const conv = await post(b, "/api/sessoes/trazer", { sessionId: "conversa-crm", porVisivel: true });
  assert.equal(conv.status, 409, "nem para a Conversa enquanto abre no tmux");
  const r1 = await um;
  assert.equal(r1.status, 200, JSON.stringify(r1.json));
  assert.equal(t("list-sessions", "-F", "#{session_name}"), "crm", "uma sessão do tmux só, sem crm-2");
  const tres = await post(b, "/api/sessoes/tmux", { sessionId: "conversa-crm" });
  assert.equal(tres.status, 409, "aberta e registrada: continua recusando");
  assert.equal((await post(b, "/api/sessoes/trazer", { sessionId: "conversa-crm", porVisivel: true })).status, 409);
  assert.equal(readFileSync(join(caixa.home, "claude-sessoes.log"), "utf8").trim().split("\n").length, 1, "o claude abriu uma vez só");
});

test("nova sessão: só projeto da seleção, só pela tela, nome livre no tmux, --name; e a sessão segue viva com o board fora", SEM_TMUX, async () => {
  const { b, caixa, t } = await prepararAbrir();
  assert.deepEqual((await b.api("GET", "/api/sessoes/projetos")).json.projetos, [{ slug: "ERP", label: "ERP" }, { slug: "crm", label: "CRM" }]);
  assert.equal((await post(b, "/api/sessoes/nova", { projeto: "crm" }, {})).status, 403);
  assert.equal((await post(b, "/api/sessoes/nova", { projeto: "crm" }, { origin: "http://mal.example" })).status, 403);
  assert.equal((await post(b, "/api/sessoes/nova", { projeto: "../../etc" })).status, 400, "fora da seleção");
  const a = await post(b, "/api/sessoes/nova", { projeto: "crm" });
  assert.equal(a.status, 200, JSON.stringify(a.json)); assert.equal(a.json.tmux, "crm");
  const c = await post(b, "/api/sessoes/nova", { projeto: "crm" });
  assert.equal(c.json.tmux, "crm-2", "nome já usado no tmux ganha sufixo");
  assert.match(readFileSync(join(caixa.home, "claude-sessoes.log"), "utf8"), /^args:--name crm path-ok:sim\nargs:--name crm-2 path-ok:sim$/m);
  const d = (await b.api("GET", "/api/sessoes?fresco")).json;
  assert.deepEqual(d.sessoes.map((s) => s.nome).sort(), ["crm", "crm-2"]);
  await b.fim(); atual.find((x) => x.b === b).b = null;
  assert.match(t("list-sessions", "-F", "#{session_name}"), /^crm\ncrm-2$/, "o board saiu e as sessões continuam no servidor do tmux");
});

test("tela: ＋ Nova sessão abre e passa para a aba dela; ⇱ Abrir no tmux avisa do /exit com a de fora viva", SEM_TELA, async () => {
  const ctx = await prepararAbrir({ fora: true });
  const { b, filho } = ctx;
  const nav = await abrirNavegador(); const fechar = ctx.nav.fechar; ctx.nav = { fechar: () => { nav.fechar(); fechar(); } };
  await nav.carregar(b.url + "/#/sessoes");
  const espera = async (expr, oque) => { for (let i = 0; i < 80; i++) { if (await nav.avaliar(expr)) return; await esperar(150); } throw new Error("a tela não mostrou: " + oque + "\n" + await nav.avaliar(`document.querySelector('#sesLista')?.innerText`)); };
  await espera(`!!document.querySelector('[data-tmux]') && !!document.querySelector('[data-trazer]')`, "os dois caminhos de volta");
  await nav.avaliar(`document.querySelector('[data-tmux]').click()`);
  await espera(`[...document.querySelectorAll('.toast')].some(t => t.innerText.includes('/exit'))`, "o aviso do /exit");
  assert.equal(filho.exitCode, null);
  await nav.avaliar(`document.querySelector('#sesNovaProj').value = 'ERP'; document.querySelector('#sesNova').requestSubmit()`);
  await espera(`document.querySelector('.ses-aba.on')?.innerText.includes('erp') && document.querySelector('#sesTerm')?.innerText.includes('conversa novo-')`, "a aba da sessão nova com o terminal");
  assert.deepEqual(nav.erros, []);
});
