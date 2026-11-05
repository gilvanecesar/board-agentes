// 🖥 "ver no tmux" (o botão da faixa de agentes no Meu quadro). No Mac (com tela) abre o Terminal na sessão tmux
// "board-agentes", como sempre. Numa máquina SEM tela (#248, 29/10: o board foi para o Atena e o clique não abria nada,
// sem aviso) a mesma sessão — painel + uma aba por agente, montada pelo `board agentes` — aparece NO NAVEGADOR, com a
// tela crua do menu Sessões (#233: capture-pane → ANSI→HTML, SSE ao vivo). Só leitura: as abas só mostram (o painel e
// o `board seguir` não leem teclado), então não há rota que digite nelas.
import { execFile } from "child_process";
import { join } from "path";
import { PORT, ROOT } from "./config.mjs";
import { assistirTela, binTmux, capturarPainel, tmux } from "./sessoes.mjs";
import { daTela as daTelaDoBoard, hostDaMaquina } from "./origem.mjs";
import { abrirGhostty, appGhostty, boardDoMac, comandoAnexar, ghosttyDe, lerMac, modoGhostty } from "./ghostty.mjs";
import { logEvent } from "./estado.mjs";

export const SESSAO_AGENTES = "board-agentes";

/**
 * "terminal" (abre o Terminal na máquina do board) ou "navegador" (a vista na tela). Terminal só no Mac que não é o
 * servidor (BOARD_SERVIDOR=local é o board rodando no Atena); Linux não tem o Terminal do osascript, com ou sem DISPLAY.
 * BOARD_AGENTES_TELA=terminal|navegador força um dos dois.
 */
export function modoAgentes() {
  const m = process.env.BOARD_AGENTES_TELA;
  if (m === "terminal" || m === "navegador") return m;
  return process.platform === "darwin" && process.env.BOARD_SERVIDOR !== "local" ? "terminal" : "navegador";
}

const falha = (status, msg) => Object.assign(new Error(msg), { status });

/** `board agentes …` com o tmux do board (BOARD_TMUX/SOCKET) e o endereço DESTE board (o painel lê o estado dele). */
function cli(args) {
  const env = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}`, BOARD_TMUX: binTmux(), BOARD_URL: process.env.BOARD_URL || `http://127.0.0.1:${PORT}` };
  return new Promise((ok, nao) => execFile(process.execPath, [join(ROOT, "board-cli.mjs"), "agentes", ...args], { env, timeout: 30000, encoding: "utf8" }, (e, out, err) => {
    // A 1ª linha do stderr: a CLI escreve o motivo limpo (exceção solta põe o arquivo:linha ali — vale a mensagem dela).
    const linhas = String(err || "").split("\n").map((l) => l.trim()).filter(Boolean);
    if (e) return nao(falha(502, (e.killed ? "o comando passou de 30 s" : linhas.find((l) => /^\w*Error:/.test(l)) || linhas[0]) || e.message));
    ok(out);
  }));
}

/** As abas da sessão (uma por janela do tmux: o painel e cada agente), na ordem. null = a sessão não existe. */
export async function janelasDosAgentes() {
  let out;
  // "=board-agentes:" = a SESSÃO exata. Sem o ":", o list-panes lê o alvo como janela e aceita prefixo de sessão: com a
  // board-agentes fechada, ele lia a "board-agentes-x" de outro programa (achado da QA da #248).
  try { out = await tmux(["list-panes", "-s", "-t", "=" + SESSAO_AGENTES + ":", "-F", "#{window_index}\t#{window_name}\t#{pane_id}\t#{pane_index}\t#{window_active}\t#{pane_dead}\t#{pane_start_command}"]); }
  catch { return null; }
  const vistas = new Set(), janelas = [];
  for (const l of out.split("\n").filter(Boolean)) {
    const [i, nome, pane, , ativa, morta, cmd] = l.split("\t");
    if (vistas.has(i)) continue; // o 1º painel de cada janela
    vistas.add(i);
    const tarefa = Number((String(cmd || "").match(/seguir["']?\s+["']?(\d+)/) || [])[1]) || null;
    janelas.push({ janela: Number(i), nome, pane, ativa: ativa === "1", terminou: morta === "1", tarefa });
  }
  return janelas.sort((a, b) => a.janela - b.janela);
}

/** O clique do 🖥: Terminal (Mac) ou monta a sessão para a vista na tela. Nunca calado: falhou → erro com o motivo.
 *  Um clique por vez: dois juntos (clique duplo, duas abas) faziam o 2º `new-session` dar "duplicate session" e virar
 *  um 502 falso com a sessão aberta (achado da QA da #248). */
let fila = Promise.resolve();
export function abrirAgentes() {
  const vez = fila.then(abrirAgora, abrirAgora);
  fila = vez.catch(() => {});
  return vez;
}
// #352 (04/11, o dono: "as tarefas já têm um botão chamado tmux, não daria pra usar ele?"): o MESMO 🖥 abre o Ghostty.
// No Mac com o Ghostty: monta a sessão e abre `open -na Ghostty … tmux attach -t =board-agentes` (sem Ghostty, o Terminal
// de antes). No board sem tela com o board do Mac configurado (BOARD_GHOSTTY_MAC): monta a sessão e devolve o endereço do
// board do Mac (`#/ghostty/board-agentes`), que abre o Ghostty em `ssh -t <servidor> tmux attach`. Sem os dois: #/agentes.
async function abrirAgora() {
  const modo = modoAgentes();
  if (modo === "terminal" && !appGhostty()) { await cli(["--abrir"]); return { ok: true, modo }; }
  try { await tmux(["-V"]); } catch { throw falha(502, `não achei o tmux nesta máquina (${binTmux()}): instale o tmux para ver os agentes`); }
  if (!(await janelasDosAgentes())) await cli(["--montar"]);
  const janelas = await janelasDosAgentes();
  if (!janelas) throw falha(502, `a sessão tmux ${SESSAO_AGENTES} não abriu`);
  if (modo === "terminal") {
    const comando = comandoAnexar(SESSAO_AGENTES);
    await abrirGhostty(comando);
    logEvent("sessoes", { t: "ghostty", sessao: SESSAO_AGENTES, remoto: false, comando, quem: "dono (tela)" });
    return { ok: true, modo: "ghostty", comando };
  }
  if (boardDoMac()) {
    await lerMac(); // o clique pergunta AGORA: o Mac pode ter ganhado o código (ou caído) desde a última leitura
    if (modoGhostty() === "mac") return { ok: true, modo: "mac", ghostty: ghosttyDe(SESSAO_AGENTES), url: "#/agentes", janelas };
    return { ok: true, modo, url: "#/agentes", janelas, ghostty: ghosttyDe(SESSAO_AGENTES) }; // copiar + aviso, e a vista aqui
  }
  return { ok: true, modo, url: "#/agentes", janelas };
}

async function telaDaJanela(n) {
  const j = (await janelasDosAgentes() || []).find((x) => x.janela === n);
  if (!j) throw falha(404, "essa aba não existe mais na sessão " + SESSAO_AGENTES);
  return { janela: j.janela, nome: j.nome, html: await capturarPainel(j.pane) };
}

/** As rotas: as mesmas travas das Sessões (só a máquina; página de outro site não lê nem pede). */
export async function rotaAgentesTmux(req, res, url, { json }) {
  try {
    if (!hostDaMaquina(req)) return json(res, 403, { error: "a sessão dos agentes é só desta máquina (localhost ou o endereço do Tailscale configurado)" });
    if (req.headers.origin && !daTelaDoBoard(req)) return json(res, 403, { error: "a sessão dos agentes não aceita pedido de outra página" });
    const path = url.pathname;
    if (req.method === "POST" && path === "/api/agentes/tmux") return json(res, 200, await abrirAgentes());
    if (req.method === "GET" && path === "/api/agentes/tmux") {
      const janelas = await janelasDosAgentes();
      return json(res, 200, { modo: modoAgentes(), sessao: SESSAO_AGENTES, existe: !!janelas, janelas: janelas || [] });
    }
    const m = path.match(/^\/api\/agentes\/tmux\/(\d+)\/(tela|ao-vivo)$/);
    if (m && req.method === "GET") {
      const n = Number(m[1]);
      if (m[2] === "tela") return json(res, 200, await telaDaJanela(n));
      return assistirTela("a:" + n, () => telaDaJanela(n), req, res);
    }
    return json(res, 404, { error: "rota não existe" });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message });
  }
}
