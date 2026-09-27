// Os projetos (pastas irmãs), o git deles e as cópias isoladas (⚡ e produção): criar, juntar, remover.
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, symlinkSync } from "fs";
import { dirname, join, relative } from "path";
import { AGENTES_DIR, DEV, PRODUCAO, cut } from "./config.mjs";
import { broadcast, logEvent, save, state } from "./estado.mjs";

// ── projetos = pastas irmãs em ~/Documents/DEV com .git, CLAUDE.md ou package.json ─
export let projCache = null;
export function listProjects() {
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
export const projetoBase = (task) => listProjects().find((p) => p.slug === task.project) || listProjects()[0];
// Tarefa ⚡ trabalha na cópia dela: agente, portão, revisor, QA e PR usam esta pasta, não a principal.
export const projectOf = (task) => {
  const p = projetoBase(task);
  return task?.worktree?.dir && !task.worktree.removida && existsSync(task.worktree.dir)
    ? { ...p, dir: task.worktree.dir, principal: p.dir } : p;
};
export const git = (dir, args, opts = {}) => execFileSync("git", ["-C", dir, ...args],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000, maxBuffer: 64 << 20, ...opts });

/** O nome do agente (#eng01, #eng02…): o menor livre entre os que estão trabalhando no projeto. */
export function nomeDeAgente(task) {
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
export function criarCopia(task) {
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
export function juntarNaPasta(task) {
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

/** Some com a cópia quando ela não guarda mais nada que só exista lá. */
export function removerCopia(task) {
  const wt = task.worktree;
  if (!wt || wt.removida || !existsSync(wt.dir)) return;
  if (wt.juntar === "conflito" || wt.juntar === "pendente") return; // o trabalho só existe lá
  try { git(projetoBase(task).dir, ["worktree", "remove", "--force", wt.dir]); wt.removida = true; }
  catch { /* fica para a próxima */ }
}

/**
 * O estado do git da pasta — o agente precisa saber ANTES de decidir o que fazer.
 * Pasta sem repo, repo sem remoto e repo pronto pedem caminhos diferentes; descobrir isso
 * aqui é mais barato (e mais previsível) que mandar o agente adivinhar por tentativa.
 */
export function gitInfo(dir) {
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

/** A pasta tem mudança pendente? (fora de git, assume que sim: não dá para saber.) */
export function haMudancas(dir) {
  try {
    return !!execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return true; }
}
