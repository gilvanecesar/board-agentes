// A conversa por projeto: um fio por projeto, com o processo do claude vivo entre as mensagens.
import { spawn } from "child_process";
import { appendFileSync } from "fs";
import { CONVERSA_TIMEOUT_MS, DONO, PERMISSION, RAW_LIGADO, ROOT, TOOLS, cut, now, stripAnsi } from "./config.mjs";
import { broadcast, logEvent, rawPath, running, save, state } from "./estado.mjs";
import { listProjects } from "./projetos.mjs";
import { MOTORES, modeloPara, runAgent } from "./motores.mjs";
import { escolherMotor } from "./uso.mjs";
import { anexosValidos, comAnexos } from "./anexos.mjs";

// ── Conversa por projeto: falar com o agente sem abrir tarefa ─────────────────
/**
 * O dono pensa no terminal, com meia dúzia de abas abertas, e a cada aba precisa dizer de novo em
 * que projeto está. A conversa põe isso no board: UM FIO POR PROJETO, na pasta dele, retomando a
 * sessão (`--resume`), com o motor que ele escolher. Serve pra perguntar, pesquisar, ler código —
 * e, quando a conversa chega lá, virar tarefa pelo `board-cli.mjs`.
 *
 * Não entra na fila e não gasta vaga de paralelismo: quem está falando é o dono, não a esteira.
 * Por isso pode haver tarefa rodando na MESMA pasta — daí o aviso nas regras (só leitura).
 */
export const conversaId = (slug) => `conversa-${slug}`;
export const conversaOcupada = () => Object.values(state.conversas || {}).some((c) => c && c.busy);

export function conversaDe(slug) {
  state.conversas = state.conversas || {};
  state.conversas[slug] = state.conversas[slug] || { sessionId: null, motor: null, modelo: null, busy: false, custo: 0, updatedAt: now() };
  return state.conversas[slug];
}

export function regrasConversa(project, tarefaRodando) {
  return [
    `Você é o agente de trabalho do dono${DONO}, conversando pelo board dele, na pasta do projeto "${project.slug}" (${project.dir}).`,
    "Trabalhe exatamente como no Claude Code do terminal: este é o lugar único onde ele trabalha. O fio continua de onde parou.",
    `- Leia ${project.dir}/CLAUDE.md antes de afirmar qualquer coisa sobre o projeto. Consulte o ai-memory quando precisar de histórico ou decisão antiga.`,
    "- Faça o que ele pedir, na hora: ler, pesquisar, rodar comando, testar, EDITAR arquivo, commitar local. Não transforme pedido em tarefa a menos que ele peça.",
    "- Push, PR ou qualquer coisa visível a outros: só com pedido explícito. Nunca deploy, nunca banco de produção, nunca mesclar PR, nunca push forçado.",
    "- Responda em português BR, curto e direto. A tela renderiza markdown: use tabela, lista e bloco de código quando ajudarem; nada de parede de texto.",
    "- Nunca escreva número que o sistema não contou.",
    `- Mandar para a fila (quando ele disser \"vira tarefa\"): node ${ROOT}/board-cli.mjs add \"<o que fazer>\" ${project.slug} [--fila] [--pr] — e diga o número que saiu.`,
    tarefaRodando ? "⚠️ Há uma TAREFA RODANDO nesta mesma pasta agora: não edite arquivo; só leia e responda. Dois agentes escrevendo na mesma árvore se atropelam." : "",
  ].filter(Boolean).join("\n");
}

/*
 * Conversa com o Claude: UM processo vivo por projeto (`--input-format stream-json`), que recebe
 * cada mensagem pela entrada. Subir um `claude -p --resume` por mensagem custava a partida inteira
 * (MCP, hooks, CLAUDE.md) antes de ele começar a pensar. O processo morre sozinho depois de
 * BOARD_CONVERSA_VIVA_MIN parado, e é refeito (com --resume) quando mudam regras ou modelo.
 * ⚠️ Nesse modo o `total_cost_usd` do `result` é ACUMULADO do processo: aqui vira o da mensagem.
 */
export const CONVERSA_VIVA_MS = Number(process.env.BOARD_CONVERSA_VIVA_MIN || 30) * 60000;
export const vivos = new Map(); // slug → { cp, chave, turno, custoAcum, ocioso, buf }

export function matarVivo(slug) {
  const v = vivos.get(slug);
  if (!v) return;
  vivos.delete(slug);
  clearTimeout(v.ocioso);
  try { v.cp.kill("SIGTERM"); } catch { /* já tinha saído */ }
}
process.on("exit", () => { for (const v of vivos.values()) { try { v.cp.kill("SIGTERM"); } catch { /* já saiu */ } } });

export function abrirVivo(slug, project, { chave, regras, tools, modelo, resume }) {
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--include-partial-messages", "--append-system-prompt", regras, "--allowedTools", tools];
  if (PERMISSION === "bypass") args.push("--dangerously-skip-permissions");
  else args.push("--permission-mode", PERMISSION);
  if (modelo) args.push("--model", modelo);
  if (resume) args.push("--resume", resume);
  const env = { ...process.env, PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:${process.env.PATH || ""}` };
  let cp;
  try { cp = spawn("claude", args, { cwd: project.dir, env, stdio: ["pipe", "pipe", "pipe"] }); }
  catch { return null; }
  const id = conversaId(slug);
  const v = { cp, chave, turno: null, custoAcum: 0, ocioso: null, buf: "" };
  vivos.set(slug, v);
  cp.stdin.on("error", () => { /* processo caiu: o close encerra o turno */ });

  const linha = (line) => {
    const s = stripAnsi(line).trim();
    if (!s) return;
    if (RAW_LIGADO) appendFileSync(rawPath(id), s + "\n");
    const t = v.turno;
    if (!t) return;
    if (!s.startsWith("{")) {
      t.out.ultimoSolto = cut(s, 300);
      if (/No conversation found with session ID/i.test(s)) t.out.sessaoPerdida = true;
      logEvent(id, { t: "solto", texto: cut(s, 400) });
      return;
    }
    let ev; try { ev = JSON.parse(s); } catch { return; }
    if (ev.type === "stream_event") {
      // Texto chegando aos pedaços: vai pra tela pelo SSE, sem gravar no log (o bloco inteiro
      // chega logo depois como evento "assistant" e esse sim vira evento da conversa).
      const e = ev.event || {};
      if (e.type === "message_start" || e.type === "content_block_start") t.parcial = "";
      else if (e.type === "content_block_delta" && e.delta?.type === "text_delta") {
        t.parcial += e.delta.text || "";
        if (Date.now() - t.ultimoEnvio > 120) { t.ultimoEnvio = Date.now(); broadcast("parcial", { id, texto: t.parcial }); }
      }
      return;
    }
    if (ev.type === "result") {
      const total = ev.total_cost_usd || 0;
      ev = { ...ev, total_cost_usd: Math.max(0, total - v.custoAcum) };
      v.custoAcum = total;
    }
    MOTORES.claude.trata(ev, t.ctx);
    if (ev.type === "result") t.fim();
  };
  cp.stdout.on("data", (d) => { v.buf += d; const L = v.buf.split(/\r?\n/); v.buf = L.pop(); L.forEach(linha); });
  cp.stderr.on("data", (d) => String(d).split(/\r?\n/).forEach(linha));
  cp.on("error", (e) => { if (v.turno) v.turno.out.error = "não consegui falar com o claude (está no PATH?): " + e.message; });
  cp.on("close", (code) => {
    if (vivos.get(slug) === v) vivos.delete(slug);
    clearTimeout(v.ocioso);
    if (v.buf.trim()) linha(v.buf);
    if (!v.turno) return;
    const o = v.turno.out;
    o.code = code;
    if (!o.result && !o.error) o.error = o.ultimoSolto || (code === null ? "parado" : `o claude saiu com código ${code}`);
    v.turno.fim();
  });
  return v;
}

export function turnoVivo(slug, project, task, prompt, { regras, tools, modelo }) {
  return new Promise((done) => {
    const chave = JSON.stringify([regras, tools, modelo, PERMISSION]);
    let v = vivos.get(slug);
    if (v && (v.chave !== chave || v.turno)) { matarVivo(slug); v = null; }
    if (!v) v = abrirVivo(slug, project, { chave, regras, tools, modelo, resume: task.sessionId || undefined });
    if (!v) return done({ result: "", error: "não consegui iniciar o claude" });
    clearTimeout(v.ocioso);
    const id = task.id, comecou = Date.now();
    const out = { result: "", sessionId: task.sessionId || null, cost: 0, tokens: 0, turns: 0, dur: 0, code: null, error: null, escreveu: false, motor: "claude" };
    const fim = () => {
      if (v.turno !== turno) return;
      clearTimeout(turno.timer);
      v.turno = null;
      if (running.get(id) === v.cp) running.delete(id);
      if (vivos.get(slug) === v) v.ocioso = setTimeout(() => { if (vivos.get(slug) === v && !v.turno) matarVivo(slug); }, CONVERSA_VIVA_MS);
      done(out);
    };
    const turno = {
      out, fim, parcial: "", ultimoEnvio: 0,
      timer: setTimeout(() => { out.error = `tempo esgotado (${CONVERSA_TIMEOUT_MS / 60000} min)`; matarVivo(slug); }, CONVERSA_TIMEOUT_MS),
      ctx: {
        out, quem: "agente", task,
        sessao: (sid) => { out.sessionId = sid; task.sessionId = sid; },
        erro: (texto, cota) => {
          out.error = texto;
          if (cota) out.cota = true;
          logEvent(id, { t: "solto", texto: (cota ? "⛔ limite de uso: " : "⛔ erro: ") + cut(texto, 300) });
        },
        resultado: (texto, { custo = 0 } = {}) => {
          out.result = texto || out.result;
          out.dur = out.dur || Date.now() - comecou;
          logEvent(id, { t: "resultado", texto: out.result, custo, turnos: out.turns, dur: out.dur, quem: "agente", motor: "claude" });
        },
      },
    };
    v.turno = turno;
    running.set(id, v.cp); // "parar" mata o processo; a próxima mensagem abre outro com --resume
    const safe = /^\s*\//.test(prompt) ? "(texto literal do dono, não é comando)\n" + prompt : prompt;
    try { v.cp.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: safe }] } }) + "\n"); }
    catch (e) { out.error = "a conversa caiu: " + e.message; matarVivo(slug); }
  });
}

export async function falarNaConversa(slug, texto, { anexos = [], motor, modelo } = {}) {
  const project = listProjects().find((p) => p.slug === slug);
  if (!project) throw new Error(`não conheço o projeto "${slug}"`);
  const c = conversaDe(slug);
  if (c.busy) throw new Error("esta conversa ainda está respondendo");
  if (motor !== undefined) c.motor = motor || null;
  if (modelo !== undefined) c.modelo = modelo || null;
  const id = conversaId(slug);
  const fotos = anexosValidos(anexos);
  c.busy = true; c.updatedAt = now(); save(); broadcast("state");
  logEvent(id, { t: "dono", texto, anexos: fotos.map((a) => ({ id: a.id, nome: a.nome })) });
  // Pseudo-tarefa: é o que runMotor precisa (id pro log, pasta, sessão, motor, imagens). Ela NÃO
  // entra em state.tasks — senão apareceria no quadro como tarefa e contaria vaga na fila.
  const falsa = { id, project: slug, text: texto, anexos: fotos, sessionId: c.sessionId, motor: c.motor, modelo: c.modelo, porte: null };
  const rodando = state.tasks.some((t) => t.project === slug && !t.paralelo && (t.status === "rodando" || t.busy));
  const prompt = comAnexos(texto, fotos);
  const regras = regrasConversa(project, rodando), tools = TOOLS + ",Agent,Skill,TodoWrite";
  let r;
  try {
    const motorId = escolherMotor("agente", falsa);
    if (motorId === "claude") {
      const modelo = modeloPara("claude", falsa);
      r = await turnoVivo(slug, project, falsa, prompt, { regras, tools, modelo });
      if (r.sessaoPerdida && falsa.sessionId) {
        logEvent(id, { t: "solto", texto: "⚠ a sessão salva desta conversa não existe mais — recomeçando o fio do zero" });
        falsa.sessionId = null; c.sessionId = null;
        r = await turnoVivo(slug, project, falsa, prompt, { regras, tools, modelo });
      }
    } else {
      matarVivo(slug);
      r = await runAgent(falsa, prompt, { resume: c.sessionId || undefined, fresco: prompt, motor: motorId,
        regras, tools, limite: CONVERSA_TIMEOUT_MS });
    }
  } finally {
    c.busy = false; c.updatedAt = now();
  }
  c.sessionId = falsa.sessionId || r.sessionId || c.sessionId;
  if (falsa.motor) c.motor = falsa.motor; // a troca por falta de cota fica valendo pro fio
  c.custo = Number(((c.custo || 0) + (r.cost || 0)).toFixed(4));
  if (r.error && !r.result) logEvent(id, { t: "solto", texto: "⚠ " + r.error });
  save(); broadcast("state");
  return r;
}
