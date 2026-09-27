// Configuração: pastas, variáveis de ambiente (board.env) e os utilitários pequenos (cores, hora, cortar texto).
import { existsSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
 // procurar tarefa pelo sentido (embeddings)

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), ".."); // a pasta do board (este arquivo mora em servidor/)
export const DEV = process.env.BOARD_PROJETOS || dirname(ROOT); // ~/Documents/DEV — os projetos são as pastas irmãs (no Docker: /projetos)
export const DATA = resolve(ROOT, "data");
export const LOGS = join(DATA, "logs");
export const RAW = join(DATA, "raw");
export const ANEXOS = join(DATA, "anexos"); // imagens que o dono cola/arrasta na tarefa ou no chat
export const STATE_FILE = join(DATA, "board.json");
export const WEB = join(ROOT, "web", "index.html");

export const PORT = Number(process.env.BOARD_PORT || 4488);
// O servidor sempre ligado (Monitoramento, Controle, cópia do board): um apelido do ~/.ssh/config.
export const SERVIDOR = process.env.BOARD_SERVIDOR || "saturno";
// Paralelismo: UM agente por projeto (duas sessões na mesma pasta se atropelam nos arquivos)
// e um teto geral. Tarefas de projetos diferentes rodam ao mesmo tempo.
export const PARALLEL = Math.max(1, Number(process.env.BOARD_PARALELO || 4));       // teto geral
export const PER_PROJECT = Math.max(1, Number(process.env.BOARD_POR_PROJETO || 1)); // por projeto
// ⚡ Agentes em paralelo no MESMO projeto (só quando o dono marca): cada um numa cópia isolada
// (worktree git) em DEV/.board-agentes — a pasta com ponto não vira "projeto". A pasta principal
// continua com um agente só (PER_PROJECT); as cópias têm teto próprio.
export const PARALELO_POR_PROJETO = Math.max(1, Number(process.env.BOARD_PARALELO_POR_PROJETO || 3));
export const AGENTES_DIR = join(DEV, ".board-agentes");
// Produção: o agente ⚡ entrega por PR (regra de ouro do portfólio); nos outros o board junta na pasta.
export const PRODUCAO = (process.env.BOARD_PRODUCAO || "").split(",").map((x) => x.trim()).filter(Boolean); // projetos que SEMPRE trabalham em cópia e entregam por PR
export const DONO = process.env.BOARD_DONO ? ` (${process.env.BOARD_DONO})` : ""; // o nome do dono nas regras dos agentes
export const TIMEOUT_MS = Number(process.env.BOARD_TIMEOUT_MIN || 90) * 60000;
// A conversa é conversa: resposta que demora meia hora não é resposta. Teto próprio, bem menor.
export const CONVERSA_TIMEOUT_MS = Number(process.env.BOARD_CONVERSA_MIN || 15) * 60000; // 45 → 90 em 17/09: tarefa full-stack (migração + motor + tela + portão de 5 min) não cabia em 45
// board.env (opcional, ao lado deste arquivo): BOARD_MODELO=…, BOARD_MODELO_REVISOR=…, BOARD_MODELO_QA=…, BOARD_TIMEOUT_MIN=…
// Lido a cada subida do processo — o "reiniciar" da tela/CLI basta para trocar de modelo, sem mexer no board.sh que está rodando.
try { process.loadEnvFile(new URL("../board.env", import.meta.url).pathname); } catch { /* sem board.env: só o ambiente */ }
export const MODEL = process.env.BOARD_MODELO || "";
export const TOOLS = process.env.BOARD_TOOLS ||
  "Read,Edit,Write,MultiEdit,NotebookEdit,Grep,Glob,Bash,WebFetch,WebSearch,mcp__ai-memory";
export const PERMISSION = process.env.BOARD_PERMISSAO || "acceptEdits";
// Motor = qual CLI roda a tarefa. O do agente é escolhido POR TAREFA na tela; revisor e QA têm o
// seu (padrão claude), de propósito: agente no Codex revisado pelo Claude é conferência cruzada.
export const MOTOR_PADRAO = process.env.BOARD_MOTOR || "claude";
export const MOTOR_REVISOR = process.env.BOARD_MOTOR_REVISOR || "claude";
export const MOTOR_QA = process.env.BOARD_MOTOR_QA || "claude";
// Modelo por PORTE da tarefa (leve/normal/pesado), por motor. O dono ajusta em data/modelos.json;
// escolher o modelo na mão continua valendo e ganha do porte.
export const MODELOS_FILE = join(DATA, "modelos.json");
// Modelo padrão POR MOTOR. ⚠️ BOARD_MODELO é do motor padrão (histórico): aplicá-lo a todos fazia
// o Codex receber "claude-opus-5" e recusar a tarefa (22/09/2026).
export const MODELO_PADRAO = {
  [MOTOR_PADRAO]: process.env.BOARD_MODELO || "",
  claude: process.env.BOARD_MODELO_CLAUDE || (MOTOR_PADRAO === "claude" ? process.env.BOARD_MODELO || "" : ""),
  codex: process.env.BOARD_MODELO_CODEX || "",
  gemini: process.env.BOARD_MODELO_GEMINI || "",
  opencode: process.env.BOARD_MODELO_OPENCODE || "",
};
/** O modelo combina com o motor? Família errada é recusa na hora do CLI, não vale nem tentar. */
export function modeloServe(motorId, m) {
  const nome = String(m || "").trim();
  if (!nome) return false;
  if (motorId === "opencode") return nome.includes("/");
  if (nome.includes("/")) return false;
  const familia = { claude: /^(claude|haiku|sonnet|opus)/i, codex: /^(gpt|o\d|codex)/i, gemini: /^gemini/i }[motorId];
  const deOutro = [/^claude|^haiku$|^sonnet$|^opus$/i, /^gpt|^o\d/i, /^gemini/i]
    .filter((rx) => rx !== familia).some((rx) => rx.test(nome));
  return familia ? familia.test(nome) || !deOutro : !deOutro;
}
export const PORTES = ["leve", "normal", "pesado"];
// No CLAUDE o porte regula o ESFORÇO (--effort), não o modelo: o agente é sempre o modelo padrão.
// normal = padrão do CLI, igual a antes; só o leve pensa menos e o pesado pensa mais (decisão do
// dono em 24/09: "quero coisa boa e rápida" — trocar por modelo mais fraco piorava o trabalho).
export const ESFORCO_CLAUDE = {
  leve: process.env.BOARD_ESFORCO_LEVE ?? "low",
  normal: process.env.BOARD_ESFORCO_NORMAL ?? "",
  pesado: process.env.BOARD_ESFORCO_PESADO ?? "xhigh",
};
// Tarefa nova sem porte nem modelo fixo é classificada por uma chamada curta (haiku, sem ferramenta).
export const CLASSIFICAR = process.env.BOARD_CLASSIFICAR !== "0";
// Portão: a verificação do próprio projeto (tsc/test). Não gasta token — é o comando da casa.
export const GATE_TIMEOUT_MS = Number(process.env.BOARD_PORTAO_TIMEOUT_MIN || 8) * 60000;
export const GATE_FILE = join(DATA, "portao.json"); // { "<slug>": "comando" } — "" desliga o portão
// Revisor: só nas tarefas marcadas como PR. Lê o diff, não escreve código.
export const REVIEW_MODEL = process.env.BOARD_MODELO_REVISOR || "sonnet";
export const REVIEW_ROUNDS = Math.max(0, Number(process.env.BOARD_REVISOES ?? 1)); // rodadas de conserto
// Esteira de conferência em toda tarefa que mexe em arquivo: portão → revisor → QA.
// Desligáveis por env (BOARD_REVISOR=0, BOARD_QA=0) sem mexer em código.
export const REVISOR_LIGADO = process.env.BOARD_REVISOR !== "0";
export const QA_LIGADO = process.env.BOARD_QA !== "0";
export const QA_MODEL = process.env.BOARD_MODELO_QA || "sonnet";
export const QA_TIMEOUT_MS = Number(process.env.BOARD_QA_TIMEOUT_MIN || 20) * 60000;
// Mesclar e publicar: só existe para projeto com comando DECLARADO em data/deploy.json.
// O arquivo nasce vazio de propósito — escrever o comando ali é o ato de autorizar.
export const DEPLOY_FILE = join(DATA, "deploy.json");
// Fila pausada = um ARQUIVO, não memória: a pausa tem que sobreviver ao reinício (pausar e reiniciar
// era justamente o pedido do dono — com a pausa só em memória, o board voltava e pegava a próxima).
export const PAUSE_FLAG = join(DATA, "fila-pausada");
export const filaPausada = () => existsSync(PAUSE_FLAG);
// Retentativa automática de tarefa em erro (fora cota, que pausa a fila e não conta).
export const RETRY_MAX = Math.max(0, Number(process.env.BOARD_RETENTATIVAS ?? 2));
export const RETRY_DELAY_MS = Number(process.env.BOARD_RETENTATIVA_MIN || 2) * 60000;
export const DEPLOY_TIMEOUT_MS = Number(process.env.BOARD_DEPLOY_TIMEOUT_MIN || 20) * 60000;

export const STATUSES = ["pendente", "fila", "rodando", "executada", "concluida", "erro"];
export const STARTED_AT = new Date().toISOString();

// ── cores do terminal ─────────────────────────────────────────────────────────
export const C = {
  amber: "\x1b[1;38;2;232;179;71m", green: "\x1b[1;38;2;55;207;124m", red: "\x1b[1;38;2;235;110;110m",
  cyan: "\x1b[1;38;2;53;193;239m", dim: "\x1b[38;2;109;130;153m", txt: "\x1b[38;2;234;243;248m", r: "\x1b[0m",
};
export const now = () => new Date().toISOString();
export const clock = () => new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
export const cut = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
export const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
export const COM_ROTINAS = process.env.BOARD_SEM_ROTINAS !== "1";

/*
 * O GRAFO DA MEMÓRIA (menu "Memória"): as páginas do ai-memory e as ligações [[…]] entre elas, lidas do
 * espelho que o board já mantém para o Obsidian (~/Documents/Memoria/ai-memory, a cada 10 min) — sem
 * leitura nova no Saturno. Só leitura: mudar a memória continua sendo pedir a um agente.
 */
export const ESPELHO_MEMORIA = process.env.BOARD_ESPELHO_MEMORIA || join(process.env.HOME, "Documents", "Memoria", "ai-memory");
// O log CRU (stream-json) é só para depurar e cresce rápido: 211 MB em três dias. Desligável.
export const RAW_LIGADO = process.env.BOARD_LOG_CRU !== "0";
