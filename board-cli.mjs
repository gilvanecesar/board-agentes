#!/usr/bin/env node
/**
 * CLI do BOARD — pra usar do terminal (inclusive por um Claude rodando em outra sessão).
 *
 *   board add "<texto>" [projeto] [--fila] [--pr] [--paralelo]   inclui tarefa (--pr = entrega por PR; --paralelo = ⚡ um agente por tarefa, cada um na sua cópia)
 *   board list                                 lista o quadro
 *   board show <id>                            detalhe + últimos eventos
 *   board run <id>                             põe na fila
 *   board stop <id>                            para
 *   board done <id>                            marca concluída
 *   board say <id> "<mensagem>"                fala com a tarefa (mesma sessão do agente)
 *   board rm <id>                              exclui
 *   board reiniciar                            reinicia o board quando nada estiver rodando (precisa do board.sh)
 *   board agentes [--abrir]                    tmux "board-agentes": painel geral + um painel por agente (#eng01…) ao vivo
 *   board seguir <id>                          acompanha uma tarefa ao vivo no terminal (é o que roda em cada painel)
 *
 * Fala com o servidor local (BOARD_URL, padrão http://127.0.0.1:4488). Sem servidor, avisa e sai 0.
 */
const BASE = process.env.BOARD_URL || "http://127.0.0.1:4488";
const [, , cmd, ...a] = process.argv;
const LABEL = { pendente: "pendente", fila: "na fila", rodando: "RODANDO", executada: "executada", concluida: "concluída", erro: "ERRO" };

async function call(path, method = "GET", body) {
  let r;
  try { r = await fetch(BASE + "/api" + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); }
  catch { console.error("(board fora do ar — suba com: node board.mjs)"); process.exit(0); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { console.error("erro:", d.error || r.status); process.exit(1); }
  return d;
}
const id = () => { const n = Number(a[0]); if (!n) { console.error("informe o id"); process.exit(1); } return n; };

// ── tmux: ver os agentes (#eng01, #eng02…) trabalhando, um painel cada ─────────────
import { readFileSync as lerArq, existsSync as existe, statSync as tam, openSync, readSync, closeSync } from "fs";
import { execFileSync as rodar, spawnSync } from "child_process";
import { fileURLToPath as caminhoDe } from "url";
import { dirname as pastaDe, join as juntar } from "path";
const AQUI = pastaDe(caminhoDe(import.meta.url));
const SESSAO = "board-agentes";
const K = { r: "\x1b[0m", dim: "\x1b[2m", b: "\x1b[1m", cyan: "\x1b[36m", verde: "\x1b[32m", verm: "\x1b[31m", amar: "\x1b[33m" };
const hora = (iso) => (iso ? new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");
const nomeModelo = (m) => { const r = String(m || "").match(/^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i); return r ? r[1][0].toUpperCase() + r[1].slice(1) + " " + r[2] + (r[3] ? "." + r[3] : "") : (m || "padrão"); };
const titulo = (t) => `${t.paralelo ? "⚡" : ""}#${t.agente || "?"} · ${t.project} · ${nomeModelo(t.modeloUsado)}${t.esforcoUsado ? " · " + t.esforcoUsado : ""} · tarefa #${t.id}`;
const limpa = (x) => String(x || "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");
async function estado() { try { const r = await fetch(BASE + "/api/state"); return await r.json(); } catch { return null; } }
function linhaDoEvento(ev) {
  const h = K.dim + hora(ev.at) + K.r + " ";
  const quem = ev.quem && ev.quem !== "agente" ? K.amar + "[" + ev.quem.toUpperCase() + "] " + K.r : "";
  switch (ev.t) {
    case "inicio": return "\n" + h + K.b + "▶ começou em " + ev.projeto + K.r;
    case "texto": return h + quem + limpa(ev.texto);
    case "ferramenta": return h + quem + K.dim + "▸ " + ev.nome + " " + String(ev.alvo || "").slice(0, 110) + K.r;
    case "resultado": return h + K.verde + "■ resultado" + (ev.custo ? " · US$ " + Number(ev.custo).toFixed(2) : "") + K.r + (ev.dup ? "" : "\n" + limpa(ev.texto));
    case "portao": return ev.estado === "rodando" ? h + K.dim + "⛨ portão: " + ev.comando + K.r : h + (ev.estado === "passou" ? K.verde + "⛨ portão passou" : K.verm + "⛨ portão falhou") + K.r;
    case "revisor": case "qa": return h + (ev.veredito === "APROVADO" ? K.verde : K.verm) + (ev.t === "qa" ? "🧪 QA: " : "🔍 revisor: ") + ev.veredito + K.r;
    case "solto": return h + K.amar + limpa(ev.texto) + K.r;
    case "dono": return h + K.cyan + "você: " + ev.texto + K.r;
    case "fim": return h + (ev.status === "erro" ? K.verm : K.b) + "■ " + ev.status + (ev.motivo ? " — " + ev.motivo : "") + K.r + "\n";
    default: return "";
  }
}
/** Nome da aba e título do painel — só na aba deste processo (TMUX_PANE), sem mexer no resto do tmux. */
function nomeiaAba(aba, tit) {
  const p = process.env.TMUX_PANE; if (!p) return;
  try { tmux("rename-window", "-t", p, aba); tmux("select-pane", "-t", p, "-T", tit); } catch { /* tmux saiu */ }
}
/** O cabeçalho da aba: o que o dono quer saber de relance. */
function cabecalho(t) {
  const linha = (k, v) => v ? "  " + K.dim + k.padEnd(9) + K.r + v + "\n" : "";
  return "\n" + K.cyan + K.b + "  " + (t.paralelo ? "⚡ " : "") + "#" + (t.agente || "?") + K.r + K.b + "  tarefa #" + t.id + K.r + "\n"
    + "  " + String(t.title || "").slice(0, 100) + "\n\n"
    + linha("projeto", t.project)
    + linha("modelo", nomeModelo(t.modeloUsado) + (t.esforcoUsado ? K.dim + " · esforço " + K.r + t.esforcoUsado : ""))
    + linha("porte", t.porte ? t.porte + (t.porteAuto ? K.dim + " (automático)" + K.r : "") : "")
    + linha("entrega", t.entrega === "pr" ? "Pull Request" : t.entrega === "deploy" ? "PR + publicar" : "direto na pasta")
    + linha("cópia", t.worktree && t.worktree.dir ? t.worktree.dir : "")
    + K.dim + "  " + "─".repeat(60) + "  Ctrl+B D sai sem parar nada" + K.r + "\n";
}
// ── O código sendo escrito: o log compacto só diz "Edit arquivo"; o cru (data/raw) traz o trecho.
const LIM = 30;
const curto = (p) => { const m = String(p || "").match(/\.board-agentes\/[^/]+\/(.*)$/); return m ? m[1] : String(p || "").split("/").slice(-3).join("/"); };
function diffDeTrecho(antigo, novo) {
  const a = String(antigo ?? "").split("\n"), b = String(novo ?? "").split("\n");
  let ini = 0; while (ini < a.length && ini < b.length && a[ini] === b[ini]) ini++;
  let fim = 0; while (fim < a.length - ini && fim < b.length - ini && a[a.length - 1 - fim] === b[b.length - 1 - fim]) fim++;
  const out = [];
  const ctx = (l) => out.push(K.dim + "    " + l + K.r);
  if (ini > 0) ctx(a[ini - 1]);
  const tira = a.slice(ini, a.length - fim), poe = b.slice(ini, b.length - fim);
  tira.slice(0, LIM).forEach((l) => out.push(K.verm + "  - " + l + K.r));
  if (tira.length > LIM) out.push(K.dim + "    … mais " + (tira.length - LIM) + " linha(s) removida(s)" + K.r);
  poe.slice(0, LIM).forEach((l) => out.push(K.verde + "  + " + l + K.r));
  if (poe.length > LIM) out.push(K.dim + "    … mais " + (poe.length - LIM) + " linha(s)" + K.r);
  if (fim > 0) ctx(a[a.length - fim]);
  return out.join("\n");
}
function blocoDeCodigo(u) {
  const i = u.input || {};
  if (u.name === "Edit") return K.b + "✎ Edit " + K.r + K.cyan + curto(i.file_path) + K.r + "\n" + diffDeTrecho(i.old_string, i.new_string);
  if (u.name === "MultiEdit") return K.b + "✎ MultiEdit " + K.r + K.cyan + curto(i.file_path) + K.r + " (" + (i.edits || []).length + " trechos)\n"
    + (i.edits || []).map((e) => diffDeTrecho(e.old_string, e.new_string)).join("\n" + K.dim + "    ⋯" + K.r + "\n");
  if (u.name === "Write") {
    const L = String(i.content ?? "").split("\n");
    return K.b + "✎ Write " + K.r + K.cyan + curto(i.file_path) + K.r + K.dim + " (" + L.length + " linhas)" + K.r + "\n"
      + L.slice(0, LIM).map((l) => K.verde + "  + " + l + K.r).join("\n") + (L.length > LIM ? "\n" + K.dim + "    … mais " + (L.length - LIM) + " linha(s)" + K.r : "");
  }
  if (u.name === "Bash") return K.amar + "$ " + K.r + String(i.command || "").split("\n").slice(0, 8).join("\n  ");
  return null;
}
const COM_CODIGO = new Set(["Edit", "MultiEdit", "Write", "Bash"]);

/** Segue o log da tarefa (data/logs/<id>.jsonl); o nome da aba e o cabeçalho acompanham o estado. */
async function seguir(n) {
  const arq = juntar(AQUI, "data", "logs", n + ".jsonl");
  const cru = juntar(AQUI, "data", "raw", n + ".jsonl");
  let pos = 0, resto = "", ultimo = "", mostrouCab = false, conta = 0;
  let posCru = tam(cru, { throwIfNoEntry: false })?.size || 0, restoCru = ""; // o histórico velho vai sem trecho
  const fila = []; // tool_use do cru, na ordem, esperando o evento "ferramenta" do log
  const lerNovo = (caminho, desde) => {
    if (!existe(caminho)) return ["", desde];
    const t = tam(caminho).size; if (t <= desde) return ["", desde];
    const fd = openSync(caminho, "r"); const buf = Buffer.alloc(t - desde); readSync(fd, buf, 0, buf.length, desde); closeSync(fd);
    return [buf.toString("utf8"), t];
  };
  const atualiza = async () => {
    const s = await estado(); const t = s && s.tasks.find((x) => x.id === n);
    if (!t) return;
    if (!mostrouCab && t.agente) { process.stdout.write(cabecalho(t)); mostrouCab = true; }
    const vivo = t.status === "rodando" || t.busy;
    const aba = (t.paralelo ? "⚡" : "") + (t.agente || "t" + n) + " " + t.project + (vivo ? "" : t.status === "erro" ? " ✗" : " ✓");
    const tit = titulo(t) + (vivo ? " · trabalhando" : " · " + t.status);
    if (aba + tit !== ultimo) { nomeiaAba(aba, tit); ultimo = aba + tit; }
  };
  await atualiza();
  for (;;) {
    // O log primeiro, o cru depois: o cru é gravado ANTES do log, então todo evento lido já tem o trecho.
    let novo; [novo, pos] = lerNovo(arq, pos); resto += novo;
    let novoCru; [novoCru, posCru] = lerNovo(cru, posCru); restoCru += novoCru;
    const lc = restoCru.split("\n"); restoCru = lc.pop();
    for (const l of lc) {
      try { const e = JSON.parse(l); if (e.type === "assistant") for (const c of e.message?.content || []) if (c.type === "tool_use" && COM_CODIGO.has(c.name)) fila.push(c); } catch { /* não é do claude */ }
    }
    const linhas = resto.split("\n"); resto = linhas.pop();
    for (const l of linhas) {
      let ev; try { ev = JSON.parse(l); } catch { continue; }
      if (ev.t === "ferramenta" && COM_CODIGO.has(ev.nome)) {
        const k = fila.findIndex((u) => u.name === ev.nome);
        if (k >= 0) { const [u] = fila.splice(k, 1); const b = blocoDeCodigo(u); if (b) { console.log(K.dim + hora(ev.at) + K.r + " " + b); continue; } }
      }
      const txt = linhaDoEvento(ev); if (txt) console.log(txt);
    }
    await new Promise((r) => setTimeout(r, 500));
    if (++conta % 6 === 0) await atualiza();
  }
}
/** A aba "painel": quem está trabalhando, a fila, e fecha a aba de tarefa já concluída. */
async function painel() {
  nomeiaAba("painel", "board · quem está trabalhando agora");
  for (;;) {
    const s = await estado();
    const ts = s ? s.tasks : [];
    const ag = ts.filter((t) => (t.status === "rodando" || t.busy) && t.agente).sort((a, b) => a.project.localeCompare(b.project) || a.agente.localeCompare(b.agente));
    const fila = ts.filter((t) => t.status === "fila");
    let out = "\x1b[2J\x1b[H\n" + K.cyan + K.b + "  ⚡ BOARD" + K.r + K.b + " · agentes agora" + K.r + K.dim + "   " + hora(new Date().toISOString()) + (s ? "" : "  · board fora do ar") + K.r + "\n\n";
    if (!ag.length) out += K.dim + "  ninguém trabalhando — cada agente que começar ganha uma aba lá embaixo\n" + K.r;
    for (const t of ag) out += "  " + K.amar + "●" + K.r + " " + K.cyan + K.b + (t.paralelo ? "⚡" : "") + "#" + t.agente + K.r + "  " + t.project.padEnd(16) + " " + nomeModelo(t.modeloUsado).padEnd(10) + K.dim + (t.esforcoUsado || "").padEnd(6) + " #" + t.id + K.r + "  " + String(t.title || "").slice(0, 60) + "\n";
    out += "\n" + K.b + "  Na fila (" + fila.length + ")" + K.r + "\n";
    for (const t of fila.sort((a, b) => a.order - b.order).slice(0, 8)) out += "  " + K.dim + "○ #" + t.id + "  " + t.project.padEnd(16) + K.r + " " + (t.paralelo ? "⚡ " : "") + String(t.title || "").slice(0, 70) + "\n";
    process.stdout.write(out);
    // As abas moram AQUI, num processo só: três agentes começando no mesmo segundo faziam o servidor
    // pedir três new-window juntos, que brigavam pelo mesmo número e só um abria (24/09).
    try {
      const temAba = new Set();
      for (const l of tmux("list-panes", "-s", "-t", SESSAO, "-F", "#{window_id} #{pane_start_command}").split("\n")) {
        const m = l.match(/^(\S+) .*seguir (\d+)/); if (!m) continue;
        temAba.add(Number(m[2]));
        const t = ts.find((x) => x.id === Number(m[2]));
        if (t && t.status === "concluida") tmux("kill-window", "-t", m[1]); // a executada/erro fica: ainda pede olho
      }
      for (const t of ag) if (!temAba.has(t.id)) abrirAba(t);
    } catch { /* fora do tmux */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
}
/** Uma linha para a barra do tmux (status-right). */
async function resumo() {
  const s = await estado();
  if (!s) return console.log("board fora do ar");
  const trab = s.tasks.filter((t) => t.status === "rodando" || t.busy).length, fila = s.tasks.filter((t) => t.status === "fila").length;
  console.log(trab + " trabalhando · " + fila + " na fila");
}
const tmux = (...args) => rodar("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
// Aba nova nasce em segundo plano, MAS se o dono está olhando o painel o tmux vai até ela: sem isso
// o agente ficava numa aba lá embaixo e parecia que "não abriu" (24/09). Quem já está vendo outro
// agente não é arrancado de lá.
function abrirAba(t, focar) {
  let noPainel = false;
  try { noPainel = tmux("display-message", "-p", "-t", SESSAO, "#{window_name}") === "painel"; } catch { /* sem cliente */ }
  const id = tmux("new-window", "-d", "-P", "-F", "#{window_id}", "-t", SESSAO + ":", "-n", (t.paralelo ? "⚡" : "") + t.agente + " " + t.project,
    '"' + process.execPath + '" "' + juntar(AQUI, "board-cli.mjs") + '" seguir ' + t.id);
  if (focar ?? noPainel) { try { tmux("select-window", "-t", id); } catch { /* sumiu */ } }
  return id;
}

// ── A barra (estilo lualine do Neovim): blocos de cor com o que importa agora ─────────────
import { cpus, loadavg, totalmem } from "os";
function memoriaUsada() {
  // Como o Monitor de Atividade conta "memória usada": ativa + wired + comprimida (o os.freemem do
  // macOS só conta página livre e faz parecer que a máquina está sempre cheia).
  try {
    const v = rodar("vm_stat", [], { encoding: "utf8" });
    const pag = Number((v.match(/page size of (\d+)/) || [])[1] || 16384);
    const q = (k) => Number((v.match(new RegExp(k + ":\\s+(\\d+)")) || [])[1] || 0);
    const usada = (q("Pages active") + q("Pages wired down") + q("Pages occupied by compressor")) * pag;
    return { usada, total: totalmem() };
  } catch { return null; }
}
async function barra() {
  const seg = (bg, fg, txt) => "#[bg=" + bg + ",fg=" + fg + "] " + txt + " ";
  const partes = [];
  const s = await estado();
  if (s) {
    const trab = s.tasks.filter((t) => t.status === "rodando" || t.busy).length, fila = s.tasks.filter((t) => t.status === "fila").length;
    partes.push(seg("#282e3b", trab ? "#e8a94a" : "#8b94a3", (trab ? "● " : "○ ") + trab + " trabalhando · " + fila + " na fila"));
    try {
      const u = await (await fetch(BASE + "/api/claude-uso")).json();
      const c = u.motores && u.motores.claude;
      if (c && c.ok) {
        const sess = c.limites.find((l) => /sess/i.test(l.nome)), sem = c.limites.find((l) => /seman|week/i.test(l.nome));
        const cor = (p) => (p >= 90 ? "#ef6b6b" : p >= 70 ? "#e8a94a" : "#4fcf7f");
        const pior = Math.max(sess ? sess.pct : 0, sem ? sem.pct : 0);
        partes.push(seg("#1c1f26", cor(pior), "Claude" + (sess ? " sessão " + sess.pct + "%" : "") + (sem ? " · semana " + sem.pct + "%" : "")));
      }
    } catch { /* sem leitura do plano */ }
  } else partes.push(seg("#2a1c1c", "#ef6b6b", "board fora do ar"));
  const nucleos = cpus().length, carga = loadavg()[0];
  partes.push(seg("#1c1f26", carga > nucleos ? "#ef6b6b" : "#8b94a3", "CPU " + carga.toFixed(1) + "/" + nucleos));
  const m = memoriaUsada();
  if (m) { const p = Math.round((m.usada / m.total) * 100); partes.push(seg("#1c1f26", p >= 90 ? "#ef6b6b" : p >= 75 ? "#e8a94a" : "#8b94a3", "RAM " + (m.usada / 2 ** 30).toFixed(1) + "/" + Math.round(m.total / 2 ** 30) + " GB " + p + "%")); }
  partes.push(seg("#4fb8e6", "#0f1117", "#[bold]" + new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })));
  process.stdout.write(partes.join(""));
}
/** O visual da sessão: as cores do board, abas clicáveis e o resumo ao vivo à direita. */
function estilo(cli, node) {
  const o = (k, v) => tmux("set-option", "-t", SESSAO, k, v);
  const w = (k, v) => tmux("set-window-option", "-g", "-t", SESSAO, k, v);
  o("mouse", "on");
  o("status-position", "bottom"); // o dono prefere embaixo (24/09)
  o("status-interval", "5");
  // DUAS linhas: as abas em cima e os blocos de informação embaixo. Numa linha só, a esquerda e a
  // direita espremiam a lista de abas até sumir e o dono não achava a aba do agente (24/09).
  o("status", "2");
  o("status-style", "bg=#0f1117,fg=#8b94a3");
  o("status-left-length", "40");
  o("status-left", "#[bg=#4fb8e6,fg=#0f1117,bold]  ⚡ BOARD #[bg=#0f1117,nobold] ");
  o("status-right", "#[fg=#5e6673]clique na aba · Ctrl+B e o número ");
  o("status-right-length", "40");
  // Definir só a linha 1 na sessão deixa a linha 0 (a das abas) VAZIA — o array não herda o
  // global. Copia o padrão do tmux para a linha 0 antes (24/09: a barra de abas sumiu assim).
  o("status-format[0]", tmux("show-options", "-gv", "status-format[0]"));
  o("status-format[1]", '#[align=right,bg=#0f1117]#("' + node + '" "' + cli + '" barra)');
  o("message-style", "bg=#1c1f26,fg=#e8ecf1");
  o("pane-border-status", "top");
  o("pane-border-format", " #[fg=#4fb8e6,bold]#{pane_title} ");
  o("pane-border-style", "fg=#2c3037");
  o("pane-active-border-style", "fg=#4fb8e6");
  w("automatic-rename", "off");
  w("remain-on-exit", "on");
  w("window-status-format", "#[fg=#5e6673] #I #[fg=#8b94a3]#W ");
  w("window-status-current-format", "#[bg=#a78bfa,fg=#0f1117,bold] #I #[bg=#282e3b,fg=#e8ecf1] #W ");
  w("window-status-separator", " ");
}
async function agentesTmux(abrir) {
  const s = await call("/state");
  const ag = s.tasks.filter((t) => (t.status === "rodando" || t.busy) && t.agente);
  const cli = juntar(AQUI, "board-cli.mjs"), node = process.execPath;
  try { tmux("kill-session", "-t", SESSAO); } catch { /* não havia */ }
  tmux("new-session", "-d", "-s", SESSAO, "-n", "painel", "-x", "220", "-y", "60", '"' + node + '" "' + cli + '" painel');
  estilo(cli, node);
  // Abre já na aba do primeiro agente trabalhando (o painel continua a um clique).
  ag.forEach((t, i) => abrirAba(t, i === 0));
  console.log('tmux "' + SESSAO + '": aba "painel" + ' + ag.length + " aba(s) de agente. Agente novo ganha aba sozinho.");
  if (process.env.TMUX) { tmux("switch-client", "-t", SESSAO); return; }
  if (abrir) {
    rodar("osascript", ["-e", 'tell application "Terminal" to do script "tmux attach -t ' + SESSAO + '"', "-e", 'tell application "Terminal" to activate']);
    return;
  }
  if (process.stdout.isTTY) spawnSync("tmux", ["attach", "-t", SESSAO], { stdio: "inherit" });
  else console.log("para ver: tmux attach -t " + SESSAO);
}

if (cmd === "add") {
  const queue = a.includes("--fila"); const pr = a.includes("--pr"); const paralelo = a.includes("--paralelo");
  const rest = a.filter((x) => x !== "--fila" && x !== "--pr" && x !== "--paralelo");
  const [text, project] = rest;
  if (!text) { console.error('uso: board add "<texto>" [projeto] [--fila]'); process.exit(1); }
  const d = await call("/tasks", "POST", { text, project, queue, paralelo, entrega: pr ? "pr" : "direto" });
  for (const t of d.tasks) console.log(`#${t.id} ${t.title} (${t.project}, ${LABEL[t.status]}${t.entrega === "pr" ? ", PR" : ""})`);
} else if (cmd === "list" || !cmd) {
  const d = await call("/state");
  const order = { rodando: 0, fila: 1, pendente: 2, erro: 3, executada: 4, concluida: 5 };
  for (const t of d.tasks.sort((x, y) => (order[x.status] - order[y.status]) || (x.order - y.order)))
    console.log(`${t.status === "concluida" ? "[x]" : "[ ]"} #${String(t.id).padEnd(3)} ${LABEL[t.status].padEnd(10)} ${(t.entrega === "pr" ? "PR " : "   ")}${t.project.padEnd(16)} ${t.title}`);
  if (!d.tasks.length) console.log("(quadro vazio)");
} else if (cmd === "show") {
  const d = await call(`/tasks/${id()}/log`);
  const t = d.task;
  console.log(`#${t.id} [${LABEL[t.status]}${t.etapa ? ":" + t.etapa : ""}] ${t.project}${t.entrega === "pr" ? " · entrega por PR" : ""}${t.gate ? " · portão " + (t.gate.ok ? "✓" : "✗") : ""}${t.revisor ? " · revisor " + t.revisor.veredito : ""}${t.prUrl ? " · " + t.prUrl : ""}\n${t.text}\n`);
  let last = null;
  for (const ev of d.events.slice(-40)) {
    if (ev.t === "texto") { console.log(ev.texto); last = ev.texto.trim(); }
    else if (ev.t === "dono") console.log("dono> " + ev.texto);
    else if (ev.t === "ferramenta") console.log(`  ▸ ${ev.nome}: ${ev.alvo}`);
    else if (ev.t === "resultado") { console.log(`── resultado · US$ ${(ev.custo || 0).toFixed(2)} · ${ev.turnos || 0} turno(s) ──`); if ((ev.texto || "").trim() !== last) console.log(ev.texto); }
    else if (ev.t === "portao") console.log(ev.estado === "rodando" ? `⛨ portão: $ ${ev.comando}`
      : ev.estado === "passou" ? "⛨ portão passou" : `⛨ portão FALHOU (código ${ev.code})\n${(ev.saida || "").split("\n").slice(-15).join("\n")}`);
    else if (ev.t === "revisor") console.log(`🔍 revisor: ${ev.veredito}\n${ev.texto || ""}`);
    else if (ev.t === "fim") console.log(`■ ${ev.status}${ev.motivo ? " — " + ev.motivo : ""}`);
  }
} else if (cmd === "run") { await call(`/tasks/${id()}`, "PATCH", { status: "fila" }); console.log("na fila"); }
else if (cmd === "stop") { await call(`/tasks/${id()}/stop`, "POST"); console.log("parada"); }
else if (cmd === "done") { await call(`/tasks/${id()}`, "PATCH", { status: "concluida" }); console.log("concluída"); }
else if (cmd === "pausar") { await call("/fila/pausar", "POST"); console.log("fila pausada — nada novo começa"); }
else if (cmd === "retomar") { await call("/fila/retomar", "POST"); console.log("fila retomada"); }
else if (cmd === "reiniciar") { const d = await call("/reiniciar", "POST"); console.log(d.aviso); }
else if (cmd === "rm") { await call(`/tasks/${id()}`, "DELETE"); console.log("excluída"); }
else if (cmd === "say") {
  const text = a[1]; if (!text) { console.error('uso: board say <id> "<mensagem>"'); process.exit(1); }
  await call(`/tasks/${id()}/chat`, "POST", { text }); console.log("enviada — a resposta aparece no board (ou: board show " + id() + ")");
} else if (cmd === "seguir") {
  await seguir(id());
} else if (cmd === "barra") {
  await barra();
} else if (cmd === "resumo") {
  await resumo();
} else if (cmd === "painel") {
  await painel();
} else if (cmd === "agentes") {
  await agentesTmux(a.includes("--abrir"));
} else {
  console.log(`board — uso:\n  add "<texto>" [projeto] [--fila] [--pr] · list · show <id> · run <id> · stop <id> · done <id> · say <id> "<msg>" · rm <id> · pausar · retomar · reiniciar · agentes [--abrir] · seguir <id>`);
}

