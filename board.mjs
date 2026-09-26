#!/usr/bin/env node
/**
 * BOARD — o quadro de tarefas do dono, com runner de `claude`.
 *
 * O que faz: você inclui tarefas por um chat (tela principal), cada tarefa entra na fila e
 * o runner roda `claude -p` na pasta do projeto. A tela de detalhe mostra o que está
 * acontecendo com a tarefa (texto do agente, ferramentas, resultado, custo) e tem um chat
 * pra discutir a tarefa — a conversa continua a MESMA sessão do claude (--resume).
 * No terminal onde o board roda aparece, ao vivo, o que está rodando.
 *
 *   node board.mjs            → http://localhost:4488
 *
 * Sem dependência npm — só Node built-in. Estado em data/board.json, log por tarefa em
 * data/logs/<id>.jsonl (eventos compactos) e data/raw/<id>.jsonl (stream-json cru).
 *
 * Variáveis (opcionais):
 *   BOARD_PORT=4488            BOARD_PARALELO=4 (teto geral) · BOARD_POR_PROJETO=1 (agentes por projeto)
 *   BOARD_MODELO=opus          BOARD_TIMEOUT_MIN=90
 *   BOARD_TOOLS="Read,Edit,..." BOARD_PERMISSAO=acceptEdits|bypass
 */
import { createServer } from "http";
import { randomUUID, createHash } from "crypto";
import { spawn, execFile, execFileSync } from "child_process";
import { tmpdir } from "os";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync, renameSync, unlinkSync, statSync, symlinkSync } from "fs";
import { resolve, dirname, join, relative } from "path";
import { fileURLToPath } from "url";
import { buscar, indexar, estadoBusca } from "./busca.mjs"; // procurar tarefa pelo sentido (embeddings)

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const DEV = process.env.BOARD_PROJETOS || dirname(ROOT); // ~/Documents/DEV — os projetos são as pastas irmãs (no Docker: /projetos)
const DATA = resolve(ROOT, "data");
const LOGS = join(DATA, "logs");
const RAW = join(DATA, "raw");
const ANEXOS = join(DATA, "anexos"); // imagens que o dono cola/arrasta na tarefa ou no chat
const STATE_FILE = join(DATA, "board.json");
const WEB = join(ROOT, "web", "index.html");

const PORT = Number(process.env.BOARD_PORT || 4488);
// O servidor sempre ligado (Monitoramento, Controle, cópia do board): um apelido do ~/.ssh/config.
const SERVIDOR = process.env.BOARD_SERVIDOR || "saturno";
// Paralelismo: UM agente por projeto (duas sessões na mesma pasta se atropelam nos arquivos)
// e um teto geral. Tarefas de projetos diferentes rodam ao mesmo tempo.
const PARALLEL = Math.max(1, Number(process.env.BOARD_PARALELO || 4));       // teto geral
const PER_PROJECT = Math.max(1, Number(process.env.BOARD_POR_PROJETO || 1)); // por projeto
// ⚡ Agentes em paralelo no MESMO projeto (só quando o dono marca): cada um numa cópia isolada
// (worktree git) em DEV/.board-agentes — a pasta com ponto não vira "projeto". A pasta principal
// continua com um agente só (PER_PROJECT); as cópias têm teto próprio.
const PARALELO_POR_PROJETO = Math.max(1, Number(process.env.BOARD_PARALELO_POR_PROJETO || 3));
const AGENTES_DIR = join(DEV, ".board-agentes");
// Produção: o agente ⚡ entrega por PR (regra de ouro do portfólio); nos outros o board junta na pasta.
const PRODUCAO = (process.env.BOARD_PRODUCAO || "").split(",").map((x) => x.trim()).filter(Boolean); // projetos que SEMPRE trabalham em cópia e entregam por PR
const DONO = process.env.BOARD_DONO ? ` (${process.env.BOARD_DONO})` : ""; // o nome do dono nas regras dos agentes
const TIMEOUT_MS = Number(process.env.BOARD_TIMEOUT_MIN || 90) * 60000;
// A conversa é conversa: resposta que demora meia hora não é resposta. Teto próprio, bem menor.
const CONVERSA_TIMEOUT_MS = Number(process.env.BOARD_CONVERSA_MIN || 15) * 60000; // 45 → 90 em 17/09: tarefa full-stack (migração + motor + tela + portão de 5 min) não cabia em 45
// board.env (opcional, ao lado deste arquivo): BOARD_MODELO=…, BOARD_MODELO_REVISOR=…, BOARD_MODELO_QA=…, BOARD_TIMEOUT_MIN=…
// Lido a cada subida do processo — o "reiniciar" da tela/CLI basta para trocar de modelo, sem mexer no board.sh que está rodando.
try { process.loadEnvFile(new URL("./board.env", import.meta.url).pathname); } catch { /* sem board.env: só o ambiente */ }
const MODEL = process.env.BOARD_MODELO || "";
const TOOLS = process.env.BOARD_TOOLS ||
  "Read,Edit,Write,MultiEdit,NotebookEdit,Grep,Glob,Bash,WebFetch,WebSearch,mcp__ai-memory";
const PERMISSION = process.env.BOARD_PERMISSAO || "acceptEdits";
// Motor = qual CLI roda a tarefa. O do agente é escolhido POR TAREFA na tela; revisor e QA têm o
// seu (padrão claude), de propósito: agente no Codex revisado pelo Claude é conferência cruzada.
const MOTOR_PADRAO = process.env.BOARD_MOTOR || "claude";
const MOTOR_REVISOR = process.env.BOARD_MOTOR_REVISOR || "claude";
const MOTOR_QA = process.env.BOARD_MOTOR_QA || "claude";
// Modelo por PORTE da tarefa (leve/normal/pesado), por motor. O dono ajusta em data/modelos.json;
// escolher o modelo na mão continua valendo e ganha do porte.
const MODELOS_FILE = join(DATA, "modelos.json");
// Modelo padrão POR MOTOR. ⚠️ BOARD_MODELO é do motor padrão (histórico): aplicá-lo a todos fazia
// o Codex receber "claude-opus-5" e recusar a tarefa (22/09/2026).
const MODELO_PADRAO = {
  [MOTOR_PADRAO]: process.env.BOARD_MODELO || "",
  claude: process.env.BOARD_MODELO_CLAUDE || (MOTOR_PADRAO === "claude" ? process.env.BOARD_MODELO || "" : ""),
  codex: process.env.BOARD_MODELO_CODEX || "",
  gemini: process.env.BOARD_MODELO_GEMINI || "",
  opencode: process.env.BOARD_MODELO_OPENCODE || "",
};
/** O modelo combina com o motor? Família errada é recusa na hora do CLI, não vale nem tentar. */
function modeloServe(motorId, m) {
  const nome = String(m || "").trim();
  if (!nome) return false;
  if (motorId === "opencode") return nome.includes("/");
  if (nome.includes("/")) return false;
  const familia = { claude: /^(claude|haiku|sonnet|opus)/i, codex: /^(gpt|o\d|codex)/i, gemini: /^gemini/i }[motorId];
  const deOutro = [/^claude|^haiku$|^sonnet$|^opus$/i, /^gpt|^o\d/i, /^gemini/i]
    .filter((rx) => rx !== familia).some((rx) => rx.test(nome));
  return familia ? familia.test(nome) || !deOutro : !deOutro;
}
const PORTES = ["leve", "normal", "pesado"];
// No CLAUDE o porte regula o ESFORÇO (--effort), não o modelo: o agente é sempre o modelo padrão.
// normal = padrão do CLI, igual a antes; só o leve pensa menos e o pesado pensa mais (decisão do
// dono em 24/09: "quero coisa boa e rápida" — trocar por modelo mais fraco piorava o trabalho).
const ESFORCO_CLAUDE = {
  leve: process.env.BOARD_ESFORCO_LEVE ?? "low",
  normal: process.env.BOARD_ESFORCO_NORMAL ?? "",
  pesado: process.env.BOARD_ESFORCO_PESADO ?? "xhigh",
};
// Tarefa nova sem porte nem modelo fixo é classificada por uma chamada curta (haiku, sem ferramenta).
const CLASSIFICAR = process.env.BOARD_CLASSIFICAR !== "0";
// Portão: a verificação do próprio projeto (tsc/test). Não gasta token — é o comando da casa.
const GATE_TIMEOUT_MS = Number(process.env.BOARD_PORTAO_TIMEOUT_MIN || 8) * 60000;
const GATE_FILE = join(DATA, "portao.json"); // { "<slug>": "comando" } — "" desliga o portão
// Revisor: só nas tarefas marcadas como PR. Lê o diff, não escreve código.
const REVIEW_MODEL = process.env.BOARD_MODELO_REVISOR || "sonnet";
const REVIEW_ROUNDS = Math.max(0, Number(process.env.BOARD_REVISOES ?? 1)); // rodadas de conserto
// Esteira de conferência em toda tarefa que mexe em arquivo: portão → revisor → QA.
// Desligáveis por env (BOARD_REVISOR=0, BOARD_QA=0) sem mexer em código.
const REVISOR_LIGADO = process.env.BOARD_REVISOR !== "0";
const QA_LIGADO = process.env.BOARD_QA !== "0";
const QA_MODEL = process.env.BOARD_MODELO_QA || "sonnet";
const QA_TIMEOUT_MS = Number(process.env.BOARD_QA_TIMEOUT_MIN || 20) * 60000;
// Mesclar e publicar: só existe para projeto com comando DECLARADO em data/deploy.json.
// O arquivo nasce vazio de propósito — escrever o comando ali é o ato de autorizar.
const DEPLOY_FILE = join(DATA, "deploy.json");
// Fila pausada = um ARQUIVO, não memória: a pausa tem que sobreviver ao reinício (pausar e reiniciar
// era justamente o pedido do dono — com a pausa só em memória, o board voltava e pegava a próxima).
const PAUSE_FLAG = join(DATA, "fila-pausada");
const filaPausada = () => existsSync(PAUSE_FLAG);
// Retentativa automática de tarefa em erro (fora cota, que pausa a fila e não conta).
const RETRY_MAX = Math.max(0, Number(process.env.BOARD_RETENTATIVAS ?? 2));
const RETRY_DELAY_MS = Number(process.env.BOARD_RETENTATIVA_MIN || 2) * 60000;
const DEPLOY_TIMEOUT_MS = Number(process.env.BOARD_DEPLOY_TIMEOUT_MIN || 20) * 60000;

const STATUSES = ["pendente", "fila", "rodando", "executada", "concluida", "erro"];
const STARTED_AT = new Date().toISOString();

// ── cores do terminal ─────────────────────────────────────────────────────────
const C = {
  amber: "\x1b[1;38;2;232;179;71m", green: "\x1b[1;38;2;55;207;124m", red: "\x1b[1;38;2;235;110;110m",
  cyan: "\x1b[1;38;2;53;193;239m", dim: "\x1b[38;2;109;130;153m", txt: "\x1b[38;2;234;243;248m", r: "\x1b[0m",
};
const now = () => new Date().toISOString();
const clock = () => new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
const cut = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

// ── estado ────────────────────────────────────────────────────────────────────
for (const d of [DATA, LOGS, RAW, ANEXOS]) if (!existsSync(d)) mkdirSync(d, { recursive: true });

let state = { seq: 0, tasks: [], conversas: {} };
try { state = { seq: 0, tasks: [], conversas: {}, ...JSON.parse(readFileSync(STATE_FILE, "utf8")) }; } catch { /* primeiro uso */ }
// Só UM board por quadro: dois servidores no mesmo data/ rodam a mesma tarefa duas vezes
// (já aconteceu: dois agentes editando o mesmo projeto ao mesmo tempo).
const LOCK = join(DATA, "board.lock");
try {
  const pid = Number(readFileSync(LOCK, "utf8"));
  if (pid && pid !== process.pid) { process.kill(pid, 0); console.error(`já existe um board rodando (pid ${pid}) neste quadro — use esse, ou pare-o antes.`); process.exit(1); }
} catch (e) { if (e.code === "EPERM") { console.error("já existe um board rodando neste quadro."); process.exit(1); } }
writeFileSync(LOCK, String(process.pid));

// Tarefa que estava "rodando" quando o board caiu NÃO volta pra fila sozinha: o processo antigo
// pode ter deixado meia mudança no projeto. Fica pendente, com o motivo no log, e o dono decide.
const interrupted = state.tasks.filter((t) => t.status === "rodando");
for (const t of state.tasks) { t.busy = false; t.etapa = null; t.classificando = false; if (t.status === "rodando") t.status = "pendente"; }
for (const c of Object.values(state.conversas || {})) c.busy = false;

function save() {
  const tmp = STATE_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_FILE);
}

const taskById = (id) => state.tasks.find((t) => t.id === Number(id));
const titleOf = (text) => cut(String(text).split(/\r?\n/).find((l) => l.trim()) || "", 110);

// ── projetos = pastas irmãs em ~/Documents/DEV com .git, CLAUDE.md ou package.json ─
let projCache = null;
function listProjects() {
  if (projCache && Date.now() - projCache.t < 20000) return projCache.v;
  const out = [{ slug: "DEV", dir: DEV, label: "DEV (raiz)" }];
  for (const e of readdirSync(DEV, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
    const dir = join(DEV, e.name);
    if (["git", "CLAUDE.md", "package.json"].some((f) => existsSync(join(dir, f === "git" ? ".git" : f))))
      out.push({ slug: e.name, dir, label: e.name });
  }
  projCache = { t: Date.now(), v: out };
  return out;
}
const projetoBase = (task) => listProjects().find((p) => p.slug === task.project) || listProjects()[0];
// Tarefa ⚡ trabalha na cópia dela: agente, portão, revisor, QA e PR usam esta pasta, não a principal.
const projectOf = (task) => {
  const p = projetoBase(task);
  return task?.worktree?.dir && !task.worktree.removida && existsSync(task.worktree.dir)
    ? { ...p, dir: task.worktree.dir, principal: p.dir } : p;
};
const git = (dir, args, opts = {}) => execFileSync("git", ["-C", dir, ...args],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000, maxBuffer: 64 << 20, ...opts });

/** O nome do agente (#eng01, #eng02…): o menor livre entre os que estão trabalhando no projeto. */
function nomeDeAgente(task) {
  const usados = new Set(state.tasks.filter((t) => t !== task && t.project === task.project && (t.status === "rodando" || t.busy) && t.agente).map((t) => t.agente));
  if (task.agente && !usados.has(task.agente)) return task.agente; // retentativa mantém o nome
  for (let n = 1; ; n++) { const nome = "eng" + String(n).padStart(2, "0"); if (!usados.has(nome)) return nome; }
}

/**
 * Cria a cópia isolada da tarefa ⚡. Parte do estado ATUAL da pasta, inclusive o que está sem commit
 * (`git stash create` fotografa sem mexer na pasta) — senão o agente trabalharia em código velho e
 * o trabalho dele brigaria com o da pasta na volta. Produção parte do commit: o PR não pode levar
 * mudança alheia que só existe na pasta. Arquivo não rastreado da pasta principal não vem junto.
 */
function criarCopia(task) {
  const p = projetoBase(task);
  if (!existsSync(join(p.dir, ".git"))) throw new Error(`"${p.slug}" não é repositório git — cópia isolada (⚡ ou produção) precisa de git`);
  const dir = join(AGENTES_DIR, `${p.slug}-${task.id}`);
  mkdirSync(AGENTES_DIR, { recursive: true });
  const producao = PRODUCAO.includes(p.slug);
  let base = "";
  if (producao) {
    // Produção parte do que está PUBLICADO e atualizado, nunca do HEAD da pasta do dono: ela fica
    // para trás a cada PR mesclado, e quem nasce de main velha abre PR em cima de código velho.
    try { git(p.dir, ["fetch", "--quiet", "origin"]); } catch { /* sem rede: vale o que já está aqui */ }
    for (const ref of ["origin/HEAD", "origin/main", "origin/master"]) {
      try { base = git(p.dir, ["rev-parse", "--verify", "--quiet", ref]).trim(); } catch { /* ref não existe */ }
      if (base) break;
    }
  } else {
    try { base = git(p.dir, ["stash", "create"]).trim(); } catch { /* pasta limpa */ }
  }
  base = base || git(p.dir, ["rev-parse", "HEAD"]).trim();
  if (existsSync(dir)) { try { git(p.dir, ["worktree", "remove", "--force", dir]); } catch { /* sobra de antes */ } }
  git(p.dir, ["worktree", "add", "--detach", dir, base]);
  // node_modules não está no git: aponta para os da pasta principal (instalar de novo levaria minutos).
  try {
    const achados = execFileSync("find", [p.dir, "-maxdepth", "3", "-name", "node_modules", "-type", "d", "-prune"],
      { encoding: "utf8", timeout: 20000 }).split("\n").filter(Boolean);
    for (const nm of achados) {
      const alvo = join(dir, relative(p.dir, nm));
      if (!existsSync(alvo) && existsSync(dirname(alvo))) symlinkSync(nm, alvo);
    }
  } catch { /* sem node_modules: segue */ }
  task.worktree = { dir, base, aplicado: git(dir, ["rev-parse", "HEAD^{tree}"]).trim(), producao, juntar: null };
  logEvent(task.id, { t: "solto", texto: `⚡ #${task.agente} numa cópia isolada (${dir})`
    + (producao ? " — produção: entrega por PR" : " — o board junta na pasta principal quando a conferência aprovar") });
}

/**
 * Traz o trabalho da cópia para a pasta principal, como se o agente tivesse trabalhado lá (sem
 * commit — igual ao modo "direto"). `git apply` é tudo-ou-nada: com conflito, NADA entra na pasta,
 * a cópia fica guardada e o dono é avisado. Incremental: só o que mudou desde a última junção.
 */
function juntarNaPasta(task) {
  const wt = task.worktree, p = projetoBase(task);
  if (!wt || wt.producao || !existsSync(wt.dir)) return;
  let patch = "", arvore = "";
  try {
    git(wt.dir, ["add", "-A", "--", ".", ":(exclude,glob)**/node_modules"]);
    arvore = git(wt.dir, ["write-tree"]).trim();
    if (arvore !== wt.aplicado) patch = git(wt.dir, ["diff-tree", "-p", "--binary", "-r", wt.aplicado, arvore]);
  } catch (e) { patch = null; wt.erroJuntar = cut(String(e.stderr || e.message), 300); }
  if (patch === "") { wt.juntar = "ok"; save(); broadcast("state"); return; }
  let ok = false, erro = wt.erroJuntar || "";
  if (patch) {
    const arq = join(tmpdir(), `board-juntar-${task.id}-${Date.now()}.patch`);
    writeFileSync(arq, patch);
    try { git(p.dir, ["apply", "--binary", "--whitespace=nowarn", arq]); ok = true; }
    catch (e) { erro = cut(String(e.stderr || e.message), 300); }
    try { unlinkSync(arq); } catch { /* tmp */ }
  }
  if (ok) {
    wt.aplicado = arvore; wt.juntar = "ok"; wt.erroJuntar = null;
    logEvent(task.id, { t: "solto", texto: `⇲ #${task.agente} juntou o trabalho na pasta principal (${p.dir})` });
  } else {
    wt.juntar = "conflito";
    logEvent(task.id, { t: "solto", texto: `⚠ não deu para juntar na pasta principal — algo lá mudou nos mesmos trechos. Nada foi aplicado; o trabalho continua na cópia ${wt.dir}. ${erro}` });
  }
  save(); broadcast("state");
}

/*
 * A aba Monitoramento: ai-memory, Mac, Saturno e Google Drive. A leitura antiga rodava a cada 3 s
 * com execSync — travava o servidor inteiro por segundos — e testava o Drive com `rclone ls | head`,
 * cujo código de saída é o do head (dizia "online" com o rclone falhando). E o Drive "ficava
 * offline" porque o cliente padrão do rclone é compartilhado pelo mundo todo e estoura a cota
 * por minuto (403 RATE_LIMIT_EXCEEDED): o rclone espera ~50 s e consegue. Aqui: tudo assíncrono,
 * ai-memory e Saturno a cada 30 s, Drive a cada 10 min com até 2 min de espera. null = sem leitura.
 */
const INFRA = {
  timestamp: null,
  aiMemory: { online: null, url: null, host: null, pages: 0, sessoes: 0, observacoes: 0, motores: [] },
  copiaBoard: { quando: null, ok: null, erro: null },
  mac: { online: true },
  saturno: { online: null, tunnel: "ai-memory-tunnel" },
  googleDrive: { online: null, lastSync: null, lento: false, aviso: null, backups: {}, backupEmDia: null },
  docker: { mac: { online: null, containers: [] }, saturno: { online: null, containers: [] } },
};
// `docker ps -a` + `docker stats` numa chamada só (a mesma linha roda no Mac e, por ssh, no Saturno).
const DOCKER_LER = "docker ps -a --format '{{json .}}' && echo ---STATS--- && docker stats --no-stream --format '{{json .}}'";
function lerDocker(r, fora) {
  const tudo = r.out + r.err;
  if (!r.out.includes("---STATS---") && !/^\{/m.test(r.out)) {
    return { online: false, motivo: /Cannot connect|daemon/i.test(tudo) ? "Docker desligado" : fora, containers: [] };
  }
  const [ps, st = ""] = r.out.split("---STATS---");
  const stats = {};
  for (const l of st.split("\n")) { try { const j = JSON.parse(l); stats[j.Name] = { cpu: j.CPUPerc, mem: String(j.MemUsage || "").split(" / ")[0] }; } catch { /* linha vazia */ } }
  const containers = [];
  for (const l of ps.split("\n")) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    const projeto = (String(j.Labels || "").match(/com\.docker\.compose\.project=([^,]+)/) || [])[1] || "";
    const status = String(j.Status || "");
    containers.push({
      nome: j.Names, imagem: j.Image, estado: j.State, status, projeto,
      saude: /\(healthy\)/.test(status) ? "saudavel" : /unhealthy/.test(status) ? "doente" : /health: starting/.test(status) ? "subindo" : "",
      codigo: /Exited \((\d+)\)/.test(status) ? Number(status.match(/Exited \((\d+)\)/)[1]) : null,
      ...(stats[j.Names] || {}),
    });
  }
  return { online: true, containers };
}
const infraLida = { rapido: 0, drive: 0 };
let infraRodando = false;
const execP = (cmd, args, timeout, extra = {}) => new Promise((ok) => execFile(cmd, args,
  { timeout, encoding: "utf8", maxBuffer: 4 << 20, env: { ...process.env, ...extra, PATH: `/opt/homebrew/bin:${process.env.HOME}/.local/bin:/usr/local/bin:${process.env.PATH || ""}` } },
  (e, out, err) => ok({ ok: !e, out: String(out || ""), err: String(err || "") })));
// O endereço e o token da memória compartilhada (servidor no Saturno; na reserva, o do Mac).
function envMemoria() {
  try {
    const o = {};
    for (const m of readFileSync(join(process.env.HOME, ".ai-memory-env.sh"), "utf8").matchAll(/export (AI_MEMORY_[A-Z_]+)="([^"]*)"/g)) o[m[1]] = m[2];
    return o;
  } catch { return {}; }
}
// Cada motor está ligado à memória (MCP) e capturando (ganchos) no MESMO servidor? Lê a configuração
// de cada CLI — é isso que decide se a troca de modelo leva a memória junto.
function motoresDaMemoria(url) {
  const ler = (p) => { try { return readFileSync(join(process.env.HOME, p), "utf8"); } catch { return ""; } };
  const tem = (p) => !!url && ler(p).includes(url.replace(/^https?:\/\//, ""));
  return [
    { nome: "Claude Code", memoria: tem(".claude.json"), captura: tem(".claude/settings.json") },
    { nome: "Codex", memoria: tem(".codex/config.toml"), captura: tem(".codex/hooks.json") },
    { nome: "Gemini (agy)", memoria: tem(".gemini/config/mcp_config.json"), captura: tem(".gemini/config/hooks.json") },
    { nome: "opencode", memoria: tem(".config/opencode/opencode.json"), captura: tem(".config/opencode/plugins/ai-memory.ts") },
  ];
}
// Os dados do board vivem no Mac: o PRÓPRIO board os espelha no Saturno a cada 30 min (ele tem acesso
// à ~/Documents; o cron do macOS não tem), e o backup da madrugada do Saturno leva ao Drive.
function copiarBoardProSaturno() {
  execFile("rsync", ["-a", "--delete", "-e", "ssh -o BatchMode=yes -o ConnectTimeout=8", DATA + "/", SERVIDOR + ":backups/board-data/"],
    { timeout: 15 * 60000, env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH || ""}` } },
    (e, _o, err) => { INFRA.copiaBoard = { quando: new Date().toISOString(), ok: !e, erro: e ? cut(String(err || e.message), 200) : null }; });
}
// O cofre do Obsidian "Memória" (~/Documents/Memoria): espelho só-leitura do ai-memory do Saturno + memórias
// do Mac, para o dono VER o grafo. Mesmo motivo da cópia acima: quem tem acesso à ~/Documents é o board.
function atualizarCofreObsidian() {
  execFile(join(process.env.HOME, ".local/bin/memoria-obsidian"), [], { timeout: 5 * 60000 },
    (e) => { INFRA.espelho = { quando: new Date().toISOString(), ok: !e }; grafoCache.em = 0; });
}
const COM_ROTINAS = process.env.BOARD_SEM_ROTINAS !== "1"; // BOARD_SEM_ROTINAS=1: sem cópia para o servidor, sem espelho, sem leituras de fundo (demo)
if (COM_ROTINAS) {
  setTimeout(atualizarCofreObsidian, 120000);
  setInterval(atualizarCofreObsidian, 10 * 60000);
  setTimeout(copiarBoardProSaturno, 90000);
  setInterval(copiarBoardProSaturno, 30 * 60000);
}

async function lerInfra() {
  if (infraRodando) return;
  infraRodando = true;
  try {
    const agora = Date.now();
    if (agora - infraLida.rapido > 30000) {
      infraLida.rapido = agora;
      const env = envMemoria();
      const [mem, sat, dMac, dSat, marcas] = await Promise.all([
        execP("ai-memory", ["status"], 15000, env),
        execP("ssh", ["-o", "ConnectTimeout=4", "-o", "BatchMode=yes", SERVIDOR, "exit"], 8000),
        execP("sh", ["-c", DOCKER_LER], 15000),
        execP("ssh", ["-o", "ConnectTimeout=4", "-o", "BatchMode=yes", SERVIDOR, DOCKER_LER], 20000),
        execP("ssh", ["-o", "ConnectTimeout=4", "-o", "BatchMode=yes", SERVIDOR,
          "cd /var/lib/backup-memoria 2>/dev/null && for f in ULTIMO_*; do printf '%s=%s\\n' \"$f\" \"$(tr -d '\\n' < $f)\"; done"], 10000),
      ]);
      INFRA.docker.mac = lerDocker(dMac, "sem leitura");
      INFRA.docker.saturno = lerDocker(dSat, "Saturno fora do ar");
      const num = (k) => Number((mem.out.match(new RegExp(k + ":\\s*(\\d+)")) || [])[1] || 0);
      const m = mem.out.match(/pages:\s*(\d+)/);
      const url = env.AI_MEMORY_SERVER_URL || null;
      INFRA.aiMemory.online = mem.ok && !!m;
      INFRA.aiMemory.pages = m ? Number(m[1]) : 0;
      INFRA.aiMemory.sessoes = num("sessions"); INFRA.aiMemory.observacoes = num("observations");
      INFRA.aiMemory.url = url;
      INFRA.aiMemory.host = !url ? null : /127\.0\.0\.1|localhost/.test(url) ? "Mac (reserva)" : "Saturno";
      INFRA.aiMemory.motores = motoresDaMemoria(url);
      // Backups: as marcas que o /usr/local/sbin/backup-memoria.sh grava no Saturno.
      const mk = Object.fromEntries(marcas.out.split("\n").filter(Boolean).map((l) => l.split("=")).map(([k, ...v]) => [k, v.join("=")]));
      // Os backups dos bancos (e todos os outros) aparecem no Controle, que lê a lista de data/backups.json.
      INFRA.googleDrive.backups = { memoria: mk.ULTIMO_OK || null, board: mk.ULTIMO_BOARD_OK || null, arquivo: mk.ULTIMO_ARQUIVO || null };
      const datas = [INFRA.googleDrive.backups.memoria, INFRA.googleDrive.backups.board];
      INFRA.googleDrive.lastSync = datas.every(Boolean) ? datas.sort()[0] : null; // o mais velho dos dois
      INFRA.googleDrive.backupEmDia = marcas.ok ? datas.every((d) => d && Date.now() - Date.parse(d) < 26 * 3600000) : null;
      INFRA.saturno.online = sat.ok;
    }
    if (agora - infraLida.drive > 10 * 60000) {
      infraLida.drive = agora;
      const t0 = Date.now();
      const d = await execP("rclone", ["lsd", "gdrive_backup:", "--max-depth", "1", "-v"], 120000);
      const segundos = Math.round((Date.now() - t0) / 1000);
      const cota = /RATE_LIMIT_EXCEEDED|Quota exceeded/i.test(d.err);
      INFRA.googleDrive.online = d.ok;
      INFRA.googleDrive.lento = d.ok && (cota || segundos > 20);
      INFRA.googleDrive.aviso = !d.ok ? "o rclone não conseguiu falar com o Drive"
        : cota ? `respondeu em ${segundos} s: o cliente padrão do rclone estourou a cota por minuto do Google` : null;
    }
    INFRA.timestamp = new Date().toISOString();
  } finally { infraRodando = false; }
}

/*
 * O GRAFO DA MEMÓRIA (menu "Memória"): as páginas do ai-memory e as ligações [[…]] entre elas, lidas do
 * espelho que o board já mantém para o Obsidian (~/Documents/Memoria/ai-memory, a cada 10 min) — sem
 * leitura nova no Saturno. Só leitura: mudar a memória continua sendo pedir a um agente.
 */
const ESPELHO_MEMORIA = process.env.BOARD_ESPELHO_MEMORIA || join(process.env.HOME, "Documents", "Memoria", "ai-memory");
// TEMAS cortam os projetos: a memória de um projeto pode morar quase toda no _global (veio da memória portátil,
// que vale para todos), então "projeto" não acha ela — o tema acha pelo assunto do texto.
// Os temas vêm de data/mentes.json ("temas": {"Nome": "regex"}); sem arquivo, não há temas.
const temasDaMemoria = () => Object.fromEntries(Object.entries((lerMentes() || {}).temas || {}).map(([k, v]) => [k, new RegExp(v, "i")]));
let grafoCache = { em: 0, dado: null };
function tiraCabecalhos(txt) { // as páginas importadas têm DOIS frontmatters (o do ai-memory e o original)
  let t = String(txt); for (let i = 0; i < 3 && /^---\n/.test(t); i++) { const f = t.indexOf("\n---", 4); if (f < 0) break; t = t.slice(f + 4).replace(/^\n+/, ""); }
  return t;
}
// Quando a memória foi mexida DE VERDADE. A data do arquivo não serve: a migração de 25/09/2026 regravou todas.
// Ordem: "modified" (a última edição, que veio da memória do Claude) → "generated.at" (quando entrou no ai-memory).
function dataDaMemoria(bruto) {
  const m = bruto.match(/^\s+modified:\s*['"]?(\d{4}-\d\d-\d\dT[\d:.]+Z?)/m) || bruto.match(/^generated:\s*\n(?:\s+.*\n)*?\s+at:\s*['"]?(\d{4}-\d\d-\d\dT[\d:.]+Z?)/m);
  const t = m ? Date.parse(m[1]) : NaN;
  return Number.isFinite(t) ? t : null;
}

// ── Mentes: o endereçamento das memórias por ASSUNTO (o porta-palete do Galpão) ─────────────────────────
// Decisão do dono (26/09): 9 mentes + triagem; cada memória mora numa mente só, com "também serve para".
// O mapa vive em data/mentes.json: um agente PROPÕE, o dono confere as duvidosas e aprova. Nada disto escreve
// no ai-memory — levar a mente para lá é outro passo, depois da aprovação.
const MENTES_PADRAO = [
  { id: "dono", nome: "O Dono", icone: "🧭", desc: "como o dono trabalha e quer as coisas · área comum, todos carregam" },
  { id: "produto", nome: "Produto", icone: "📦", desc: "regras de negócio e funcionalidades do produto" },
  { id: "financeiro", nome: "Financeiro", icone: "💰", desc: "cobrança, pagamentos, dinheiro" },
  { id: "comercial", nome: "Comercial", icone: "📣", desc: "clientes, vendas, marketing" },
  { id: "design", nome: "Design e Telas", icone: "🎨", desc: "padrões de interface" },
  { id: "engenharia", nome: "Engenharia e Infra", icone: "🛠️", desc: "código, deploy, servidores, ferramentas" },
  { id: "seguranca", nome: "Segurança e Qualidade", icone: "🛡️", desc: "auditorias, testes, bugs que se repetem · revisor e QA" },
  { id: "triagem", nome: "Triagem", icone: "📥", desc: "área de recebimento: sem mente clara, ninguém carrega" },
];
// As mentes do dono (e as pistas e a mente de cada projeto) moram em data/mentes.json, fora do git.
const mentesDef = () => (lerMentes() || {}).definicoes || MENTES_PADRAO;
const MENTES_FILE = join(DATA, "mentes.json");
function lerMentes() { try { return JSON.parse(readFileSync(MENTES_FILE, "utf8")); } catch { return null; } }
function gravarMentes(m) { writeFileSync(MENTES_FILE + ".tmp", JSON.stringify(m, null, 1)); renameSync(MENTES_FILE + ".tmp", MENTES_FILE); }
function resumoMentes(m) {
  const mapa = (m && m.mapa) || {}; const v = Object.values(mapa);
  const conta = (f) => v.reduce((a, x) => { a[f(x)] = (a[f(x)] || 0) + 1; return a; }, {});
  return { existe: !!m, status: m ? m.status : null, geradoEm: m ? m.geradoEm : null, aprovadaEm: m ? m.aprovadaEm || null : null,
    total: v.length, porMente: conta((x) => x.mente), porConfianca: conta((x) => x.confianca),
    aRevisar: v.filter((x) => x.confianca === "media" || x.confianca === "baixa").length, mentes: mentesDef() };
}

// ── Romaneio: o picking da memória para cada tarefa (a doca do galpão) ─────────────────────────────────
// Na 1ª rodada (ou quando outro motor assume), o board separa as memórias que a tarefa pede e manda junto,
// escritas no pedido — então serve para QUALQUER motor, até sem MCP. Sem IA no picking: palavra do pedido
// contra a memória (IDF), dentro das mentes escolhidas. "O Dono" vai sempre, em forma de lista curta.
// Só roda com o endereçamento APROVADO. Desligar: BOARD_ROMANEIO=0. Tudo fica registrado na tarefa (task.romaneio)
// e na linha do tempo — é isso que permite medir turnos/custo com e sem romaneio.
const ROMANEIO_LIGADO = process.env.BOARD_ROMANEIO !== "0";
const PISTAS_PADRAO = {
  financeiro: "\\b(financ|boleto|pix|carteira|saldo|cobranc|assinatura|checkout|preco|plano|fatura|pagamento|dinheiro)",
  comercial: "\\b(crm|lead|campanha|prospec|e-?mail|marketing|funil|landing|cliente)",
  design: "\\b(tela|layout|botao|design|redesign|visual|css|cor|fonte|mobile|responsiv|ux|ui|modal|componente)",
  engenharia: "\\b(deploy|docker|nginx|servidor|backup|build|git|teste|migra|banco|postgres|redis|api|rota|endpoint|script|erro|bug|performance)",
  seguranca: "\\b(seguranc|idor|permiss|acesso|senha|token|auth|login|lgpd|vazamento|ataque|rate limit|valida|auditoria)",
};
const mentePorProjeto = () => (lerMentes() || {}).mentePorProjeto || {};
const pistasDaMente = () => Object.fromEntries(Object.entries((lerMentes() || {}).pistas || PISTAS_PADRAO).map(([k, v]) => [k, new RegExp(v)]));
const PARADAS = new Set("para pelo pela como mais sobre entre quando onde sem com uma um uns umas dos das nos nas que por isso esse essa este esta aqui tudo cada todo toda fazer faz feito tem ter vai vou ser está estão também ainda depois antes agora hoje".split(" "));
const palavrasDe = (t) => [...new Set(semAcentoServidor(t).match(/[a-z0-9]{4,}/g) || [])].filter((w) => !PARADAS.has(w));
function semAcentoServidor(t) { return String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(); }
function montarRomaneio(task, { todasMentes = false, ate = null } = {}) {
  const m = lerMentes(); if (!m || m.status !== "aprovada") return null;
  const g = montarGrafo(); if (!g._porChave) return null;
  const pedido = semAcentoServidor(task.title + " " + task.text);
  const mentes = new Set([mentePorProjeto()[task.project] || "engenharia"]);
  for (const [id, rx] of Object.entries(pistasDaMente())) if (rx.test(pedido)) mentes.add(id);
  const pags = [];
  for (const [chave, end] of Object.entries(m.mapa)) {
    const p = g._porChave.get(chave); if (!p || end.mente === "triagem") continue;
    if (end.soNoProjeto && p.projeto !== task.project) continue;
    if (end.confianca === "media" || end.confianca === "baixa") continue; // proposta ainda não conferida pelo dono // regra de UM projeto (ex.: um "commit + push na main" de um projeto) não viaja
    if (ate && !(new Date(p.atualizada).getTime() < Date.parse(ate))) continue; // experimento: só o que já existia naquela data
    pags.push({ chave, mente: end.mente, tambem: end.tambem || [], p, tit: semAcentoServidor(p.titulo + " " + p.id), desc: semAcentoServidor(p.descricao),
      corpo: semAcentoServidor(p.titulo + " " + p.id + " " + p.descricao + " " + tiraCabecalhos(p.bruto).slice(0, 4000)) });
  }
  // IDF: palavra rara na memória pesa mais que palavra que aparece em tudo.
  const df = {}; for (const x of pags) for (const w of new Set(x.corpo.match(/[a-z0-9]{4,}/g) || [])) df[w] = (df[w] || 0) + 1;
  const termos = palavrasDe(task.title + " " + task.text).filter((w) => df[w]);
  // Onde a palavra aparece conta: no título vale 3, na descrição 2, só no corpo 1. Senão a página longa que cita tudo
  // passa na frente da página que é SOBRE o assunto (medido em 26/09: a página certa perdia para as longas).
  const nota = (x) => termos.reduce((a, w) => a + (x.corpo.includes(w) ? Math.log(pags.length / df[w]) * (x.tit.includes(w) ? 3 : x.desc.includes(w) ? 2 : 1) : 0), 0)
    + (x.p.projeto === task.project ? 1.5 : 0);
  for (const x of pags) x.nota = nota(x);
  const porNota = (a, b) => b.nota - a.nota || String(b.p.atualizada).localeCompare(String(a.p.atualizada));
  // O Dono: o NÚCLEO fixo vai sempre, na ordem que o dono escolheu (data/mentes.json "nucleoDono"); depois, até 4 regras
  // dele que tenham a ver com o pedido. Antes era só por palavra, e às vezes ia "commit push test" no lugar de "veredito primeiro".
  const nucleo = (m.nucleoDono || []).map((k) => pags.find((x) => x.chave === k)).filter(Boolean);
  const dono = [...nucleo, ...pags.filter((x) => x.mente === "dono" && !nucleo.includes(x) && x.nota > 0).sort(porNota).slice(0, nucleo.length ? 4 : 10)];
  const daTarefa = pags.filter((x) => x.mente !== "dono" && x.nota > 0 && (todasMentes || mentes.has(x.mente) || x.tambem.some((t) => mentes.has(t)))).sort(porNota).slice(0, todasMentes ? 10 : 6);
  if (!dono.length && !daTarefa.length) return null;
  const nomeM = Object.fromEntries(mentesDef().map((x) => [x.id, x.icone + " " + x.nome]));
  const texto = [
    "## Romaneio — memórias separadas pelo board para esta tarefa",
    "Use como contexto (vêm da memória compartilhada). Se precisar de mais, consulte o ai-memory. Se alguma estiver desatualizada, diga no resumo.",
    "", "### 🧭 O Dono (vale sempre)",
    ...dono.map((x) => `- **${x.p.titulo}**: ${cut(x.p.descricao || tiraCabecalhos(x.p.bruto), 220)}`),
    ...(daTarefa.length ? ["", `### Da tarefa — mentes: ${[...mentes].map((id) => nomeM[id]).join(", ")}`] : []),
    ...daTarefa.map((x) => `\n#### ${x.p.titulo} (${nomeM[x.mente]} · ${x.p.projeto})\n${x.p.descricao ? x.p.descricao + "\n" : ""}${cut(tiraCabecalhos(x.p.bruto).replace(/^#.*$/m, ""), 700)}`),
  ].join("\n");
  return {
    em: now(), mentes: [...mentes], termos: termos.length, tokensAprox: Math.round(texto.length / 4), texto,
    itens: [...dono, ...daTarefa].map((x) => ({ chave: x.chave, titulo: x.p.titulo, mente: x.mente, nota: Number(x.nota.toFixed(2)) })),
  };
}

// ── Inventário da memória (o inventário do galpão) ─────────────────────────────────────────────────────
// Toda madrugada (02h), SEM IA e sem custo: acha memória NOVA sem mente, suspeitas de REPETIDAS e as VENCIDAS
// (sessões, notas de status com data, cópias grandes). Nada muda sozinho: o dono decide na tela. Só o "Juntar" chama IA,
// e só quando o dono clica (escreve a versão única para ele ver antes de aplicar). Estado em data/inventario.json.
const INVENTARIO_FILE = join(DATA, "inventario.json");
const lerInventario = () => { try { return JSON.parse(readFileSync(INVENTARIO_FILE, "utf8")); } catch { return null; } };
const gravarInventario = (x) => { writeFileSync(INVENTARIO_FILE + ".tmp", JSON.stringify(x, null, 1)); renameSync(INVENTARIO_FILE + ".tmp", INVENTARIO_FILE); };
const radical = (w) => w.slice(0, 5); // "trabalha", "trabalhar", "trabalhem" → "traba"
// o nome do dono aparece em muito título ("Como trabalhar com o <nome>") e não diz nada do assunto
const NOME_DONO = semAcentoServidor(process.env.BOARD_DONO || "").split(/\s+/).filter(Boolean);
function palavrasTitulo(t) { return new Set((semAcentoServidor(t).match(/[a-z0-9]{4,}/g) || []).filter((w) => !PARADAS.has(w) && w !== "dono" && !NOME_DONO.includes(w)).map(radical)); }
function inventariar() {
  grafoCache.em = 0; const g = montarGrafo(); if (!g._porChave) return null;
  const m = lerMentes() || { mapa: {} }; const mapa = m.mapa || {};
  const pags = [...g._porChave.values()].filter((p) => !/^(log-\d{4}-\d{2}|index|MEMORY)$/.test(p.id));
  const agora = Date.now(), dias = (t) => (agora - t) / 86400000;
  // 1) novas: estão na memória e não têm endereço
  const novas = pags.filter((p) => !mapa[p.chave]).map((p) => ({ chave: p.chave, titulo: p.titulo, projeto: p.projeto, sessao: p.sessao }));
  // 2) vencidas: sessão com mais de 7 dias, nota de status com data (mais de 14 dias), cópia grande
  const vencidas = [];
  for (const p of pags) {
    const idade = dias(p.atualizada), tam = p.bruto.length;
    const motivo = p.sessao && idade > 7 ? `resumo de sessão de ${Math.round(idade)} dias (o que importava já virou memória)`
      : /onde paramos|onde estamos|estado em \d|status em \d/i.test(p.titulo) && idade > 14 ? `nota de status datada, de ${Math.round(idade)} dias`
      : tam > 30000 ? `página grande (${Math.round(tam / 1000)} KB): pesa no contexto; confira se é cópia de documento ou se dá para resumir`
      : /^(Revise a tarefa|Teste a entrega)/.test(p.titulo) ? "sessão do revisor/QA do board (não é memória de trabalho)" : null;
    if (motivo) vencidas.push({ chave: p.chave, titulo: p.titulo, projeto: p.projeto, motivo });
  }
  // 3) suspeitas de repetidas: texto parecido (cosseno TF-IDF ≥ 0,5) OU mesma mente + 2 palavras do título em comum
  const doc = pags.filter((p) => !p.sessao).map((p) => {
    const ws = (semAcentoServidor(p.titulo + " " + p.descricao + " " + tiraCabecalhos(p.bruto).slice(0, 6000)).match(/[a-z0-9]{4,}/g) || []).filter((w) => !PARADAS.has(w));
    return { p, tf: ws.reduce((a, w) => (a[w] = (a[w] || 0) + 1, a), {}), tit: palavrasTitulo(p.titulo), mente: (mapa[p.chave] || {}).mente };
  });
  const df = {}; for (const d of doc) for (const w in d.tf) df[w] = (df[w] || 0) + 1;
  for (const d of doc) { let s2 = 0; d.v = {}; for (const w in d.tf) { const x = d.tf[w] * Math.log(doc.length / df[w]); d.v[w] = x; s2 += x * x; } d.n = Math.sqrt(s2) || 1; }
  const cos = (a, b) => { let x = 0; for (const w in a.v) if (b.v[w]) x += a.v[w] * b.v[w]; return x / (a.n * b.n); };
  const pares = [];
  for (let i = 0; i < doc.length; i++) for (let j = i + 1; j < doc.length; j++) {
    const a = doc[i], b = doc[j]; const c = cos(a, b);
    const comum = [...a.tit].filter((w) => b.tit.has(w)).length, jac = comum / (Math.min(a.tit.size, b.tit.size) || 1);
    // título parecido só conta com um mínimo de texto em comum (≥ 0,15): senão "Saturno" no título juntava assuntos sem nada a ver
    const titulo = a.mente && a.mente === b.mente && comum >= 2 && jac >= 0.6 && c >= 0.15;
    if (c >= 0.5 || titulo) pares.push({ a: a.p.chave, b: b.p.chave, texto: Number(c.toFixed(2)), titulo });
  }
  // agrupa pares encadeados (A~B, B~C → um grupo) e fica com os 15 mais parecidos
  const grupo = new Map(); const achar = (k) => { while (grupo.get(k) && grupo.get(k) !== k) k = grupo.get(k); return k; };
  for (const x of pares) { grupo.set(x.a, achar(x.a) || x.a); grupo.set(x.b, achar(x.b) || x.b); const ra = achar(x.a), rb = achar(x.b); if (ra !== rb) grupo.set(rb, ra); }
  const grupos = {}; for (const k of grupo.keys()) (grupos[achar(k)] = grupos[achar(k)] || new Set()).add(k);
  const titulo = (k) => (g._porChave.get(k) || {}).titulo || k;
  const repetidas = Object.values(grupos).filter((set) => set.size >= 2 && set.size <= 5).map((set) => {
    const ks = [...set]; const ps = pares.filter((x) => set.has(x.a) && set.has(x.b));
    return { chaves: ks, titulos: ks.map(titulo), parecenca: Math.max(...ps.map((x) => x.texto)), porTitulo: ps.some((x) => x.titulo) };
  }).sort((a, b) => b.parecenca - a.parecenca).slice(0, 15);
  const antes = lerInventario() || {}; const ign = new Set(antes.ignoradas || []);
  const chaveGrupo = (ks) => [...ks].sort().join("|");
  const inv = { em: now(), total: pags.length, ignoradas: [...ign], juntar: antes.juntar || {}, feitos: antes.feitos || [],
    novas, vencidas: vencidas.filter((x) => !ign.has(x.chave)), repetidas: repetidas.filter((r) => !ign.has(chaveGrupo(r.chaves))) };
  gravarInventario(inv);
  logEvent("inventario", { t: "solto", texto: `inventário da memória: ${novas.length} novas sem mente · ${repetidas.length} grupos suspeitos de repetição · ${vencidas.length} vencidas` });
  return inv;
}
// Roda uma vez por madrugada (às 2h, depois dos backups). Conferido a cada 10 min.
function inventarioDaMadrugada() {
  const h = new Date().getHours(), hoje = new Date().toLocaleDateString("sv-SE");
  const ult = (lerInventario() || {}).em; if (h !== 2 || (ult && new Date(ult).toLocaleDateString("sv-SE") === hoje)) return;
  try { inventariar(); } catch (e) { console.error("inventário falhou:", e.message); }
}
// Caminho da página DENTRO do projeto no ai-memory (o espelho usa o nome do projeto como pasta).
const caminhoNoProjeto = (p) => relative(join(ESPELHO_MEMORIA, p.projeto), p.caminho);
function apagarDaMemoria(chave) {
  const g = montarGrafo(); const p = g._porChave && g._porChave.get(chave); if (!p) throw new Error("memória não encontrada: " + chave);
  const guarda = join(DATA, "inventario-descartadas"); mkdirSync(guarda, { recursive: true });
  writeFileSync(join(guarda, chave.replace(/[^\w.-]+/g, "_") + ".md"), p.bruto); // cópia local para desfazer à mão, além do backup noturno
  execFileSync("ai-memory", ["delete-page", "--workspace", "default", "--project", p.projeto, "--path", caminhoNoProjeto(p)],
    { env: { ...process.env, ...envMemoria(), PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:${process.env.PATH || ""}` }, timeout: 30000, stdio: "pipe" });
  const m = lerMentes(); if (m && m.mapa[chave]) { delete m.mapa[chave]; gravarMentes(m); }
}

// O "tipo" de uma memória (vira o porta-palete na vista Galpão): pela pasta, ou pelo type do cabeçalho original
// da memória do Claude (project/feedback/reference/user), que veio junto quando ela foi importada.
function tipoDaMemoria(caminho, bruto) {
  if (/[\/]decisions[\/]/.test(caminho)) return "decisao";
  if (/[\/]sessions[\/]/.test(caminho)) return "sessao";
  const t = (bruto.match(/^\s+type:\s*(project|feedback|reference|user)\s*$/m) || [])[1];
  if (/[\/](_rules|preferences|preferencias)[\/]/.test(caminho)) return t === "user" ? "dono" : "regra";
  return { project: "projeto", feedback: "regra", reference: "referencia", user: "dono" }[t] || "outro";
}

function montarGrafo() {
  if (grafoCache.dado && Date.now() - grafoCache.em < 60000) return grafoCache.dado;
  if (!existsSync(ESPELHO_MEMORIA)) return { erro: "o espelho da memória ainda não existe (rode memoria-obsidian)", nos: [], ligacoes: [] };
  const paginas = [];
  const anda = (dir, projeto) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "_lint") anda(p, projeto); continue; }
      if (!e.name.endsWith(".md") || e.name === "_meta.md") continue;
      const bruto = readFileSync(p, "utf8");
      const id = e.name.slice(0, -3);
      const nome = (bruto.match(/^name:\s*(.+)$/m) || [])[1];
      const h1 = (tiraCabecalhos(bruto).match(/^#\s+(.+)$/m) || [])[1];
      const descricao = ((bruto.match(/^description:\s*(.+)$/m) || [])[1] || "").replace(/^["']|["']$/g, "");
      // Sem título escrito, o nome é um código (project_saas_multitenant): vira texto legível.
      const cru = (h1 || nome || id).trim();
      const titulo = /^[a-z0-9_-]+$/i.test(cru) ? cru.replace(/^(project|feedback|reference|user|notes?)[-_]+/i, "").replace(/[-_]+/g, " ").replace(/^./, (x) => x.toUpperCase()) : cru;
      paginas.push({ chave: projeto + "/" + id, id, projeto, titulo: titulo.slice(0, 120), descricao: descricao.slice(0, 240), caminho: p, bruto,
        atualizada: dataDaMemoria(bruto) || statSync(p).mtimeMs, sessao: /[\/]sessions[\/]/.test(p), tipo: tipoDaMemoria(p, bruto) });
    }
  };
  for (const e of readdirSync(ESPELHO_MEMORIA, { withFileTypes: true })) if (e.isDirectory()) anda(join(ESPELHO_MEMORIA, e.name), e.name);
  const porId = new Map();
  const norm = (x) => String(x).toLowerCase().trim().replace(/\.md$/, "").replace(/[\s_]+/g, "-");
  for (const pg of paginas) { const k = norm(pg.id); if (!porId.has(k)) porId.set(k, []); porId.get(k).push(pg); }
  const acha = (alvo, projeto) => { const l = porId.get(norm(alvo)); return l ? (l.find((x) => x.projeto === projeto) || l[0]) : null; };
  const ligacoes = new Set();
  for (const pg of paginas) {
    for (const m of pg.bruto.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
      const alvo = acha(m[1].split("/").pop(), pg.projeto);
      if (alvo && alvo.chave !== pg.chave) ligacoes.add(pg.chave + "\u0000" + alvo.chave);
    }
  }
  const grau = {}; const lig = [...ligacoes].map((l) => { const [a, b] = l.split("\u0000"); grau[a] = (grau[a] || 0) + 1; grau[b] = (grau[b] || 0) + 1; return { a, b }; });
  const dado = {
    geradoEm: new Date().toISOString(),
    nos: paginas.map((p) => ({ chave: p.chave, id: p.id, projeto: p.projeto, titulo: p.titulo, descricao: p.descricao, grau: grau[p.chave] || 0,
      atualizada: new Date(p.atualizada).toISOString(), sessao: p.sessao, tipo: p.tipo,
      temas: Object.entries(temasDaMemoria()).filter(([, rx]) => rx.test(p.id + " " + p.titulo + " " + p.descricao + " " + tiraCabecalhos(p.bruto))).map(([t]) => t) })),
    ligacoes: lig,
    _porChave: new Map(paginas.map((p) => [p.chave, p])),
  };
  grafoCache = { em: Date.now(), dado };
  return dado;
}

// ── Controle (menu "Controle"): backups, memória e cópias fora das máquinas, num lugar só ─────────────
// O dono pediu (25/09) um lugar para ver se nada se perde. Tudo é LIDO de quem faz o trabalho — os logs e o
// cron do Saturno, o `ai-memory status`, a listagem do Drive, o espelho da memória — e os ALERTAS saem daqui,
// não da tela: a tela não decide o que é problema. Nada aqui escreve em lugar nenhum.
// A lista dos backups que o servidor roda vem de data/backups.json (fora do git: tem endereços e nomes do dono).
// Cada item: {id, nome, origem, log, script, ok, falha, drive, guarda, recuperar} — ok/falha são regex (texto).
function lerBackups() {
  try { return JSON.parse(readFileSync(join(DATA, "backups.json"), "utf8")).map((b) => ({ ...b, ok: new RegExp(b.ok), falha: new RegExp(b.falha) })); }
  catch { return []; }
}
const CONTROLE = { lidoEm: null, backups: [], drive: null, driveLidoEm: null, memoria: null, saturno: null, alertas: [] };
const controleLido = { rapido: 0, drive: 0 };
let controleRodando = false;
// Hora dos logs do Saturno: as linhas novas trazem o fuso ("2026-09-26 00:30:01-0300"); as antigas, de quando
// o Saturno rodava em UTC (até 26/09/2026), não trazem nada — e aí são UTC.
const utc = (x) => { const m = x.match(/^(\S+) (\d\d:\d\d:\d\d)([+-]\d\d)(\d\d)?$/);
  return new Date(m ? `${m[1]}T${m[2]}${m[3]}:${m[4] || "00"}` : x.replace(" ", "T") + "Z").toISOString(); };

function lerRodadas(texto, b, cron) {
  const rodadas = []; let inicio = null, escrito = null;
  for (const l of texto.split("\n")) {
    const i = l.match(/^== (\S+ \S+) início/); if (i) { inicio = utc(i[1]); escrito = null; continue; }
    const w = l.match(/wrote backup to \S+ \(([^)]+)\)/); if (w) { escrito = w[1]; continue; } // tamanho do instantâneo da memória
    let m = l.match(b.ok);
    if (m) { rodadas.push({ ok: true, fim: utc(m[1]), inicio, arquivo: m[2] && m[2] !== "ok" ? m[2].split("/").pop() : null, tamanho: m[3] || (b.id === "memoria" ? escrito : null) }); continue; }
    m = l.match(b.falha);
    if (m && !(b.id === "memoria" && /board:/.test(l))) rodadas.push({ ok: false, fim: utc(m[1]), inicio, motivo: cut(m[2], 160) });
  }
  // Automática = começou no minuto do cron (±10 min). A primeira automática é a prova de que o agendamento vale.
  for (const r of rodadas) {
    const t = new Date(r.inicio || r.fim);
    r.automatica = !!cron && Math.abs((t.getUTCHours() * 60 + t.getUTCMinutes()) - (cron.h * 60 + cron.m)) <= 10;
  }
  return rodadas.slice(-120);
}

async function lerControle() {
  if (controleRodando) return;
  controleRodando = true;
  try {
    const agora = Date.now();
    if (agora - controleLido.rapido > 60000) {
      controleLido.rapido = agora;
      const env = envMemoria();
      const BACKUPS = lerBackups();
      const logs = [...new Set(BACKUPS.map((b) => b.log))];
      const [sat, mem] = await Promise.all([
        execP("ssh", ["-o", "ConnectTimeout=5", "-o", "BatchMode=yes", SERVIDOR,
          logs.map((f) => `echo "@@LOG ${f}"; tail -n 600 ${f} 2>/dev/null`).join("; ") + '; echo "@@FUSO"; date +%z; echo "@@CRON"; cat /etc/cron.d/backup-* 2>/dev/null; echo "@@DISCO"; df -B1 --output=avail,size /var/lib | tail -1'], 20000),
        execP("ai-memory", ["status"], 15000, env),
      ]);
      if (sat.ok) {
        const partes = {}; let atual = null;
        for (const l of sat.out.split("\n")) { const h = l.match(/^@@(LOG (\S+)|FUSO|CRON|DISCO)/); if (h) { atual = h[2] || h[1]; partes[atual] = ""; continue; } if (atual) partes[atual] += l + "\n"; }
        const cron = {};
        // O cron está no fuso do Saturno; a tela e a conta de "automática" trabalham em UTC.
        const fz = (partes.FUSO || "").trim().match(/^([+-])(\d\d)(\d\d)$/);
        const fusoMin = fz ? (fz[1] === "-" ? -1 : 1) * (+fz[2] * 60 + +fz[3]) : 0;
        for (const l of (partes.CRON || "").split("\n")) {
          const m = l.match(/^(\d+)\s+(\d+)\s+\*\s+\*\s+\*\s+\S+\s+\S*?([\w-]+\.sh)/); if (!m) continue;
          const t = ((+m[2] * 60 + +m[1] - fusoMin) % 1440 + 1440) % 1440;
          cron[m[3]] = { h: Math.floor(t / 60), m: t % 60 };
        }
        CONTROLE.backups = BACKUPS.map((b) => ({
          id: b.id, nome: b.nome, origem: b.origem, drive: b.drive, guarda: b.guarda, recuperar: b.recuperar,
          cronUTC: cron[b.script] || null, rodadas: lerRodadas(partes[b.log] || "", b, cron[b.script]),
        }));
        const [livre, total] = (partes.DISCO || "").trim().split(/\s+/).map(Number);
        CONTROLE.saturno = { online: true, discoLivre: livre || null, discoTotal: total || null };
      } else CONTROLE.saturno = { online: false, erro: cut(sat.err || "sem resposta", 160) };
      const n = (k) => Number((mem.out.match(new RegExp("\\n\\s*" + k + ":\\s*(\\d+)")) || [])[1] || 0);
      const dur = (mem.out.match(/last write:\s*([^\n]+)/) || [])[1] || "";
      const seg = [...dur.matchAll(/(\d+)\s*(d|h|m|s)\b/g)].reduce((a, [, v, u]) => a + v * { d: 86400, h: 3600, m: 60, s: 1 }[u], 0);
      const g = montarGrafo();
      const porProjeto = {};
      const mes = new Date().toISOString().slice(0, 7), hoje = new Date().toLocaleDateString("sv-SE");
      try {
        for (const e of readdirSync(ESPELHO_MEMORIA, { withFileTypes: true })) {
          if (!e.isDirectory()) continue;
          let t = ""; try { t = readFileSync(join(ESPELHO_MEMORIA, e.name, `log-${mes}.md`), "utf8"); } catch { continue; }
          const ev = [...t.matchAll(/^## \[([^\]]+)\] ([\w-]+)/gm)].map((m) => ({ at: m[1], tipo: m[2] }));
          if (!ev.length) continue;
          const doDia = ev.filter((x) => new Date(x.at).toLocaleDateString("sv-SE") === hoje);
          porProjeto[e.name] = { ultimo: ev[ev.length - 1].at, eventosHoje: doDia.length, pedidosHoje: doDia.filter((x) => x.tipo === "user-prompt").length };
        }
      } catch { /* sem espelho ainda */ }
      CONTROLE.memoria = {
        online: mem.ok && /pages:\s*\d+/.test(mem.out), url: env.AI_MEMORY_SERVER_URL || null,
        reserva: /127\.0\.0\.1|localhost/.test(env.AI_MEMORY_SERVER_URL || ""),
        paginas: n("pages"), sessoes: n("sessions"), observacoes: n("observations"),
        ultimaGravacao: dur && seg >= 0 ? new Date(agora - seg * 1000).toISOString() : null,
        filaPendente: Number((mem.out.match(/pending:\s*(\d+)/) || [])[1] || 0),
        motores: motoresDaMemoria(env.AI_MEMORY_SERVER_URL || null),
        espelho: INFRA.espelho || null,
        // O que foi SALVO: páginas de verdade — o log de captura do mês e o índice mudam a cada evento e taparam o resto.
        recentes: (g.nos || []).filter((x) => x.atualizada && !/^(log-\d{4}-\d{2}|index)$/.test(x.id)).sort((a, b) => b.atualizada.localeCompare(a.atualizada)).slice(0, 25)
          .map((x) => ({ chave: x.chave, titulo: x.titulo, projeto: x.projeto, atualizada: x.atualizada, sessao: x.sessao })),
        captura: Object.entries(porProjeto).map(([projeto, v]) => ({ projeto, ...v })).sort((a, b) => b.ultimo.localeCompare(a.ultimo)),
      };
      CONTROLE.copiaBoard = INFRA.copiaBoard || null;
    }
    if (agora - controleLido.drive > 10 * 60000) {
      controleLido.drive = agora;
      const pastas = await Promise.all(lerBackups().map(async (b) => {
        if (b.id === "board") {
          const r = await execP("rclone", ["size", "--json", "gdrive_backup:" + b.drive], 120000);
          try { const j = JSON.parse(r.out); return { pasta: b.drive, ok: r.ok, arquivos: j.count, bytes: j.bytes, lista: [] }; } catch { return { pasta: b.drive, ok: false, erro: cut(r.err, 160) }; }
        }
        const r = await execP("rclone", ["lsjson", "gdrive_backup:" + b.drive], 120000);
        try {
          const l = JSON.parse(r.out).filter((x) => !x.IsDir).map((x) => ({ nome: x.Name, bytes: x.Size, quando: x.ModTime })).sort((a, b2) => b2.nome.localeCompare(a.nome));
          return { pasta: b.drive, ok: true, arquivos: l.length, bytes: l.reduce((a, x) => a + x.bytes, 0), lista: l.slice(0, 20) };
        } catch { return { pasta: b.drive, ok: false, erro: cut(r.err || "sem resposta", 160) }; }
      }));
      CONTROLE.drive = pastas; CONTROLE.driveLidoEm = new Date().toISOString();
    }
    CONTROLE.alertas = alertasDoControle();
    CONTROLE.lidoEm = new Date().toISOString();
    broadcast("controle", { lidoEm: CONTROLE.lidoEm });
  } finally { controleRodando = false; }
}

function alertasDoControle() {
  const a = []; const h = (iso) => iso ? (Date.now() - Date.parse(iso)) / 3600000 : Infinity;
  const semAutomatica = [];
  if (CONTROLE.saturno && !CONTROLE.saturno.online) a.push({ nivel: "erro", texto: "Saturno não responde: não dá para ler os backups." });
  for (const b of CONTROLE.backups) {
    const oks = b.rodadas.filter((r) => r.ok), ultOk = oks[oks.length - 1], ult = b.rodadas[b.rodadas.length - 1];
    if (!ultOk) a.push({ nivel: "erro", backup: b.id, texto: `${b.nome}: nenhum backup concluído ainda.` });
    else if (ult && !ult.ok) a.push({ nivel: "erro", backup: b.id, texto: `${b.nome}: a última rodada falhou — ${ult.motivo}.` });
    else if (h(ultOk.fim) > 26) a.push({ nivel: "erro", backup: b.id, texto: `${b.nome}: último backup há ${Math.round(h(ultOk.fim))} h (o normal é todo dia).` });
    if (ultOk && b.cronUTC && !b.rodadas.some((r) => r.ok && r.automatica)) semAutomatica.push(b.nome);
    const pasta = (CONTROLE.drive || []).find((p) => p.pasta === b.drive);
    if (ultOk && ultOk.arquivo && pasta && pasta.ok && pasta.lista.length && !pasta.lista.some((x) => x.nome === ultOk.arquivo))
      a.push({ nivel: "erro", backup: b.id, texto: `${b.nome}: o arquivo ${ultOk.arquivo} não está no Drive.` });
    if (pasta && !pasta.ok) a.push({ nivel: "aviso", backup: b.id, texto: `Drive: não consegui listar ${b.drive}.` });
  }
  // Um aviso só: a prova de que o AGENDAMENTO vale é a primeira rodada sozinha, na madrugada.
  if (semAutomatica.length) a.push({ nivel: "aviso", texto: `Ainda sem rodada automática (só as manuais de teste): ${semAutomatica.join(", ")}. A primeira é na próxima madrugada.` });
  const m = CONTROLE.memoria;
  if (m) {
    if (!m.online) a.push({ nivel: "erro", texto: "A memória compartilhada não responde." });
    if (m.reserva) a.push({ nivel: "aviso", texto: "Reserva ligada: os motores estão usando a memória do Mac, não a do Saturno." });
    const fora = (m.motores || []).filter((x) => !(x.memoria && x.captura));
    if (fora.length) a.push({ nivel: "erro", texto: "Motor sem memória ou sem captura: " + fora.map((x) => x.nome).join(", ") + "." });
    if (m.filaPendente > 200) a.push({ nivel: "aviso", texto: `${m.filaPendente} capturas esperando para subir à memória.` });
    if (m.espelho ? h(m.espelho.quando) > 0.5 : process.uptime() > 900) a.push({ nivel: "aviso", texto: "O espelho da memória (Obsidian e o grafo) está desatualizado." });
  }
  const inv = lerInventario();
  if (inv && inv.em) {
    const n = (inv.novas || []).length + (inv.repetidas || []).length + (inv.vencidas || []).length;
    if (n) a.push({ nivel: "aviso", texto: `Inventário da memória: ${n} para conferir (${(inv.novas || []).length} novas, ${(inv.repetidas || []).length} suspeitas de repetição, ${(inv.vencidas || []).length} vencidas) — menu Memória → Galpão.` });
  }
  const c = CONTROLE.copiaBoard;
  if (c && (c.ok === false || (c.quando ? h(c.quando) > 2 : process.uptime() > 2400))) a.push({ nivel: "aviso", texto: "A cópia do board para o Saturno " + (c.ok === false ? "falhou." : "está atrasada.") });
  const s = CONTROLE.saturno;
  if (s && s.discoTotal && s.discoLivre / s.discoTotal < 0.1) a.push({ nivel: "erro", texto: "Disco do Saturno com menos de 10% livre." });
  return a;
}
if (COM_ROTINAS) {
  setInterval(inventarioDaMadrugada, 10 * 60000);
  setTimeout(lerControle, 20000);
  setInterval(lerControle, 60000);
}

/** Some com a cópia quando ela não guarda mais nada que só exista lá. */
function removerCopia(task) {
  const wt = task.worktree;
  if (!wt || wt.removida || !existsSync(wt.dir)) return;
  if (wt.juntar === "conflito" || wt.juntar === "pendente") return; // o trabalho só existe lá
  try { git(projetoBase(task).dir, ["worktree", "remove", "--force", wt.dir]); wt.removida = true; }
  catch { /* fica para a próxima */ }
}

// ── log por tarefa (eventos compactos que a tela entende) ─────────────────────
const logPath = (id) => join(LOGS, `${id}.jsonl`);
const rawPath = (id) => join(RAW, `${id}.jsonl`);

function readLog(id) {
  let raw = "";
  try { raw = readFileSync(logPath(id), "utf8"); } catch { return []; }
  const out = [];
  for (const line of raw.split(/\r?\n/)) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch { /* linha torta */ } }
  return out;
}

function logEvent(id, ev) {
  const full = { at: now(), ...ev };
  appendFileSync(logPath(id), JSON.stringify(full) + "\n");
  broadcast("log", { id, ev: full });
  printEvent(id, full);
}

/** O argumento que identifica a chamada — é o que diz "rodando npm test", não só "Bash". */
const toolTarget = (input = {}) =>
  cut(input.command || input.file_path || input.pattern || input.path || input.description || input.prompt || "", 100);

function printEvent(id, ev) {
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

/**
 * O estado do git da pasta — o agente precisa saber ANTES de decidir o que fazer.
 * Pasta sem repo, repo sem remoto e repo pronto pedem caminhos diferentes; descobrir isso
 * aqui é mais barato (e mais previsível) que mandar o agente adivinhar por tentativa.
 */
function gitInfo(dir) {
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    if (git("rev-parse", "--is-inside-work-tree") !== "true") return { repo: false };
  } catch { return { repo: false }; }
  const tenta = (...a) => { try { return git(...a); } catch { return ""; } };
  return {
    repo: true,
    remote: tenta("remote", "get-url", "origin") || null,
    branch: tenta("rev-parse", "--abbrev-ref", "HEAD") || null,
    sujo: !!tenta("status", "--porcelain"),
  };
}

/**
 * O PORTÃO — a verificação que o próprio projeto já tem (tsc, testes). Não usa IA: é o
 * comando da casa rodando de verdade. Existe porque o board acreditava no resumo do agente:
 * "check limpo, 39 testes verdes" era palavra dele, nunca conferida por ninguém.
 *
 * O comando sai de `data/portao.json` ({slug: comando}; "" desliga) ou, na falta, dos scripts
 * do package.json do projeto.
 */
function gateCommand(project) {
  try {
    const cfg = JSON.parse(readFileSync(GATE_FILE, "utf8"));
    if (Object.prototype.hasOwnProperty.call(cfg, project.slug)) return String(cfg[project.slug] || "");
  } catch { /* sem arquivo de portão */ }
  let scripts = {};
  try { scripts = JSON.parse(readFileSync(join(project.dir, "package.json"), "utf8")).scripts || {}; } catch { return ""; }
  const partes = [];
  const tipo = ["check", "typecheck", "lint"].find((k) => scripts[k]);
  if (tipo) partes.push(`npm run ${tipo}`);
  if (scripts.test) partes.push("npm test");
  return partes.join(" && ");
}

/** Mata o grupo de processos de um comando (bash + npm + vitest…), não só o bash. */
function killGroup(cp) {
  try { process.kill(-cp.pid, "SIGKILL"); } catch { try { cp.kill("SIGKILL"); } catch { /* já morreu */ } }
}

/** Roda o comando do portão e devolve o veredito com o rabo da saída (o que explica a falha). */
function runGate(task, project, comando, limite = GATE_TIMEOUT_MS) {
  return new Promise((done) => {
    const env = { ...process.env, CI: "true", PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:${process.env.PATH || ""}` };
    let cp;
    // `detached`: o comando vira líder de grupo, e o timeout mata o GRUPO. Matar só o bash
    // deixava npm/vitest vivos segurando o pipe — e o "close" nunca chegava (portão pendurado).
    try { cp = spawn("bash", ["-c", comando], { cwd: project.dir, env, stdio: ["ignore", "pipe", "pipe"], detached: true }); }
    catch (e) { return done({ ok: false, code: -1, saida: "não consegui rodar o portão: " + e.message }); }
    gates.set(task.id, cp);
    let buf = "", estourou = false;
    const timer = setTimeout(() => { estourou = true; killGroup(cp); }, limite);
    const ler = (d) => { buf += stripAnsi(String(d)); if (buf.length > 400000) buf = buf.slice(-200000); };
    cp.stdout.on("data", ler); cp.stderr.on("data", ler);
    cp.on("error", (e) => { buf += "\n" + e.message; });
    cp.on("close", (code) => {
      clearTimeout(timer); gates.delete(task.id);
      const saida = buf.split(/\r?\n/).filter((l) => l.trim()).slice(-60).join("\n");
      done({ ok: !estourou && code === 0, code, saida: estourou ? saida + `\n(passou de ${limite / 60000} min e foi interrompido)` : saida });
    });
  });
}

/**
 * O catálogo de modelos de cada motor: o que dá para escolher na tela e o que cada porte usa.
 * A lista do opencode vem do próprio CLI (`opencode models`); a do Claude são os nomes da casa.
 * O Codex não lista modelos pela CLI, então ali o campo fica livre.
 */
let modelosCache = null;
function catalogoModelos() {
  if (modelosCache && Date.now() - modelosCache.t < 300000) return modelosCache.v;
  let mapa = {};
  try { mapa = JSON.parse(readFileSync(MODELOS_FILE, "utf8")); } catch { /* usa o padrão abaixo */ }
  const padraoPortes = {};
  const v = {};
  for (const [id, m] of Object.entries(MOTORES)) {
    if (!temBin(m.bin)) continue;
    let lista = [];
    if (id === "claude") lista = ["haiku", "sonnet", "opus"];
    else if (id === "gemini") {
      try {
        lista = execFileSync("agy", ["models"], { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "ignore"],
          env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:${process.env.PATH || ""}` } })
          .split(/\r?\n/).map((l) => stripAnsi(l).split("\t")[0].trim()).filter((l) => /^[a-z0-9][\w.-]+$/i.test(l));
      } catch { lista = []; }
    }
    else if (id === "opencode") {
      try {
        lista = execFileSync("opencode", ["models"], { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "ignore"],
          env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:${process.env.PATH || ""}` } })
          .split(/\r?\n/).map((l) => stripAnsi(l).trim()).filter((l) => /^[\w.-]+\/[\w.:-]+$/.test(l));
      } catch { lista = []; }
    }
    // Claude: porte não troca modelo (é esforço) — o mapa antigo do modelos.json não vale para ele.
    v[id] = { lista, portes: id === "claude" ? {} : { ...(padraoPortes[id] || {}), ...((mapa[id] || {})) },
      esforcos: id === "claude" ? ESFORCO_CLAUDE : null, exemplo: m.exemploModelo };
  }
  modelosCache = { t: Date.now(), v };
  return v;
}

/**
 * O modelo do REVISOR/QA para o motor que vai rodar. O modelo configurado (ex.: `sonnet`) vale só
 * para o motor configurado; quando o papel cai para outro motor por falta de cota, mandar o modelo
 * antigo é 400 na hora ("The 'sonnet' model is not supported when using Codex", 22/09/2026).
 */
function modeloDePapel(quem, id) {
  const cfg = quem === "revisor" ? { motor: MOTOR_REVISOR, modelo: REVIEW_MODEL } : { motor: MOTOR_QA, modelo: QA_MODEL };
  if (id === cfg.motor && modeloServe(id, cfg.modelo)) return cfg.modelo;
  const padrao = MODELO_PADRAO[id] || "";
  return modeloServe(id, padrao) ? padrao : "";
}

/** O modelo que a rodada usa: escolha explícita > porte > padrão do board > padrão do CLI. */
function modeloPara(motorId, task) {
  if (task?.modelo) {
    if (modeloServe(motorId, task.modelo)) return task.modelo;
    logEvent(task.id, { t: "solto", texto: `⚠ o modelo "${task.modelo}" não é deste motor (${motorId}) — usando o padrão dele` });
  }
  const porte = task?.porte;
  if (porte && motorId !== "claude") {
    const c = catalogoModelos()[motorId];
    if (c?.portes?.[porte]) return c.portes[porte];
  }
  const padrao = MODELO_PADRAO[motorId] || "";
  return modeloServe(motorId, padrao) ? padrao : "";
}

/** A pasta tem mudança pendente? (fora de git, assume que sim: não dá para saber.) */
function haMudancas(dir) {
  try {
    return !!execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return true; }
}

/** O comando de publicação do projeto. Sem entrada aqui, o modo "mesclar e publicar" não existe. */
function deployCommand(project) {
  try {
    const cfg = JSON.parse(readFileSync(DEPLOY_FILE, "utf8"));
    const c = cfg[project.slug];
    return typeof c === "string" && c.trim() ? c : "";
  } catch { return ""; }
}

/** A assinatura do git — serve para saber se a rodada mexeu em arquivo de verdade. */
/**
 * "A rodada mexeu em arquivo?" — é isso que liga portão, revisor e QA.
 * ⚠️ Antes olhava só `git status --porcelain`, e ele NÃO muda quando o agente altera um arquivo
 * que já estava sujo ou não rastreado. Um agente que grava por comando de shell (o Codex faz isso
 * o tempo todo, e o Claude também com heredoc) passava batido por toda a conferência — visto no
 * teste do motor em 22/09. Agora a pergunta é feita ao disco: existe arquivo mais novo que a marca?
 * Marca fica em data/ (nunca dentro do projeto). Funciona em pasta sem git também.
 */
function marcarInstante() {
  const marca = join(DATA, ".marca-tempo");
  writeFileSync(marca, now());
  return marca;
}

function mexeuEmArquivo(dir, marca) {
  try {
    const achou = execFileSync("find", [dir, "-type", "f", "-newer", marca,
      "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*", "-not", "-path", "*/dist/*",
      "-not", "-path", "*/.next/*", "-not", "-name", "*.log", "-print", "-quit"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30000 });
    return !!achou.trim();
  } catch { return false; }
}

// ── rodar o claude (runner e chat usam o mesmo caminho) ───────────────────────
const running = new Map(); // id → processo do claude
const gates = new Map();   // id → processo do portão

/** O bloco de ENTREGA: com PR (o dono revisa e mescla) ou direto na pasta. */
function deliveryRules(task, project) {
  if (task.entrega !== "pr" && task.entrega !== "deploy") {
    return [
      "ENTREGA: direto na pasta, SEM Pull Request.",
      "- Não faça push, não abra PR, não crie repositório. Se achar que o trabalho merece PR, diga no resumo.",
    ];
  }
  const g = gitInfo(project.dir);
  const base = g.repo
    ? (g.remote
        ? `O projeto já é repositório git (branch atual: ${g.branch || "?"}) e tem remoto: ${g.remote}.`
        : `O projeto é repositório git (branch atual: ${g.branch || "?"}) mas NÃO tem remoto "origin" — crie com: gh repo create ${project.slug} --private --source=. --remote=origin --push`)
    : `A pasta AINDA NÃO É repositório git. Antes de qualquer coisa: git init -b main → escreva/confira o .gitignore → confira com "git status" o que entraria → primeiro commit → gh repo create ${project.slug} --private --source=. --remote=origin --push`;
  const prBranch = branchDoPr(task, project);
  return [
    task.prUrl ? "ENTREGA: ATUALIZAR O PULL REQUEST QUE JÁ EXISTE. VOCÊ NUNCA MESCLA E NUNCA ABRE OUTRO PR."
      : "ENTREGA: abrir PULL REQUEST. VOCÊ NUNCA MESCLA.",
    task.entrega === "deploy"
      ? "Esta tarefa está no modo MESCLAR E PUBLICAR: quem mescla e quem publica é o BOARD, por comando declarado pelo dono, e só depois do portão verde e do revisor APROVADO. Você abre o PR e para por aí."
      : "Quem revisa e mescla é o dono.",
    base,
    g.sujo ? "⚠️ A pasta tem mudanças não commitadas do dono. Não as apague nem as inclua sem dizer; se atrapalharem, pare e avise." : "",
    "Sequência:",
    ...(task.prUrl ? [
      // ⚠️ Rodada de conserto com "branch NOVA" abre PR novo a cada volta: a #127 deixou TRÊS (22/09/2026).
      `0. Esta tarefa JÁ TEM Pull Request aberto: ${task.prUrl}. ELE é a entrega — não abra outro.`,
      `1. Volte para a branch dele e continue nela: \`gh pr checkout ${task.prUrl}\`${prBranch ? ` (branch \`${prBranch}\`)` : ""}. Nunca crie outra branch nem commite em main/master.`,
      "2. Ao terminar: commit com mensagem clara (o porquê, não só o quê) e push NA MESMA branch — o PR se atualiza sozinho. NUNCA `gh pr create` de novo.",
      project.principal
        ? "3. NÃO volte para main: esta cópia é descartável e o board a remove sozinho. Responda com a URL do PR (a mesma) no resumo."
        : "3. Depois do push: `git checkout main` — deixe a pasta na branch principal para o próximo. Responda com a URL do PR (a mesma) no resumo.",
    ] : project.principal ? [
      // 🔴 Em cópia (worktree) a branch principal está EM USO pela pasta do dono: `git checkout main`
      // aqui morre com "already checked out at ...". A cópia já nasceu do origin/main atualizado,
      // então não há o que puxar — e puxar seria justamente o passo que travava quando a pasta
      // do dono tinha trabalho sem commit.
      "0. Esta CÓPIA já nasceu a partir do `origin/main` atualizado — não há nada a puxar. NUNCA rode `git checkout main` nem `git pull` aqui: em cópia (worktree) a branch principal pertence à pasta do dono e o comando falha.",
      `1. Crie a branch aqui mesmo, a partir de onde você já está: \`git checkout -b board/${task.id}-<3-a-5-palavras-do-assunto>\`. Nunca commite em main/master.`,
      "2. Ao terminar: commit com mensagem clara (o porquê, não só o quê), `git push -u origin <a-sua-branch>`, e `gh pr create` com título e corpo explicando o que mudou e como testar.",
      "3. NÃO volte para main: esta cópia é descartável e o board a remove sozinho. Responda com a URL do PR no resumo.",
    ] : [
      "0. ANTES de qualquer edição: `git checkout main && git pull --ff-only origin main` (a branch principal local fica para trás a cada PR mesclado; quem começa de uma branch velha abre PR em cima de código velho). Se o pull falhar por árvore suja ou divergência, PARE e avise — não force.",
      `1. Trabalhe numa branch NOVA a partir da main atualizada: board/${task.id}-<3-a-5-palavras-do-assunto>. Nunca commite direto em main/master.`,
      "2. Ao terminar: commit com mensagem clara (o porquê, não só o quê), push da branch, e `gh pr create` com título e corpo explicando o que mudou e como testar.",
      "3. Depois do push: `git checkout main` — deixe a pasta na branch principal para o próximo. Responda com a URL do PR no resumo.",
    ]),
    "🔴 Segredos: .env, chave, token e credencial NUNCA entram no commit — ponha no .gitignore antes do primeiro commit. Se um arquivo assim já estiver rastreado no repositório, PARE e avise o dono em vez de dar push.",
    "🔴 Nunca `gh pr merge`, nunca push forçado, nunca push na branch principal.",
    task.prUrl ? "🔴 UM PR por tarefa. Se achar que o trabalho não cabe no PR aberto, PARE e avise o dono em vez de abrir outro." : "",
    "Repositório novo nasce PRIVADO (--private). Se por algum motivo precisar ser público, pare e pergunte.",
  ].filter(Boolean);
}

function houseRules(task, project) {
  return [
    `Você está executando a tarefa #${task.id} do BOARD do dono${DONO}, na pasta do projeto "${project.slug}" (${project.dir}).`,
    ...(project.principal ? [
      `Você é o agente #${task.agente}, numa CÓPIA isolada (worktree git) deste projeto — a pasta principal é a bancada do dono e pode ter trabalho dele sem commit. Trabalhe SÓ em ${project.dir}; nunca mexa na pasta principal (${project.principal})${task.paralelo ? "; ⚡ outros agentes podem estar em outras cópias ao mesmo tempo" : ""}.`,
      task.worktree?.producao ? "" : "Não faça commit, branch nem push: quando a conferência aprovar, o board junta o seu trabalho na pasta principal.",
    ].filter(Boolean) : []),
    "Regras da casa:",
    "- Leia o CLAUDE.md do projeto antes de mexer. Trabalhe direto nesta pasta.",
    `- Projeto de PRODUÇÃO${PRODUCAO.length ? " (" + PRODUCAO.join(", ") + ")" : ""}: NUNCA deploy, NUNCA mudança em banco — o portão é sempre o PR que o dono revisa.`,
    "- Não invente número nem promessa. Se travar em algo que só o dono decide, pare e diga exatamente o que falta.",
    "- Teste instável ou problema FORA do escopo da tarefa: anote no resumo e siga. Não pare para investigar — o portão do board confere a suíte. (Uma tarefa já gastou os 45 min inteiros investigando teste instável e não entregou.)",
    "- Ao terminar, responda com um resumo curto (3–8 linhas): o que fez, o que verificou (comandos/testes) e o que ficou pendente.",
    "Interface e textos em português do Brasil; código em inglês.",
    "",
    ...deliveryRules(task, project),
  ].join("\n");
}

/**
 * Roda `claude -p` e vai gravando o percurso no log da tarefa, evento a evento.
 * Devolve { result, sessionId, cost, turns, dur, code }.
 */
/**
 * OS MOTORES — cada CLI fala um dialeto; o board normaliza para os mesmos eventos (texto,
 * ferramenta, resultado) e para a mesma sessão retomável. Acrescentar um motor é acrescentar uma
 * entrada aqui: `args` monta a linha de comando, `trata` traduz cada evento do CLI.
 * ⚠️ Custo: o Claude informa dólar por rodada; o Codex informa TOKENS, não dólar. O board mostra
 * o que cada um conta e não inventa a conversão.
 */
const MOTORES = {
  claude: {
    rotulo: "Claude", bin: "claude", moeda: "usd",
    exemploModelo: "opus, sonnet, haiku",
    args: ({ prompt, regras, tools, modelo, resume, esforco, semCaptura }) => {
      const a = ["-p", prompt, "--append-system-prompt", regras,
        "--output-format", "stream-json", "--verbose", "--allowedTools", tools];
      if (PERMISSION === "bypass") a.push("--dangerously-skip-permissions");
      else a.push("--permission-mode", PERMISSION);
      if (modelo) a.push("--model", modelo);
      if (esforco) a.push("--effort", esforco);
      if (resume) a.push("--resume", resume);
      // Revisor e QA sem os ganchos do usuário (é lá que mora a captura do ai-memory): as sessões deles viravam
      // "memória" — "Revise a tarefa #166" — e o inventário tinha de varrer toda noite. Modelo, permissão e
      // ferramentas continuam vindo por aqui, então nada muda no trabalho deles.
      if (semCaptura) a.push("--setting-sources", "project,local");
      return a;
    },
    trata: (ev, ctx) => {
      const { out, quem, task } = ctx;
      if (ev.session_id) ctx.sessao(ev.session_id);
      if (ev.type === "assistant") {
        for (const c of ev.message?.content || []) {
          if (c.type === "tool_use") {
            if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(c.name)) out.escreveu = true;
            logEvent(task.id, { t: "ferramenta", nome: c.name, alvo: toolTarget(c.input), quem });
          } else if (c.type === "text" && c.text?.trim()) logEvent(task.id, { t: "texto", texto: c.text, quem });
        }
      } else if (ev.type === "result") {
        out.cost += ev.total_cost_usd || 0;
        out.turns = ev.num_turns || out.turns;
        out.dur = ev.duration_ms || out.dur;
        const texto = ev.result || "";
        // Limite de uso/gasto vem como `result` normal, com texto de aviso — NÃO é resultado da
        // tarefa. Sem isto a tarefa virava "executada" com "You've hit your ... limit" no lugar do
        // resumo (15/09/2026) e o trabalho se perdia sem ninguém notar.
        // ⚠️ Marcador PRÓPRIO do CLI, não palavra solta: a regra antiga (/rate limit/) marcava
        // como "limite" a resposta legítima de um agente que FALOU de rate limit no resumo.
        const cota = /cc_cli_limit_message/.test(texto) || /^you'?ve hit your [\w ]*limit\b/i.test(texto.trim());
        if (ev.is_error || cota) ctx.erro(cut(texto || ev.error || out.ultimoSolto || "o claude devolveu erro", 300), cota);
        else ctx.resultado(texto, { custo: ev.total_cost_usd || 0 });
      }
    },
  },
  codex: {
    rotulo: "Codex", bin: "codex", moeda: "tokens",
    exemploModelo: "gpt-5-codex, o3",
    // Codex não tem system-prompt separado: as regras da casa vão no começo do próprio prompt.
    args: ({ prompt, regras, modelo, resume, imagens, dir }) => {
      // ⚠️ `exec resume` NÃO aceita --sandbox (só o `exec` normal): passar isso dava
      // "unexpected argument '--sandbox'" e código 2 em TODA retomada (#127, 22/09/2026).
      const flags = ["--json", "--skip-git-repo-check"];
      // ⚠️ O sandbox workspace-write bloqueia escrita em `.git`: sem liberar, o agente não troca
      // de branch nem commita ("Operation not permitted" em .git/index.lock, #127). O `-c` vale
      // TAMBÉM na retomada — `exec resume` aceita -c, só não aceita --sandbox.
      if (PERMISSION !== "bypass") {
        if (dir) flags.push("-c", `sandbox_workspace_write.writable_roots=["${join(dir, ".git")}"]`);
        // Sem rede o agente não faz pull, push nem `gh pr` — "Could not resolve host: github.com".
        flags.push("-c", "sandbox_workspace_write.network_access=true");
      }
      if (!resume) flags.push(...(PERMISSION === "bypass" ? ["--dangerously-bypass-approvals-and-sandbox"] : ["--sandbox", "workspace-write"]));
      if (modelo) flags.push("--model", modelo);
      // `-i` é só imagem: PDF anexado chega pelo caminho no prompt (o agente abre ele mesmo).
      for (const i of imagens || []) if (!i.endsWith(".pdf")) flags.push("-i", i);
      const texto = regras ? regras + "\n\n---\n\n" + prompt : prompt;
      return resume ? ["exec", "resume", ...flags, resume, texto] : ["exec", ...flags, texto];
    },
    trata: (ev, ctx) => {
      const { out, quem, task } = ctx;
      if (ev.type === "thread.started" && ev.thread_id) ctx.sessao(ev.thread_id);
      else if (ev.type === "item.completed") {
        const it = ev.item || {};
        if (it.type === "agent_message" && it.text?.trim()) { out.result = it.text; logEvent(task.id, { t: "texto", texto: it.text, quem }); }
        else if (it.type === "command_execution") logEvent(task.id, { t: "ferramenta", nome: "Bash", alvo: cut(it.command || "", 100), quem });
        else if (it.type === "file_change") { out.escreveu = true; logEvent(task.id, { t: "ferramenta", nome: "Edit", alvo: cut((it.changes || []).map((c) => c.path).join(", ") || it.path || "", 100), quem }); }
        else if (it.type === "mcp_tool_call") logEvent(task.id, { t: "ferramenta", nome: it.server ? `${it.server}.${it.tool}` : "MCP", alvo: cut(JSON.stringify(it.arguments || {}), 100), quem });
        else if (it.type === "web_search") logEvent(task.id, { t: "ferramenta", nome: "WebSearch", alvo: cut(it.query || "", 100), quem });
        else if (it.type === "error") ctx.erro(cut(it.message || "erro do codex", 300), /usage limit|rate limit/i.test(it.message || ""));
      } else if (ev.type === "turn.completed") {
        const u = ev.usage || {};
        out.turns += 1;
        out.tokens += (u.input_tokens || 0) + (u.output_tokens || 0);
        ctx.resultado(out.result, { tokens: (u.input_tokens || 0) + (u.output_tokens || 0) });
      } else if (ev.type === "turn.failed" || ev.type === "error") {
        const m = ev.error?.message || ev.message || "o codex devolveu erro";
        ctx.erro(cut(m, 300), /usage limit|rate limit|quota/i.test(m));
      }
    },
  },
  gemini: {
    rotulo: "Gemini", bin: "agy", moeda: "tokens",
    exemploModelo: "gemini-3.8-flash-high",
    // ⚠️ `--add-dir`: sem isso o agy NÃO trabalha na pasta de onde foi chamado — ele cai no
    // workspace próprio dele (~/.gemini/antigravity-cli/scratch) e a tarefa acontece no lugar
    // errado, em silêncio (visto em 22/09). O `dir` vem do projeto da tarefa.
    args: ({ prompt, regras, modelo, resume, dir }) => {
      const a = ["-p", regras ? regras + "\n\n---\n\n" + prompt : prompt,
        "--output-format", "stream-json", "--add-dir", dir];
      // ⚠️ `--mode accept-edits` deixa o agy ESCREVER mas NEGA comando em modo headless
      // ("a tool required the command permission ... auto-denied") e a tarefa sai vazia (#127).
      // Sem ninguém para aprovar, a única opção que funciona sem travar é pular a permissão.
      a.push("--dangerously-skip-permissions");
      if (modelo) a.push("--model", modelo);
      if (resume) a.push("--conversation", resume);
      return a.filter(Boolean);
    },
    trata: (ev, ctx) => {
      const { out, quem, task } = ctx;
      if (ev.event === "init" && ev.init && ev.conversation_id) ctx.sessao(ev.conversation_id);
      else if (ev.event === "step_update") {
        const s = ev.step_update || {};
        if (s.conversation_id && !out.sessionId) ctx.sessao(s.conversation_id);
        // O texto vem em pedaços (text_delta) por passo: junta e solta quando o passo termina.
        if (s.step_type === "agent_response") {
          out.parcial = (out.parcial || "") + (s.text_delta || "");
          if (s.state === "DONE") {
            const txt = (out.parcial || "").trim(); out.parcial = "";
            if (txt) { out.result = txt; logEvent(task.id, { t: "texto", texto: txt, quem }); }
          }
        } else if (s.step_type === "tool" && s.state === "DONE") {
          const ti = s.tool_info || {};
          const nome = ti.name || s.tool_name || "ferramenta";
          if (/write|edit|replace|create/i.test(nome)) out.escreveu = true;
          const par = ti.parameters || {};
          logEvent(task.id, { t: "ferramenta", nome, alvo: cut(par.CommandLine || par.TargetFile || par.Query || JSON.stringify(par), 100), quem });
        }
      } else if (ev.event === "result") {
        const r = ev.result || {};
        const u = r.usage || {};
        out.turns += r.num_turns || 1;
        out.tokens += (u.input_tokens || 0) + (u.output_tokens || 0);
        if (r.status && r.status !== "SUCCESS") ctx.erro(cut(r.response || r.error || `o agy terminou com status ${r.status}`, 300), /limit|quota/i.test(JSON.stringify(r).slice(0, 500)));
        else ctx.resultado(r.response || out.result, { tokens: (u.input_tokens || 0) + (u.output_tokens || 0) });
      }
    },
  },
  opencode: {
    rotulo: "opencode", bin: "opencode", moeda: "ambos",
    exemploModelo: "google/gemini-3-pro, openai/gpt-5.4",
    // Ponte para qualquer provedor que o opencode tenha autenticado (é o caminho do Gemini aqui).
    // Sem system-prompt separado: as regras da casa vão no começo do prompt, como no Codex.
    args: ({ prompt, regras, modelo, resume, imagens }) => {
      // `--auto`: sem isto o opencode recusa sozinho até mexer na pasta do próprio projeto
      // ("permission requested: external_directory ... auto-rejecting", visto em 22/09). O board
      // já roda cada tarefa na pasta certa e com o portão depois; quem escolhe o risco é o dono.
      const a = ["run", "--format", "json", "--auto"];
      if (modelo) a.push("-m", modelo);
      if (resume) a.push("-s", resume);
      for (const i of imagens || []) a.push("-f", i);
      a.push(regras ? regras + "\n\n---\n\n" + prompt : prompt);
      return a;
    },
    trata: (ev, ctx) => {
      const { out, quem, task } = ctx;
      if (ev.sessionID && !out.sessionId) ctx.sessao(ev.sessionID);
      const p = ev.part || {};
      if (ev.type === "text" && p.text?.trim()) { out.result = p.text; logEvent(task.id, { t: "texto", texto: p.text, quem }); }
      else if (ev.type === "tool_use" && p.state?.status === "completed") {
        if (/^(write|edit|patch|multiedit|apply)/i.test(p.tool || "")) out.escreveu = true;
        logEvent(task.id, { t: "ferramenta", nome: p.tool || "ferramenta", alvo: cut(p.state.title || JSON.stringify(p.state.input || {}), 100), quem });
      } else if (ev.type === "step_finish") {
        out.tokens += p.tokens?.total || 0;
        out.cost += p.cost || 0;
        out.turns += 1;
      } else if (ev.type === "error" || p.type === "error") {
        const m = ev.message || p.message || JSON.stringify(ev).slice(0, 200);
        ctx.erro(cut(m, 300), /usage limit|rate limit|quota|credit/i.test(m));
      }
    },
    // O opencode não tem evento de "turno acabou": a conta fecha quando o processo sai.
    fim: ({ out, resultado }) => { if (out.result || out.tokens) resultado(out.result, { custo: out.cost, tokens: out.tokens }); },
  },
};

const temBin = (() => {
  const cache = {};
  return (bin) => {
    if (cache[bin] === undefined) {
      try { execFileSync("which", [bin], { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:${process.env.PATH || ""}` } }); cache[bin] = true; }
      catch { cache[bin] = false; }
    }
    return cache[bin];
  };
})();
const motoresDisponiveis = () => Object.entries(MOTORES).filter(([, m]) => temBin(m.bin))
  .map(([id, m]) => ({ id, rotulo: m.rotulo, moeda: m.moeda, exemploModelo: m.exemploModelo }));
const motorDe = (id) => MOTORES[id] || MOTORES.claude;

/**
 * O AGENTE, com cura de sessão perdida. O board grava o sessionId no primeiro evento (pra retomar
 * se cair); se a tarefa for parada nos primeiros segundos, o Claude ainda não gravou a conversa e
 * todo `--resume` falha na hora com "No conversation found" — a retentativa virava laço de falha
 * instantânea (já aconteceu). Aqui: sessão perdida → esquece o id e recomeça com o prompt fresco.
 */
async function runAgent(task, prompt, opts = {}) {
  const { fresco, ...rest } = opts;
  const r = await runMotor(task, prompt, rest);
  if (!(r.sessaoPerdida && rest.resume)) return r;
  logEvent(task.id, { t: "solto", texto: "⚠ a sessão salva desta tarefa não existe mais (foi interrompida antes de o Claude gravar) — recomeçando do zero" });
  task.sessionId = null; save();
  return runMotor(task, fresco || task.text, { ...rest, resume: undefined });
}

function runMotor(task, prompt, { resume, quem = "agente", regras, modelo, tools, limite = TIMEOUT_MS, motor } = {}) {
  return new Promise((done) => {
    const project = projectOf(task);
    const id = motor || escolherMotor(quem, task);
    const M = motorDe(id);
    // Mensagem começando com "/" viraria slash-command no CLI. É texto do dono, não comando.
    const safe = /^\s*\//.test(prompt) ? "(texto literal do dono, não é comando)\n" + prompt : prompt;
    const modeloEfetivo = modelo && modeloServe(id, modelo) ? modelo
      : quem === "agente" ? modeloPara(id, task) : modeloDePapel(quem, id);
    const esforco = quem === "agente" && id === "claude" && !task.modelo ? ESFORCO_CLAUDE[task.porte] || "" : "";
    if (quem === "agente" && state.tasks.includes(task)) { task.modeloUsado = modeloEfetivo || MODELO_PADRAO[id] || ""; task.esforcoUsado = esforco; task.motorUsado = id; }
    const args = M.args({
      prompt: safe, regras: regras || houseRules(task, project), tools: tools || TOOLS,
      modelo: modeloEfetivo,
      resume, dir: project.dir,
      esforco, semCaptura: quem !== "agente",
      imagens: quem === "agente" ? (task.anexos || []).map((a) => a.caminho || join(ANEXOS, a.id)) : [],
    });

    const env = { ...process.env, PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:${process.env.PATH || ""}` };
    let cp;
    try { cp = spawn(M.bin, args, { cwd: project.dir, env, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { return done({ result: "", error: `não consegui iniciar o ${M.bin}: ` + e.message }); }
    running.set(task.id, cp);

    const out = { result: "", sessionId: resume || null, cost: 0, tokens: 0, turns: 0, dur: 0, code: null, error: null, escreveu: false, motor: id };
    const comecou = Date.now(); // motor que não informa duração (codex) ganha a do relógio
    let buf = "";
    const timer = setTimeout(() => { out.error = `tempo esgotado (${limite / 60000} min)`; cp.kill("SIGTERM"); }, limite);

    const handleLine = (line) => {
      const s = stripAnsi(line).trim();
      if (!s) return;
      if (RAW_LIGADO) appendFileSync(rawPath(task.id), s + "\n");
      if (!s.startsWith("{")) {
        if (/^Reading additional input from stdin/i.test(s)) return; // ruído do codex, não é evento
        // Erro do CLI sai em texto solto, não em JSON: é ele que explica o "devolveu erro".
        out.ultimoSolto = cut(s, 300);
        if (/No conversation found with session ID/i.test(s)) out.sessaoPerdida = true;
        logEvent(task.id, { t: "solto", texto: cut(s, 400) }); return;
      }
      let ev; try { ev = JSON.parse(s); } catch { return; }
      const ctx = {
        out, quem, task,
        sessao: (sid) => {
          out.sessionId = sid;
          // Só a sessão do AGENTE é a sessão da tarefa; a do revisor é descartável.
          if (quem === "agente" && !task.sessionId) { task.sessionId = sid; save(); }
        },
        erro: (texto, cota) => {
          out.error = texto;
          if (cota) out.cota = true; // quem sabe que foi cota é o motor, não uma palavra no texto
          logEvent(task.id, { t: "solto", texto: (cota ? "⛔ limite de uso: " : "⛔ erro: ") + cut(texto, 300) });
        },
        resultado: (texto, { custo = 0, tokens = 0 } = {}) => {
          out.result = texto || out.result;
          if (!out.dur) out.dur = Date.now() - comecou;
          logEvent(task.id, { t: "resultado", texto: out.result, custo, tokens, turnos: out.turns, dur: out.dur, quem, motor: id });
        },
      };
      M.trata(ev, ctx);
    };
    const onData = (d) => {
      buf += d;
      const lines = buf.split(/\r?\n/); buf = lines.pop();
      lines.forEach(handleLine);
    };
    cp.stdout.on("data", onData);
    cp.stderr.on("data", onData);
    cp.on("error", (e) => { out.error = `não consegui falar com o ${M.bin} (está no PATH?): ` + e.message; });
    cp.on("close", (code) => {
      clearTimeout(timer);
      if (buf.trim()) handleLine(buf);
      running.delete(task.id);
      out.code = code;
      // Motor que só fecha a conta no fim do processo (opencode) registra o resultado aqui.
      if (M.fim) M.fim({ out, quem, task, resultado: (texto, extra) => {
        out.result = texto || out.result;
        if (!out.dur) out.dur = Date.now() - comecou;
        logEvent(task.id, { t: "resultado", texto: out.result, turnos: out.turns, dur: out.dur, quem, motor: id, ...extra });
      } });
      if (code !== 0 && !out.result && !out.error) out.error = `o ${M.bin} saiu com código ${code}`;
      done(out);
    });
  });
}

/** A URL do PR sai no texto do agente; guardá-la é o que transforma "executada" em link clicável. */
function catchPrUrl(task, texto) {
  const m = String(texto || "").match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/);
  if (!m) return;
  // ⚠️ O PR da tarefa é o PRIMEIRO. Se uma rodada de conserto abrir outro, trocar aqui esconderia
  // o anterior, que fica aberto e esquecido — foi o que a #127 fez (três PRs, 22/09/2026).
  if (task.prUrl && task.prUrl !== m[0]) {
    task.prExtras = task.prExtras || [];
    if (!task.prExtras.includes(m[0])) {
      task.prExtras.push(m[0]);
      logEvent(task.id, { t: "solto", texto: `⚠️ O agente abriu OUTRO Pull Request (${m[0]}). A entrega desta tarefa continua sendo ${task.prUrl} — confira e feche o extra.` });
    }
    return;
  }
  task.prUrl = m[0];
}

function applyRunInfo(task, r) {
  catchPrUrl(task, r.result);
  // ⚠️ A sessão da tarefa é SÓ a do agente (runClaude grava). Aqui isto sobrescrevia com a sessão
  // do REVISOR: a rodada de conserto e a entrega da #7 foram parar na sessão do revisor, que
  // (certo) recusou commitar. O sessionId não passa mais por aqui.
  task.cost = Number(((task.cost || 0) + (r.cost || 0)).toFixed(4));
  task.tokens = (task.tokens || 0) + (r.tokens || 0);
  task.turns = (task.turns || 0) + (r.turns || 0);
  task.durationMs = (task.durationMs || 0) + (r.dur || 0);
}

/**
 * O veredito de revisor e QA. Prefere a LINHA que é só a palavra: o modelo às vezes escreve uma
 * frase antes (visto no teste do QA em 16/09), e procurar a primeira ocorrência solta leria
 * "o revisor tinha APROVADO, mas…" como aprovação. Sem veredito legível → null (fail-closed).
 */
function lerVeredito(texto) {
  const t = String(texto || "");
  const linha = t.match(/^[\s*_#>`-]*(APROVADO|REPROVADO)[\s*_.!`]*$/im);
  if (linha) return linha[1].toUpperCase();
  const m = t.match(/\b(APROVADO|REPROVADO)\b/i);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Onde está o trabalho a revisar. Depois que o agente abre o PR, a pasta pode estar de volta na
 * branch principal e limpa — `git diff` sozinho não mostra nada e o revisor "aprovaria o vazio".
 * Com PR aberto, o diff certo é o da branch dele contra a principal.
 */
function branchDoPr(task, project) {
  if (!task.prUrl) return "";
  try {
    return execFileSync("gh", ["pr", "view", task.prUrl, "--json", "headRefName", "-q", ".headRefName"],
      { cwd: project.dir, encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return ""; /* sem gh ou PR inacessível: segue sem o nome da branch */ }
}

function ondeEstaOTrabalho(task, project) {
  if (!task.prUrl) return "";
  const branch = branchDoPr(task, project);
  return [`O trabalho JÁ está no Pull Request ${task.prUrl}${branch ? ` (branch \`${branch}\`)` : ""}.`,
    branch ? `A pasta pode estar de volta na branch principal e limpa — o diff que vale é \`git diff origin/main...${branch}\` (ou \`gh pr diff ${task.prUrl}\`).` :
      `Use \`gh pr diff ${task.prUrl}\` para ver o que mudou.`].join(" ");
}

/** As regras do REVISOR: ele lê o que mudou e dá veredito. Não escreve código. */
function reviewerRules(task, project) {
  return [
    `Você é o REVISOR do board, revisando a tarefa #${task.id} no projeto "${project.slug}" (${project.dir}).`,
    "NÃO escreva nem altere arquivo nenhum. Não faça commit, push, PR nem merge. Você só lê e julga.",
    "🔴 PROIBIDO mexer na árvore de trabalho: nada de `git stash`, `git checkout`, `git reset`, `git clean`, `git restore`.",
    "Um stash que não volta apaga o trabalho do agente. Para ver o estado anterior use só leitura: `git diff`, `git show HEAD:<arquivo>`.",
    ondeEstaOTrabalho(task, project),
    "Como revisar: veja o que mudou (`git status`, `git log --oneline -5`, `git diff` da branch contra a principal)",
    "e leia os arquivos tocados. Confira contra o CLAUDE.md do projeto.",
    "O portão JÁ rodou a verificação do projeto e passou; não repita a suíte inteira várias vezes. Rode no máximo UM comando de teste, focado no que mudou.",
    "Procure DEFEITO DE VERDADE: quebra de regra da casa, isolamento/segurança furados, teste que não morde,",
    "número inventado, segredo commitado, promessa no resumo que o código não cumpre.",
    "Estilo e gosto pessoal NÃO reprovam.",
    "Responda assim: a PRIMEIRA LINHA é exatamente APROVADO ou REPROVADO.",
    "Depois, no máximo 8 linhas. Se reprovou, diga exatamente o que consertar, em itens.",
  ].join("\n");
}

/** Devolve o veredito do revisor. Sem veredito legível é REPROVA — fail-closed. */
async function runReviewer(task, project) {
  const r = await runMotor(task,
    [`Revise a tarefa #${task.id}.`, "", "O que o dono pediu:", comAnexos(task.text, task.anexos), "",
      "O que o agente respondeu que fez:", cut(task.result || "(sem resumo)", 2000)].join("\n"),
    { quem: "revisor", regras: reviewerRules(task, project), modelo: REVIEW_MODEL, tools: "Read,Grep,Glob,Bash" });
  applyRunInfo(task, r);
  if (r.error && !String(r.result || "").trim()) { if (r.cota) task.erroCota = true; return { falhou: true, motivo: `o revisor não rodou: ${cut(r.error, 160)}` }; }
  const veredito = lerVeredito(r.result);
  const ev = { t: "revisor", veredito: veredito || "SEM VEREDITO", texto: r.result || r.error || "", custo: r.cost };
  logEvent(task.id, ev);
  return { aprovado: veredito === "APROVADO", veredito, texto: r.result || "" };
}

/**
 * As regras do QA: ele TENTA QUEBRAR o que foi entregue, rodando de verdade — o revisor lê, o QA
 * executa. Não escreve no projeto: o único que escreve código é o agente (duas mãos na mesma pasta
 * se atropelam). Sonda e teste descartável vão para fora do repositório.
 */
function qaRules(task, project) {
  return [
    `Você é o QA do board, testando a entrega da tarefa #${task.id} no projeto "${project.slug}" (${project.dir}).`,
    "Seu trabalho é TENTAR QUEBRAR o que foi entregue, executando de verdade. O revisor já leu o código; você roda.",
    "🔴 NÃO altere arquivo do projeto, não faça commit, push, PR nem merge. Sonda, script ou teste descartável só FORA do repositório (ex.: /tmp).",
    "🔴 PROIBIDO mexer na árvore de trabalho: nada de `git stash`, `git checkout`, `git reset`, `git clean`, `git restore`.",
    "O que fazer, nesta ordem e sem se alongar (orçamento: uns 15 minutos):",
    ondeEstaOTrabalho(task, project),
    "1. Veja o que mudou (`git status`, `git diff`, ou `gh pr diff` se houver PR) e leia o CLAUDE.md do projeto.",
    "2. Exercite a mudança como um usuário e como um atacante: entrada vazia, enorme e inválida; outro tenant; papel sem permissão; repetir e disparar ao mesmo tempo. Use o que for executável: testes focados, chamadas à API, scripts em /tmp.",
    "3. INSTABILIDADE: rode os arquivos de teste que a tarefa criou ou alterou 5 vezes seguidas. Falha intermitente nesses arquivos é defeito DESTA entrega (reprova). Falha em arquivo que a tarefa não tocou é instabilidade PRÉ-EXISTENTE: anote e NÃO reprove por ela.",
    "Reprove só por defeito real e reproduzível. Estilo, gosto e melhoria opcional não reprovam.",
    "Responda assim: a PRIMEIRA LINHA é exatamente APROVADO ou REPROVADO.",
    "Depois, no máximo 10 linhas. Para cada defeito: o passo exato que reproduz (comando), o que aconteceu e o que devia acontecer. Se houver instabilidade pré-existente, cite numa linha separada.",
  ].join("\n");
}

/** Devolve o veredito do QA. Sem veredito legível é REPROVA — fail-closed, igual ao revisor. */
async function runQA(task, project) {
  const r = await runMotor(task,
    [`Teste a entrega da tarefa #${task.id}.`, "", "O que o dono pediu:", comAnexos(task.text, task.anexos), "",
      "O que o agente respondeu que fez:", cut(task.result || "(sem resumo)", 2000)].join("\n"),
    { quem: "qa", regras: qaRules(task, project), modelo: QA_MODEL, tools: "Read,Grep,Glob,Bash", limite: QA_TIMEOUT_MS });
  applyRunInfo(task, r);
  if (r.error && !String(r.result || "").trim()) { if (r.cota) task.erroCota = true; return { falhou: true, motivo: `o QA não rodou: ${cut(r.error, 160)}` }; }
  const veredito = lerVeredito(r.result);
  logEvent(task.id, { t: "qa", veredito: veredito || "SEM VEREDITO", texto: r.result || r.error || "", custo: r.cost });
  return { aprovado: veredito === "APROVADO", veredito, texto: r.result || r.error || "" };
}

/** Marca em que etapa a tarefa está (agente → portão → revisor → QA) e avisa a tela. */
function etapa(task, nome) { task.etapa = nome; task.updatedAt = now(); save(); broadcast("state"); }

function finaliza(task, status, motivo) {
  task.status = status; task.busy = false; task.etapa = null; task.finishedAt = now(); task.updatedAt = now();
  if (status === "erro") task.error = motivo || task.error;
  if (status === "executada") { task.tentativas = 0; task.retentativa = null; }
  // ⚡ aprovado: o runner junta na pasta principal assim que ela estiver livre.
  if (status === "executada" && task.worktree && !task.worktree.producao && !task.worktree.removida) task.worktree.juntar = "pendente";
  logEvent(task.id, { t: "fim", status, motivo: motivo || "" });
  if (status === "erro") scheduleRetry(task, task.error);
  save(); broadcast("state");
}

// ── retentativa automática ────────────────────────────────────────────────────
/**
 * Erro volta pra fila sozinho — mas NÃO às cegas. Cada motivo pede um remédio:
 *  - COTA: tentar de novo na hora falha de novo, e a fila inteira morre em sequência (foi o que
 *    aconteceu em 16/09: #17, #18, #19 e #38 em dois minutos). A fila PAUSA até o horário que o
 *    próprio CLI informa e retoma sozinha. Não gasta tentativa: não é culpa da tarefa.
 *  - TEMPO, PORTÃO, REVISOR, falha do processo: volta pra fila depois de um respiro, retomando a
 *    mesma sessão ("continue de onde parou"), no máximo BOARD_RETENTATIVAS vezes.
 *  - MESCLAR/PUBLICAR: NUNCA automático. Um deploy que falhou pela metade pede olho humano.
 */
function classifyError(motivo, task) {
  const m = String(motivo || "").trim();
  // A marca vem do MOTOR (ele sabe que foi cota); o texto é só reforço, e reconhece os três CLIs.
  if (task?.erroCota) return "cota";
  if (/cc_cli_limit_message/.test(m) || /^you'?ve hit your [\w ]*limit\b/i.test(m)) return "cota";
  if (/usage limit|rate limit|quota (exceeded|reached)|out of credits|limite de uso/i.test(m)) return "cota";
  if (/mescl|publica|deploy|URL do PR|URL de PR/i.test(m)) return "manual";
  if (/tempo esgotado/i.test(m)) return "tempo";
  if (/portão reprovou/i.test(m)) return "portao";
  if (/revisor reprovou/i.test(m)) return "revisor";
  if (/QA reprovou/i.test(m)) return "qa";
  return "falha";
}

/** O horário em que a cota volta, lido da própria mensagem do CLI ("resets 11:40pm"). */
function parseReset(msg, ref = new Date()) {
  const m = String(msg || "").match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!m) return null;
  let h = Number(m[1]) % 12; if (/pm/i.test(m[3])) h += 12;
  const d = new Date(ref); d.setHours(h, Number(m[2] || 0), 0, 0);
  if (d <= ref) d.setDate(d.getDate() + 1); // já passou hoje → é amanhã
  return d;
}

function scheduleRetry(task, motivo) {
  const tipo = classifyError(motivo, task);
  const hora = (ms) => new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  if (tipo === "manual") {
    task.retentativa = null;
    logEvent(task.id, { t: "retentativa", estado: "manual", texto: "erro em mesclar/publicar não é repetido sozinho — confira e decida" });
    return;
  }
  if (tipo === "cota") {
    const novo = proximoMotorComCota(task.motor || MOTOR_PADRAO);
    if (novo) { passarBastao(task, novo, "sem cota"); return; }
    const volta = parseReset(motivo);
    // +2 min de folga; nunca menos de 5 min, pra não virar laço se o horário vier estranho.
    const quando = Math.max(volta ? volta.getTime() + 2 * 60000 : Date.now() + 30 * 60000, Date.now() + 5 * 60000);
    state.pausaAte = Math.max(state.pausaAte || 0, quando);
    task.retentativa = { em: new Date(quando).toISOString(), tipo, conta: false };
    logEvent(task.id, { t: "retentativa", estado: "agendada", tipo, texto: `cota esgotada — a fila pausa e esta tarefa volta às ${hora(quando)}` });
    console.log(`${C.amber}⏸ fila pausada por cota até ${hora(quando)}${C.r}`);
    return;
  }
  const n = task.tentativas || 0;
  if (n >= RETRY_MAX) {
    task.retentativa = null;
    logEvent(task.id, { t: "retentativa", estado: "esgotada", tipo, texto: `sem mais tentativas automáticas (${n} de ${RETRY_MAX}) — precisa de você` });
    return;
  }
  task.tentativas = n + 1;
  const quando = Date.now() + RETRY_DELAY_MS;
  task.retentativa = { em: new Date(quando).toISOString(), tipo, conta: true, n: task.tentativas, max: RETRY_MAX };
  logEvent(task.id, { t: "retentativa", estado: "agendada", tipo, texto: `volta pra fila às ${hora(quando)} (tentativa ${task.tentativas} de ${RETRY_MAX}), continuando a mesma sessão` });
}

/**
 * A esteira de uma tarefa: AGENTE → PORTÃO (verificação do projeto) → REVISOR (só no modo PR).
 * O portão só roda se a rodada mexeu em arquivo — perguntar não precisa de teste.
 */
async function runTask(task) {
  task.agente = nomeDeAgente(task);
  // 🔴 Projeto de PRODUÇÃO trabalha SEMPRE numa cópia, mesmo sem ⚡: a pasta do dono é a bancada
  // DELE. Em 24/09/2026 um bloco de documentação sem commit no CLAUDE.md de um projeto de produção fez o
  // `git pull --ff-only` do agente falhar, e a fila inteira do projeto parou — o sintoma que chegou
  // ao dono foi "o tmux não abre as abas dos eng", porque sem agente rodando não nasce aba.
  const precisaCopia = task.paralelo || PRODUCAO.includes(task.project);
  if (precisaCopia && (!task.worktree || task.worktree.removida || !existsSync(task.worktree.dir))) {
    try { criarCopia(task); }
    catch (e) { task.status = "rodando"; return finaliza(task, "erro", "não consegui criar a cópia isolada: " + cut(String(e.stderr || e.message), 300)); }
  }
  const project = projectOf(task);
  // Retomada depois de erro: a mesma sessão continua de onde parou, em vez de receber a tarefa
  // inteira de novo e recomeçar (o que repetiria o trabalho e, no caso de tempo, o mesmo buraco).
  const erroAnterior = task.retomar && task.sessionId ? task.error : null;
  const bastao = task.passagem && !task.sessionId ? task.passagem : null;
  // Guarda a reprovação anterior ANTES de limpar: rodada que não mexe em nada não a resolve.
  const reprovaAnterior = task.reprovaPendente || task.revisor?.veredito === "REPROVADO" || task.qa?.veredito === "REPROVADO";
  task.retomar = false;
  task.status = "rodando"; task.busy = true; task.startedAt = now(); task.updatedAt = now(); task.error = null;
  task.gate = null; task.revisor = null; task.qa = null;
  etapa(task, "agente");
  logEvent(task.id, { t: "inicio", titulo: (erroAnterior ? "retomada — " : "") + task.title, projeto: project.slug, dir: project.dir });

  const marca = marcarInstante();
  const prompt = bastao ? comAnexos(textoDaPassagem(task, MOTORES[bastao.de]?.rotulo || bastao.de, bastao.para, bastao.motivo), task.anexos)
    : erroAnterior
    ? ["A rodada anterior desta tarefa terminou em ERRO:", erroAnterior, "",
        "Continue de onde parou e TERMINE a tarefa. Não recomece do zero e não refaça o que já está feito.",
        "Se o erro foi tempo esgotado: vá direto ao que falta e não abra investigação fora do escopo."].join("\n")
    : comAnexos(task.text, task.anexos);
  if (bastao) task.passagem = null; // o bastão só vale para a primeira rodada do novo motor
  // Romaneio: só quando o agente começa do zero (sessão nova ou outro motor). Na retomada, a sessão já tem.
  let pedido = prompt;
  if (ROMANEIO_LIGADO && !task.sessionId && !erroAnterior) {
    let rom = null; try { rom = montarRomaneio(task); } catch (e) { logEvent(task.id, { t: "solto", texto: "⚠ romaneio falhou: " + cut(e.message, 160) }); }
    if (rom) {
      pedido = rom.texto + "\n\n---\n\n## A tarefa\n\n" + prompt;
      const { texto, ...registro } = rom; task.romaneio = registro;
      logEvent(task.id, { t: "romaneio", mentes: rom.mentes, itens: rom.itens, tokens: rom.tokensAprox });
    }
  }
  let r = await runAgent(task, pedido, { resume: task.sessionId || undefined });
  applyRunInfo(task, r);
  if (r.cota) task.erroCota = true;
  if (task.status !== "rodando") return finaliza(task, task.status, "parada pelo dono");
  if (r.error && !r.result) return finaliza(task, "erro", r.error);
  task.result = r.result;

  const mexeu = r.escreveu || mexeuEmArquivo(project.dir, marca);
  // Resposta vazia E nada mexido = o motor não trabalhou (permissão negada, saída vazia…).
  // Marcar isso como "executada" é o pior dos mundos: parece pronto e não é (#127 no Gemini).
  if (!String(task.result || "").trim() && !mexeu) {
    return finaliza(task, "erro", "o motor não produziu resposta nem mexeu em arquivo — veja o histórico");
  }
  if (reprovaAnterior && !mexeu) {
    return finaliza(task, "erro", "a conferência tinha REPROVADO e esta rodada não mexeu em nada — o defeito continua de pé");
  }
  const v = await esteira(task, project, { mexeu });
  if (v.parou) return finaliza(task, task.status, "parada pelo dono");
  if (!v.ok) return finaliza(task, "erro", v.motivo);
  // Modo PR/deploy sem PR aberto: o agente fez o trabalho mas não entregou — entrega agora.
  // ⚠️ Só se a rodada MEXEU em arquivo: tarefa de diagnóstico ("pode verificar?") responde sem
  // mudar nada, e exigir PR dela virava erro (22/09/2026).
  if (mexeu && (task.entrega === "pr" || task.entrega === "deploy") && !task.prUrl) return entregar(task, project);
  if (task.entrega === "deploy") {
    const p = await mesclarEPublicar(task, project);
    if (!p.ok) return finaliza(task, "erro", p.motivo);
  }
  finaliza(task, "executada");
}

/**
 * A CONFERÊNCIA: portão (verificação do projeto) e, no modo PR, revisor — com uma rodada de
 * conserto pelo próprio agente. Vale para a tarefa recém-rodada e para o "Virar PR" de uma
 * tarefa antiga, por isso mora fora do runTask.
 */
async function esteira(task, project, { mexeu }) {
  const comando = gateCommand(project);
  let rodada = 0;

  while (true) {
    // ── portão ──────────────────────────────────────────────────────────────
    if (comando && mexeu) {
      etapa(task, "portao");
      logEvent(task.id, { t: "portao", estado: "rodando", comando });
      const g = await runGate(task, project, comando);
      if (task.status !== "rodando") return { parou: true };
      task.gate = { comando, ok: g.ok, code: g.code, em: now() };
      logEvent(task.id, { t: "portao", estado: g.ok ? "passou" : "falhou", comando, code: g.code, saida: g.saida });
      if (!g.ok) {
        if (rodada >= REVIEW_ROUNDS) return { ok: false, motivo: `o portão reprovou (${comando})` };
        rodada++;
        etapa(task, "agente");
        const fix = await runMotor(task,
          ["O PORTÃO do board reprovou o seu trabalho. O comando de verificação do projeto falhou:",
            "", "$ " + comando, g.saida.slice(-4000), "",
            "Conserte de verdade (não desligue teste nem afrouxe conferência) e responda o que mudou."].join("\n"),
          { resume: task.sessionId || undefined });
        applyRunInfo(task, fix);
        if (task.status !== "rodando") return { parou: true };
        // ⚠️ A rodada de CONSERTO também pode estourar cota ou falhar. Ignorar isso fazia o board
        // seguir para o portão, reprovar e culpar o código por uma falha de motor (#127, 22/09).
        if (fix.cota) { task.erroCota = true; return { ok: false, motivo: fix.error || "cota esgotada no conserto" }; }
        if (fix.error && !String(fix.result || "").trim()) return { ok: false, motivo: fix.error };
        if (fix.result) task.result = fix.result;
        continue; // roda o portão de novo
      }
    }
    // ── revisor: em TODA tarefa que mexeu em arquivo (antes era só no modo PR) ─
    // Decisão do dono em 16/09 ("fica Revisor > QA"): o revisor custou 1,1% do gasto e pegou
    // entrega com teste instável que o portão, rodando uma vez só, deixou passar.
    if (REVISOR_LIGADO && mexeu) {
      etapa(task, "revisor");
      const rev = await runReviewer(task, project);
      if (task.status !== "rodando") return { parou: true };
      if (rev.falhou) return { ok: false, motivo: rev.motivo }; // falha de infraestrutura, não reprova o trabalho
      task.revisor = { veredito: rev.veredito, rodadas: rodada, em: now() };
      task.reprovaPendente = !rev.aprovado; // só sai quando alguém aprovar de verdade
      if (!rev.aprovado) {
        if (rodada >= REVIEW_ROUNDS) return { ok: false, motivo: `o revisor reprovou (${rev.veredito || "sem veredito"})` };
        rodada++;
        etapa(task, "agente");
        const fix = await runMotor(task,
          ["O REVISOR do board reprovou o seu trabalho:", "", rev.texto, "",
            "Corrija o que ele apontou e responda o que mudou. Se discordar, explique com evidência."].join("\n"),
          { resume: task.sessionId || undefined });
        applyRunInfo(task, fix);
        if (task.status !== "rodando") return { parou: true };
        // ⚠️ A rodada de CONSERTO também pode estourar cota ou falhar. Ignorar isso fazia o board
        // seguir para o portão, reprovar e culpar o código por uma falha de motor (#127, 22/09).
        if (fix.cota) { task.erroCota = true; return { ok: false, motivo: fix.error || "cota esgotada no conserto" }; }
        if (fix.error && !String(fix.result || "").trim()) return { ok: false, motivo: fix.error };
        if (fix.result) task.result = fix.result;
        continue; // volta pro portão e revisa de novo
      }
    }
    // ── QA: tenta quebrar, rodando de verdade (inclui instabilidade da entrega) ─
    if (QA_LIGADO && mexeu) {
      etapa(task, "qa");
      const qa = await runQA(task, project);
      if (task.status !== "rodando") return { parou: true };
      if (qa.falhou) return { ok: false, motivo: qa.motivo }; // falha de infraestrutura, não reprova o trabalho
      task.qa = { veredito: qa.veredito, rodadas: rodada, em: now() };
      task.reprovaPendente = !qa.aprovado;
      if (!qa.aprovado) {
        if (rodada >= REVIEW_ROUNDS) return { ok: false, motivo: `o QA reprovou (${qa.veredito || "sem veredito"})` };
        rodada++;
        etapa(task, "agente");
        const fix = await runMotor(task,
          ["O QA do board testou a sua entrega e REPROVOU:", "", qa.texto, "",
            "Reproduza cada defeito com o passo que ele deu, conserte na causa, deixe um teste que morda o defeito, e responda o que mudou.",
            "Instabilidade que ele marcou como PRÉ-EXISTENTE não é sua: não mexa nela."].join("\n"),
          { resume: task.sessionId || undefined });
        applyRunInfo(task, fix);
        if (task.status !== "rodando") return { parou: true };
        // ⚠️ A rodada de CONSERTO também pode estourar cota ou falhar. Ignorar isso fazia o board
        // seguir para o portão, reprovar e culpar o código por uma falha de motor (#127, 22/09).
        if (fix.cota) { task.erroCota = true; return { ok: false, motivo: fix.error || "cota esgotada no conserto" }; }
        if (fix.error && !String(fix.result || "").trim()) return { ok: false, motivo: fix.error };
        if (fix.result) task.result = fix.result;
        continue; // portão → revisor → QA de novo
      }
    }
    break;
  }
  return { ok: true };
}

/**
 * MESCLAR E PUBLICAR — o passo que a casa sempre deixou na mão do dono. Só roda com trava:
 * comando declarado pelo dono em data/deploy.json, portão verde, revisor APROVADO e PR aberto.
 * Quem mescla e quem publica são COMANDOS FIXOS, não o agente improvisando: publicação
 * improvisada é o caminho mais curto para derrubar produção.
 */
async function mesclarEPublicar(task, project) {
  const comando = deployCommand(project);
  if (!comando) return { ok: false, motivo: `o projeto "${project.slug}" não tem comando de publicação declarado (data/deploy.json)` };
  if (!task.prUrl) return { ok: false, motivo: "não achei a URL do PR para mesclar" };
  if (!task.revisor || task.revisor.veredito !== "APROVADO") return { ok: false, motivo: "o revisor não aprovou — não mesclo" };
  if (task.gate && !task.gate.ok) return { ok: false, motivo: "o portão não passou — não mesclo" };

  etapa(task, "merge");
  const mergeCmd = `gh pr merge ${JSON.stringify(task.prUrl)} --squash --delete-branch`;
  logEvent(task.id, { t: "passo", nome: "merge", estado: "rodando", comando: mergeCmd });
  const m = await runGate(task, project, mergeCmd);
  logEvent(task.id, { t: "passo", nome: "merge", estado: m.ok ? "passou" : "falhou", comando: mergeCmd, code: m.code, saida: m.saida });
  if (!m.ok) return { ok: false, motivo: "não consegui mesclar o PR" };
  task.merged = { em: now() };

  etapa(task, "deploy");
  logEvent(task.id, { t: "passo", nome: "deploy", estado: "rodando", comando });
  const d = await runGate(task, project, comando, DEPLOY_TIMEOUT_MS);
  logEvent(task.id, { t: "passo", nome: "deploy", estado: d.ok ? "passou" : "falhou", comando, code: d.code, saida: d.saida });
  task.deploy = { comando, ok: d.ok, em: now() };
  if (!d.ok) return { ok: false, motivo: `a publicação falhou (${comando}) — ⚠️ o PR JÁ FOI MESCLADO, confira o servidor` };
  return { ok: true };
}

/**
 * VIRAR PR — o trabalho já está feito na pasta; isto só ENTREGA (confere e abre o Pull Request),
 * na mesma sessão do agente. Existe porque a decisão de virar PR quase sempre vem DEPOIS de ver
 * o resultado, e refazer a tarefa inteira só para ganhar um PR seria pagar duas vezes pelo mesmo.
 */
async function prTask(task, alvo = "pr") {
  const project = projectOf(task);
  task.entrega = alvo; task.status = "rodando"; task.busy = true; task.error = null;
  task.gate = null; task.revisor = null; task.qa = null;
  etapa(task, "agente");
  logEvent(task.id, { t: "inicio", titulo: (alvo === "deploy" ? "entregar, mesclar e publicar — " : "entrega por PR — ") + task.title, projeto: project.slug, dir: project.dir });

  const v = await esteira(task, project, { mexeu: true });
  if (v.parou) return finaliza(task, task.status, "parada pelo dono");
  if (!v.ok) return finaliza(task, "erro", v.motivo);
  await entregar(task, project, { exigirPr: false }); // pedido na mão: sem mudança, não é erro
}

/**
 * O passo de ENTREGA (branch, commit, push, PR) e, no modo deploy, mesclar e publicar.
 * Chamado pelo "Virar PR" e também no fim de uma tarefa em modo PR cujo agente terminou sem
 * abrir o PR — já aconteceu: 20 arquivos prontos na main, revisor aprovando, e
 * ninguém para abrir o PR.
 */
async function entregar(task, project, { exigirPr = true } = {}) {
  etapa(task, "entrega");
  const r = await runMotor(task,
    ["O trabalho desta tarefa JÁ ESTÁ FEITO nesta pasta. NÃO refaça nada e não mude o comportamento do código.",
      "Sua única função agora é ENTREGAR por Pull Request, seguindo a sequência de entrega das regras.",
      "Se não houver mudança nenhuma para entregar, diga isso e não invente commit.",
      "Responda com a URL do PR."].join("\n"),
    { resume: task.sessionId || undefined });
  applyRunInfo(task, r);
  if (task.status !== "rodando") return finaliza(task, task.status, "parada pelo dono");
  if (r.error && !r.result) return finaliza(task, "erro", r.error);
  task.result = r.result;
  if (!task.prUrl) {
    // Sem PR pode ser as duas coisas: não havia nada a entregar (certo) ou o agente falhou (erro).
    // Automático (a rodada mexeu em arquivo) exige PR; pedido na mão só reclama se a pasta tem
    // mudança pendente — e mesmo assim ela pode ser do dono, então o texto diz isso.
    if (!exigirPr && !haMudancas(project.dir)) { logEvent(task.id, { t: "solto", texto: "nada para entregar: a pasta não tem mudança pendente" }); return finaliza(task, "executada"); }
    return finaliza(task, "erro", "a entrega terminou sem URL de PR — veja o resumo do agente (se a tarefa não mudou arquivo, não havia o que entregar)");
  }
  if (task.entrega === "deploy") {
    const p = await mesclarEPublicar(task, project);
    if (!p.ok) return finaliza(task, "erro", p.motivo);
  }
  finaliza(task, "executada");
}

async function chatTask(task, text, anexos = []) {
  task.busy = true; task.updatedAt = now(); save(); broadcast("state");
  const fotos = anexosValidos(anexos);
  logEvent(task.id, { t: "dono", texto: text, anexos: fotos.map((a) => ({ id: a.id, nome: a.nome })) });
  const contexto = `Tarefa #${task.id} do board:\n${task.text}\n\nO dono diz sobre ela:\n${text}`;
  const prompt = comAnexos(task.sessionId ? text : contexto, fotos);
  const r = await runAgent(task, prompt, { resume: task.sessionId || undefined, fresco: comAnexos(contexto, fotos) });
  applyRunInfo(task, r);
  task.busy = false; task.updatedAt = now();
  if (r.error && !r.result) logEvent(task.id, { t: "solto", texto: "⚠ " + r.error });
  save(); broadcast("state");
}

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
const conversaId = (slug) => `conversa-${slug}`;
const conversaOcupada = () => Object.values(state.conversas || {}).some((c) => c && c.busy);

function conversaDe(slug) {
  state.conversas = state.conversas || {};
  state.conversas[slug] = state.conversas[slug] || { sessionId: null, motor: null, modelo: null, busy: false, custo: 0, updatedAt: now() };
  return state.conversas[slug];
}

function regrasConversa(project, tarefaRodando) {
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
const CONVERSA_VIVA_MS = Number(process.env.BOARD_CONVERSA_VIVA_MIN || 30) * 60000;
const vivos = new Map(); // slug → { cp, chave, turno, custoAcum, ocioso, buf }

function matarVivo(slug) {
  const v = vivos.get(slug);
  if (!v) return;
  vivos.delete(slug);
  clearTimeout(v.ocioso);
  try { v.cp.kill("SIGTERM"); } catch { /* já tinha saído */ }
}
process.on("exit", () => { for (const v of vivos.values()) { try { v.cp.kill("SIGTERM"); } catch { /* já saiu */ } } });

function abrirVivo(slug, project, { chave, regras, tools, modelo, resume }) {
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

function turnoVivo(slug, project, task, prompt, { regras, tools, modelo }) {
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

async function falarNaConversa(slug, texto, { anexos = [], motor, modelo } = {}) {
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

function stopTask(task, newStatus = "pendente") {
  const cp = running.get(task.id), g = gates.get(task.id);
  task.status = newStatus; task.busy = false; task.etapa = null; task.updatedAt = now();
  if (cp) cp.kill("SIGTERM");
  if (g) killGroup(g);
  save(); broadcast("state");
}

// O runner: a cada 1,5s, se tem vaga, pega a próxima da fila (na ordem do quadro).
// Só começa depois que a porta é nossa (ver listen) — senão um segundo board rodaria a fila.
// Reinício pedido pela tela/CLI: o board sai sozinho (código 75, o board.sh sobe de novo) no
// primeiro instante em que nada estiver rodando — nunca no meio de uma tarefa. Antes disso,
// carregar código novo significava alguém derrubar o servidor com tarefa no meio.
let restartPending = false;
function startRunner() {
  setInterval(() => {
    if (restartPending && !state.tasks.some((t) => t.status === "rodando" || t.busy) && !conversaOcupada()) {
      console.log(`${C.amber}↻ reiniciando (nada rodando) — o board.sh sobe de novo${C.r}`);
      try { save(); } catch { /* disco */ }
      try { unlinkSync(LOCK); } catch { /* sem lock */ }
      process.exit(75);
    }
    // Pausada pelo dono: nada novo começa, e nem retentativa volta pra fila, até ele retomar.
    if (filaPausada()) return;
    // Cota esgotada: nada novo começa até o horário em que ela volta.
    const agora = Date.now();
    if (state.pausaAte && agora < state.pausaAte) return;
    if (state.pausaAte && agora >= state.pausaAte) { state.pausaAte = 0; console.log(`${C.green}▶ cota de volta — fila retomada${C.r}`); save(); broadcast("state"); }
    // Retentativas vencidas voltam pra fila, retomando a sessão.
    for (const t of state.tasks) {
      if (t.status === "erro" && t.retentativa && Date.parse(t.retentativa.em) <= agora) {
        t.status = "fila"; t.retomar = true; t.retentativa = null; t.updatedAt = now();
        logEvent(t.id, { t: "retentativa", estado: "na-fila", texto: "voltou pra fila automaticamente" });
        save(); broadcast("state");
      }
    }
    // ⚡ Trabalho aprovado numa cópia volta pra pasta principal — só com ela livre (sem agente
    // nem conversa escrevendo lá), senão seria outro atropelo.
    for (const t of state.tasks) {
      if (t.worktree?.juntar !== "pendente") continue;
      const ocupada = state.tasks.some((o) => o.project === t.project && !o.paralelo && (o.status === "rodando" || o.busy))
        || !!(state.conversas || {})[t.project]?.busy;
      if (!ocupada) juntarNaPasta(t);
    }
    const active = state.tasks.filter((t) => t.status === "rodando");
    if (active.length >= PARALLEL) return;
    const naPasta = {}, emCopia = {};
    for (const t of active) { const m = t.paralelo ? emCopia : naPasta; m[t.project] = (m[t.project] || 0) + 1; }
    const cabe = (t) => (t.paralelo ? (emCopia[t.project] || 0) < PARALELO_POR_PROJETO : (naPasta[t.project] || 0) < PER_PROJECT);
    const next = state.tasks
      .filter((t) => t.status === "fila" && !t.busy && !t.classificando && cabe(t))
      .sort((a, b) => a.order - b.order)[0];
    if (next) {
      const acao = next.acao; next.acao = null;
      if (acao) prTask(next, acao); else runTask(next);
    }
  }, 1500);
}

// Ao parar o board (Ctrl+C, kill), derruba os agentes filhos e deixa as tarefas pendentes —
// agente órfão continua editando o projeto sem ninguém gravar o que ele faz.
function shutdown(signal) {
  for (const [id, cp] of running) {
    const t = taskById(id);
    if (t) {
      // Pergunta do chat morre calada se ninguém disser nada: o dono fica esperando uma
      // resposta que não vem. Tarefa interrompida volta pra pendente; conversa ganha o aviso.
      if (t.status === "rodando") { t.status = "pendente"; logEvent(id, { t: "fim", status: "pendente", motivo: `board parado (${signal}) — rode de novo` }); }
      else logEvent(id, { t: "solto", texto: `⚠ o board foi parado (${signal}) antes da resposta — mande a pergunta de novo` });
      t.busy = false;
    }
    try { cp.kill("SIGKILL"); } catch { /* já morreu */ }
  }
  for (const [, g] of gates) killGroup(g);
  try { save(); } catch { /* disco */ }
  try { unlinkSync(LOCK); } catch { /* sem lock */ }
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ── tarefas ───────────────────────────────────────────────────────────────────
/** Mensagem com várias linhas "- item" / "1. item" vira várias tarefas; senão, uma só. */
function splitTasks(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const bullets = lines.filter((l) => /^([-*•]|\d+[.)])\s+/.test(l));
  if (lines.length >= 2 && bullets.length === lines.length) return bullets.map((l) => l.replace(/^([-*•]|\d+[.)])\s+/, ""));
  return [String(text).trim()];
}

function createTasks(text, project, { queue = false, entrega = "direto", anexos = [], motor, modelo, porte, paralelo = false } = {}) {
  const anexados = anexosValidos(anexos);
  const created = [];
  for (const t of splitTasks(text)) {
    if (!t) continue;
    const id = ++state.seq;
    const task = {
      id, text: t, title: titleOf(t), project: project || "DEV", status: queue ? "fila" : "pendente",
      entrega: ["pr", "deploy"].includes(entrega) ? entrega : "direto", prUrl: null,
      etapa: null, gate: null, revisor: null, qa: null, merged: null, deploy: null, anexos: anexados,
      motor: MOTORES[motor] ? motor : MOTOR_PADRAO, modelo: cut(String(modelo || ""), 60) || null,
      porte: PORTES.includes(porte) ? porte : null, tokens: 0,
      order: id, createdAt: now(), updatedAt: now(), startedAt: null, finishedAt: null,
      sessionId: null, cost: 0, turns: 0, durationMs: 0, result: null, error: null, busy: false,
    };
    if (paralelo) {
      task.paralelo = true;
      // Produção só por PR (regra de ouro): o agente ⚡ entrega pela branch dele.
      if (PRODUCAO.includes(task.project) && task.entrega === "direto") task.entrega = "pr";
    }
    if (CLASSIFICAR && !task.porte && !task.modelo) task.classificando = true;
    state.tasks.push(task); created.push(task);
  }
  save(); broadcast("state");
  for (const t of created) if (t.classificando) classificarPorte(t);
  return created;
}

/**
 * Decide o porte da tarefa nova (leve/normal/pesado) com uma chamada curta e barata: haiku, sem
 * ferramenta, sem MCP, sem hooks, fora de qualquer projeto. Medido em 24/09: 5–7 s, US$ 0,004–0,015.
 * A tarefa não sai da fila enquanto isso (`classificando`); se falhar, vai sem porte (esforço padrão).
 */
function classificarPorte(task) {
  const prompt = [
    "Classifique o PORTE desta tarefa de programação; ele decide quanto o agente pensa antes de agir.",
    "leve = mudança pequena, localizada e óbvia (texto, cor, um ajuste num lugar só, pergunta simples).",
    "pesado = mexe em várias partes, migração de banco, segurança, dinheiro, produção, bug difícil de achar, desenho de arquitetura.",
    "normal = todo o resto.",
    "Responda SÓ uma palavra: leve, normal ou pesado.",
    "", `Projeto: ${task.project}`, "Tarefa:", String(task.text || "").slice(0, 4000),
  ].join("\n");
  const args = ["-p", prompt, "--model", "haiku", "--output-format", "json", "--no-session-persistence",
    "--strict-mcp-config", "--setting-sources", "", "--tools", ""];
  const env = { ...process.env, PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:${process.env.PATH || ""}` };
  execFile("claude", args, { cwd: tmpdir(), env, timeout: 60000, maxBuffer: 1 << 20 }, (_err, stdout) => {
    let porte = null, custo = 0;
    try {
      const d = JSON.parse(stdout);
      custo = d.total_cost_usd || 0;
      porte = (String(d.result || "").toLowerCase().match(/\b(leve|normal|pesado)\b/) || [])[1] || null;
    } catch { /* sem resposta legível: vai sem porte */ }
    task.classificando = false;
    task.cost = Number(((task.cost || 0) + custo).toFixed(4));
    // O automático só BAIXA o esforço (leve) ou mantém o normal: "pesado" (xhigh) é escolha do dono.
    // Decisão de 24/09 — a #165 foi classificada pesada, rodou em xhigh e gastou US$ 1,76 para parar no passo 0.
    if (porte === "pesado") porte = "normal";
    if (!task.porte && !task.modelo && porte) { task.porte = porte; task.porteAuto = true; }
    const esf = task.motor === "claude" ? ESFORCO_CLAUDE[porte] : "";
    logEvent(task.id, { t: "solto", texto: porte
      ? `porte ${porte} (automático${esf ? `, esforço ${esf}` : ""}) — dá pra trocar na ficha`
      : "⚠ não consegui classificar o porte — vai com o esforço padrão" });
    save(); broadcast("state");
  });
}

function updateTask(task, patch) {
  // O dono mexeu no status à mão: a decisão é dele — cancela a retentativa agendada e zera a conta.
  if (patch.status && STATUSES.includes(patch.status)) { task.retentativa = null; task.tentativas = 0; }
  if (patch.status && STATUSES.includes(patch.status) && patch.status !== task.status) {
    if (task.status === "rodando" && patch.status !== "rodando") stopTask(task, patch.status);
    else if (patch.status === "rodando") throw new Error('use status "fila" — o runner é quem põe pra rodar');
    else { task.status = patch.status; if (patch.status === "concluida") { task.finishedAt = task.finishedAt || now(); removerCopia(task); } }
  }
  if (typeof patch.text === "string" && patch.text.trim()) { task.text = patch.text.trim(); task.title = titleOf(task.text); }
  if (typeof patch.project === "string") task.project = patch.project;
  if (["pr", "direto", "deploy"].includes(patch.entrega)) task.entrega = patch.entrega;
  if (MOTORES[patch.motor] && patch.motor !== task.motor) {
    task.motor = patch.motor;
    if (task.modelo && !modeloServe(patch.motor, task.modelo)) task.modelo = null;
  }
  if (typeof patch.modelo === "string") task.modelo = cut(patch.modelo, 60) || null;
  if (patch.porte === null || PORTES.includes(patch.porte)) { task.porte = patch.porte || null; task.porteAuto = false; task.classificando = false; }
  if (typeof patch.order === "number") task.order = patch.order;
  task.updatedAt = now();
  save(); broadcast("state");
}

function reorder(ids) {
  const base = ids.map((id, i) => [taskById(id), i]).filter(([t]) => t);
  for (const [t, i] of base) t.order = i + 1;
  save(); broadcast("state");
}

function removeTask(task) {
  if (task.status === "rodando") stopTask(task);
  removerCopia(task);
  state.tasks = state.tasks.filter((t) => t.id !== task.id);
  for (const p of [logPath(task.id), rawPath(task.id)]) { try { unlinkSync(p); } catch { /* sem log */ } }
  save(); broadcast("state");
}

// ── uso do plano do Claude (/usage) ───────────────────────────────────────────
/**
 * O PLANO — o /usage do Claude Code roda no modo `-p` SEM gastar nada (0 turnos, custo 0) e
 * devolve o painel da assinatura: quanto da sessão e da semana já foi usado e quando renova.
 * O board só LÊ e traduz esse painel; não estima nem inventa saldo. (Em 15/09 eu disse ao dono
 * que isso não saía pela CLI — estava errado: não tinha testado o `/usage` no modo -p.)
 * Cache de 60 s: cada leitura sobe um processo do CLI.
 */
let usoCache = null, usoEmVoo = null;
const MESES = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** "Sep 17 at 9:59am (America/Sao_Paulo)" → ISO. O Mac do dono está no mesmo fuso. */
function parseQuando(txt) {
  const m = String(txt || "").match(/\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm))?/i);
  if (!m || MESES[m[1].toLowerCase()] === undefined) return null;
  const agora = new Date();
  let h = m[3] ? Number(m[3]) % 12 : 0; if (m[5] && /pm/i.test(m[5])) h += 12;
  const d = new Date(agora.getFullYear(), MESES[m[1].toLowerCase()], Number(m[2]), h, Number(m[4] || 0));
  if (d.getTime() < agora.getTime() - 180 * 86400000) d.setFullYear(d.getFullYear() + 1); // virada de ano
  return d.toISOString();
}

/** As frases fixas do painel em português; o que não reconhecer passa como veio. */
function traduzUso(s) {
  return String(s)
    .replace(/^Current session$/i, "Sessão atual")
    .replace(/^Current week \(all models\)$/i, "Semana · todos os modelos")
    .replace(/^Current week \((.+)\)$/i, "Semana · $1")
    .replace(/^Current month$/i, "Mês atual")
    .replace(/(\d[\d.,]*) requests?/i, "$1 requisições")
    .replace(/(\d[\d.,]*) sessions?/i, "$1 sessões")
    .replace(/^(\d+)% of your usage was at >(\S+) context$/i, "$1% do uso foi com contexto acima de $2")
    .replace(/^(\d+)% of your usage came from sessions active for (\S+) hours$/i, "$1% do uso veio de sessões abertas há $2 horas")
    .replace(/^(\d+)% of your usage came from subagent-heavy sessions$/i, "$1% do uso veio de sessões com muitos subagentes")
    .replace(/^Top skills:/i, "Skills que mais pesam:")
    .replace(/^Top subagents:/i, "Subagentes que mais pesam:")
    .replace(/^Top MCP servers:/i, "Servidores MCP que mais pesam:");
}

function parseUso(texto) {
  const limites = [], contrib = [], extras = [];
  let atual = null, modo = "", nota = "";
  for (const l of String(texto || "").split(/\r?\n/).map((x) => x.trim())) {
    if (!l) continue;
    let m;
    if ((m = l.match(/^(.+?):\s*(\d+(?:\.\d+)?)%\s*used(?:\s*·\s*resets\s+(.+))?$/i))) {
      limites.push({ nome: traduzUso(m[1]), pct: Number(m[2]), renovaTexto: m[3] || "", renovaEm: parseQuando(m[3]) });
      continue;
    }
    if ((m = l.match(/^Last\s+(\S+)\s*·\s*(.+)$/i))) {
      const j = m[1].toLowerCase();
      atual = { janela: j === "24h" ? "Últimas 24h" : j === "7d" ? "Últimos 7 dias" : "Últimos " + m[1], resumo: m[2].split("·").map((x) => traduzUso(x.trim())).join(" · "), itens: [] };
      contrib.push(atual); continue;
    }
    if (/using your subscription/i.test(l)) { modo = "assinatura"; continue; }
    if (/^Approximate/i.test(l)) { nota = "Aproximado: conta só as sessões deste Mac, sem outros aparelhos nem o claude.ai."; continue; }
    if (/^What's contributing/i.test(l)) continue;
    if (atual) atual.itens.push(traduzUso(l)); else extras.push(l);
  }
  return { ok: limites.length > 0, modo, limites, contrib, nota, extras, bruto: limites.length ? undefined : String(texto || "").slice(0, 2000) };
}

// O /usage leva ~20 s (sobe o CLI e analisa as sessões locais). Por isso: devolve a última
// leitura NA HORA e, se ela tiver mais de 5 min, atualiza em segundo plano. Só espera quem não
// tem leitura nenhuma ainda, ou quem pediu "fresco".
const USO_TTL = 5 * 60000;
/**
 * O uso do plano do GEMINI, pelo `agy -p "/usage"` (roda sem gastar: 0 turnos). Ele devolve o que
 * RESTA; aqui vira "usado" para a tela falar a mesma língua do Claude.
 * Linhas: "Grupo\tWeekly Limit Remaining\t91%\t2026-09-29T12:04:59Z".
 */
function usoDoGemini() {
  return new Promise((ok) => {
    if (!temBin("agy")) return ok({ ok: false, erro: "agy não instalado" });
    const env = { ...process.env, PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:${process.env.PATH || ""}` };
    let out = "";
    let cp;
    try { cp = spawn("agy", ["-p", "/usage", "--output-format", "json"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { return ok({ ok: false, erro: e.message }); }
    const timer = setTimeout(() => { try { cp.kill("SIGKILL"); } catch { /* já saiu */ } }, 60000);
    cp.stdout.on("data", (d) => { out += d; });
    cp.on("error", (e) => { clearTimeout(timer); ok({ ok: false, erro: e.message }); });
    cp.on("close", () => {
      clearTimeout(timer);
      try {
        const linha = out.trim().split(/\r?\n/).filter((l) => l.startsWith("{")).pop();
        const resposta = JSON.parse(linha).response || "";
        const limites = [];
        for (const l of resposta.split(/\r?\n/)) {
          const p = l.split("\t").map((x) => x.trim());
          if (p.length < 4) continue;
          const resta = parseFloat(p[2]);
          if (!(resta >= 0)) continue;
          const janela = /five hour/i.test(p[1]) ? "5 horas" : /week/i.test(p[1]) ? "semana" : p[1];
          limites.push({ nome: `${p[0]} · ${janela}`, pct: Math.round((100 - resta) * 10) / 10, renovaEm: new Date(p[3]).toISOString(), renovaTexto: p[3] });
        }
        ok(limites.length ? { ok: true, modo: "assinatura", limites, contrib: [], nota: "" } : { ok: false, erro: "o agy não devolveu limites", bruto: resposta.slice(0, 500) });
      } catch (e) { ok({ ok: false, erro: "não entendi a resposta do agy: " + e.message }); }
    });
  });
}

/**
 * O uso do plano do CODEX. Ele não tem comando de uso, mas GRAVA o limite em cada sessão
 * (`rate_limits` no rollout de ~/.codex/sessions). Lemos o arquivo mais novo — ou seja, o número
 * é do último uso do Codex, e a tela diz de quando é.
 */
function usoDoCodex() {
  try {
    const raiz = join(process.env.HOME, ".codex", "sessions");
    if (!existsSync(raiz)) return { ok: false, erro: "sem sessões do codex nesta máquina" };
    const maisNovos = (dir, quantos, prof = 0, saco = []) => {
      const itens = readdirSync(dir, { withFileTypes: true }).sort((a, b) => b.name.localeCompare(a.name));
      for (const it of itens) {
        if (saco.length >= quantos) break;
        const caminho = join(dir, it.name);
        if (it.isDirectory() && prof < 3) maisNovos(caminho, quantos, prof + 1, saco);
        else if (it.isFile() && it.name.endsWith(".jsonl")) saco.push(caminho);
      }
      return saco;
    };
    const arqs = maisNovos(raiz, 12);
    if (!arqs.length) return { ok: false, erro: "sem sessões do codex" };
    // A sessão mais nova pode ter falhado antes de receber limite: procura nas últimas.
    let arq = null, linhas = [];
    for (const a of arqs) {
      const l = readFileSync(a, "utf8").split(/\r?\n/).filter((x) => x.includes('"rate_limits"'));
      if (l.length) { arq = a; linhas = l; break; }
    }
    if (!arq) return { ok: false, erro: "as últimas sessões do codex não trouxeram limite" };
    const achar = (o) => { if (o && typeof o === "object") { if (o.rate_limits) return o.rate_limits; for (const v of Object.values(o)) { const r = achar(v); if (r) return r; } } return null; };
    const rl = achar(JSON.parse(linhas[linhas.length - 1]));
    if (!rl) return { ok: false, erro: "não achei o limite na sessão do codex" };
    const janela = (min) => (min >= 10080 ? "semana" : min >= 1440 ? `${Math.round(min / 1440)} dias` : `${Math.round(min / 60)} horas`);
    const limites = [];
    for (const [k, rotulo] of [["primary", ""], ["secondary", " (segundo limite)"]]) {
      const w = rl[k];
      if (!w || !(w.used_percent >= 0)) continue;
      limites.push({ nome: `Codex · ${janela(w.window_minutes || 10080)}${rotulo}`, pct: Math.round(w.used_percent * 10) / 10,
        renovaEm: w.resets_at ? new Date(w.resets_at * 1000).toISOString() : null, renovaTexto: "" });
    }
    return limites.length
      ? { ok: true, modo: rl.plan_type ? "plano " + rl.plan_type : "", limites, contrib: [], nota: "",
          medidoEm: statSync(arq).mtime.toISOString() }
      : { ok: false, erro: "o codex não trouxe percentual de uso" };
  } catch (e) { return { ok: false, erro: "não consegui ler o uso do codex: " + e.message }; }
}

function lerUsoClaude({ fresco = false } = {}) {
  if (!fresco && usoCache) {
    if (Date.now() - usoCache.t >= USO_TTL) buscarUsoClaude();
    return Promise.resolve(usoCache.v);
  }
  return buscarUsoClaude();
}

function buscarUsoClaude() {
  if (usoEmVoo) return usoEmVoo;
  usoEmVoo = new Promise((ok) => {
    const env = { ...process.env, PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:${process.env.PATH || ""}` };
    let out = "", cp;
    const fim = (v) => {
      v.atualizadoEm = now();
      if (v.ok) { usoCache = { t: Date.now(), v }; broadcast("uso"); } // a tela recarrega o painel sozinha
      usoEmVoo = null; ok(v);
    };
    // stdin fechado: com pipe aberto o CLI espera 3 s por entrada antes de responder.
    try { cp = spawn("claude", ["-p", "/usage", "--output-format", "json"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { return fim({ ok: false, erro: "não consegui rodar o claude: " + e.message }); }
    const timer = setTimeout(() => { try { cp.kill("SIGKILL"); } catch { /* já saiu */ } }, 45000);
    cp.stdout.on("data", (d) => { out += d; });
    cp.on("error", (e) => { clearTimeout(timer); fim({ ok: false, erro: "não consegui rodar o claude: " + e.message }); });
    cp.on("close", () => {
      clearTimeout(timer);
      try { const d = JSON.parse(out.trim().split(/\r?\n/).filter((x) => x.startsWith("{")).pop()); fim(parseUso(d.result)); }
      catch { fim({ ok: false, erro: "o CLI não devolveu o painel de uso", bruto: stripAnsi(out).slice(0, 2000) }); }
    });
  });
  return usoEmVoo;
}

/**
 * O uso do plano de CADA motor instalado, lado a lado. Cada CLI conta do seu jeito e a tela mostra
 * como veio: o Claude e o Codex dizem quanto foi USADO, o agy diz quanto RESTA (convertido aqui).
 */
let usosCache = null, usosEmVoo = null;
function lerUsos({ fresco = false } = {}) {
  if (!fresco && usosCache) {
    if (Date.now() - usosCache.t >= USO_TTL) buscarUsos();
    return Promise.resolve(usosCache.v);
  }
  return buscarUsos();
}
function buscarUsos() {
  if (usosEmVoo) return usosEmVoo;
  usosEmVoo = (async () => {
    const v = { motores: {}, teto: TETO_COTA, atualizadoEm: now() };
    const claude = temBin("claude") ? await lerUsoClaude({ fresco: true }) : null;
    if (claude) v.motores.claude = { rotulo: "Claude", ...claude };
    if (temBin("agy")) v.motores.gemini = { rotulo: "Gemini", ...(await usoDoGemini()) };
    if (temBin("codex")) v.motores.codex = { rotulo: "Codex", ...usoDoCodex() };
    // Todo motor instalado ganha um cartão no painel — inclusive o que NÃO informa plano (o
    // opencode é ponte para provedores). Melhor ele aparecer dizendo o motivo do que sumir da tela.
    for (const m of motoresDisponiveis())
      if (!v.motores[m.id]) v.motores[m.id] = { rotulo: m.rotulo, ok: false, semPlano: true,
        erro: "este CLI não informa limite de plano — o que ele gastou aparece em “Por motor”" };
    // O mesmo número que o board usa para decidir a passagem de bastão, para a tela não contar
    // outra história: a janela mais apertada e se o motor está sem cota.
    for (const u of Object.values(v.motores)) { u.pct = pctDeLimites(u); u.semCota = semCotaDoUso(u); }
    // Compatibilidade com a tela antiga (painel só do Claude).
    Object.assign(v, claude || {});
    usosCache = { t: Date.now(), v }; usosEmVoo = null; broadcast("uso");
    return v;
  })();
  return usosEmVoo;
}

/**
 * PASSAGEM DE BASTÃO entre motores. Quando a cota de um acaba, outro termina a tarefa.
 * ⚠️ A sessão NÃO atravessa: cada CLI tem a sua. O que atravessa é o que está escrito — o resumo
 * do que já foi feito, os últimos passos e o estado real da pasta. O novo agente lê os arquivos.
 */
const RESERVA = (process.env.BOARD_MOTORES_RESERVA || "gemini,codex,opencode").split(",").map((x) => x.trim()).filter(Boolean);
const TETO_COTA = Number(process.env.BOARD_COTA_TETO || 98); // % a partir do qual consideramos esgotado

/** A janela mais apertada de um motor (as curtas mandam; sem elas, o que houver). Sem leitura, null. */
function pctDeLimites(u) {
  if (!u || !u.ok || !u.limites?.length) return null;
  const curtos = u.limites.filter((l) => !/semana|week/i.test(l.nome));
  return Math.max(...(curtos.length ? curtos : u.limites).map((l) => l.pct));
}

/** Este motor está sem cota? A regra é uma só — a tela pinta de vermelho pelo mesmo critério. */
function semCotaDoUso(u) {
  const p = pctDeLimites(u);
  if (p == null) return false; // sem informação, não é motivo para descartar o motor
  return p >= TETO_COTA || u.limites.some((l) => l.pct >= 100);
}

/** O motor tem cota? Usa o painel já lido (não chama CLI nenhum aqui). */
function temCota(id) {
  return !semCotaDoUso(usosCache?.v?.motores?.[id]);
}

/** Quanto do plano deste motor já foi usado (a janela mais apertada). Sem dado, neutro. */
function usoDoMotor(id) {
  const p = pctDeLimites(usosCache?.v?.motores?.[id]);
  return p == null ? 50 : p;
}

/** O motor com MAIS folga entre os que têm cota — a ordem da reserva só desempata. */
function proximoMotorComCota(atual) {
  const ordem = [...RESERVA, ...Object.keys(MOTORES)].filter((id, i, a) => a.indexOf(id) === i);
  const aptos = ordem.filter((id) => id !== atual && MOTORES[id] && temBin(MOTORES[id].bin) && temCota(id));
  if (!aptos.length) return null;
  return aptos.sort((a, b) => usoDoMotor(a) - usoDoMotor(b) || ordem.indexOf(a) - ordem.indexOf(b))[0];
}

/**
 * Qual motor roda ESTE papel agora. Sem cota, cai para outro que tenha — senão o revisor e o QA
 * (que rodam no Claude por padrão) reprovariam toda tarefa quando a semana do Claude fecha.
 * No agente só troca se ainda não há sessão; com sessão aberta quem resolve é a passagem de bastão.
 */
function escolherMotor(quem, task) {
  const desejado = quem === "revisor" ? MOTOR_REVISOR : quem === "qa" ? MOTOR_QA : task.motor || MOTOR_PADRAO;
  if (temCota(desejado)) return desejado;
  if (quem === "agente" && task.sessionId) return desejado; // sessão aberta: bastão cuida disso
  const alt = proximoMotorComCota(desejado);
  if (!alt) return desejado;
  const de = MOTORES[desejado]?.rotulo || desejado, para = MOTORES[alt]?.rotulo || alt;
  logEvent(task.id, { t: "solto", texto: `⇄ ${de} sem cota — ${quem === "agente" ? "a tarefa" : "o " + quem} vai de ${para}` });
  if (quem === "agente") { task.motor = alt; save(); }
  return alt;
}

/** Troca o motor da tarefa e a devolve pra fila com o bastão. Usado pela cota e pelo botão. */
function passarBastao(task, novo, motivo = "pedido do dono") {
  const deId = task.motor || MOTOR_PADRAO;
  const de = MOTORES[deId]?.rotulo || deId, para = MOTORES[novo]?.rotulo || novo;
  task.passagem = { de: deId, para, em: now(), motivo };
  task.motor = novo; task.sessionId = null; task.retomar = false; task.erroCota = false;
  if (task.modelo && !modeloServe(novo, task.modelo)) task.modelo = null; // modelo era do motor antigo
  task.status = "fila"; task.retentativa = null; task.tentativas = 0; task.updatedAt = now();
  logEvent(task.id, { t: "retentativa", estado: "passagem",
    texto: `⇄ ${de} → ${para} (${motivo}). A sessão não atravessa: vão o resumo, os últimos passos e o estado da pasta.` });
  console.log(`${C.amber}⇄ #${task.id}: ${de} → ${para} (${motivo})${C.r}`);
  save(); broadcast("state");
}

/** O bastão: o que o próximo agente precisa saber, por escrito. */
function textoDaPassagem(task, de, para, motivo) {
  const evs = readLog(task.id);
  const passos = evs.filter((e) => e.t === "ferramenta" && (e.quem || "agente") === "agente").slice(-12)
    .map((e) => `- ${e.nome}: ${e.alvo}`).join("\n");
  const project = projectOf(task);
  let pasta = "";
  try { pasta = execFileSync("git", ["status", "--porcelain"], { cwd: project.dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/).slice(0, 30).join("\n"); } catch { pasta = "(a pasta não é um repositório git)"; }
  // O que o revisor/QA já apontou vai junto: sem isso o novo agente conserta no escuro.
  const pareceres = evs.filter((e) => (e.t === "revisor" || e.t === "qa") && e.veredito === "REPROVADO").slice(-2)
    .map((e) => `${e.t === "qa" ? "QA" : "Revisor"} REPROVOU:\n${cut(e.texto || "", 1200)}`).join("\n\n");
  return [
    `PASSAGEM DE BASTÃO: esta tarefa foi começada por outro agente (${de}) e ${motivo === "sem cota" ? "ele ficou SEM COTA no meio" : "o dono pediu a troca"}. Você (${para}) continua daqui.`,
    "", "A tarefa original:", task.text, "",
    task.result ? "O que o agente anterior relatou:\n" + cut(task.result, 1500) : "O agente anterior não chegou a relatar nada.",
    "", pareceres ? "⚠️ O QUE A CONFERÊNCIA JÁ APONTOU (conserte isto):\n" + pareceres : "",
    "", passos ? "Os últimos passos dele (ferramenta: alvo):\n" + passos : "",
    "", "Como está a pasta AGORA (git status):", pasta || "(sem mudanças pendentes)",
    "", "⚠️ Você NÃO tem a conversa dele: o que vale é o estado dos arquivos. LEIA os arquivos que ele tocou antes de mexer.",
    "Continue de onde ele parou e termine a tarefa. Não recomece do zero e não refaça o que já está pronto.",
    task.entrega === "pr" ? "A entrega desta tarefa é por PULL REQUEST — as regras de entrega valem para você também."
      : task.entrega === "deploy" ? "Esta tarefa é PR + mesclar + publicar — as regras de entrega valem para você também." : "",
  ].filter(Boolean).join("\n");
}

// ── consumo ───────────────────────────────────────────────────────────────────
/**
 * O CONSUMO DO BOARD — só o que o sistema conta: o `total_cost_usd` que o CLI devolve a cada
 * rodada (evento "resultado" no log de cada tarefa), somado por dia, projeto, papel e tarefa.
 * É o valor de referência em dólar das rodadas do board, não o saldo do plano (esse é o /usage).
 */
function usage() {
  const byDay = {}, byProject = {}, byRole = { agente: 0, revisor: 0, qa: 0 }, byTask = {}, byMotor = {};
  let runs = 0;
  // ⚠️ O dia é o do RELÓGIO DO DONO, não UTC: às 21h em São Paulo já é o dia seguinte em UTC,
  // e "hoje" apareceria zerado enquanto ele ainda trabalha.
  const diaLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  for (const t of state.tasks) {
    for (const ev of readLog(t.id)) {
      if (ev.t !== "resultado") continue;
      const c = Number(ev.custo) || 0;
      if (!c && !(Number(ev.tokens) || 0)) continue;
      runs++;
      const dia = diaLocal(new Date(ev.at));
      byDay[dia] = (byDay[dia] || 0) + c;
      byProject[t.project] = (byProject[t.project] || 0) + c;
      byRole[ev.quem === "revisor" || ev.quem === "qa" ? ev.quem : "agente"] += c;
      const mot = ev.motor || "claude";
      byMotor[mot] = byMotor[mot] || { usd: 0, tokens: 0, rodadas: 0 };
      byMotor[mot].usd += c; byMotor[mot].tokens += ev.tokens || 0; byMotor[mot].rodadas++;
      byTask[t.id] = (byTask[t.id] || 0) + c;
    }
  }
  const hoje = new Date();
  const dias = []; for (let i = 13; i >= 0; i--) { const d = new Date(hoje); d.setDate(hoje.getDate() - i); dias.push(diaLocal(d)); }
  const semana = dias.slice(-7).reduce((s, k) => s + (byDay[k] || 0), 0);
  const total = Object.values(byDay).reduce((s, v) => s + v, 0);
  const r2 = (v) => Number(v.toFixed(2));
  return {
    hoje: r2(byDay[diaLocal(hoje)] || 0), semana: r2(semana), total: r2(total), rodadas: runs,
    porDia: dias.map((k) => ({ dia: k, custo: r2(byDay[k] || 0) })),
    porProjeto: Object.entries(byProject).map(([projeto, custo]) => ({ projeto, custo: r2(custo) })).sort((a, b) => b.custo - a.custo),
    porPapel: { agente: r2(byRole.agente), revisor: r2(byRole.revisor), qa: r2(byRole.qa) },
    porMotor: Object.fromEntries(Object.entries(byMotor).map(([k, v]) => [k, { usd: r2(v.usd), tokens: v.tokens, rodadas: v.rodadas }])),
    tarefas: Object.entries(byTask).map(([id, custo]) => { const t = taskById(id); return { id: Number(id), custo: r2(custo), titulo: t?.title || "", projeto: t?.project || "", turnos: t?.turns || 0 }; })
      .sort((a, b) => b.custo - a.custo).slice(0, 10),
  };
}

// ── anexos (imagens) ──────────────────────────────────────────────────────────
/**
 * O dono explica muita coisa com PRINT (foi assim a sessão inteira). A tarefa merece o mesmo:
 * a imagem é gravada em data/anexos e o CAMINHO vai no prompt — o agente lê com a ferramenta Read,
 * que enxerga imagem. Nada de base64 no prompt (estouraria o comando e o custo).
 * PDF entra pelo mesmo caminho (o Read também lê PDF) — pedido do dono em 24/09, depois que o 📎
 * recusou um PDF em silêncio.
 * ⚠️ Só o que está nesta lista, por assinatura do próprio arquivo (extensão mente), com teto de tamanho.
 */
const TIPOS_ANEXO = [
  { ext: "png", mime: "image/png", casa: (b) => b.length > 8 && b[0] === 0x89 && b.toString("latin1", 1, 4) === "PNG" },
  { ext: "jpg", mime: "image/jpeg", casa: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "gif", mime: "image/gif", casa: (b) => b.toString("latin1", 0, 6).startsWith("GIF8") },
  { ext: "webp", mime: "image/webp", casa: (b) => b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP" },
  { ext: "pdf", mime: "application/pdf", casa: (b) => b.toString("latin1", 0, 5) === "%PDF-" },
];
const EXTS_ANEXO = TIPOS_ANEXO.map((t) => t.ext).join("|");
const ID_ANEXO = new RegExp(`^[0-9a-f]{16}\\.(?:${EXTS_ANEXO})$`);
// O log CRU (stream-json) é só para depurar e cresce rápido: 211 MB em três dias. Desligável.
const RAW_LIGADO = process.env.BOARD_LOG_CRU !== "0";
const ANEXO_MAX = Number(process.env.BOARD_ANEXO_MB || 10) * 1024 * 1024;
const ANEXOS_POR_VEZ = 6;

function lerBinario(req, limite = ANEXO_MAX) {
  return new Promise((ok, bad) => {
    const partes = []; let tam = 0;
    req.on("data", (d) => { tam += d.length; if (tam > limite) { bad(new Error(`arquivo grande demais (máx ${Math.round(limite / 1048576)} MB)`)); req.destroy(); return; } partes.push(d); });
    req.on("end", () => ok(Buffer.concat(partes)));
    req.on("error", bad);
  });
}

function salvarAnexo(buf, nome) {
  const tipo = TIPOS_ANEXO.find((t) => t.casa(buf));
  if (!tipo) throw new Error("só aceito imagem (png, jpg, gif ou webp) ou PDF");
  const id = randomUUID().replace(/-/g, "").slice(0, 16) + "." + tipo.ext;
  writeFileSync(join(ANEXOS, id), buf);
  return { id, nome: cut(String(nome || "imagem"), 80), mime: tipo.mime, bytes: buf.length, caminho: join(ANEXOS, id) };
}

/** Só ids que o board gerou, e só dentro de data/anexos — nada de caminho vindo do cliente. */
function anexosValidos(lista) {
  return (Array.isArray(lista) ? lista : []).slice(0, ANEXOS_POR_VEZ)
    .map((a) => (typeof a === "string" ? { id: a } : a))
    .filter((a) => a && typeof a.id === "string" && ID_ANEXO.test(a.id) && existsSync(join(ANEXOS, a.id)))
    .map((a) => ({ id: a.id, nome: cut(String(a.nome || "imagem"), 80), caminho: join(ANEXOS, a.id) }));
}

/** O texto que o agente recebe, com o caminho das imagens e PDFs (ele abre com Read). */
function comAnexos(texto, anexos) {
  const lista = anexosValidos(anexos);
  if (!lista.length) return texto;
  const titulo = lista.some((a) => a.id.endsWith(".pdf")) ? "Arquivos (imagens/PDF)" : "Imagens";
  return [texto, "", `${titulo} que o dono anexou (ABRA cada um com a ferramenta Read antes de decidir):`,
    ...lista.map((a) => `- ${a.nome}: ${a.caminho}`)].join("\n");
}

// ── busca semântica (a aba 🔎 Buscar) ─────────────────────────────────────────
/**
 * O quadro é de TODOS os projetos e já passou de uma centena de tarefas: achar "aquela do rate
 * limit" pelo título exato não funciona. A busca compara o SENTIDO da pergunta com o de cada
 * tarefa (título + descrição) — ver `busca.mjs`, que também escolhe o provedor e, quando ele
 * não responde, cai sozinho na procura por palavra.
 *
 * O histórico mora onde mora tudo aqui: `data/logs/busca.jsonl`, escrito por `logEvent` — assim
 * a tela lê com o mesmo `/api/busca/historico` e o terminal imprime a consulta junto do resto.
 */
const BUSCA_LOG = "busca";
const BUSCA_ESTADO_TTL = 60000;
let buscaEstadoCache = null;

async function estadoDaBusca({ fresco = false } = {}) {
  if (!fresco && buscaEstadoCache && Date.now() - buscaEstadoCache.t < BUSCA_ESTADO_TTL) return buscaEstadoCache.v;
  const v = await estadoBusca(state.tasks);
  buscaEstadoCache = { t: Date.now(), v };
  return v;
}

async function buscarTarefas(consulta, { projeto = null, limite = 20 } = {}) {
  const r = await buscar(consulta, state.tasks, { projeto, limite });
  if (r.modo !== "vazio") {
    logEvent(BUSCA_LOG, { t: "busca", consulta: r.consulta, modo: r.modo, provedor: r.provedor, projeto: projeto || "todos",
      ms: r.ms, aviso: r.aviso, achados: r.resultados.slice(0, 5).map((x) => ({ id: x.id, title: x.title, score: x.score })) });
    buscaEstadoCache = null; // a busca acabou de pôr o índice em dia: a próxima leitura conta certo
  }
  return r;
}

// ── HTTP + SSE ────────────────────────────────────────────────────────────────
const clients = new Set();
function broadcast(event, data = {}) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) { try { res.write(msg); } catch { clients.delete(res); } }
}

const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((ok, bad) => {
  let b = ""; req.on("data", (d) => { b += d; if (b.length > 1e6) bad(new Error("corpo grande demais")); });
  req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch { bad(new Error("JSON inválido")); } });
});

/**
 * O estado que a TELA precisa — sem o texto e o resumo inteiros de cada tarefa. A lista mostra
 * título, status e selos; quem quer o texto todo é a tela da tarefa, que já busca `/tasks/:id/log`.
 * Medido em 18/09: 289 KB por atualização com 84 tarefas, 214 KB só de texto+resumo, e a tela
 * redesenhava tudo a cada evento. (`?tudo=1` devolve o completo, para quem precisar.)
 */
const magro = (t) => {
  const { text, result, ...resto } = t;
  return { ...resto, anexos: (t.anexos || []).map((a) => ({ id: a.id, nome: a.nome })) };
};
const publicState = (completo = false) => ({
  tasks: state.tasks.map((t) => (completo ? { ...t } : magro(t))),
  projects: listProjects().map(({ slug, label }) => ({ slug, label })),
  config: { parallel: PARALLEL, perProject: PER_PROJECT, model: MODEL || "(padrão do CLI)", permission: PERMISSION,
    motor: MOTOR_PADRAO, motorRevisor: MOTOR_REVISOR, motorQa: MOTOR_QA,
    revisor: REVIEW_MODEL, revisorLigado: REVISOR_LIGADO, qa: QA_MODEL, qaLigado: QA_LIGADO, rodadas: REVIEW_ROUNDS, reinicioPendente: restartPending, iniciadoEm: STARTED_AT, filaPausada: filaPausada(),
    retentativas: RETRY_MAX, pausaAte: state.pausaAte && state.pausaAte > Date.now() ? new Date(state.pausaAte).toISOString() : null },
  motores: motoresDisponiveis(),
  // Só o cabeçalho de cada fio (o histórico vem por /api/conversa/<slug>), pra não engordar o SSE.
  conversas: Object.fromEntries(Object.entries(state.conversas || {}).map(([slug, c]) => [slug,
    { busy: !!c.busy, motor: c.motor || null, modelo: c.modelo || null, temSessao: !!c.sessionId, custo: c.custo || 0, updatedAt: c.updatedAt }])),
  portoes: Object.fromEntries(listProjects().map((p) => [p.slug, gateCommand(p)])),
  deploys: Object.fromEntries(listProjects().map((p) => [p.slug, deployCommand(p)])),
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const path = url.pathname;
  try {
    if (req.method === "GET" && (path === "/" || path.startsWith("/#"))) {
      // no-cache + ETag: the browser always revalidates, so an edit to index.html shows up on a
      // plain F5 (without it, an open tab kept the old renderer — 24/09); unchanged → 304, no body.
      const html = readFileSync(WEB);
      const etag = `"${createHash("sha1").update(html).digest("hex")}"`;
      const headers = { "cache-control": "no-cache", etag };
      const inm = req.headers["if-none-match"];
      if (inm && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag || t.trim() === "*")) {
        res.writeHead(304, headers);
        return res.end();
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...headers });
      return res.end(html);
    }
    if (req.method === "GET" && path === "/api/state") return json(res, 200, publicState(url.searchParams.has("tudo")));
    if (req.method === "GET" && path === "/api/usage") return json(res, 200, usage());
    if (req.method === "POST" && path === "/api/agentes/tmux") {
      // O botão "🖥 tmux": monta a sessão com uma aba por agente e abre o Terminal nela.
      const env = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}` };
      execFile(process.execPath, [join(ROOT, "board-cli.mjs"), "agentes", "--abrir"], { env, timeout: 30000 }, () => {});
      return json(res, 202, { ok: true });
    }
    if (req.method === "GET" && path === "/api/modelos") return json(res, 200, catalogoModelos());
    if (req.method === "GET" && path === "/api/claude-uso") return json(res, 200, await lerUsos({ fresco: url.searchParams.has("fresco") }));
    /**
     * TROCAR DE MOTOR de uma vez (o botão "Trocar" do painel de Consumo): quando a cota de um
     * acaba, o dono move o que está esperando nele para outro, com o bastão de sempre.
     * ⚠️ Só o que ESPERA: tarefa rodando não se interrompe no meio, e tarefa `pendente` não entra
     * na fila por causa de uma troca de motor (quem decide enfileirar é o dono).
     */
    if (req.method === "POST" && path === "/api/motores/passar") {
      const b = await readBody(req);
      const de = String(b.de || ""), para = String(b.para || "");
      if (!MOTORES[para] || !temBin(MOTORES[para].bin)) return json(res, 400, { error: "motor de destino inválido ou não instalado" });
      if (!MOTORES[de]) return json(res, 400, { error: "motor de origem inválido" });
      if (de === para) return json(res, 400, { error: "o destino é o mesmo motor" });
      const alvos = state.tasks.filter((t) => (t.motor || MOTOR_PADRAO) === de && !t.busy && ["fila", "erro"].includes(t.status));
      for (const t of alvos) passarBastao(t, para, "troca de motor no painel de Consumo");
      return json(res, 200, { ok: true, trocadas: alvos.map((t) => t.id) });
    }
    // ── grafo da memória (menu "Memória") ──
    if (req.method === "GET" && path === "/api/memoria/grafo") {
      const g = montarGrafo(); const mapa = (lerMentes() || {}).mapa || {};
      const nos = g.nos.map((n) => mapa[n.chave] ? { ...n, mente: mapa[n.chave].mente, mentesTambem: mapa[n.chave].tambem || [], menteConfianca: mapa[n.chave].confianca, menteMotivo: mapa[n.chave].motivo } : n);
      return json(res, 200, { geradoEm: g.geradoEm, erro: g.erro || null, nos, ligacoes: g.ligacoes, mentes: resumoMentes(lerMentes()) });
    }
    if (req.method === "GET" && path === "/api/memoria/pagina") {
      // Só por chave que o próprio grafo conhece: nada de caminho vindo da tela.
      const g = montarGrafo(); const p = g._porChave && g._porChave.get(String(url.searchParams.get("chave") || ""));
      if (!p) return json(res, 404, { error: "página não encontrada" });
      const titulo = (k) => (g._porChave.get(k) || {}).titulo || k;
      return json(res, 200, { chave: p.chave, id: p.id, projeto: p.projeto, titulo: p.titulo, descricao: p.descricao,
        texto: tiraCabecalhos(p.bruto).slice(0, 60000),
        liga: g.ligacoes.filter((l) => l.a === p.chave).map((l) => ({ chave: l.b, titulo: titulo(l.b) })),
        citadaPor: g.ligacoes.filter((l) => l.b === p.chave).map((l) => ({ chave: l.a, titulo: titulo(l.a) })) });
    }
    // ── Prévia do romaneio: o que o board separaria para um pedido (não cria tarefa, não roda nada) ──
    if (req.method === "GET" && path === "/api/romaneio/previa") {
      const texto = String(url.searchParams.get("texto") || "").slice(0, 4000);
      if (!texto.trim()) return json(res, 400, { error: "escreva o pedido" });
      const rom = montarRomaneio({ title: titleOf(texto), text: texto, project: String(url.searchParams.get("projeto") || "DEV") }, { todasMentes: url.searchParams.has("todas"), ate: url.searchParams.get("ate") || null });
      return json(res, 200, rom || { vazio: true, motivo: (lerMentes() || {}).status !== "aprovada" ? "endereçamento não aprovado" : "nada relacionado" });
    }
    // ── Inventário da memória: ver, rodar, endereçar novas, descartar, juntar (só com clique do dono) ──
    if (req.method === "GET" && path === "/api/memoria/inventario") return json(res, 200, lerInventario() || { em: null });
    if (req.method === "POST" && path.startsWith("/api/memoria/inventario/")) {
      const acao = path.split("/").pop(); const b = await readBody(req);
      const refresca = () => { atualizarCofreObsidian(); };
      try {
        if (acao === "rodar") return json(res, 200, inventariar());
        const inv = lerInventario() || inventariar();
        if (acao === "enderecar-novas") {
          // proposta pelas pistas (sem IA); confiança média → aparece na lista de conferência e NÃO vai ao romaneio até o dono conferir
          const m = lerMentes(); if (!m) return json(res, 400, { error: "sem endereçamento" });
          const g = montarGrafo(); let n = 0;
          for (const x of inv.novas) {
            const p = g._porChave.get(x.chave); if (!p || m.mapa[x.chave]) continue;
            const texto = semAcentoServidor(p.titulo + " " + p.descricao + " " + tiraCabecalhos(p.bruto).slice(0, 2000));
            const pista = Object.entries(pistasDaMente()).find(([, rx]) => rx.test(texto));
            const mente = p.sessao ? "triagem" : pista ? pista[0] : (mentePorProjeto()[p.projeto] || "triagem");
            m.mapa[x.chave] = { mente, tambem: [], confianca: p.sessao ? "alta" : "media", motivo: p.sessao ? "resumo de sessão" : pista ? "pista do assunto (inventário)" : "mente do projeto (inventário)" };
            n++;
          }
          gravarMentes(m); inventariar(); return json(res, 200, { ok: true, enderecadas: n });
        }
        if (acao === "descartar") {
          const k = String(b.chave || ""); if (!inv.vencidas.some((x) => x.chave === k)) return json(res, 400, { error: "só descarta o que o inventário apontou" });
          apagarDaMemoria(k); inv.feitos.push({ em: now(), acao: "descartada", chaves: [k] }); inv.vencidas = inv.vencidas.filter((x) => x.chave !== k);
          gravarInventario(inv); refresca(); return json(res, 200, { ok: true });
        }
        if (acao === "ignorar") {
          const k = String(b.chave || (Array.isArray(b.chaves) ? [...b.chaves].sort().join("|") : ""));
          if (!k) return json(res, 400, { error: "o que ignorar?" });
          inv.ignoradas = [...new Set([...(inv.ignoradas || []), k])];
          inv.vencidas = inv.vencidas.filter((x) => x.chave !== k); inv.repetidas = inv.repetidas.filter((r) => [...r.chaves].sort().join("|") !== k);
          gravarInventario(inv); return json(res, 200, { ok: true });
        }
        if (acao === "juntar") {
          const chaves = (Array.isArray(b.chaves) ? b.chaves : []).map(String);
          const grupo = inv.repetidas.find((r) => [...r.chaves].sort().join("|") === [...chaves].sort().join("|"));
          if (!grupo) return json(res, 400, { error: "grupo fora do inventário" });
          const g = montarGrafo(); const ps = chaves.map((k) => g._porChave.get(k)).filter(Boolean);
          const prompt = ["Estas páginas da memória compartilhada dos agentes parecem REPETIDAS.",
            "Se tratam do MESMO assunto, escreva UMA página que junte tudo sem perder nenhum fato, regra, data ou motivo, sem inventar nada e sem repetir.",
            "Formato: a 1ª linha é `# Título`; depois o texto em markdown, curto e direto, em português do Brasil.",
            "Se NÃO forem o mesmo assunto (só parecidos), responda apenas `NAO_JUNTAR:` e o motivo em uma frase.",
            ...ps.map((p, i) => `\n===== PÁGINA ${i + 1}: ${p.chave} =====\n${tiraCabecalhos(p.bruto).slice(0, 12000)}`)].join("\n");
          const r = await execP("claude", ["-p", prompt, "--model", "sonnet", "--output-format", "json", "--no-session-persistence",
            "--strict-mcp-config", "--setting-sources", "", "--tools", ""], 180000);
          let d = null; try { d = JSON.parse(r.out); } catch { return json(res, 502, { error: "a IA não respondeu" }); }
          const texto = String(d.result || "").trim(); const custo = d.total_cost_usd || 0;
          const id = createHash("sha1").update([...chaves].sort().join("|")).digest("hex").slice(0, 10);
          const prop = /^NAO_JUNTAR/i.test(texto) ? { chaves, naoJuntar: texto.replace(/^NAO_JUNTAR:?\s*/i, ""), custo, em: now() }
            : { chaves, titulo: (texto.match(/^#\s+(.+)$/m) || [])[1] || "(sem título)", texto, custo, em: now() };
          inv.juntar[id] = prop; gravarInventario(inv); return json(res, 200, { id, ...prop });
        }
        if (acao === "aplicar") {
          const prop = inv.juntar[String(b.id || "")]; if (!prop || !prop.texto) return json(res, 400, { error: "não há versão única para aplicar" });
          const g = montarGrafo(); const alvo = g._porChave.get(prop.chaves[0]); if (!alvo) return json(res, 404, { error: "a 1ª página sumiu" });
          execFileSync("ai-memory", ["write-page", "--workspace", "default", "--project", alvo.projeto, "--path", caminhoNoProjeto(alvo),
            "--tier", "semantic", "--kind", "Note", "--body", prop.texto],
            { env: { ...process.env, ...envMemoria(), PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:${process.env.PATH || ""}` }, timeout: 30000, stdio: "pipe" });
          for (const k of prop.chaves.slice(1)) apagarDaMemoria(k);
          delete inv.juntar[String(b.id)]; inv.feitos.push({ em: now(), acao: "juntadas", chaves: prop.chaves, em1: prop.chaves[0] });
          inv.repetidas = inv.repetidas.filter((r) => !r.chaves.includes(prop.chaves[0]));
          gravarInventario(inv); refresca(); return json(res, 200, { ok: true, ficou: prop.chaves[0] });
        }
        return json(res, 404, { error: "ação desconhecida" });
      } catch (e) { return json(res, 500, { error: cut(String(e.stderr || e.message), 300) }); }
    }
    // ── Mentes: conferir e aprovar o endereçamento (só mexe em data/mentes.json) ──
    if (req.method === "GET" && path === "/api/memoria/mentes") return json(res, 200, resumoMentes(lerMentes()));
    if (req.method === "POST" && (path === "/api/memoria/mentes/mover" || path === "/api/memoria/mentes/conferir" || path === "/api/memoria/mentes/aprovar")) {
      const m = lerMentes(); if (!m) return json(res, 404, { error: "ainda não há endereçamento proposto" });
      const b = await readBody(req);
      if (path.endsWith("/aprovar")) {
        const falta = Object.values(m.mapa).filter((x) => x.confianca === "media" || x.confianca === "baixa").length;
        if (falta) return json(res, 400, { error: `ainda faltam ${falta} memórias para conferir` });
        m.status = "aprovada"; m.aprovadaEm = now(); gravarMentes(m); return json(res, 200, resumoMentes(m));
      }
      const item = m.mapa[String(b.chave || "")]; if (!item) return json(res, 404, { error: "memória fora do endereçamento" });
      if (path.endsWith("/mover")) {
        if (!mentesDef().some((x) => x.id === b.mente)) return json(res, 400, { error: "mente inválida" });
        if (b.mente !== item.mente) { item.antes = item.antes || item.mente; item.mente = b.mente; item.tambem = (item.tambem || []).filter((t) => t !== b.mente); }
      }
      item.confianca = "dono"; item.conferidaEm = now(); if (m.status === "aprovada") m.status = "proposta";
      gravarMentes(m); return json(res, 200, { ok: true, item, resumo: resumoMentes(m) });
    }
    // ── Controle: backups + memória; devolve a última leitura na hora e lê em segundo plano ──
    if (req.method === "GET" && path === "/api/controle") {
      lerControle();
      return json(res, 200, CONTROLE);
    }
    // ── infraestrutura (aba Monitoramento): devolve a última leitura na hora; lê em segundo plano ──
    if (req.method === "GET" && path === "/api/monitoring") {
      lerInfra();
      return json(res, 200, INFRA);
    }
    // ── busca semântica ──
    if (req.method === "GET" && path === "/api/busca") {
      const q = String(url.searchParams.get("q") || "").trim();
      if (!q) return json(res, 400, { error: "escreva o que procurar" });
      if (q.length > 500) return json(res, 400, { error: "consulta grande demais" });
      const limite = Math.min(50, Math.max(1, Number(url.searchParams.get("limite")) || 20));
      return json(res, 200, await buscarTarefas(q, { projeto: url.searchParams.get("projeto"), limite }));
    }
    if (req.method === "GET" && path === "/api/busca/estado")
      return json(res, 200, await estadoDaBusca({ fresco: url.searchParams.has("fresco") }));
    if (req.method === "GET" && path === "/api/busca/historico") {
      const n = Math.min(100, Math.max(1, Number(url.searchParams.get("n")) || 30));
      return json(res, 200, { buscas: readLog(BUSCA_LOG).filter((e) => e.t === "busca").slice(-n).reverse() });
    }
    if (req.method === "POST" && path === "/api/busca/reindexar") {
      const r = await indexar(state.tasks, { forcar: true });
      buscaEstadoCache = null;
      if (r.erro) return json(res, 502, { error: r.erro });
      return json(res, 200, { ok: true, ...r });
    }
    if (req.method === "GET" && path === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write("event: hello\ndata: {}\n\n");
      clients.add(res);
      const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* caiu */ } }, 20000);
      req.on("close", () => { clients.delete(res); clearInterval(ping); });
      return;
    }
    if (req.method === "POST" && path === "/api/anexos") {
      const buf = await lerBinario(req);
      if (!buf.length) return json(res, 400, { error: "arquivo vazio" });
      return json(res, 201, { anexo: (({ id, nome, mime, bytes }) => ({ id, nome, mime, bytes }))(salvarAnexo(buf, url.searchParams.get("nome"))) });
    }
    const img = path.startsWith("/api/anexos/") && path.slice(12).match(ID_ANEXO);
    if (req.method === "GET" && img) {
      const arq = join(ANEXOS, img[0]);
      if (!existsSync(arq)) return json(res, 404, { error: "anexo não existe" });
      const mime = TIPOS_ANEXO.find((t) => img[0].endsWith("." + t.ext))?.mime || "application/octet-stream";
      res.writeHead(200, { "content-type": mime, "x-content-type-options": "nosniff", "cache-control": "public, max-age=31536000, immutable" });
      return res.end(readFileSync(arq));
    }
    // ── conversa por projeto ──
    const mc = path.match(/^\/api\/conversa\/([\w.-]+)(?:\/(limpar|parar))?$/);
    if (mc) {
      const slug = mc[1], acao = mc[2], c = conversaDe(slug), id = conversaId(slug);
      if (req.method === "GET" && !acao) {
        return json(res, 200, { slug, busy: !!c.busy, motor: c.motor, modelo: c.modelo, custo: c.custo || 0, events: readLog(id) });
      }
      if (req.method === "POST" && acao === "parar") {
        const cp = running.get(id);
        if (cp) cp.kill("SIGTERM");
        c.busy = false; save(); broadcast("state");
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && acao === "limpar") {
        // Fio novo: o histórico na tela some junto, senão a tela mostraria o que o agente não lembra.
        if (c.busy) return json(res, 409, { error: "espere a resposta terminar" });
        matarVivo(slug); // o processo vivo lembraria do fio velho
        c.sessionId = null; c.custo = 0; c.updatedAt = now();
        try { unlinkSync(logPath(id)); } catch { /* nunca houve conversa */ }
        save(); broadcast("state"); broadcast("conversa-limpa", { slug });
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST") {
        const b = await readBody(req);
        const texto = String(b.texto || "").trim();
        if (!texto) return json(res, 400, { error: "escreva alguma coisa" });
        falarNaConversa(slug, texto, { anexos: b.anexos, motor: b.motor, modelo: b.modelo })
          .catch((e) => { logEvent(id, { t: "solto", texto: "⚠ " + e.message }); const cc = conversaDe(slug); cc.busy = false; save(); broadcast("state"); });
        return json(res, 202, { ok: true }); // a resposta chega pelo SSE, como na tarefa
      }
    }

    if (req.method === "POST" && path === "/api/tasks") {
      const b = await readBody(req);
      if (!String(b.text || "").trim()) return json(res, 400, { error: "escreva a tarefa" });
      return json(res, 201, { tasks: createTasks(b.text, b.project, { queue: !!b.queue, entrega: b.entrega, anexos: b.anexos, motor: b.motor, modelo: b.modelo, porte: b.porte, paralelo: !!b.paralelo }) });
    }
    if (req.method === "POST" && (path === "/api/fila/pausar" || path === "/api/fila/retomar")) {
      const pausar = path.endsWith("pausar");
      if (pausar) writeFileSync(PAUSE_FLAG, now()); else { try { unlinkSync(PAUSE_FLAG); } catch { /* já estava retomada */ } }
      console.log(pausar ? `${C.amber}⏸ fila pausada pelo dono${C.r}` : `${C.green}▶ fila retomada pelo dono${C.r}`);
      broadcast("state");
      return json(res, 200, { ok: true, pausada: pausar });
    }
    if (req.method === "POST" && path === "/api/reiniciar") {
      restartPending = true; broadcast("state");
      const ocupado = state.tasks.some((t) => t.status === "rodando" || t.busy);
      return json(res, 202, { ok: true, agora: !ocupado, aviso: ocupado ? "vai reiniciar assim que nada estiver rodando" : "reiniciando agora" });
    }
    if (req.method === "POST" && path === "/api/tasks/reorder") {
      const b = await readBody(req);
      if (!Array.isArray(b.ids)) return json(res, 400, { error: "ids" });
      reorder(b.ids); return json(res, 200, { ok: true });
    }
    const m = path.match(/^\/api\/tasks\/(\d+)(?:\/(log|chat|stop|pr|publicar|passar))?$/);
    if (m) {
      const task = taskById(m[1]);
      if (!task) return json(res, 404, { error: "tarefa não existe" });
      const sub = m[2];
      if (req.method === "GET" && sub === "log") return json(res, 200, { task, events: readLog(task.id) });
      if (req.method === "GET" && !sub) return json(res, 200, { task });
      if (req.method === "PATCH" && !sub) { updateTask(task, await readBody(req)); return json(res, 200, { task }); }
      if (req.method === "DELETE" && !sub) { removeTask(task); return json(res, 200, { ok: true }); }
      if (req.method === "POST" && sub === "stop") { stopTask(task); return json(res, 200, { task }); }
      if (req.method === "POST" && sub === "passar") {
        if (task.busy || task.status === "rodando") return json(res, 409, { error: "a tarefa está rodando — pare antes de passar o bastão" });
        const b = await readBody(req);
        const novo = String(b.motor || "");
        if (!MOTORES[novo] || !temBin(MOTORES[novo].bin)) return json(res, 400, { error: "motor inválido ou não instalado" });
        if (novo === (task.motor || MOTOR_PADRAO)) return json(res, 400, { error: "a tarefa já está nesse motor" });
        passarBastao(task, novo);
        return json(res, 202, { ok: true, motor: novo });
      }
      if (req.method === "POST" && (sub === "pr" || sub === "publicar")) {
        if (task.busy || task.status === "rodando") return json(res, 409, { error: "a tarefa está ocupada — espere terminar" });
        if (!task.sessionId) return json(res, 400, { error: "esta tarefa nunca rodou — não há trabalho para entregar" });
        if (sub === "publicar" && !deployCommand(projectOf(task)))
          return json(res, 400, { error: `o projeto "${task.project}" não tem comando de publicação declarado em data/deploy.json` });
        // ⚠️ Pela FILA, nunca direto: chamar prTask aqui pulava o "um agente por projeto", e 20
        // cliques em Virar PR viraram 20 agentes na mesma pasta, a caminho de criar
        // branch e commitar ao mesmo tempo na mesma árvore (16/09, parado a tempo).
        // E um PR por projeto de cada vez: a pasta é uma só, o primeiro PR leva TODAS as mudanças.
        const outro = state.tasks.find((t) => t.id !== task.id && t.project === task.project && (t.acao || (t.etapa === "entrega")));
        if (outro) return json(res, 409, { error: `já tem um PR sendo montado para ${task.project} (#${outro.id}). A pasta é uma só: esse PR leva todas as mudanças que estão nela. Espere ele terminar.` });
        task.acao = sub === "publicar" ? "deploy" : "pr";
        task.status = "fila"; task.retentativa = null; task.updatedAt = now();
        logEvent(task.id, { t: "retentativa", estado: "na-fila", texto: task.acao === "deploy" ? "na fila para entregar, mesclar e publicar" : "na fila para virar PR" });
        save(); broadcast("state");
        return json(res, 202, { ok: true });
      }
      if (req.method === "POST" && sub === "chat") {
        const b = await readBody(req);
        const text = String(b.text || "").trim();
        if (!text && !anexosValidos(b.anexos).length) return json(res, 400, { error: "escreva a mensagem ou anexe uma imagem" });
        if (text.length > 8000) return json(res, 400, { error: "mensagem grande demais" });
        if (task.busy || task.status === "rodando") return json(res, 409, { error: "a tarefa está rodando — espere terminar" });
        chatTask(task, text, b.anexos); // assíncrono: a resposta chega pelo SSE
        return json(res, 202, { ok: true });
      }
    }
    json(res, 404, { error: "rota não existe" });
  } catch (e) {
    json(res, 400, { error: e.message });
  }
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") console.error(`a porta ${PORT} já está em uso — o board já está rodando em outro terminal? (ou mude BOARD_PORT)`);
  else console.error("não consegui subir o servidor:", e.message);
  try { unlinkSync(LOCK); } catch { /* sem lock */ }
  process.exit(1);
});
// Só na máquina, por padrão: quem abre a tela manda agentes rodarem comandos. No Docker é 0.0.0.0, e a porta
// é publicada só no 127.0.0.1 do host (docker run -p 127.0.0.1:4488:4488).
server.listen(PORT, process.env.BOARD_HOST || "127.0.0.1", () => {
  for (const t of interrupted) logEvent(t.id, { t: "fim", status: "pendente", motivo: "o board caiu enquanto rodava — confira o projeto e rode de novo" });
  // Erro de ANTES da retentativa existir (campo `retentativa` nunca gravado) ganha a sua chance
  // uma vez. Erro já tratado pelo código novo tem o campo (objeto ou null) e não é reagendado.
  for (const t of state.tasks) if (t.status === "erro" && t.retentativa === undefined) scheduleRetry(t, t.error);
  if (filaPausada()) console.log(`${C.amber}⏸ a fila está PAUSADA — nada novo começa até retomar (botão na tela ou: node board-cli.mjs retomar)${C.r}`);
  buscarUsos(); // aquece os painéis: a primeira abertura da tela não espera
  setInterval(() => { if (!usosCache || Date.now() - usosCache.t >= USO_TTL) buscarUsos(); }, USO_TTL);
  save();
  startRunner();
  console.log(`${C.green}BOARD${C.r} ${C.txt}http://localhost:${PORT}${C.r}  ${C.dim}paralelo=${PARALLEL} (${PER_PROJECT} por projeto) · modelo=${MODEL || "padrão"} · permissão=${PERMISSION}${C.r}`);
  console.log(`${C.dim}${state.tasks.length} tarefa(s) no quadro · ${state.tasks.filter((t) => t.status === "fila").length} na fila. O que rodar aparece aqui embaixo.${C.r}`);
});
