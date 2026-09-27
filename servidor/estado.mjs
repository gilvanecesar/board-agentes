// O quadro em disco (data/board.json), o lock de um board por quadro, o log de cada tarefa e o SSE para a tela.
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, renameSync } from "fs";
import { join } from "path";
import { ANEXOS, C, DATA, LOGS, RAW, STATE_FILE, clock, cut, now } from "./config.mjs";

// ── estado ────────────────────────────────────────────────────────────────────
for (const d of [DATA, LOGS, RAW, ANEXOS]) if (!existsSync(d)) mkdirSync(d, { recursive: true });

export let state = { seq: 0, tasks: [], conversas: {} };
try { state = { seq: 0, tasks: [], conversas: {}, ...JSON.parse(readFileSync(STATE_FILE, "utf8")) }; } catch { /* primeiro uso */ }
// Só UM board por quadro: dois servidores no mesmo data/ rodam a mesma tarefa duas vezes
// (já aconteceu: dois agentes editando o mesmo projeto ao mesmo tempo).
export const LOCK = join(DATA, "board.lock");
try {
  const pid = Number(readFileSync(LOCK, "utf8"));
  if (pid && pid !== process.pid) { process.kill(pid, 0); console.error(`já existe um board rodando (pid ${pid}) neste quadro — use esse, ou pare-o antes.`); process.exit(1); }
} catch (e) { if (e.code === "EPERM") { console.error("já existe um board rodando neste quadro."); process.exit(1); } }
writeFileSync(LOCK, String(process.pid));

// Tarefa que estava "rodando" quando o board caiu NÃO volta pra fila sozinha: o processo antigo
// pode ter deixado meia mudança no projeto. Fica pendente, com o motivo no log, e o dono decide.
export const interrupted = state.tasks.filter((t) => t.status === "rodando");
for (const t of state.tasks) { t.busy = false; t.etapa = null; t.classificando = false; if (t.status === "rodando") t.status = "pendente"; }
for (const c of Object.values(state.conversas || {})) c.busy = false;

export function save() {
  const tmp = STATE_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_FILE);
}

export const taskById = (id) => state.tasks.find((t) => t.id === Number(id));
export const titleOf = (text) => cut(String(text).split(/\r?\n/).find((l) => l.trim()) || "", 110);

// ── log por tarefa (eventos compactos que a tela entende) ─────────────────────
export const logPath = (id) => join(LOGS, `${id}.jsonl`);
export const rawPath = (id) => join(RAW, `${id}.jsonl`);

export function readLog(id) {
  let raw = "";
  try { raw = readFileSync(logPath(id), "utf8"); } catch { return []; }
  const out = [];
  for (const line of raw.split(/\r?\n/)) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch { /* linha torta */ } }
  return out;
}

export function logEvent(id, ev) {
  const full = { at: now(), ...ev };
  appendFileSync(logPath(id), JSON.stringify(full) + "\n");
  broadcast("log", { id, ev: full });
  printEvent(id, full);
}

/** O argumento que identifica a chamada — é o que diz "rodando npm test", não só "Bash". */
export const toolTarget = (input = {}) =>
  cut(input.command || input.file_path || input.pattern || input.path || input.description || input.prompt || "", 100);

export function printEvent(id, ev) {
  const tag = `${C.dim}#${id}${C.r}`;
  if (ev.t === "inicio") console.log(`\n${C.amber}▶ ${clock()} #${id}${C.r} ${C.txt}${ev.titulo}${C.r} ${C.dim}(${ev.projeto})${C.r}`);
  else if (ev.t === "ferramenta") console.log(`  ${tag} ${C.cyan}▸ ${ev.nome}${C.r} ${C.dim}${ev.alvo}${C.r}`);
  else if (ev.t === "texto") console.log(`  ${tag} ${ev.quem === "revisor" ? C.cyan + "🔍 " : ev.quem === "qa" ? C.amber + "🧪 " : ""}${C.txt}${cut(ev.texto, 160)}${C.r}`);
  else if (ev.t === "dono") console.log(`  ${tag} ${C.amber}dono:${C.r} ${cut(ev.texto, 160)}`);
  else if (ev.t === "resultado") console.log(`  ${tag} ${C.green}✓ resultado${C.r} ${C.dim}US$ ${(ev.custo || 0).toFixed(2)} · ${ev.turnos || 0} turno(s) · ${Math.round((ev.dur || 0) / 1000)}s${C.r}`);
  else if (ev.t === "fim") console.log(`${ev.status === "erro" ? C.red + "✗" : C.green + "✓"} ${clock()} #${id}${C.r} ${C.dim}${ev.status}${ev.motivo ? " — " + ev.motivo : ""}${C.r}\n`);
  else if (ev.t === "romaneio") console.log(`  ${tag} ${C.cyan}📦 romaneio${C.r} ${C.dim}${(ev.itens || []).length} memórias · ~${ev.tokens} tokens · ${(ev.mentes || []).join(", ")}${C.r}`);
  else if (ev.t === "solto") console.log(`  ${tag} ${C.dim}${cut(ev.texto, 160)}${C.r}`);
  else if (ev.t === "busca") console.log(`  ${C.dim}🔎${C.r} ${C.txt}${cut(ev.consulta, 80)}${C.r} ${C.dim}${ev.modo === "semantica" ? ev.provedor : "por palavra"} · ${(ev.achados || []).length ? (ev.achados || []).map((a) => "#" + a.id).join(" ") : "nada"} · ${ev.ms}ms${C.r}`);
  else if (ev.t === "portao") {
    if (ev.estado === "rodando") console.log(`  ${tag} ${C.cyan}⛨ portão${C.r} ${C.dim}$ ${ev.comando}${C.r}`);
    else if (ev.estado === "passou") console.log(`  ${tag} ${C.green}⛨ portão passou${C.r}`);
    else { console.log(`  ${tag} ${C.red}⛨ portão FALHOU${C.r} ${C.dim}(código ${ev.code})${C.r}`); for (const l of String(ev.saida || "").split("\n").slice(-12)) console.log(`     ${C.dim}${cut(l, 150)}${C.r}`); }
  } else if (ev.t === "passo") {
    const nome = ev.nome === "merge" ? "mesclar" : "publicar";
    if (ev.estado === "rodando") console.log(`  ${tag} ${C.amber}⇪ ${nome}${C.r} ${C.dim}$ ${cut(ev.comando, 120)}${C.r}`);
    else if (ev.estado === "passou") console.log(`  ${tag} ${C.green}⇪ ${nome} ok${C.r}`);
    else { console.log(`  ${tag} ${C.red}⇪ ${nome} FALHOU${C.r} ${C.dim}(código ${ev.code})${C.r}`); for (const l of String(ev.saida || "").split("\n").slice(-12)) console.log(`     ${C.dim}${cut(l, 150)}${C.r}`); }
  } else if (ev.t === "revisor" || ev.t === "qa") {
    const cor = ev.veredito === "APROVADO" ? C.green : C.red;
    console.log(`  ${tag} ${cor}${ev.t === "qa" ? "🧪 QA" : "🔍 revisor"}: ${ev.veredito}${C.r}`);
    for (const l of String(ev.texto || "").split("\n").slice(0, 8)) if (l.trim()) console.log(`     ${C.dim}${cut(l, 150)}${C.r}`);
  }
}

// ── rodar o claude (runner e chat usam o mesmo caminho) ───────────────────────
export const running = new Map(); // id → processo do claude
export const gates = new Map();

// ── HTTP + SSE ────────────────────────────────────────────────────────────────
export const clients = new Set();
export function broadcast(event, data = {}) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) { try { res.write(msg); } catch { clients.delete(res); } }
}
