// 🖥 ver no tmux → Ghostty (#352): a sessão do tmux numa janela do Ghostty do Mac, pelo clique do dono.
// Tmux DE VERDADE num servidor próprio (-L); o `open` do macOS é FALSO (anota os argumentos: nenhum Ghostty abre), e o
// `ssh` falso roda o comando aqui mesmo (o "servidor" é esta máquina). O "Mac" é forçado por BOARD_GHOSTTY_APP.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { criarCaixa, subirBoard, limparCaixa, esperar } from "./ajuda.mjs";
import { abrirNavegador, CHROME } from "./navegador.mjs";

const TMUX = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].find((p) => existsSync(p));
const SEM_TMUX = { skip: !TMUX && "sem tmux nesta máquina" };
const SEM_TELA = { skip: (!TMUX && "sem tmux nesta máquina") || (!CHROME && "sem Chrome nesta máquina") };

let atual = [];
afterEach(async () => {
  for (const { b, caixa, sock, nav } of atual) {
    await nav?.fechar?.(); await b?.fim();
    try { execFileSync(TMUX, ["-L", sock, "kill-server"], { stdio: "ignore" }); } catch { /* já saiu */ }
    limparCaixa(caixa);
  }
  atual = [];
});

async function preparar(env = {}) {
  const caixa = criarCaixa();
  const sock = "gh" + process.pid + "-" + Math.random().toString(36).slice(2, 7);
  const t = (...a) => execFileSync(TMUX, ["-L", sock, ...a], { encoding: "utf8" }).trim();
  t("new-session", "-d", "-s", "robo", "-x", "80", "-y", "20", "sh", "-c", "while true; do sleep 1; done");
  t("new-session", "-d", "-s", "a b", "sh", "-c", "while true; do sleep 1; done"); // nome fora do formato: nunca vira comando
  const pid = Number(t("display-message", "-p", "-t", "=robo:", "#{pane_pid}"));
  const dir = join(caixa.home, ".claude", "sessions"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId: "s-robo", cwd: "/x/DEV/atendimento", entrypoint: "cli", name: "robo", status: "idle" }));
  const log = join(caixa.home, "open.log");
  const escreve = (nome, txt) => { writeFileSync(join(caixa.bin, nome), txt); chmodSync(join(caixa.bin, nome), 0o755); };
  escreve("open-falso", `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${log}"\n`);
  escreve("ssh", `#!/bin/sh\nfor a; do last="$a"; done\necho "$*" >> "$HOME/ssh.log"\nPATH="${dirname(TMUX)}:$PATH" exec sh -c "$last"\n`);
  // O board do Mac falso: o que o `curl` do Atena recebe de /api/ghostty?so-modo ($HOME/mac-resposta: "<código> <corpo>";
  // sem o arquivo, um Mac pronto). Anota cada pergunta, com os argumentos (o --resolve pelo IP da tailnet).
  escreve("curl-mac", `#!/bin/sh\necho "$*" >> "$HOME/curl-mac.log"\nr="200 {\\"modo\\":\\"abrir\\"}"\n[ -f "$HOME/mac-resposta" ] && r="$(cat "$HOME/mac-resposta")"\n[ "$r" = "fora" ] && exit 7\nprintf '%s\\n%s' "\${r#* }" "\${r%% *}"\n`);
  escreve("tailscale-mac", `#!/bin/sh\necho '{"Peer":{"x":{"DNSName":"mac.exemplo.ts.net.","TailscaleIPs":["100.64.0.9"]}}}'\n`);
  if (env.macResposta) writeFileSync(join(caixa.home, "mac-resposta"), env.macResposta);
  delete env.macResposta;
  const b = await subirBoard(caixa, { BOARD_TMUX: TMUX, BOARD_TMUX_SOCKET: sock, BOARD_GHOSTTY_OPEN: join(caixa.bin, "open-falso"),
    BOARD_GHOSTTY_CURL: join(caixa.bin, "curl-mac"), BOARD_GHOSTTY_TAILSCALE: join(caixa.bin, "tailscale-mac"), BOARD_GHOSTTY_MAC_CACHE_MS: "0", ...env });
  const ctx = { b, caixa, sock, pid, t, abriu: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : null) };
  atual.push(ctx);
  return ctx;
}
const post = (b, rota, corpo, headers = { origin: b.url }) =>
  fetch(b.url + rota, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(corpo) }).then(async (r) => ({ status: r.status, json: await r.json() }));

test("no Mac: o botão abre o Ghostty já em tmux attach da sessão do registro; só pela tela, só nome do registro", SEM_TMUX, async () => {
  const { b, pid, sock, abriu } = await preparar({ BOARD_GHOSTTY_APP: "/Applications/Ghostty.app", BOARD_SERVIDOR: "atena" });
  const s = (await b.api("GET", "/api/sessoes")).json.sessoes.find((x) => x.pid === pid);
  assert.deepEqual(s.ghostty, { modo: "abrir", sessao: "robo", comando: `tmux -L ${sock} attach -t =robo` });

  assert.equal((await post(b, "/api/ghostty/abrir", { pid }, {})).status, 403, "sem Origin (CLI, agente)");
  assert.equal((await post(b, "/api/ghostty/abrir", { pid }, { origin: "http://mal.example" })).status, 403, "outra página");
  assert.equal((await post(b, "/api/ghostty/abrir", { pid: 1 })).status, 404, "pid fora do registro");
  assert.equal(abriu(), null, "nada abriu até aqui");

  const r = await post(b, "/api/ghostty/abrir", { pid });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(abriu(), ["-na", "/Applications/Ghostty.app", "--args", `--initial-command=tmux -L ${sock} attach -t =robo`]);

  // As sessões do tmux do SERVIDOR (lidas por ssh agora): a do endereço só escolhe, quem decide é a lista.
  const d = (await b.api("GET", "/api/ghostty")).json;
  assert.equal(d.modo, "abrir"); assert.equal(d.servidor, "atena");
  assert.deepEqual(d.sessoes.map((x) => x.nome), ["robo"], "\"a b\" (fora do formato) não aparece");
  assert.equal(d.sessoes[0].comando, `ssh -t atena tmux -L ${sock} attach -t =robo`);
  for (const nome of ["a b", "robo; touch /tmp/x", "rob", "=robo"]) assert.equal((await post(b, "/api/ghostty/abrir", { servidor: nome })).status, 404, nome);
  assert.equal((await post(b, "/api/ghostty/abrir", { servidor: "robo" })).status, 200);
  assert.deepEqual(abriu().slice(3), [`--initial-command=ssh -t atena tmux -L ${sock} attach -t =robo`]);
  const reg = readFileSync(join(atual[0].caixa.board, "data", "logs", "sessoes.jsonl"), "utf8");
  assert.equal((reg.match(/"t":"ghostty"/g) || []).length, 2, "cada abertura fica no registro");
});

test("no servidor (Atena): o botão leva ao board do Mac com a sessão; sem o Mac, copia o comando; nunca abre nada aqui", SEM_TMUX, async () => {
  const { b, pid, sock, abriu } = await preparar({ BOARD_SERVIDOR: "local", BOARD_GHOSTTY_MAC: "https://mac.exemplo.ts.net", BOARD_GHOSTTY_SSH: "atena" });
  const s = (await b.api("GET", "/api/sessoes")).json.sessoes.find((x) => x.pid === pid);
  assert.deepEqual(s.ghostty, { modo: "mac", sessao: "robo", comando: `ssh -t atena tmux -L ${sock} attach -t =robo`, url: "https://mac.exemplo.ts.net/#/ghostty/robo" });
  const c = (await b.api("GET", "/api/central/sessoes")).json.sessoes.find((x) => x.pid === pid);
  assert.equal(c.ghostty?.url, s.ghostty.url, "a coluna da Central leva o mesmo botão");
  const r = await post(b, "/api/ghostty/abrir", { pid });
  assert.equal(r.status, 200); assert.equal(r.json.modo, "mac");
  assert.equal((await post(b, "/api/ghostty/abrir", { servidor: "robo" })).status, 409, "o board do servidor não abre Ghostty");
  assert.equal(abriu(), null);
  await b.fim();
  const b2 = atual[0].b = await subirBoard(atual[0].caixa, { BOARD_TMUX: TMUX, BOARD_TMUX_SOCKET: sock, BOARD_SERVIDOR: "local", BOARD_GHOSTTY_SSH: "atena" });
  assert.equal((await b2.api("GET", "/api/sessoes")).json.sessoes.find((x) => x.pid === pid).ghostty.modo, "copiar");
});

test("tela: botão no menu Sessões (com a dica Ctrl+B D) e na Central levando ao Mac; no Mac, #/ghostty/<sessão> abre pelo clique", SEM_TELA, async () => {
  const ctx = await preparar({ BOARD_SERVIDOR: "local", BOARD_GHOSTTY_MAC: "https://mac.exemplo.ts.net", BOARD_GHOSTTY_SSH: "atena" });
  const nav = ctx.nav = await abrirNavegador();
  const espera = async (expr, oque) => { for (let i = 0; i < 60; i++) { if (await nav.avaliar(expr)) return; await esperar(150); } throw new Error("a tela não mostrou: " + oque + "\n" + await nav.avaliar(`document.querySelector('#app')?.innerText`)); };
  await nav.carregar(ctx.b.url + "/#/sessoes");
  await espera(`!!document.querySelector('.ses-cab [data-ghostty]')`, "o botão no alto da sessão");
  assert.match(await nav.avaliar(`document.querySelector('.ses-cab').innerText`), /ver no tmux[\s\S]*Ctrl\s*\+\s*B, depois D/);
  await nav.avaliar(`window.__abertas = []; window.open = (u, a, f) => { window.__abertas.push([u, a, f]); return null; }; document.querySelector('.ses-cab [data-ghostty]').click()`);
  await espera(`window.__abertas.length === 1`, "a aba do board do Mac");
  assert.deepEqual(await nav.avaliar(`window.__abertas[0]`), ["https://mac.exemplo.ts.net/#/ghostty/robo", "_blank", "noopener"]);
  await espera(`[...document.querySelectorAll('.toast')].some(t => /board do Mac/.test(t.innerText) && /Ctrl\\+B, depois D/.test(t.innerText))`, "o aviso");
  await nav.carregar(ctx.b.url + "/#/central");
  await espera(`!!document.querySelector('.cl-sessao [data-ghostty]')`, "o botão na coluna da Central");
  assert.equal(ctx.abriu(), null, "o board do servidor nunca roda o open");

  // O "Mac": a página que o board do servidor abriu. Mostra a sessão pedida primeiro, e só o clique abre.
  await ctx.b.fim();
  ctx.b = await subirBoard(ctx.caixa, { BOARD_TMUX: TMUX, BOARD_TMUX_SOCKET: ctx.sock, BOARD_GHOSTTY_OPEN: join(ctx.caixa.bin, "open-falso"), BOARD_GHOSTTY_APP: "/Applications/Ghostty.app", BOARD_SERVIDOR: "atena" });
  await nav.carregar(ctx.b.url + "/#/ghostty/robo");
  await espera(`!!document.querySelector('.gh-linha.on [data-ghostty]')`, "a sessão robo do servidor");
  assert.match(await nav.avaliar(`document.querySelector('#ghLista').innerText`), /ssh -t atena tmux -L \S+ attach -t =robo[\s\S]*Ctrl\+B, depois D/);
  assert.equal(ctx.abriu(), null, "abrir a página não abre nada sozinho");
  await nav.avaliar(`document.querySelector('.gh-linha.on [data-ghostty]').click()`);
  for (let i = 0; i < 40 && !ctx.abriu(); i++) await esperar(100);
  assert.deepEqual(ctx.abriu().slice(3), [`--initial-command=ssh -t atena tmux -L ${ctx.sock} attach -t =robo`]);
  await nav.carregar(ctx.b.url + "/#/ghostty/naoexiste");
  await espera(`/Não há sessão "naoexiste"/.test(document.querySelector('#ghLista')?.innerText || '')`, "o aviso da sessão que não existe");
  assert.deepEqual(nav.erros, [], "sem erro de JS");
});

test("🖥 ver no tmux dos agentes: no Mac com o Ghostty, monta board-agentes e abre o Ghostty nela (sem o Terminal)", SEM_TMUX, async () => {
  const { b, sock, abriu, caixa } = await preparar({ BOARD_GHOSTTY_APP: "/Applications/Ghostty.app", BOARD_AGENTES_TELA: "terminal", BOARD_SERVIDOR: "atena" });
  assert.equal((await post(b, "/api/agentes/tmux", {}, { origin: "http://mal.example" })).status, 403);
  const r = await post(b, "/api/agentes/tmux", {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.modo, "ghostty");
  assert.deepEqual(abriu(), ["-na", "/Applications/Ghostty.app", "--args", `--initial-command=tmux -L ${sock} attach -t =board-agentes`]);
  assert.match(execFileSync(TMUX, ["-L", sock, "list-sessions", "-F", "#{session_name}"], { encoding: "utf8" }), /^board-agentes$/m, "a sessão foi montada antes");
  assert.equal(existsSync(join(caixa.home, "osascript.log")), false, "o Terminal não abriu");
});

test("🖥 ver no tmux dos agentes no Atena: monta a sessão e a tela abre o board do Mac em #/ghostty/board-agentes", SEM_TELA, async () => {
  const ctx = await preparar({ BOARD_SERVIDOR: "local", BOARD_GHOSTTY_MAC: "https://mac.exemplo.ts.net", BOARD_GHOSTTY_SSH: "atena" });
  const r = await post(ctx.b, "/api/agentes/tmux", {});
  assert.equal(r.json.modo, "mac");
  assert.equal(r.json.ghostty.url, "https://mac.exemplo.ts.net/#/ghostty/board-agentes");
  assert.equal(r.json.ghostty.comando, `ssh -t atena tmux -L ${ctx.sock} attach -t =board-agentes`);
  const nav = ctx.nav = await abrirNavegador();
  await nav.carregar(ctx.b.url + "/");
  for (let i = 0; i < 40 && !(await nav.avaliar(`GH.modo === "mac"`)); i++) await esperar(100);
  await nav.avaliar(`window.__aba = { opener: 1, location: { href: "" }, close() { this.fechada = true; } }; window.__chamadas = []; window.open = (...a) => { window.__chamadas.push(a); return window.__aba; }; abrirTmux()`);
  for (let i = 0; i < 60 && !(await nav.avaliar(`window.__aba.location.href`)); i++) await esperar(100);
  assert.deepEqual(await nav.avaliar(`window.__chamadas`), [["", "_blank"]], "a aba nasce no gesto, em branco");
  assert.equal(await nav.avaliar(`window.__aba.location.href`), "https://mac.exemplo.ts.net/#/ghostty/board-agentes");
  assert.equal(await nav.avaliar(`window.__aba.opener`), null);
  assert.equal(ctx.abriu(), null, "o Atena não roda open");
});

test("board do Mac sem condições (código antigo 404, fora do ar, sem Ghostty, 403): o Atena não leva a uma aba vazia, copia e diz por quê", SEM_TMUX, async () => {
  const casos = [["404 {\"error\":\"rota não existe\"}", /código antigo/], ["fora", /não respondeu/], ["200 {\"modo\":\"copiar\"}", /não achou o Ghostty/], ["403 {}", /BOARD_ORIGENS_EXTRAS/]];
  for (const [resposta, motivo] of casos) {
    const ctx = await preparar({ BOARD_SERVIDOR: "local", BOARD_GHOSTTY_MAC: "https://mac.exemplo.ts.net", BOARD_GHOSTTY_SSH: "atena", macResposta: resposta });
    const g = (await ctx.b.api("GET", "/api/ghostty?so-modo")).json;
    assert.equal(g.modo, "copiar", resposta); assert.equal(g.mac.pronto, false); assert.match(g.mac.motivo, motivo);
    const s = (await ctx.b.api("GET", "/api/sessoes")).json.sessoes.find((x) => x.pid === ctx.pid);
    assert.equal(s.ghostty.modo, "copiar"); assert.equal(s.ghostty.url, undefined, "sem aba para um Mac que não serve"); assert.match(s.ghostty.aviso, motivo);
    const r = await post(ctx.b, "/api/agentes/tmux", {});
    assert.equal(r.json.modo, "navegador", "a vista fica aqui"); assert.match(r.json.ghostty.aviso, motivo);
    assert.equal(r.json.ghostty.comando, `ssh -t atena tmux -L ${ctx.sock} attach -t =board-agentes`);
    assert.match(readFileSync(join(ctx.caixa.home, "curl-mac.log"), "utf8"), /--resolve mac\.exemplo\.ts\.net:443:100\.64\.0\.9 https:\/\/mac\.exemplo\.ts\.net\/api\/ghostty\?so-modo/);
    await ctx.b.fim();
  }
  // O Mac ganhou o código: o próximo clique já pergunta de novo e vai pelo Mac.
  const ctx = atual.at(-1); writeFileSync(join(ctx.caixa.home, "mac-resposta"), "200 {\"modo\":\"abrir\"}");
  ctx.b = await subirBoard(ctx.caixa, { BOARD_TMUX: TMUX, BOARD_TMUX_SOCKET: ctx.sock, BOARD_SERVIDOR: "local", BOARD_GHOSTTY_MAC: "https://mac.exemplo.ts.net", BOARD_GHOSTTY_SSH: "atena",
    BOARD_GHOSTTY_CURL: join(ctx.caixa.bin, "curl-mac"), BOARD_GHOSTTY_TAILSCALE: join(ctx.caixa.bin, "tailscale-mac"), BOARD_GHOSTTY_MAC_CACHE_MS: "0" });
  assert.equal((await post(ctx.b, "/api/agentes/tmux", {})).json.modo, "mac");
});

test("tela, Mac com código antigo: o 🖥 da faixa não abre aba nenhuma, copia o comando e mostra o motivo", SEM_TELA, async () => {
  const ctx = await preparar({ BOARD_SERVIDOR: "local", BOARD_GHOSTTY_MAC: "https://mac.exemplo.ts.net", BOARD_GHOSTTY_SSH: "atena", macResposta: "404 {}" });
  const nav = ctx.nav = await abrirNavegador();
  await nav.carregar(ctx.b.url + "/");
  for (let i = 0; i < 40 && !(await nav.avaliar(`GH.modo === "copiar"`)); i++) await esperar(100);
  await nav.avaliar(`window.__chamadas = []; window.open = (...a) => { window.__chamadas.push(a); return null; }; window.__copiado = null; navigator.clipboard.writeText = async (t) => { window.__copiado = t; }; abrirTmux()`);
  for (let i = 0; i < 60 && !(await nav.avaliar(`location.hash === "#/agentes"`)); i++) await esperar(100);
  assert.deepEqual(await nav.avaliar(`window.__chamadas`), [], "nenhuma aba para o Mac");
  assert.equal(await nav.avaliar(`window.__copiado`), `ssh -t atena tmux -L ${ctx.sock} attach -t =board-agentes`);
  assert.match(await nav.avaliar(`[...document.querySelectorAll('.toast')].map(t => t.innerText).join(' | ')`), /código antigo/);
});
