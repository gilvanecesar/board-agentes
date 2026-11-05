// 🖥 ver no tmux → Ghostty (#352, 04/11 — pedido do dono: "eu só queria que as sessões do tmux fossem abertas em terminais, e
// não na sessão dentro do board"; ele usa o Ghostty no Mac). Muda o rumo da #234 SEM tirar nada: a vista crua do menu
// Sessões continua, e cada sessão viva no tmux ganha um botão que abre uma janela do Ghostty já em `tmux attach`.
//
// Três jeitos, decididos aqui (`modoGhostty`), nunca pela tela:
// - "abrir": este board roda no Mac que tem o Ghostty → `open -na Ghostty.app --args --initial-command=<attach>`.
// - "mac": este board roda no servidor (Atena, sem tela) e há o board do Mac (`BOARD_GHOSTTY_MAC`): a tela abre o board
//   do Mac em `#/ghostty/<sessão>`, onde o dono clica de novo e o board DO MAC abre `ssh -t <servidor> tmux attach`.
// - "copiar": nenhum dos dois → a tela copia o comando pronto.
// O nome da sessão vem SEMPRE do registro (painel do tmux de uma sessão do Claude, ou `tmux list-sessions` do servidor lido
// agora), nunca do pedido: o pedido só escolhe, e quem não está na lista é 404. Abrir só com o Origin da tela (a barreira do
// 🚀). Nenhuma tecla vai para a sessão: o Ghostty só se anexa a ela.
import { execFile } from "child_process";
import { existsSync } from "fs";
import { hostname } from "os";
import { logEvent } from "./estado.mjs";
import { SERVIDOR, SERVIDOR_LOCAL } from "./config.mjs";
import { listarSessoesTerminal, LOG_SESSOES } from "./sessoes.mjs";
import { noServidor } from "./infra.mjs";
import { daTela as daTelaDoBoard, hostDaMaquina } from "./origem.mjs";

const falha = (status, msg) => Object.assign(new Error(msg), { status });
/** Nome de sessão do tmux que pode entrar num comando sem aspas: letras, números, _ . - (é o que o board cria). */
export const NOME_SEGURO = /^[\w.-]{1,64}$/;
const aspas = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
const sock = () => (process.env.BOARD_TMUX_SOCKET ? `-L ${aspas(process.env.BOARD_TMUX_SOCKET)} ` : "");

/** O app: BOARD_GHOSTTY_APP, senão o Ghostty.app de sempre. null = esta máquina não tem Ghostty. */
export function appGhostty() {
  if (process.env.BOARD_GHOSTTY_APP) return process.env.BOARD_GHOSTTY_APP;
  if (process.platform !== "darwin") return null;
  return ["/Applications/Ghostty.app", `${process.env.HOME}/Applications/Ghostty.app`].find((p) => existsSync(p)) || null;
}
/** O endereço do board do Mac (só origem http/https), para o board do servidor mandar o dono até ele. */
export function boardDoMac() {
  try { const u = new URL(process.env.BOARD_GHOSTTY_MAC || ""); return /^https?:$/.test(u.protocol) && !u.username ? u.origin : null; } catch { return null; }
}
// O board do Mac está pronto para abrir o Ghostty? (#352, 2ª volta: o dono clicou e "não está abrindo" — o Atena levava a
// `#/ghostty/…` de um board do Mac com o código ANTIGO, que nem tem a página: 404 em /api/ghostty, e a aba caía no quadro.)
// Perguntado ao próprio board do Mac (`GET /api/ghostty?so-modo` tem de dizer "abrir"), em segundo plano, guardado 60 s.
// O Atena não usa o DNS da tailnet: o curl vai pelo IP do par (`tailscale status`), como no Monitoramento.
export const MAC = { ok: null, motivo: null, em: 0, lendo: null };
const MAC_VALE_MS = () => Number(process.env.BOARD_GHOSTTY_MAC_CACHE_MS || 60000);
function curl(args) {
  return new Promise((ok) => execFile(process.env.BOARD_GHOSTTY_CURL || "curl", args, { timeout: 12000, encoding: "utf8" }, (e, out) => ok({ falhou: !!e && !out, out: String(out || "") })));
}
async function ipDaTailnet(host) {
  return new Promise((ok) => execFile(process.env.BOARD_GHOSTTY_TAILSCALE || "tailscale", ["status", "--json"], { timeout: 6000, encoding: "utf8", maxBuffer: 4 << 20 }, (e, out) => {
    try { const p = Object.values(JSON.parse(out).Peer || {}).find((x) => String(x.DNSName || "").replace(/\.$/, "") === host); ok((p?.TailscaleIPs || [])[0] || null); } catch { ok(null); }
  }));
}
export function lerMac() {
  const url = boardDoMac();
  if (!url) return Promise.resolve(MAC);
  if (MAC.lendo) return MAC.lendo;
  MAC.lendo = (async () => {
    const u = new URL(url), porta = u.port || (u.protocol === "https:" ? "443" : "80");
    const ip = /\.ts\.net$/i.test(u.hostname) ? await ipDaTailnet(u.hostname) : null;
    const r = await curl(["-s", "-m", "8", "-w", "\n%{http_code}", ...(ip ? ["--resolve", `${u.hostname}:${porta}:${ip}`] : []), `${url}/api/ghostty?so-modo`]);
    const linhas = r.out.trimEnd().split("\n"), codigo = linhas.pop(), corpo = linhas.join("\n");
    let d = null; try { d = JSON.parse(corpo); } catch { /* não é JSON */ }
    const fora = r.falhou || !/^\d{3}$/.test(codigo) || codigo === "000";
    MAC.ok = !fora && codigo === "200" && d?.modo === "abrir";
    MAC.motivo = MAC.ok ? null
      : fora ? "o board do Mac não respondeu (Mac desligado, dormindo ou fora da tailnet)"
      : codigo === "404" ? "o board do Mac está com o código antigo, sem o 🖥 Ghostty: leve este código para lá e dê ↻"
      : codigo === "403" ? "o board do Mac recusou o endereço do Tailscale (falta BOARD_ORIGENS_EXTRAS no board.env do Mac)"
      : codigo === "200" ? "o board do Mac não achou o Ghostty.app naquele Mac"
      : `o board do Mac respondeu ${codigo}`;
    MAC.em = Date.now();
    return MAC;
  })().finally(() => { MAC.lendo = null; });
  return MAC.lendo;
}
/** "abrir" (aqui), "mac" (pelo board do Mac) ou "copiar". BOARD_GHOSTTY=copiar força o copiar. O Mac que já se mostrou
 *  sem condições (código antigo, fora do ar, sem Ghostty) vira "copiar" com o motivo; enquanto ninguém perguntou, vale "mac". */
export function modoGhostty() {
  if (process.env.BOARD_GHOSTTY === "copiar") return "copiar";
  if (appGhostty()) return "abrir";
  if (boardDoMac()) {
    if (Date.now() - MAC.em > MAC_VALE_MS()) lerMac();
    return MAC.ok === false ? "copiar" : "mac";
  }
  return "copiar";
}
/** Por que não vai pelo Mac (só no "copiar" que veio de um Mac sem condições). */
export const avisoDoMac = () => (boardDoMac() && !appGhostty() && MAC.ok === false ? MAC.motivo : null);

/** O comando que se anexa à sessão: `tmux attach -t =<nome>` aqui, ou por `ssh -t <servidor>` quando ela mora no servidor.
 *  O apelido do ssh: BOARD_GHOSTTY_SSH, senão o BOARD_SERVIDOR (no Mac, "atena"), senão o nome desta máquina (no Atena). */
export function comandoAnexar(nome, { remoto = false } = {}) {
  if (!NOME_SEGURO.test(String(nome || ""))) throw falha(400, "nome de sessão do tmux fora do formato que o board aceita");
  const attach = `tmux ${sock()}attach -t =${nome}`; // "=" = a sessão EXATA, nunca por prefixo
  return remoto ? `ssh -t ${aspas(process.env.BOARD_GHOSTTY_SSH || (SERVIDOR_LOCAL ? hostname() : SERVIDOR))} ${attach}` : attach;
}
/** O que a tela leva de cada sessão viva no tmux: o modo, o comando para copiar e (no modo "mac") o endereço. */
export function ghosttyDe(nomeTmux) {
  if (!NOME_SEGURO.test(String(nomeTmux || ""))) return null;
  const modo = modoGhostty();
  // Copiado ou aberto no Mac, o dono está NO MAC: sessão de um board no servidor se anexa por ssh.
  const remoto = SERVIDOR_LOCAL || process.platform !== "darwin";
  const comando = comandoAnexar(nomeTmux, { remoto: modo !== "abrir" && remoto });
  const aviso = modo === "copiar" ? avisoDoMac() : null;
  return { modo, sessao: nomeTmux, comando, ...(modo === "mac" ? { url: `${boardDoMac()}/#/ghostty/${encodeURIComponent(nomeTmux)}` } : {}), ...(aviso ? { aviso } : {}) };
}

/** As sessões do tmux do SERVIDOR (no board do Mac): `tmux list-sessions` lido agora, por ssh. Só nomes no formato seguro. */
export async function sessoesDoServidor() {
  if (SERVIDOR_LOCAL) return [];
  const r = await noServidor(`tmux ${sock()}list-sessions -F '#{session_name}\t#{session_attached}\t#{session_windows}'`, 8000);
  if (!r.ok) {
    if (/no server running|no sessions/i.test(r.err)) return [];
    throw falha(502, `não li as sessões do tmux em ${SERVIDOR}: ${(r.err || "ssh falhou").trim().split("\n")[0]}`);
  }
  return r.out.split("\n").filter(Boolean).map((l) => { const [nome, presos, janelas] = l.split("\t"); return { nome, presos: Number(presos) || 0, janelas: Number(janelas) || 0 }; })
    .filter((s) => NOME_SEGURO.test(s.nome)).sort((a, b) => a.nome.localeCompare(b.nome));
}

/** `open -na <app> --args --initial-command=<cmd>`. BOARD_GHOSTTY_E=1 usa `-e` (pode pedir confirmação no Ghostty). */
export function abrirGhostty(comando) {
  const app = appGhostty();
  if (!app) throw falha(409, "o Ghostty não está instalado nesta máquina");
  const ghArgs = process.env.BOARD_GHOSTTY_E === "1" ? ["-e", "sh", "-c", comando] : [`--initial-command=${comando}`];
  const abrir = process.env.BOARD_GHOSTTY_OPEN || "open";
  return new Promise((ok, nao) => execFile(abrir, ["-na", app, "--args", ...ghArgs], { timeout: 15000, encoding: "utf8" },
    (e, _out, err) => (e ? nao(falha(502, "o Ghostty não abriu: " + (String(err || "").trim() || e.message))) : ok())));
}

/** O clique: `{pid}` = uma sessão do Claude deste board no tmux; `{servidor: nome}` = uma sessão do tmux do servidor. */
export async function abrirNoGhostty(b = {}, quem = "dono (tela)") {
  let nome, remoto = false, rotulo;
  if (b.servidor != null) {
    if (SERVIDOR_LOCAL) throw falha(409, "este board roda no próprio servidor: abrir no Ghostty é pelo board do Mac");
    const s = (await sessoesDoServidor()).find((x) => x.nome === String(b.servidor));
    if (!s) throw falha(404, `não há sessão "${String(b.servidor).slice(0, 64)}" no tmux de ${SERVIDOR} agora`);
    nome = s.nome; remoto = true; rotulo = `${s.nome} (${SERVIDOR})`;
  } else {
    const s = (await listarSessoesTerminal({ fresco: true })).sessoes.find((x) => x.pid === Number(b.pid));
    if (!s) throw falha(404, "sessão não encontrada (fechou, ou não é uma sessão do Claude)");
    if (!s.tmux) throw falha(409, "esta sessão não está no tmux: só sessão no tmux abre no Ghostty");
    nome = s.tmux.sessao; rotulo = s.nome;
    if (modoGhostty() !== "abrir") return { ok: true, ...ghosttyDe(nome), nome: rotulo }; // a tela leva ao Mac ou copia
  }
  const comando = comandoAnexar(nome, { remoto });
  await abrirGhostty(comando);
  logEvent(LOG_SESSOES, { t: "ghostty", sessao: nome, remoto, comando, quem });
  return { ok: true, modo: "aberto", sessao: nome, nome: rotulo, comando };
}

/** /api/ghostty: GET = o modo e (no Mac) as sessões do servidor; POST /abrir = o clique. Só a máquina; abrir só pela tela. */
export async function rotaGhostty(req, res, url, { json, readBody }) {
  try {
    if (!hostDaMaquina(req)) return json(res, 403, { error: "abrir no Ghostty é só desta máquina (localhost ou o endereço do Tailscale configurado)" });
    const daTela = daTelaDoBoard(req);
    if (req.headers.origin && !daTela) return json(res, 403, { error: "abrir no Ghostty não aceita pedido de outra página" });
    if (req.method === "GET" && url.pathname === "/api/ghostty") {
      if (boardDoMac() && !appGhostty() && (url.searchParams.has("conferir-mac") || MAC.ok === null)) await lerMac();
      const modo = modoGhostty(), d = { modo, servidor: SERVIDOR_LOCAL ? null : SERVIDOR, ghostty: !!appGhostty(), sessoes: [],
        ...(boardDoMac() && !appGhostty() ? { mac: { endereco: boardDoMac(), pronto: MAC.ok, motivo: MAC.motivo, lidoEm: MAC.em ? new Date(MAC.em).toISOString() : null } } : {}) };
      if (modo === "abrir" && !SERVIDOR_LOCAL && !url.searchParams.has("so-modo")) {
        try { d.sessoes = (await sessoesDoServidor()).map((s) => ({ ...s, comando: comandoAnexar(s.nome, { remoto: true }) })); }
        catch (e) { d.erro = e.message; }
      }
      return json(res, 200, d);
    }
    if (req.method === "POST" && url.pathname === "/api/ghostty/abrir") {
      if (!daTela) return json(res, 403, { error: "abrir no Ghostty só pela tela do board (o clique do dono)" });
      return json(res, 200, await abrirNoGhostty(await readBody(req)));
    }
    return json(res, 404, { error: "rota não existe" });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message });
  }
}
