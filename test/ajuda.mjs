// Test harness: an ISOLATED board (own folder, own data/, own HOME, own port) with fake CLIs.
// Nothing here touches the real board (port 4488), the real data/ or the real ~ — and no real agent runs.
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync, realpathSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Where the board code under test comes from (default: this repo). The mutation check points it at a sabotaged copy.
const FONTE = process.env.BOARD_TESTE_FONTE || REPO;
export const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// The fake `claude`: reads the script ($HOME/cenario.json), logs every call ($HOME/chamadas.jsonl) and answers in
// stream-json like the real CLI. The role comes from the prompt the board builds (reviewer/QA/usage/size check).
const FALSO_CLAUDE = `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const H = process.env.HOME, a = process.argv.slice(2);
const arg = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : undefined; };
// Conversation mode: ONE live process, one message per stdin line (like the real CLI with --input-format stream-json).
if (a.includes("--input-format")) {
  const cen = JSON.parse(fs.readFileSync(path.join(H, "cenario.json"), "utf8"));
  const cp = path.join(H, "processos-conversa"); fs.writeFileSync(cp, String((fs.existsSync(cp) ? Number(fs.readFileSync(cp, "utf8")) : 0) + 1));
  const sid = arg("--resume") || "sessao-conversa-" + process.pid; let total = 0, buf = "";
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue;
    const msg = JSON.parse(l).message.content[0].text; const conta = path.join(H, "conta-conversa");
    const n = fs.existsSync(conta) ? Number(fs.readFileSync(conta, "utf8")) : 0; fs.writeFileSync(conta, String(n + 1));
    fs.appendFileSync(path.join(H, "chamadas.jsonl"), JSON.stringify({ papel: "conversa", n, args: a, cwd: process.cwd(), msg, t: Date.now() }) + "\\n");
    const lista = cen.conversa || ["ok"]; const txt = lista[Math.min(n, lista.length - 1)];
    total += 0.02; out({ type: "system", subtype: "init", session_id: sid });
    out({ type: "assistant", session_id: sid, message: { content: [{ type: "text", text: txt }] } });
    out({ type: "result", session_id: sid, result: txt, total_cost_usd: total, num_turns: 1, duration_ms: 3 }); } });
  process.stdin.on("end", () => process.exit(0));
  return;
}
const prompt = arg("-p") || "";
const papel = prompt === "/usage" ? "uso" : /^Revise a tarefa/.test(prompt) ? "revisor" : /^Teste a entrega/.test(prompt) ? "qa"
  : /Classifique o PORTE/.test(prompt) ? "porte" : "agente";
const cen = JSON.parse(fs.readFileSync(path.join(H, "cenario.json"), "utf8"));
const conta = path.join(H, "conta-" + papel);
const n = fs.existsSync(conta) ? Number(fs.readFileSync(conta, "utf8")) : 0;
fs.writeFileSync(conta, String(n + 1));
fs.appendFileSync(path.join(H, "chamadas.jsonl"), JSON.stringify({ papel, n, args: a, cwd: process.cwd(), t: Date.now() }) + "\\n");
if (papel === "uso") { console.log(JSON.stringify({ type: "result", result: "", total_cost_usd: 0 })); process.exit(0); }
if (papel === "porte") { console.log(JSON.stringify({ result: "leve", total_cost_usd: 0.001 })); process.exit(0); }
const lista = (cen[papel] || [{ texto: papel === "agente" ? "feito" : "APROVADO" }]).map((x) => typeof x === "string" ? { texto: x } : x);
// An item with "quando" answers the prompt it matches; the others answer in call order.
const porPedido = lista.find((x) => x.quando && new RegExp(x.quando).test(prompt));
const seq = lista.filter((x) => !x.quando);
const passo = porPedido || seq[Math.min(n, seq.length - 1)] || { texto: "feito" };
const sid = arg("--resume") || "sessao-" + papel + "-" + n + "-" + process.pid;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "system", subtype: "init", session_id: sid });
const fim = () => {
  if (passo.escreve) { fs.writeFileSync(path.join(process.cwd(), passo.escreve.arquivo), passo.escreve.conteudo ?? "x\\n");
    out({ type: "assistant", session_id: sid, message: { content: [{ type: "tool_use", name: "Write", input: { file_path: passo.escreve.arquivo } }] } }); }
  if (passo.apaga) fs.rmSync(path.join(process.cwd(), passo.apaga), { force: true });
  out({ type: "assistant", session_id: sid, message: { content: [{ type: "text", text: passo.texto || "" }] } });
  out({ type: "result", session_id: sid, is_error: !!passo.erro, result: passo.texto || "", total_cost_usd: passo.custo ?? 0.01, num_turns: 1, duration_ms: 5 });
  process.exit(passo.codigo || 0);
};
passo.dorme ? setTimeout(fim, passo.dorme) : fim();
`;

// Everything else that could reach the outside world answers "not here".
const MUDOS = ["codex", "agy", "opencode", "ssh", "rclone", "docker", "ai-memory", "tmux", "osascript", "open", "ollama"];
const FALSO_GH = `#!/bin/sh
echo "gh $*" >> "$HOME/gh.log"
case "$1 $2" in
  "pr view") echo "board/1-teste" ;;
  "pr merge") [ -f "$HOME/gh-merge-falha" ] && { echo "merge recusado" >&2; exit 1; } ;;
esac
exit 0
`;

export function portaLivre() {
  return new Promise((ok) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
}

const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A git project inside the sandbox's DEV folder. `check` = what `npm run check` does (the board's gate). */
export function criarProjeto(caixa, nome, { check = "node -e \"process.exit(require('fs').existsSync('quebrado.txt')?1:0)\"", origem = false } = {}) {
  const dir = join(caixa.dev, nome);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: nome, private: true, scripts: { check } }, null, 1));
  writeFileSync(join(dir, "CLAUDE.md"), `# ${nome}\n`);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "inicio");
  if (origem) {
    const nu = join(caixa.raiz, nome + ".git");
    execFileSync("git", ["clone", "-q", "--bare", dir, nu]);
    git(dir, "remote", "add", "origin", nu);
    git(dir, "fetch", "-q", "origin");
    git(dir, "remote", "set-head", "origin", "main");
  }
  return dir;
}

/** Builds the sandbox: a copy of the board's code, empty data/, fake HOME with the fake CLIs first in PATH. */
export function criarCaixa() {
  const raiz = realpathSync(mkdtempSync(join(tmpdir(), "board-teste-"))); // /var → /private/var no macOS
  const board = join(raiz, "board"), home = join(raiz, "home"), dev = join(raiz, "dev"), bin = join(home, ".local", "bin");
  for (const d of [board, home, dev, bin, join(board, "data")]) mkdirSync(d, { recursive: true });
  for (const f of ["board.mjs", "busca.mjs", "board-cli.mjs"]) cpSync(join(FONTE, f), join(board, f));
  cpSync(join(FONTE, "web"), join(board, "web"), { recursive: true });
  if (existsSync(join(FONTE, "servidor"))) cpSync(join(FONTE, "servidor"), join(board, "servidor"), { recursive: true });
  const escreve = (nome, txt) => { writeFileSync(join(bin, nome), txt); chmodSync(join(bin, nome), 0o755); };
  escreve("claude", FALSO_CLAUDE);
  escreve("gh", FALSO_GH);
  for (const m of MUDOS) escreve(m, "#!/bin/sh\nexit 1\n");
  const caixa = { raiz, board, home, dev, bin, cenario: (c) => writeFileSync(join(home, "cenario.json"), JSON.stringify(c)) };
  caixa.cenario({});
  return caixa;
}

export function envDaCaixa(caixa, extra = {}) {
  return {
    PATH: `${caixa.bin}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: caixa.home, TMPDIR: tmpdir(), LANG: "en_US.UTF-8",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
    BOARD_PROJETOS: caixa.dev, BOARD_SEM_ROTINAS: "1", BOARD_CLASSIFICAR: "0", BOARD_ROMANEIO: "0",
    BOARD_BUSCA_PROVEDOR: "lexico", BOARD_LOG_CRU: "0", BOARD_RETENTATIVAS: "0", BOARD_PRODUCAO: "",
    BOARD_ESPELHO_MEMORIA: join(caixa.raiz, "memoria"),
    // Some readings call the REAL binaries (/opt/homebrew/bin comes first in their PATH): point them at nothing,
    // so the sandbox never reads the owner's containers, Drive or memory server.
    DOCKER_HOST: "unix:///nao-existe/docker.sock", RCLONE_CONFIG: join(caixa.raiz, "sem-rclone.conf"),
    AI_MEMORY_SERVER_URL: "http://127.0.0.1:9", AI_MEMORY_AUTH_TOKEN: "",
    ...extra,
  };
}

/** Starts the isolated board and waits until it answers. Returns { url, api, fim, ... }. */
export async function subirBoard(caixa, extra = {}, { nodeArgs = [] } = {}) {
  const porta = await portaLivre();
  const cp = spawn(process.execPath, [...nodeArgs, "board.mjs"], { cwd: caixa.board, env: envDaCaixa(caixa, { BOARD_PORT: String(porta), ...extra }), stdio: ["ignore", "pipe", "pipe"] });
  let saida = ""; cp.stdout.on("data", (d) => (saida += d)); cp.stderr.on("data", (d) => (saida += d));
  const url = `http://127.0.0.1:${porta}`;
  for (let i = 0; i < 100; i++) {
    try { await fetch(url + "/api/state"); break; } catch { await esperar(100); }
    if (cp.exitCode !== null) throw new Error("o board não subiu:\n" + saida);
  }
  const api = async (metodo, rota, corpo) => {
    const r = await fetch(url + rota, { method: metodo, headers: corpo ? { "content-type": "application/json" } : {}, body: corpo ? JSON.stringify(corpo) : undefined });
    const txt = await r.text(); let json = null; try { json = JSON.parse(txt); } catch { /* não é JSON */ }
    return { status: r.status, json, txt, headers: r.headers };
  };
  const fim = async () => {
    if (cp.exitCode === null) { cp.kill("SIGTERM"); for (let i = 0; i < 50 && cp.exitCode === null; i++) await esperar(100); }
    if (cp.exitCode === null) cp.kill("SIGKILL");
  };
  return { url, porta, cp, api, fim, saida: () => saida };
}

/** Waits for a task to reach one of the statuses (the runner ticks every 1.5 s). */
export async function esperarStatus(b, id, status, limite = 20000) {
  const alvo = [].concat(status); const t0 = Date.now(); let t;
  while (Date.now() - t0 < limite) {
    t = (await b.api("GET", `/api/tasks/${id}`)).json?.task;
    if (t && alvo.includes(t.status) && !t.busy) return t;
    await esperar(200);
  }
  throw new Error(`a tarefa #${id} não chegou em ${alvo.join("/")} (está ${t?.status}, etapa ${t?.etapa})\n${b.saida().slice(-3000)}`);
}

export const chamadas = (caixa) => existsSync(join(caixa.home, "chamadas.jsonl"))
  ? readFileSync(join(caixa.home, "chamadas.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.papel !== "uso")
  : [];

export const limparCaixa = (caixa) => { try { rmSync(caixa.raiz, { recursive: true, force: true }); } catch { /* temp */ } };
