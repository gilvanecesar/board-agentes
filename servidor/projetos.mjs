// Os projetos (pastas irmãs), o git deles e as cópias isoladas (⚡ e produção): criar, juntar, remover.
import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { copyFileSync, writeFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, relative } from "path";
import { AGENTES_DIR, DATA, DEV, PRODUCAO, cut } from "./config.mjs";
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

/*
 * A SELEÇÃO de projetos da tela (23/10, pedido do dono): DEV tem ~30 pastas e ele trabalha em 4.
 * `data/projetos.json` = { "visiveis": ["slug", …], "rotulos": { "slug": "Nome na tela" } }.
 * Só a tela filtra: listProjects continua achando TODAS as pastas, porque tarefa antiga de projeto
 * escondido ainda precisa da pasta dela para rodar, conferir e abrir PR. Sem o arquivo, aparecem todos.
 */
export const PROJETOS_FILE = join(DATA, "projetos.json");
export function lerCatalogo() {
  try { return JSON.parse(readFileSync(PROJETOS_FILE, "utf8")); } catch { return {}; }
}
export function projetosVisiveis() {
  const { visiveis, rotulos = {} } = lerCatalogo();
  const todos = listProjects();
  const lista = Array.isArray(visiveis) ? visiveis.map((s) => todos.find((p) => p.slug === s)).filter(Boolean) : todos;
  return lista.map((p) => ({ ...p, label: rotulos[p.slug] || p.label }));
}

/*
 * O nome do projeto NA TELA (#249, pedido repetido do dono): sempre o rótulo de data/projetos.json, nunca o slug da pasta.
 * A pasta "acme" é o CRM Loja — Acme é OUTRA empresa e o nome não pode aparecer em lugar nenhum do board.
 * Vale também para projeto escondido (tarefa antiga dele ainda aparece na lista). Sem rótulo, o slug é o nome.
 */
export function rotulosDosProjetos() {
  const { rotulos = {} } = lerCatalogo();
  return { ...rotulos };
}
export const rotuloDoProjeto = (slug) => rotulosDosProjetos()[slug] || slug;
/** Texto livre para a tela (mensagem de erro que vira toast): o slug, como palavra inteira, vira o rótulo — o mesmo
 *  `nomeNaTela` da tela ("crm-antigo" → "CRM"). A rede de segurança de `json()` em http.mjs para respostas de erro. */
export function rotularTexto(texto) {
  const q = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let s = String(texto ?? "");
  for (const [slug, rot] of Object.entries(rotulosDosProjetos())) {
    if (!rot || slug === rot) continue;
    s = s.replace(new RegExp(`(^|[^a-z0-9])${q(slug)}(?=$|[^a-z0-9])`, "gi"), (_, a) => a + rot)
      .replace(new RegExp(`(^|[^a-z0-9])${q(rot)}[-_ ]${q(rot)}(?=$|[^a-z0-9])`, "gi"), (_, a) => a + rot);
  }
  return s;
}

/** Põe um projeto que já existe na seleção da tela (#234: trazer para a Conversa a sessão de uma pasta escondida). */
export function tornarVisivel(slug) {
  const cat = lerCatalogo();
  if (!Array.isArray(cat.visiveis) || cat.visiveis.includes(slug)) return false; // sem arquivo, todos já aparecem
  cat.visiveis.push(slug);
  writeFileSync(PROJETOS_FILE, JSON.stringify(cat, null, 2) + "\n");
  projCache = null;
  return true;
}

/** "Meu Projeto Ótimo!" → "meu-projeto-otimo": vira o nome da pasta em DEV. */
export function slugDoNome(nome) {
  return String(nome || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
}

/**
 * Projeto novo pela tela: cria a pasta em DEV com CLAUDE.md, .gitignore e git (commit inicial), e
 * põe na seleção. Fica LOCAL: o GitHub nasce na primeira tarefa entregue por PR (`gitInfo` manda
 * o agente criar o repositório privado). Erro tem `status` para a rota devolver 400/409.
 */
export function criarProjetoNovo({ nome, descricao = "" } = {}) {
  const falha = (status, msg) => Object.assign(new Error(msg), { status });
  const rotulo = String(nome || "").trim().slice(0, 60);
  const slug = slugDoNome(rotulo);
  if (slug.length < 2) throw falha(400, "dê um nome ao projeto (letras ou números, pelo menos 2)");
  if (slug === "node-modules" || slug === "dev") throw falha(400, `"${slug}" é um nome reservado`);
  const dir = join(DEV, slug);
  if (existsSync(dir)) throw falha(409, `já existe a pasta "${slug}" em ${DEV}`);
  const hoje = new Date().toLocaleDateString("pt-BR");
  const sobre = String(descricao || "").trim().slice(0, 500) || "Descreva aqui o que é o projeto, a stack e as regras que todo agente precisa saber.";
  mkdirSync(dir);
  writeFileSync(join(dir, "CLAUDE.md"), `# ${rotulo}\n\n${sobre}\n\nCriado pelo board em ${hoje}.\n\n## Regras\n\n- Interface e textos para o usuário em português BR; código em inglês.\n`);
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n.env\n.env.*\n.DS_Store\ndist/\n");
  let aviso = null;
  git(dir, ["init", "-q", "-b", "main"]);
  try {
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "Projeto criado pelo board"]);
  } catch (e) {
    // Sem identidade do git (user.name/email) não há commit — e o board não inventa uma.
    aviso = "pasta e git criados, mas sem o commit inicial: " + cut(String(e.stderr || e.message || e), 200);
  }
  const cat = lerCatalogo();
  if (Array.isArray(cat.visiveis) && !cat.visiveis.includes(slug)) cat.visiveis.push(slug);
  if (rotulo !== slug) cat.rotulos = { ...(cat.rotulos || {}), [slug]: rotulo };
  if (Object.keys(cat).length) writeFileSync(PROJETOS_FILE, JSON.stringify(cat, null, 2) + "\n");
  projCache = null;
  const mapa = acrescentarAoMapa({ slug, rotulo, descricao, hoje });
  return { slug, dir, label: rotulo, aviso: [aviso, mapa].filter(Boolean).join(" · ") || null };
}

/**
 * O mapa do portfólio (`DEV/CLAUDE.md`, que todo agente herda): sem a entrada, o projeto novo fica
 * invisível para os agentes dos OUTROS projetos. Entra no fim da seção "## Projetos" (antes do `---`
 * que a fecha), só com o que o dono disse — a stack fica "a definir", o board não inventa.
 * No dono, `DEV/CLAUDE.md` é um LINK para `repo-portfolio/PORTFOLIO.md` (repo que se sincroniza
 * sozinho): escrever pelo link muda o arquivo de verdade e mantém o link. Sem mapa, não faz nada.
 * Falhar aqui não desfaz o projeto: vira aviso.
 */
export function acrescentarAoMapa({ slug, rotulo, descricao = "", hoje }) {
  const arq = join(DEV, "CLAUDE.md");
  if (!existsSync(arq)) return null;
  try {
    const txt = readFileSync(arq, "utf8");
    if (new RegExp(`^### .*\\b${slug.replace(/[-]/g, "\\-")} — `, "m").test(txt)) return null; // já está no mapa
    const sobre = String(descricao || "").trim().slice(0, 500) || "O que é: ainda não descrito.";
    const entrada = `### 🆕 ${slug} — ${rotulo}\n${sobre} Stack: a definir. Criado pelo board em ${hoje} (pasta \`${slug}\`; local até a\n1ª tarefa entregue por PR). Detalhe no \`CLAUDE.md\` do projeto.\n\n`;
    const secao = txt.search(/^## Projetos\s*$/m);
    const fim = secao < 0 ? -1 : txt.slice(secao).search(/^(?:---\s*$|## (?!Projetos))/m); // o que fecha a seção
    const pos = secao >= 0 && fim > 0 ? secao + fim : txt.length;
    const antes = txt.slice(0, pos), depois = txt.slice(pos);
    writeFileSync(arq, antes.replace(/\n*$/, "\n\n") + entrada + depois);
    return null;
  } catch (e) {
    return "não entrou no mapa do portfólio (DEV/CLAUDE.md): " + cut(String(e.message || e), 150);
  }
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

export const SEM_NODE_MODULES = ["--", ".", ":(exclude,glob)**/node_modules"];

/**
 * A pasta AGORA como árvore git: o commit, o que está sem commit e os arquivos novos não ignorados (a #205 esbarrou
 * justamente em arquivos novos sem commit). Num índice temporário: o índice do dono não é tocado.
 */
export function arvoreDaPasta(dir) {
  const idx = join(tmpdir(), `board-indice-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    const real = git(dir, ["rev-parse", "--path-format=absolute", "--git-path", "index"]).trim();
    if (existsSync(real)) copyFileSync(real, idx);
    const env = { ...process.env, GIT_INDEX_FILE: idx };
    git(dir, ["add", "-A", ...SEM_NODE_MODULES], { env });
    return git(dir, ["write-tree"], { env }).trim();
  } finally { rmSync(idx, { force: true }); }
}

const IDENTIDADE_DO_BOARD = { GIT_AUTHOR_NAME: "board", GIT_AUTHOR_EMAIL: "board@localhost", GIT_COMMITTER_NAME: "board", GIT_COMMITTER_EMAIL: "board@localhost" };
/** Um commit SOLTO (nenhuma branch aponta para ele) com `arvore`; pai = HEAD da pasta, quando há. */
export function commitSolto(dir, arvore, msg) {
  let pai = []; try { pai = ["-p", git(dir, ["rev-parse", "--verify", "--quiet", "HEAD"]).trim()]; } catch { /* repo sem commit */ }
  return git(dir, ["commit-tree", arvore, ...pai, "-m", msg], { env: { ...process.env, ...IDENTIDADE_DO_BOARD } }).trim();
}

/** A fotografia da pasta inteira (commit + sem commit + arquivos novos) num commit solto — sem mexer em nada da pasta. */
export const fotografarPasta = (dir) => commitSolto(dir, arvoreDaPasta(dir), "board: fotografia da pasta principal");

/** O nome do agente (#eng01, #eng02…): o menor livre entre os que estão trabalhando no projeto. */
export function nomeDeAgente(task) {
  const usados = new Set(state.tasks.filter((t) => t !== task && t.project === task.project && (t.status === "rodando" || t.busy) && t.agente).map((t) => t.agente));
  if (task.agente && !usados.has(task.agente)) return task.agente; // retentativa mantém o nome
  for (let n = 1; ; n++) { const nome = "eng" + String(n).padStart(2, "0"); if (!usados.has(nome)) return nome; }
}

/** node_modules não está no git: a cópia aponta para os da pasta principal (instalar de novo levaria minutos). */
export function ligarNodeModules(origem, dir) {
  try {
    const achados = execFileSync("find", [origem, "-maxdepth", "3", "-name", "node_modules", "-type", "d", "-prune"],
      { encoding: "utf8", timeout: 20000 }).split("\n").filter(Boolean);
    for (const nm of achados) {
      const alvo = join(dir, relative(origem, nm));
      if (!existsSync(alvo) && existsSync(dirname(alvo))) symlinkSync(nm, alvo);
    }
  } catch { /* sem node_modules: segue */ }
}

/**
 * Cria a cópia isolada da tarefa ⚡. Parte do estado ATUAL da pasta, inclusive o que está sem commit
 * e os arquivos novos não ignorados (`fotografarPasta`, sem mexer na pasta) — senão o agente trabalharia em código velho e
 * o trabalho dele brigaria com o da pasta na volta. Produção parte do commit: o PR não pode levar
 * mudança alheia que só existe na pasta.
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
    // A pasta inteira, arquivos novos sem commit inclusive: com `git stash create` eles ficavam de fora e a cópia nascia
    // quebrada quando o código rastreado já dependia deles (27/10: a #208 partiu sem o `servidor/publicar.mjs` da #205).
    base = fotografarPasta(p.dir);
  }
  base = base || git(p.dir, ["rev-parse", "HEAD"]).trim();
  if (existsSync(dir)) { try { git(p.dir, ["worktree", "remove", "--force", dir]); } catch { /* sobra de antes */ } }
  git(p.dir, ["worktree", "add", "--detach", dir, base]);
  ligarNodeModules(p.dir, dir);
  task.worktree = { dir, base, aplicado: git(dir, ["rev-parse", "HEAD^{tree}"]).trim(), producao, juntar: null };
  logEvent(task.id, { t: "solto", texto: `⚡ #${task.agente} numa cópia isolada (${dir})`
    + (producao ? " — produção: entrega por PR" : " — o board junta na pasta principal quando a conferência aprovar") });
}

// A volta da cópia para a pasta principal (`juntarNaPasta`) mora em juntar.mjs.

/** Some com a cópia quando ela não guarda mais nada que só exista lá. */
export function removerCopia(task) {
  const wt = task.worktree;
  if (!wt || wt.removida || !existsSync(wt.dir)) return;
  if (["conflito", "pendente", "consertando"].includes(wt.juntar)) return; // o trabalho só existe lá
  try { git(projetoBase(task).dir, ["worktree", "remove", "--force", wt.dir]); wt.removida = true; }
  catch { /* fica para a próxima */ }
}

/**
 * O estado do git da pasta — o agente precisa saber ANTES de decidir o que fazer.
 * Pasta sem repo, repo sem remoto e repo pronto pedem caminhos diferentes; descobrir isso
 * aqui é mais barato (e mais previsível) que mandar o agente adivinhar por tentativa.
 */
/** Impressão digital do que está na pasta (commit + mudanças sem commit + arquivos novos). null sem git. */
/** Arquivo novo entra pelo CONTEÚDO: pelo nome só, um `sed -i` nele não mudava o estado (revisor da #288). Enorme vai por tamanho e hora. */
function lerNovo(h, dir, rel) {
  h.update(rel + "\0");
  const arq = join(dir, rel);
  try {
    const st = lstatSync(arq);
    if (st.isSymbolicLink()) h.update(readlinkSync(arq));
    else if (st.isFile()) h.update(st.size <= NOVO_INTEIRO ? readFileSync(arq) : `${st.size}:${st.mtimeMs}`);
  } catch { /* sumiu entre a lista e a leitura */ }
}
const NOVO_INTEIRO = 8 * 1024 * 1024;

export function estadoDaArvore(dir) {
  try {
    const h = createHash("sha1");
    h.update(git(dir, ["rev-parse", "HEAD"]));
    h.update(git(dir, ["diff", "HEAD", "--binary"], { maxBuffer: 64 * 1024 * 1024 }));
    for (const rel of git(dir, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean)) lerNovo(h, dir, rel);
    return h.digest("hex");
  } catch { return null; }
}

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

/**
 * Não há NADA a entregar por PR: a pasta está limpa (o link de node_modules que a cópia ganha não conta) e o HEAD já está
 * no que foi publicado (origin/HEAD, main ou master). Na dúvida (sem git, sem remoto) responde false: aí a entrega segue como sempre.
 * Existe pela #325 (03–04/11): diagnóstico em produção, sem mudança, voltava 4 vezes pedindo PR que não havia o que conter.
 */
export function nadaParaEntregar(dir) {
  try {
    const g = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const sujo = g("status", "--porcelain").split("\n").filter((l) => l.trim() && !/(^|\/)node_modules\/?"?$/.test(l.trim()));
    if (sujo.length) return false;
    for (const ref of ["origin/HEAD", "origin/main", "origin/master"]) {
      try { g("rev-parse", "--verify", "--quiet", ref); } catch { continue; }
      try { g("merge-base", "--is-ancestor", "HEAD", ref); return true; } catch { return false; }
    }
    return false;
  } catch { return false; }
}
