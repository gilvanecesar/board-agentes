// 🖥 Sessões (#233, 28/10/2026 — pedido do dono: "cria um terminal pra cada sessão"): a tela CRUA do terminal de cada
// sessão do Claude aberta na máquina (erp, crm, board…), ao vivo, com uma caixa para mandar teclas — inclusive o 1/2/3 dos
// pedidos de permissão. Sem dependência: a sessão roda dentro do tmux, o board lê o painel (`capture-pane -e`, cores ANSI
// viram HTML) e escreve nele (`send-keys`). Sessão fora do tmux (ex.: no herdr) o board TRAZ para o tmux, sem janela,
// preservando a conversa (`claude --resume`), depois que a cópia de fora sai; e abre sessão nova por projeto (#234). Diferente da #232 (o pedido de permissão como CARTÃO): aqui é o terminal inteiro.
import { execFile, execFileSync } from "child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { delimiter, dirname, join } from "path";
import { logEvent } from "./estado.mjs";
import { esquecerEncerradas, lembrarSessoes, pastaNaTela, projetoDaPasta, sessoesParaConversa, trazerParaConversa } from "./sessoes-conversa.mjs";
import { projetosVisiveis, slugDoNome } from "./projetos.mjs";
import { daTela as daTelaDoBoard, hostDaMaquina } from "./origem.mjs";
import { ghosttyDe } from "./ghostty.mjs";

export const LOG_SESSOES = "sessoes";
const SESSOES_DIR = () => join(process.env.HOME || "", ".claude", "sessions");
const HISTORICO = () => Math.max(0, Math.min(Number(process.env.BOARD_SESSOES_HISTORICO ?? 300), 5000)); // linhas acima da tela
const INTERVALO = () => Math.max(100, Number(process.env.BOARD_SESSOES_INTERVALO_MS || 400)); // a cada quanto relê o painel ao vivo

// ── tmux ─────────────────────────────────────────────────────────────────────
/** O binário: BOARD_TMUX, senão o do PATH, senão os lugares do Homebrew (o launchd não lê o .zshrc). */
export function binTmux() {
  if (process.env.BOARD_TMUX) return process.env.BOARD_TMUX;
  for (const d of String(process.env.PATH || "").split(delimiter)) if (d && existsSync(join(d, "tmux"))) return join(d, "tmux");
  return ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux"].find((p) => existsSync(p)) || "tmux";
}
// BOARD_TMUX_SOCKET = um servidor tmux separado (-L nome): é como os testes usam um tmux próprio sem ver o do dono.
const comSocket = (args) => (process.env.BOARD_TMUX_SOCKET ? ["-L", process.env.BOARD_TMUX_SOCKET, ...args] : args);
function rodar(bin, args, timeout = 4000, env) {
  return new Promise((ok, falha) => execFile(bin, args, { encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024, ...(env ? { env } : {}) }, (e, out, err) => {
    if (e) { e.message = String(err || e.message).trim(); e.stdout = out; return falha(e); }
    ok(out);
  }));
}
export const tmux = (args, timeout, env) => rodar(binTmux(), comSocket(args), timeout, env);

const aspas = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
const nomeTmux = (s) => String(s || "claude").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "") || "claude"; // sem ":" nem "."

/** O comando que reabre a sessão DENTRO do tmux, com a mesma conversa. Antes, a cópia de fora tem de sair (/exit). */
export function comandoReabrir(s) {
  const sock = process.env.BOARD_TMUX_SOCKET ? `-L ${aspas(process.env.BOARD_TMUX_SOCKET)} ` : "";
  return `tmux ${sock}new-session -A -s ${aspas(nomeTmux(s.nome))} -c ${aspas(s.cwd || process.env.HOME || ".")} claude --resume ${aspas(s.sessionId)}${s.nomeDado ? ` --name ${aspas(s.nome)}` : ""}`;
}

// ── as sessões ───────────────────────────────────────────────────────────────
/** As sessões interativas do Claude vivas (o registro do próprio CLI). `claude -p` do board fica de fora. */
export function lerRegistro() {
  const dir = SESSOES_DIR();
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    let j; try { j = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
    if (!Number.isInteger(j.pid) || j.entrypoint !== "cli" || !j.sessionId) continue;
    try { process.kill(j.pid, 0); } catch { continue; } // morreu: registro velho
    out.push(j);
  }
  return out;
}

/** pid → terminal ("/dev/ttys009"). É pelo terminal que a sessão se liga ao painel do tmux (o claude é filho do shell dele). */
async function terminais(pids) {
  if (!pids.length) return {};
  let out = ""; try { out = await rodar("ps", ["-o", "pid=,tty=", "-p", pids.join(",")]); } catch (e) { out = e.stdout || ""; }
  const m = {};
  for (const l of out.split("\n")) { const [pid, tty] = l.trim().split(/\s+/); if (pid && tty && tty !== "??" && tty !== "?") m[pid] = tty.startsWith("/dev/") ? tty : "/dev/" + tty; }
  return m;
}

async function paineis() {
  let out = "";
  try { out = await tmux(["list-panes", "-a", "-F", "#{pane_id}\t#{pane_tty}\t#{session_name}\t#{window_index}\t#{window_name}\t#{pane_width}\t#{pane_height}"]); }
  catch { return { ok: false, lista: [] }; } // sem servidor tmux rodando (ou sem tmux): ninguém está nele
  return { ok: true, lista: out.split("\n").filter(Boolean).map((l) => { const [pane, tty, sessao, janela, nomeJanela, w, h] = l.split("\t"); return { pane, tty, sessao, janela: Number(janela), nomeJanela, largura: Number(w), altura: Number(h) }; }) };
}

// As de fora que já saíram: quem lembra é o `sessoes-conversa.mjs` (data/sessoes-vistas.json — o CLI apaga o registro no
// /exit). Daqui saem os dois caminhos de volta: 💬 para a Conversa do projeto (sem terminal nenhum) e ⇱ para o tmux.
const vivo = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** O pid ainda é um claude? (pid reaproveitado por outro programa não conta como a cópia de fora viva) */
function aindaClaude(pid) {
  if (!Number.isInteger(pid) || !vivo(pid)) return false;
  try { return /claude/i.test(execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" })); } catch { return false; }
}

let cache = { t: 0, v: null };
/** A lista da tela: cada sessão com o painel do tmux onde ela roda (ou o comando para reabrir lá). Cache curto. */
export async function listarSessoesTerminal({ fresco = false } = {}) {
  if (!fresco && cache.v && Date.now() - cache.t < 1500) return cache.v;
  const reg = lerRegistro();
  const [ttys, p] = await Promise.all([terminais(reg.map((j) => j.pid)), paineis()]);
  const sessoes = reg.map((j) => {
    const nome = j.name || pastaNaTela(j.cwd) || String(j.pid);
    const painel = p.lista.find((x) => x.tty && x.tty === ttys[j.pid]) || null;
    const s = { pid: j.pid, nome, nomeDado: !!j.name, pasta: pastaNaTela(j.cwd), cwd: j.cwd || "", sessionId: j.sessionId,
      status: j.status || "?", desde: j.statusUpdatedAt ? new Date(j.statusUpdatedAt).toISOString() : null,
      tmux: painel ? { pane: painel.pane, sessao: painel.sessao, janela: painel.janela, nomeJanela: painel.nomeJanela, largura: painel.largura, altura: painel.altura } : null };
    if (!painel) s.reabrir = comandoReabrir(s);
    else s.ghostty = ghosttyDe(painel.sessao); // 🖥 ver no tmux → Ghostty (#352)
    return s;
  });
  for (const x of sessoes) x.projeto = projetoDaPasta(x.cwd);
  sessoes.sort((a, b) => (!!b.tmux - !!a.tmux) || a.nome.localeCompare(b.nome));
  const { encerradas, anteriores, trazidas, reaberta } = sessoesParaConversa(reg);
  for (const e of [...encerradas, ...anteriores]) e.reabrir = comandoReabrir(e);
  const v = { tmux: binTmux(), tmuxNoAr: p.ok, sessoes, encerradas, anteriores, trazidas, reaberta };
  cache = { t: Date.now(), v };
  return v;
}

/** Só sessão do registro que está num painel: pid qualquer (ou painel de outro programa) não recebe tecla nenhuma. */
async function painelDe(pid, fresco = false) {
  const s = (await listarSessoesTerminal({ fresco })).sessoes.find((x) => x.pid === Number(pid));
  if (!s) throw Object.assign(new Error("sessão não encontrada (fechou, ou não é uma sessão do Claude)"), { status: 404 });
  if (!s.tmux) throw Object.assign(new Error("esta sessão não está no tmux — saia dela (/exit) e traga pelo botão da tela"), { status: 409, reabrir: s.reabrir });
  return s;
}

// ── a tela: capture-pane com as cores ─────────────────────────────────────────
const PADRAO_FG = "#d7dad8", PADRAO_BG = "#0c0f0e"; // as mesmas do .ses-term no estilo
const BASE16 = ["#1b1e1d", "#e5534b", "#57ab5a", "#c69026", "#539bf5", "#b083f0", "#39c5cf", "#c5c8c6",
  "#6e7681", "#ff7b72", "#7ee787", "#f2cc60", "#79c0ff", "#d2a8ff", "#56d4dd", "#f0f3f6"];
const hex = (r, g, b) => "#" + [r, g, b].map((x) => Math.max(0, Math.min(255, x | 0)).toString(16).padStart(2, "0")).join("");
function cor256(n) {
  if (n < 16) return BASE16[n];
  if (n < 232) { n -= 16; const v = (x) => (x ? 55 + x * 40 : 0); return hex(v(Math.floor(n / 36)), v(Math.floor(n / 6) % 6), v(n % 6)); }
  const c = 8 + (n - 232) * 10; return hex(c, c, c);
}
const escHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Aplica um SGR (os números de "\e[…m") ao estado. Cor estendida: 38;5;n, 38;2;r;g;b, e a forma com ":" (38:2::r:g:b). */
function sgr(st, params) {
  const cor = (sub) => (sub[1] === 5 ? cor256(sub[2] || 0) : sub[1] === 2 ? hex(...(sub.length >= 6 ? sub.slice(3, 6) : sub.slice(2, 5)).map((x) => x || 0)) : null);
  const grupos = params === "" ? ["0"] : params.split(";");
  for (let i = 0; i < grupos.length; i++) {
    const sub = grupos[i].split(":").map((x) => (x === "" ? 0 : Number(x)));
    const n = sub[0];
    if (n === 38 || n === 48) {
      let c;
      if (sub.length > 1) c = cor(sub); // forma com ":", tudo num grupo só
      else {
        const p = grupos.slice(i, i + 5).map((x) => Number(x) || 0);
        c = cor(p); i += p[1] === 5 ? 2 : p[1] === 2 ? 4 : 0;
      }
      if (c) st[n === 38 ? "fg" : "bg"] = c;
    }
    else if (n === 0) Object.assign(st, { fg: null, bg: null, b: false, d: false, i: false, u: false, inv: false, s: false });
    else if (n === 1) st.b = true; else if (n === 2) st.d = true; else if (n === 3) st.i = true;
    else if (n === 4) st.u = sub[1] !== 0; // 4:0 = sem sublinhado; 4:3 (ondulado) vira sublinhado
    else if (n === 7) st.inv = true; else if (n === 9) st.s = true;
    else if (n === 22) st.b = st.d = false; else if (n === 23) st.i = false; else if (n === 24) st.u = false;
    else if (n === 27) st.inv = false; else if (n === 29) st.s = false;
    else if (n >= 30 && n <= 37) st.fg = BASE16[n - 30]; else if (n >= 90 && n <= 97) st.fg = BASE16[n - 90 + 8]; else if (n === 39) st.fg = null;
    else if (n >= 40 && n <= 47) st.bg = BASE16[n - 40]; else if (n >= 100 && n <= 107) st.bg = BASE16[n - 100 + 8]; else if (n === 49) st.bg = null;
  }
}
function estilo(st) {
  let fg = st.fg, bg = st.bg;
  if (st.inv) { fg = st.bg || PADRAO_BG; bg = st.fg || PADRAO_FG; }
  const css = [];
  if (fg) css.push("color:" + fg);
  if (bg) css.push("background:" + bg);
  if (st.b) css.push("font-weight:700");
  if (st.d) css.push("opacity:.6");
  if (st.i) css.push("font-style:italic");
  if (st.u || st.s) css.push("text-decoration:" + [st.u && "underline", st.s && "line-through"].filter(Boolean).join(" "));
  return css.join(";");
}

/**
 * O texto do terminal com as sequências ANSI vira HTML: cada trecho com estilo num <span style>, todo texto escapado.
 * Só o SGR (cor, negrito…) é desenhado; qualquer outra sequência (cursor, título OSC, charset) é descartada.
 */
export function ansiParaHtml(texto) {
  const st = { fg: null, bg: null, b: false, d: false, i: false, u: false, inv: false, s: false };
  const re = /\x1b\[([0-9;:]*)m|\x1b\[[0-9;:?<>=!]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[()*+][0-9A-Za-z]|\x1b[@-_]?/g;
  let out = "", ultimo = 0, m;
  const texto_ = (t) => {
    t = t.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ""); // controles soltos (o \n e o \t ficam)
    if (!t) return;
    const css = estilo(st);
    out += css ? `<span style="${css}">${escHtml(t)}</span>` : escHtml(t);
  };
  while ((m = re.exec(texto))) {
    texto_(texto.slice(ultimo, m.index));
    if (m[1] !== undefined) sgr(st, m[1]);
    ultimo = re.lastIndex;
  }
  texto_(texto.slice(ultimo));
  return out;
}

/** Um painel do tmux agora (+ o histórico acima dele), já em HTML. Sem linhas em branco sobrando no fim. Também é a tela
 *  das abas do `board agentes` no navegador (#248, servidor/agentes-tmux.mjs). */
export async function capturarPainel(pane) {
  let bruto;
  try { bruto = await tmux(["capture-pane", "-p", "-e", "-t", pane, "-S", String(-HISTORICO())]); }
  catch (e) { cache.v = null; throw Object.assign(new Error("não consegui ler o painel: " + e.message), { status: 502 }); }
  bruto = bruto.replace(/(?:[ \t]*(?:\x1b\[[0-9;:]*m)*[ \t]*\n)+$/, "\n");
  return ansiParaHtml(bruto);
}
/** A tela da sessão agora, já em HTML. */
export async function capturar(pid) {
  const s = await painelDe(pid);
  return { pid: s.pid, nome: s.nome, pane: s.tmux.pane, html: await capturarPainel(s.tmux.pane) };
}

// ── mandar teclas ────────────────────────────────────────────────────────────
// As teclas especiais que a tela manda (nome do tmux). Letra, número e texto vão como TEXTO literal (send-keys -l).
export const TECLAS = new Set(["Enter", "Escape", "Up", "Down", "Left", "Right", "Tab", "BTab", "BSpace", "Space", "C-c", "PPage", "NPage", "Home", "End"]);
const ROTULO = { Enter: "Enter", Escape: "Esc", Up: "↑", Down: "↓", Left: "←", Right: "→", Tab: "Tab", BTab: "⇧Tab", BSpace: "⌫", Space: "espaço", "C-c": "Ctrl+C", PPage: "PgUp", NPage: "PgDn", Home: "Home", End: "End" };

/**
 * Manda ao painel: `texto` (literal; com várias linhas vai por colagem — bracketed paste, para o Claude não enviar a cada
 * linha), depois as `teclas` especiais na ordem, e Enter no fim se `enter`. O registro guarda as teclas e só o TAMANHO do
 * texto: o dono pode digitar algo que não deve ir para um log.
 */
export async function mandarTeclas(pid, { texto = "", teclas = [], enter = false } = {}, quem = "dono (tela)") {
  texto = String(texto ?? "");
  teclas = Array.isArray(teclas) ? teclas.map(String) : [String(teclas)];
  const ruins = teclas.filter((t) => !TECLAS.has(t));
  if (ruins.length) throw Object.assign(new Error("tecla não aceita: " + ruins.join(", ")), { status: 400 });
  if (texto.length > 8000) throw Object.assign(new Error("texto grande demais (até 8000 caracteres)"), { status: 400 });
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(texto.replace(/\r?\n/g, ""))) throw Object.assign(new Error("caractere de controle no texto: use os botões de tecla"), { status: 400 });
  if (!texto && !teclas.length && !enter) throw Object.assign(new Error("nada para mandar"), { status: 400 });
  const s = await painelDe(pid, true);
  const alvo = s.tmux.pane;
  if (texto && /\n/.test(texto)) {
    const buf = "board-" + s.pid;
    await tmux(["set-buffer", "-b", buf, "--", texto.replace(/\r\n/g, "\n")]);
    await tmux(["paste-buffer", "-d", "-p", "-b", buf, "-t", alvo]);
  } else if (texto) await tmux(["send-keys", "-t", alvo, "-l", "--", texto]);
  for (const t of teclas) await tmux(["send-keys", "-t", alvo, t]);
  if (enter) await tmux(["send-keys", "-t", alvo, "Enter"]);
  const partes = [texto && `texto (${texto.length} caractere${texto.length === 1 ? "" : "s"})`, ...teclas.map((t) => ROTULO[t]), enter && "Enter"].filter(Boolean);
  logEvent(LOG_SESSOES, { t: "teclas", sessao: s.nome, pid: s.pid, pane: alvo, quem, texto: partes.join(" + ") });
  return { ok: true, sessao: s.nome, pane: alvo, enviado: partes };
}

// ── abrir no tmux, sem janela: "Trazer para cá" e "Nova sessão" ────────────────
/** O claude das sessões: BOARD_SESSOES_CLAUDE, senão o do PATH, senão os lugares de sempre (o launchd não lê o .zshrc). */
export function binClaude() {
  if (process.env.BOARD_SESSOES_CLAUDE) return process.env.BOARD_SESSOES_CLAUDE;
  for (const d of String(process.env.PATH || "").split(delimiter)) if (d && existsSync(join(d, "claude"))) return join(d, "claude");
  return [join(process.env.HOME || "", ".local", "bin", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"].find((p) => existsSync(p)) || null;
}
const ESPERA_MS = () => Math.max(500, Number(process.env.BOARD_SESSOES_ESPERA_MS || 8000)); // quanto espera o claude se registrar
const falha = (status, msg, extra = {}) => Object.assign(new Error(msg), { status, extra }); // `extra` vai na resposta

async function nomeLivre(base) {
  let nomes = [];
  try { nomes = (await tmux(["list-sessions", "-F", "#{session_name}"])).split("\n").filter(Boolean); } catch { /* sem servidor: tudo livre */ }
  let n = nomeTmux(base);
  for (let i = 2; nomes.includes(n); i++) n = `${nomeTmux(base)}-${i}`;
  return n;
}

/**
 * Abre o claude numa sessão NOVA do tmux, em segundo plano (-d: nenhuma janela, nenhum Terminal). A sessão mora no
 * servidor do tmux, não no board: segue viva com tudo fechado e com o board reiniciando. O claude vai pelo caminho
 * inteiro e com o PATH/HOME do board (-e), porque um servidor tmux que já existia tem o ambiente de quando nasceu.
 * Espera o claude aparecer no registro (pelo terminal do painel) para devolver o pid; saiu logo de cara → erro.
 */
async function abrirNoTmux({ modo, nome, cwd, args, quem }) {
  const claude = binClaude();
  if (!claude) throw falha(500, "não achei o claude nesta máquina (BOARD_SESSOES_CLAUDE, PATH, ~/.local/bin, Homebrew)");
  try { if (!statSync(cwd).isDirectory()) throw 0; } catch { throw falha(409, `a pasta da sessão não existe mais: ${cwd}`); }
  const sessao = await nomeLivre(nome);
  const path = [...new Set([dirname(claude), ...String(process.env.PATH || "").split(delimiter), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean))].join(delimiter);
  const argv = [claude, ...args.map((a) => (a === "{nome}" ? sessao : a))];
  try {
    await tmux(["new-session", "-d", "-s", sessao, "-c", cwd, "-x", "200", "-y", "50", "-e", "HOME=" + (process.env.HOME || ""), ...argv], 8000, { ...process.env, PATH: path });
  } catch (e) { throw falha(502, "o tmux não abriu a sessão: " + e.message); }
  logEvent(LOG_SESSOES, { t: "abriu", modo, sessao: nome, tmux: sessao, cwd, quem, comando: ["claude", ...argv.slice(1)].join(" ") });
  cache.v = null;
  const ate = Date.now() + ESPERA_MS();
  while (Date.now() < ate) {
    await new Promise((r) => setTimeout(r, 250));
    const s = (await listarSessoesTerminal({ fresco: true })).sessoes.find((x) => x.tmux?.sessao === sessao);
    if (s) return { ok: true, pid: s.pid, nome: s.nome, tmux: sessao };
    try { await tmux(["has-session", "-t", "=" + sessao]); }
    catch { throw falha(502, `o claude saiu logo ao abrir (sessão ${sessao} do tmux fechou) — veja o comando no registro`); }
  }
  return { ok: true, pid: null, nome, tmux: sessao, aviso: "a sessão abriu no tmux, mas o claude ainda não apareceu no registro — ela entra na lista em instantes" };
}

/**
 * ⇱ "Abrir no tmux": a sessão que saiu do terminal reabre DENTRO do tmux com a mesma conversa (claude --resume). Só sessão
 * que o board VIU (sessionId, pasta e nome vêm da lembrança, nunca do pedido), só depois que a cópia de fora saiu — duas
 * cópias da mesma conversa se atropelam — e o board nunca mata a de fora: viva → 409 e o aviso do /exit. Sessão que já
 * virou o fio de uma Conversa também não: seriam duas cópias de novo.
 */
// sessionId → sessão do tmux onde o board a abriu ("" enquanto abre). Entre o `new-session` e o claude novo aparecer no
// registro há segundos em que nada mais diz que ela já está aberta: sem esta marca, dois pedidos seguidos (duas abas da
// tela) abriam duas cópias da mesma conversa (achado da QA da #234). Em memória: um board só por quadro.
const NO_TMUX = new Map();
/** A sessão está (ou está sendo) aberta pelo board no tmux? Sessão do tmux que já fechou libera a marca. */
export async function abertaNoTmux(sessionId) {
  if (!NO_TMUX.has(sessionId)) return false;
  const nome = NO_TMUX.get(sessionId);
  if (nome === "") return true;
  try { await tmux(["has-session", "-t", "=" + nome]); return true; }
  catch { if (NO_TMUX.get(sessionId) === nome) NO_TMUX.delete(sessionId); return false; }
}

export async function trazerSessao(sessionId, quem = "dono (tela)") {
  const jaAberta = () => falha(409, "esta sessão já está sendo aberta no tmux (outro pedido chegou antes) — duas cópias da mesma conversa se atropelam", { abrindo: true });
  if (await abertaNoTmux(sessionId)) throw jaAberta();
  if (NO_TMUX.has(sessionId)) throw jaAberta(); // outro pedido marcou enquanto este esperava o tmux
  NO_TMUX.set(sessionId, ""); // daqui até o fim nada espera antes da marca: o 2º pedido já a encontra
  let res = null;
  try {
    const reg = lerRegistro();
    const v = lembrarSessoes(reg)[sessionId];
    if (!v) throw falha(404, "não conheço esta sessão (o board só traz sessão que viu aberta no registro do Claude)");
    const r = reg.find((j) => j.sessionId === sessionId);
    const pid = r?.pid || (aindaClaude(v.pid) ? v.pid : 0);
    if (pid) {
      logEvent(LOG_SESSOES, { t: "recusou", modo: "tmux", sessao: v.nome, pid, quem, motivo: "a cópia de fora está viva" });
      throw falha(409, `a sessão ${v.nome} ainda está aberta (pid ${pid}). Dê /exit nela primeiro — duas cópias da mesma conversa se atropelam; o board não fecha a de fora.`, { viva: pid });
    }
    if (v.trazida) throw falha(409, `esta sessão já é o fio da Conversa de ${v.trazida.label || v.trazida.slug} — abrir no tmux faria duas cópias da mesma conversa`, { conversa: "#/c/" + v.trazida.slug });
    res = await abrirNoTmux({ modo: "tmux", nome: v.nome, cwd: v.cwd, args: ["--resume", sessionId, "--name", v.nome], quem });
    NO_TMUX.set(sessionId, res.tmux);
    cache.v = null;
    return res;
  } finally { if (!res) NO_TMUX.delete(sessionId); }
}

/** "Nova sessão": um claude novo na pasta de um projeto da seleção (data/projetos.json), no tmux, com --name. */
export async function novaSessao(slug, quem = "dono (tela)") {
  const p = projetosVisiveis().find((x) => x.slug === String(slug || ""));
  if (!p) throw falha(400, "projeto fora da seleção da tela");
  const nome = slugDoNome(p.label) || nomeTmux(p.slug).toLowerCase();
  return abrirNoTmux({ modo: "nova", nome, cwd: p.dir, args: ["--name", "{nome}"], quem });
}

// ── ao vivo: um leitor por tela, só enquanto alguém assiste ──────────────────
const VIGIAS = new Map(); // chave ("s:<pid>", "a:<janela>") → { clientes:Set<res>, timer, ultimo, ler }
function enviar(res, evento, dados) { try { res.write(`event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`); } catch { /* fechou */ } }
async function rodada(v) {
  if (v.lendo) return; v.lendo = true;
  try {
    const c = await v.ler();
    if (c.html !== v.ultimo) { v.ultimo = c.html; for (const r of v.clientes) enviar(r, "tela", c); }
    v.erro = null;
  } catch (e) {
    if (e.message !== v.erro) { v.erro = e.message; for (const r of v.clientes) enviar(r, "erro", { error: e.message, reabrir: e.reabrir || null }); }
  } finally { v.lendo = false; }
}
/** SSE de uma tela: `ler()` devolve `{ html, … }`; manda o evento `tela` só quando o html muda, e `erro` quando falha. */
export function assistirTela(chave, ler, req, res) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  let v = VIGIAS.get(chave);
  if (!v) { v = { clientes: new Set(), ultimo: null, erro: null, ler }; VIGIAS.set(chave, v); v.timer = setInterval(() => rodada(v), INTERVALO()); }
  v.clientes.add(res);
  if (v.ultimo) enviar(res, "tela", { html: v.ultimo }); else rodada(v);
  req.on("close", () => { v.clientes.delete(res); if (!v.clientes.size) { clearInterval(v.timer); VIGIAS.delete(chave); } });
}
const assistir = (pid, req, res) => assistirTela("s:" + pid, () => capturar(pid), req, res);

// ── rotas ────────────────────────────────────────────────────────────────────

/**
 * Só a máquina: o pedido vem do loopback E com Host local (contra DNS rebinding — uma página de fora apontando um nome
 * para 127.0.0.1). Página de outro site (Origin estranho) não lê nem escreve. Mandar tecla exige o Origin da PRÓPRIA tela
 * (a barreira do 🚀): CLI e curl de agente não digitam nas sessões do dono.
 */
export async function rotaSessoes(req, res, url, { json, readBody }) {
  try {
    if (!hostDaMaquina(req)) return json(res, 403, { error: "o terminal das sessões é só desta máquina (localhost ou o endereço do Tailscale configurado)" });
    const daTela = daTelaDoBoard(req);
    if (req.headers.origin && !daTela) return json(res, 403, { error: "o terminal das sessões não aceita pedido de outra página" });
    const path = url.pathname;
    if (req.method === "GET" && path === "/api/sessoes") return json(res, 200, await listarSessoesTerminal({ fresco: url.searchParams.has("fresco") }));
    if (req.method === "POST" && path === "/api/sessoes/trazer") {
      // #234: a sessão do terminal vira o fio da Conversa do projeto. Só a tela (a barreira do 🚀): mexe no fio do dono.
      if (!daTela) return json(res, 403, { error: "trazer uma sessão para a Conversa só pela tela do board" });
      const b = await readBody(req);
      // Aberta pelo board no tmux (ou abrindo, antes de o claude aparecer no registro): seria a 2ª cópia da conversa.
      if (await abertaNoTmux(String(b.sessionId || ""))) return json(res, 409, { error: "esta sessão está aberta no tmux pelo board — dê /exit nela primeiro (duas cópias da mesma conversa se atropelam)", viva: true });
      const r = trazerParaConversa(String(b.sessionId || ""), { porVisivel: b.porVisivel === true, substituir: b.substituir === true }, lerRegistro());
      cache.v = null;
      return json(res, 200, r);
    }
    if (req.method === "POST" && path === "/api/sessoes/limpar-encerradas") {
      // #345: esquece as que saíram (só a lembrança do board). Só a tela: CLI e agente não mexem na lista do dono.
      if (!daTela) return json(res, 403, { error: "limpar as sessões encerradas só pela tela do board" });
      const r = esquecerEncerradas(lerRegistro(), (sid) => NO_TMUX.has(sid));
      cache.v = null;
      return json(res, 200, r);
    }
    if (req.method === "GET" && path === "/api/sessoes/projetos") return json(res, 200, { projetos: projetosVisiveis().map((p) => ({ slug: p.slug, label: p.label })) });
    if (req.method === "POST" && path === "/api/sessoes/nova") {
      if (!daTela) return json(res, 403, { error: "abrir sessão só pela tela do board" });
      return json(res, 200, await novaSessao((await readBody(req)).projeto));
    }
    if (req.method === "POST" && path === "/api/sessoes/tmux") {
      if (!daTela) return json(res, 403, { error: "abrir sessão no tmux só pela tela do board" });
      return json(res, 200, await trazerSessao(String((await readBody(req)).sessionId || "")));
    }
    const m = path.match(/^\/api\/sessoes\/(\d+)(?:\/(tela|ao-vivo|teclas))?$/);
    if (!m) return json(res, 404, { error: "rota não existe" });
    const pid = Number(m[1]);
    if (req.method === "GET" && m[2] === "tela") return json(res, 200, await capturar(pid));
    if (req.method === "GET" && m[2] === "ao-vivo") return assistir(pid, req, res);
    if (req.method === "POST" && m[2] === "teclas") {
      if (!daTela) return json(res, 403, { error: "mandar teclas às sessões só pela tela do board" });
      return json(res, 200, await mandarTeclas(pid, await readBody(req)));
    }
    return json(res, 404, { error: "rota não existe" });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message, ...(e.reabrir ? { reabrir: e.reabrir } : {}), ...(e.extra || {}) });
  }
}
