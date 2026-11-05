// The harness's watchman: whatever the tests start (Chrome, an isolated board) dies with them, however they die.
// `process.on("exit")` does NOT run on SIGTERM, SIGINT or SIGKILL, and that is how a test usually gets cut (agent tool
// timeout, gate timeout, Ctrl+C): on 31/10 two Chromes and four boards were found alive, some of them for ~34 h.
// A detached child holds the read end of a pipe; when the test process dies, in ANY way, the kernel closes the pipe.
import { spawn, execFileSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

let guarda = null;
const avisa = (o) => {
  if (!guarda) {
    guarda = spawn(process.execPath, [fileURLToPath(import.meta.url), "--vigia"], { cwd: "/", detached: true, stdio: ["pipe", "ignore", "ignore"] });
    guarda.on("error", () => { /* sem vigia o teste roda igual: ela é faxina */ }); guarda.stdin.on("error", () => {});
    guarda.unref(); guarda.stdin.unref(); // não segura a saída do teste
  }
  guarda.stdin.write(JSON.stringify(o) + "\n");
};

/** Watches a child process until it exits by itself. */
export function vigiarProcesso(cp) {
  if (!cp.pid) return;
  avisa({ pid: cp.pid }); cp.once("exit", () => avisa({ soltarPid: cp.pid }));
}
/** Watches a temp folder: if the test dies, every process using it dies and the folder is removed. */
export const vigiarPasta = (caminho) => avisa({ caminho });
export const soltarPasta = (caminho) => avisa({ soltarCaminho: caminho });

/** Processes whose command line or working folder is inside `caminho`: the path comes from mkdtemp, so it is unique. */
function quemUsa(caminho) {
  let pids;
  try { pids = readdirSync("/proc").filter((p) => /^\d+$/.test(p)); }
  catch { /* sem /proc (macOS) */ try { execFileSync("pkill", ["-KILL", "-f", caminho], { stdio: "ignore" }); } catch { /* ninguém */ } return []; }
  return pids.filter((p) => {
    if (Number(p) === process.pid) return false;
    try { if (readFileSync(`/proc/${p}/cmdline`, "utf8").includes(caminho)) return true; } catch { /* já saiu */ }
    try { const d = readlinkSync(`/proc/${p}/cwd`); return d === caminho || d.startsWith(caminho + "/"); } catch { return false; }
  }).map(Number);
}

async function faxina(pids, caminhos) {
  const mata = (p) => { try { process.kill(p, "SIGKILL"); } catch { /* já saiu */ } };
  pids.forEach(mata);
  for (const c of caminhos) {
    for (let i = 0; i < 3; i++) { quemUsa(c).forEach(mata); await new Promise((ok) => setTimeout(ok, 200)); } // filho que nasceu no meio da faxina
    try { rmSync(c, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch { /* temp */ }
  }
  process.exit(0);
}

if (process.argv[2] === "--vigia") {
  const pids = new Set(), caminhos = new Set(); let resto = "";
  process.on("SIGHUP", () => {}); // o terminal fechando é justamente quando ela precisa trabalhar
  process.stdin.on("data", (d) => {
    const linhas = (resto + d).split("\n"); resto = linhas.pop();
    for (const l of linhas) {
      const o = JSON.parse(l);
      if (o.pid) pids.add(o.pid); if (o.soltarPid) pids.delete(o.soltarPid);
      if (o.caminho) caminhos.add(o.caminho); if (o.soltarCaminho) caminhos.delete(o.soltarCaminho);
    }
  });
  process.stdin.on("end", () => faxina([...pids], [...caminhos]));
}
