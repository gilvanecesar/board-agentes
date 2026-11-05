// O quadro em disco (data/board.json), o lock de um board por quadro, o log de cada tarefa e o SSE para a tela.
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, renameSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import { ANEXOS, C, DATA, DEV, LOGS, RAW, STATE_FILE, clock, cut, now } from "./config.mjs";
import { lerRenomeados, renomearNoEstado, renomearNosArquivos } from "./renomear.mjs";
import { pedidoDeSim } from "./aprovacoes.mjs";

// ── estado ────────────────────────────────────────────────────────────────────
for (const d of [DATA, LOGS, RAW, ANEXOS]) if (!existsSync(d)) mkdirSync(d, { recursive: true });

export let state = { seq: 0, tasks: [], conversas: {} };
try { state = { seq: 0, tasks: [], conversas: {}, ...JSON.parse(readFileSync(STATE_FILE, "utf8")) }; } catch { /* primeiro uso */ }
// Projeto renomeado (`renomeados` no data/projetos.json, #250): o slug antigo vira o novo no estado e nos arquivos.
{
  const pares = lerRenomeados(DATA);
  if (pares.length) {
    const n = renomearNoEstado(state, pares, DEV), arqs = renomearNosArquivos(DATA, pares, DEV);
    if (n || arqs.length) {
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      console.log(`projeto renomeado (${pares.map(([a, b]) => `${a} → ${b}`).join(", ")}): ${n} no quadro${arqs.length ? `, ${arqs.join(", ")}` : ""}`);
    }
  }
}
// Só UM board por quadro: dois servidores no mesmo data/ rodam a mesma tarefa duas vezes
// (já aconteceu: dois agentes editando o mesmo projeto ao mesmo tempo).
// #309 (02/11): depois de um desligamento forçado o lock trazia o pid do boot anterior; no boot novo esse número era de
// um processo de OUTRO usuário, o kill(pid, 0) deu EPERM e o board recusou subir até o systemd desistir. Hoje o lock
// guarda pid + boot + hora de início do processo, e só vale se o mesmo processo ainda está vivo, deste usuário.
export const LOCK = join(DATA, "board.lock");
{
  const ocupado = donoDoLock(lerLock());
  if (ocupado.vivo) { console.error(`já existe um board rodando (pid ${ocupado.pid}) neste quadro — use esse, ou pare-o antes.`); process.exit(1); }
  if (ocupado.pid) console.log(`${C.dim}lock velho ignorado (pid ${ocupado.pid}: ${ocupado.porque}); sobrescrito.${C.r}`);
}
writeFileSync(LOCK, JSON.stringify({ pid: process.pid, boot: bootId(), inicio: inicioDoProcesso(process.pid), data: DATA }));

function lerLock() {
  let raw = ""; try { raw = readFileSync(LOCK, "utf8").trim(); } catch { return null; }
  if (/^\d+$/.test(raw)) return { pid: Number(raw) }; // formato antigo: só o pid
  try { const j = JSON.parse(raw); return Number(j?.pid) > 0 ? j : null; } catch { return null; }
}

/** Identificador do boot atual (muda a cada ligar da máquina). `null` se não dá para saber. */
export function bootId() {
  try { return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); } catch { /* não é Linux */ }
  try { return execFileSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8", timeout: 2000 }).trim() || null; } catch { return null; }
}

/** Quando o processo começou (no Linux, em ticks desde o boot; no Mac, a data do `ps`). `null` se não dá para saber. */
export function inicioDoProcesso(pid) {
  try { const s = readFileSync(`/proc/${pid}/stat`, "utf8"); return s.slice(s.lastIndexOf(")") + 2).split(" ")[19] || null; } catch { /* sem /proc */ }
  try { return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).trim() || null; } catch { return null; }
}

function linhaDeComando(pid) {
  try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " "); } catch { /* sem /proc */ }
  try { return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }); } catch { return ""; }
}

/** O lock é de um board VIVO deste quadro? `{vivo, pid, porque}` — `porque` diz por que um lock velho não vale. */
export function donoDoLock(lock) {
  const pid = Number(lock?.pid);
  if (!pid || pid === process.pid) return { vivo: false, pid: 0 };
  try { process.kill(pid, 0); } catch (e) {
    // EPERM = o pid existe, mas é de outro usuário: um board deste quadro seria do dono do data/ (#309).
    return { vivo: false, pid, porque: e.code === "EPERM" ? "o número agora é de um processo de outro usuário" : "o processo não existe mais" };
  }
  if (lock.boot && bootId() && lock.boot !== bootId()) return { vivo: false, pid, porque: "é de antes de a máquina reiniciar" };
  if (lock.inicio) {
    const agora = inicioDoProcesso(pid);
    if (agora && agora !== String(lock.inicio)) return { vivo: false, pid, porque: "o número agora é de outro processo" };
    if (agora) return { vivo: true, pid };
  }
  // Lock antigo (só o pid) ou sem como saber a hora de início: vale só se o processo é um node do board.
  return /board/.test(linhaDeComando(pid)) ? { vivo: true, pid } : { vivo: false, pid, porque: "o número agora é de outro programa" };
}

// Tarefa que estava "rodando" quando o board caiu NÃO volta pra fila sozinha: o processo antigo
// pode ter deixado meia mudança no projeto. Fica pendente, com o motivo no log, e o dono decide.
export const interrupted = state.tasks.filter((t) => t.status === "rodando");
for (const t of state.tasks) { t.busy = false; t.etapa = null; t.classificando = false; if (t.status === "rodando") t.status = "pendente"; }
// `ouvindo` também: turno de outra sessão cortado no meio deixaria "lendo mensagem" na tela e o `board tela link` recusado (#302).
for (const c of Object.values(state.conversas || {})) { c.busy = false; c.ouvindo = false; }

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
  // Conversa e Central (26/10): cada resposta com texto ganha um número (R1, R2…) contado AQUI, pelo log — não pelo
  // modelo. É por ele que o dono responde a uma resposta antiga ("Sobre R12: …"). 🧹 novo fio apaga o log e recomeça do R1.
  if (full.t === "resultado" && full.texto && String(id).startsWith("conversa-") && full.n == null)
    full.n = readLog(id).filter((e) => e.t === "resultado" && e.n).length + 1;
  // Central (#213): a resposta que termina em "PEDIDO DE SIM: …" ganha o botão Aprovar na tela.
  if (full.t === "resultado" && id === "conversa-central" && full.pedidoSim == null) { const p = pedidoDeSim(full.texto); if (p) full.pedidoSim = p; }
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
