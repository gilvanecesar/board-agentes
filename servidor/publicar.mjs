// 🚀 Publicar por projeto (#205, pedido do dono em 27/10: "botões de deploy onde precisamos de deploy").
// No menu Pull Requests: a versão NO AR (lida do próprio app) × a main, os PRs mesclados que ainda não subiram e o botão
// que SÓ o dono clica. O comando mora em data/publicar.json ({slug: {comando, conferir}}), que nasce vazio.
// ⚠️ NÃO é o data/deploy.json: aquele autoriza o board a publicar SOZINHO no fim de uma tarefa ("Mesclar e publicar").
// Este nunca roda sozinho, nunca por tarefa, nunca por retentativa — nada na esteira chama este módulo.
import { spawn, execFile } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { DATA, cut, now } from "./config.mjs";
import { broadcast, logEvent, save, state } from "./estado.mjs";
import { git, listProjects, projetosVisiveis, rotuloDoProjeto } from "./projetos.mjs";
import { repoDoProjeto } from "./prs.mjs";

export const PUBLICAR_FILE = join(DATA, "publicar.json");
if (!existsSync(PUBLICAR_FILE)) { try { writeFileSync(PUBLICAR_FILE, "{}\n"); } catch { /* sem data/: nada a publicar */ } }
export const PUBLICAR_TIMEOUT_MS = Number(process.env.BOARD_PUBLICAR_TIMEOUT_MIN || 30) * 60000;
// Depois do comando, o app leva um tempo para trocar (container subindo): confere algumas vezes antes de dizer que não trocou.
const CONFERIR_TENTATIVAS = Math.max(1, Number(process.env.BOARD_PUBLICAR_CONFERIR_TENTATIVAS || 6));
const CONFERIR_INTERVALO_MS = Number(process.env.BOARD_PUBLICAR_CONFERIR_S ?? 10) * 1000;
const COMMITS = 50; // quantos commits da main o board olha para achar a versão no ar
const LOG_MAX = 200000; // bytes de saída que vão para o log da publicação (um docker build fala muito)

export const PUBLICANDO = new Map(); // slug → { desde, comando, cp } — o reinício espera (fila.mjs)
export const logIdPublicar = (slug) => `publicar-${slug}`;
const ENV = () => ({ ...process.env, PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}` });

// Publicação que estava rodando quando o board caiu: não se sabe como terminou. Fica dito, não fingido.
for (const [slug, p] of Object.entries(state.publicacoes || {})) {
  if (p?.emAndamento) { p.emAndamento = false; p.ok = false; p.interrompida = true; logEvent(logIdPublicar(slug), { t: "fim", status: "erro", motivo: "o board caiu durante a publicação — confira o servidor" }); }
}

/** A entrada do projeto em data/publicar.json. Texto puro vale como o comando. null = não configurado. */
export function configPublicar(slug) {
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(PUBLICAR_FILE, "utf8")) || {}; } catch { return null; }
  const e = cfg[slug];
  const comando = typeof e === "string" ? e : typeof e?.comando === "string" ? e.comando : "";
  if (!comando.trim()) return null;
  const conferir = typeof e?.conferir === "string" && /^https?:\/\//.test(e.conferir) ? e.conferir : "";
  return { comando, conferir };
}
export const projetosPublicaveis = () => listProjects().filter((p) => configPublicar(p.slug)).map((p) => p.slug);

const gh = (args, timeout = 30000) => new Promise((ok) => execFile("gh", args, { cwd: tmpdir(), env: ENV(), timeout, maxBuffer: 16 << 20 },
  (err, stdout, stderr) => ok({ ok: !err, out: String(stdout || ""), err: cut(String(stderr || err?.message || ""), 300) })));

/** Os últimos commits da branch padrão no GitHub (mais novo primeiro): é contra eles que a versão no ar é achada. */
export async function commitsDaMain(repo) {
  const r = await gh(["api", `repos/${repo}/commits?per_page=${COMMITS}`]);
  if (!r.ok) return { erro: "não consegui ler a main no GitHub: " + r.err, commits: [] };
  try {
    const lista = JSON.parse(r.out);
    return { erro: null, commits: lista.map((c) => ({ sha: String(c.sha || ""), titulo: String(c.commit?.message || "").split("\n")[0], em: c.commit?.committer?.date || null })) };
  } catch { return { erro: "o GitHub respondeu algo que não entendi", commits: [] }; }
}

const HASH_CAMPOS = ["hash", "sha", "gitSha", "git_sha", "GIT_SHA", "commit"];
/**
 * A versão NO AR, lida do próprio app (`conferir`). JSON com campo de hash → é ele. Página (HTML/JS) → o board procura,
 * nela e nos scripts que ela carrega, o hash de um dos últimos commits da main (o selo do admin vem do GIT_SHA do build,
 * embutido no bundle). Nunca chuta: não achou, diz que não achou.
 */
export async function lerNoAr(url, commits = []) {
  const pegar = async (u) => {
    const r = await fetch(u, { headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(10000), redirect: "follow" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return { tipo: r.headers.get("content-type") || "", corpo: (await r.text()).slice(0, 8 << 20) };
  };
  let pag;
  try { pag = await pegar(url); } catch (e) { return { hash: null, erro: `não consegui ler ${url}: ${e.message}` }; }
  let j = null;
  try { j = JSON.parse(pag.corpo); } catch { /* não é JSON */ }
  if (j && typeof j === "object") {
    const hash = HASH_CAMPOS.map((k) => j[k]).find((v) => typeof v === "string" && /^[0-9a-f]{7,40}$/i.test(v.trim()));
    const versao = [j.versao, j.version].find((v) => typeof v === "string") || null;
    if (hash) return { hash: hash.trim().toLowerCase(), versao, fonte: "json", erro: null };
    return { hash: null, versao, erro: `${url} respondeu JSON sem campo de hash (${HASH_CAMPOS.join(", ")})` };
  }
  const textos = [pag.corpo];
  if (/html/i.test(pag.tipo) || /<script/i.test(pag.corpo)) {
    const base = new URL(url);
    const srcs = [...pag.corpo.matchAll(/<(?:script[^>]*\ssrc|link[^>]*\shref)=["']([^"']+\.js[^"']*)["']/gi)].map((m) => m[1]);
    for (const s of [...new Set(srcs)].slice(0, 8)) {
      try { const u = new URL(s, base); if (u.origin === base.origin) textos.push((await pegar(u.href)).corpo); } catch { /* script fora do ar: segue */ }
    }
  }
  for (const c of commits) {
    if (!/^[0-9a-f]{40}$/i.test(c.sha)) continue;
    const re = new RegExp(`(?<![0-9a-f])(${c.sha.slice(0, 7)}[0-9a-f]{0,33})(?![0-9a-f])`, "gi");
    for (const t of textos) for (const m of t.matchAll(re)) if (c.sha.startsWith(m[1].toLowerCase())) return { hash: m[1].toLowerCase(), versao: null, fonte: "pagina", erro: null };
  }
  return { hash: null, versao: null, erro: `não achei em ${url} nenhum dos últimos ${commits.length} commits da main` };
}

/** Os commits da main que ainda NÃO estão no ar (mais novo primeiro), e os PRs que eles carregam "(#N)". null = não dá para saber. */
export function pendentesDesde(commits, base) {
  if (!base) return null;
  const i = commits.findIndex((c) => c.sha.startsWith(base));
  if (i < 0) return null;
  const novos = commits.slice(0, i);
  const prs = [];
  for (const c of novos) {
    const m = c.titulo.match(/\(#(\d+)\)\s*$/) || c.titulo.match(/^Merge pull request #(\d+)/);
    if (m) prs.push({ numero: Number(m[1]), titulo: c.titulo.replace(/\s*\(#\d+\)\s*$/, ""), hash: c.sha.slice(0, 7) });
  }
  return { n: prs.length, prs, commits: novos.length, semPr: novos.length - prs.length };
}

/** O projeto pelo slug, com o rótulo da tela (data/projetos.json) quando houver. */
function projetoDe(slug) {
  const p = listProjects().find((x) => x.slug === slug);
  return p ? { ...p, label: rotuloDoProjeto(slug) } : null;
}

const CACHE = new Map(); // slug → { em, dados }
const TTL = 60000;

/** Tudo o que o bloco "Publicar" de um projeto mostra. Só lê (GitHub e o app no ar) se o projeto estiver configurado. */
export async function statusPublicar(slug, { fresco = false } = {}) {
  const c = CACHE.get(slug);
  const rodando = PUBLICANDO.get(slug);
  const vivo = { rodando: rodando ? { desde: rodando.desde, comando: rodando.comando } : null, ultima: state.publicacoes?.[slug] || null };
  if (!fresco && c && Date.now() - c.em < TTL) return { ...c.dados, ...vivo };
  const p = projetoDe(slug);
  if (!p) return null;
  const cfg = configPublicar(slug);
  const base = { slug, label: p.label, configurado: !!cfg };
  if (!cfg) return { ...base, ...vivo };
  let pasta = null;
  try {
    const branch = git(p.dir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    const sujos = git(p.dir, ["status", "--porcelain"]).split("\n").filter((l) => l.trim()).length;
    pasta = { branch, sujos };
  } catch { /* pasta sem git */ }
  const repo = repoDoProjeto(p.dir);
  const { erro: erroMain, commits } = repo ? await commitsDaMain(repo) : { erro: "o projeto não tem repositório no GitHub", commits: [] };
  const main = commits[0] ? { hash: commits[0].sha.slice(0, 7), sha: commits[0].sha, titulo: commits[0].titulo, em: commits[0].em } : null;
  const noAr = cfg.conferir ? { ...(await lerNoAr(cfg.conferir, commits)), lidoEm: now() } : null;
  // Sem leitura do app, a referência é o que a main tinha na última publicação do board que deu certo — e a tela diz isso.
  const ultimaOk = state.publicacoes?.[slug]?.ok ? state.publicacoes[slug].mainSha : null;
  const ref = noAr?.hash || ultimaOk;
  const pendentes = pendentesDesde(commits, ref);
  const dados = {
    ...base, comando: cfg.comando, conferir: cfg.conferir || null, dir: p.dir, repo, pasta, main, erroMain, noAr,
    pendentes: pendentes ? { ...pendentes, fonte: noAr?.hash ? "no-ar" : "ultima-publicacao" } : null,
    pendentesMotivo: pendentes ? null : !commits.length ? (erroMain || "sem commits") : !ref ? "não sei qual versão está no ar"
      : `a versão de referência (${ref.slice(0, 7)}) não está entre os últimos ${commits.length} commits da main`,
    emDia: !!(main && ref && main.sha.startsWith(ref)),
  };
  CACHE.set(slug, { em: Date.now(), dados });
  return { ...dados, ...vivo };
}

export async function listarPublicar({ fresco = false } = {}) {
  const projetos = projetosVisiveis().filter((p) => p.slug !== "DEV");
  return { lidoEm: now(), projetos: await Promise.all(projetos.map((p) => statusPublicar(p.slug, { fresco }))) };
}

const falha = (status, msg) => Object.assign(new Error(msg), { status });
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * O dono clicou "🚀 Publicar" e confirmou. `confirmo` é o comando EXATO que a confirmação mostrou: se o arquivo mudou
 * no meio, não roda. Devolve na hora; o comando segue em segundo plano com log ao vivo, teto de tempo e, no fim,
 * a conferência da versão no ar. Uma publicação por projeto de cada vez.
 */
export async function publicar(slug, { confirmo, quem } = {}) {
  const p = projetoDe(slug);
  if (!p) throw falha(404, "projeto não existe");
  const cfg = configPublicar(slug);
  if (!cfg) throw falha(400, `o projeto "${rotuloDoProjeto(slug)}" não tem comando de publicação em data/publicar.json`);
  if (PUBLICANDO.has(slug)) throw falha(409, `já há uma publicação de ${p.label} rodando`);
  if (confirmo !== cfg.comando) throw falha(409, "o comando de publicação mudou desde a confirmação — confira de novo");
  const antes = await statusPublicar(slug, { fresco: true });
  if (PUBLICANDO.has(slug)) throw falha(409, `já há uma publicação de ${p.label} rodando`);
  const id = logIdPublicar(slug);
  const desde = now(), t0 = Date.now();
  const sobem = antes.pendentes?.prs || [];
  const registro = { em: desde, quem, comando: cfg.comando, dir: p.dir, mainSha: antes.main?.sha || null, noArAntes: antes.noAr?.hash || null, prs: sobem.map((x) => x.numero), emAndamento: true, ok: null };
  (state.publicacoes ||= {})[slug] = registro;
  save();
  logEvent(id, { t: "inicio", titulo: `publicar ${p.label}`, projeto: slug, dir: p.dir, quem, comando: cfg.comando,
    prs: sobem, main: antes.main?.hash || null, noAr: antes.noAr?.hash || null, texto: `🚀 ${quem} clicou em Publicar ${p.label}` });

  const cp = spawn("/bin/bash", ["-c", cfg.comando], { cwd: p.dir, env: ENV(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
  PUBLICANDO.set(slug, { desde, comando: cfg.comando, cp });
  broadcast("publicar", { slug });
  let pendente = "", gravado = 0, cauda = "", estourou = false;
  const flush = () => {
    if (!pendente) return;
    if (gravado < LOG_MAX) { const pedaco = pendente.slice(0, LOG_MAX - gravado); gravado += pedaco.length; logEvent(id, { t: "saida", texto: pedaco }); if (gravado >= LOG_MAX) logEvent(id, { t: "saida", texto: "\n… (saída longa: o log parou aqui; as últimas linhas vão no fim)\n" }); }
    pendente = "";
  };
  const tick = setInterval(flush, 400);
  const ouve = (d) => { const s = d.toString(); pendente += s; cauda = (cauda + s).slice(-8000); };
  cp.stdout.on("data", ouve); cp.stderr.on("data", ouve);
  const matar = (sinal) => { try { process.kill(-cp.pid, sinal); } catch { /* já saiu */ } };
  const timer = setTimeout(() => { estourou = true; matar("SIGTERM"); setTimeout(() => matar("SIGKILL"), 5000).unref(); }, PUBLICAR_TIMEOUT_MS);
  cp.on("error", (e) => { pendente += "\n" + e.message; });
  cp.on("close", async (code) => {
    clearTimeout(timer); clearInterval(tick); flush();
    const ok = !estourou && code === 0;
    const motivo = estourou ? `passou de ${PUBLICAR_TIMEOUT_MS / 60000} min e foi interrompido` : ok ? null : `o comando saiu com código ${code}`;
    logEvent(id, { t: "fim", status: ok ? "publicado" : "erro", code, dur: Date.now() - t0, motivo, cauda: ok ? undefined : cauda.split("\n").slice(-40).join("\n") });
    Object.assign(registro, { emAndamento: false, ok, code, fim: now(), motivo });
    if (ok && cfg.conferir) registro.conferido = await conferirDepois(slug, id, registro.mainSha);
    PUBLICANDO.delete(slug);
    CACHE.delete(slug);
    // A linha do tempo de cada tarefa cujo PR subiu (ou tentou subir) agora.
    if (antes.repo) for (const pr of sobem) {
      const url = `https://github.com/${antes.repo}/pull/${pr.numero}`;
      const task = state.tasks.find((x) => x.prUrl === url || (x.prExtras || []).includes(url));
      if (!task) continue;
      if (ok) { task.publicado = { em: registro.fim, slug, quem, conferido: registro.conferido?.ok ?? null, mainSha: registro.mainSha }; task.updatedAt = now(); }
      logEvent(task.id, { t: "solto", texto: ok ? `🚀 PR #${pr.numero} publicado por ${quem} (Publicar ${p.label}, ${registro.fim})${registro.conferido ? registro.conferido.ok ? " — conferido no ar" : " — ⚠ a versão no ar não confere" : ""}` : `🚀 a publicação de ${p.label} com o PR #${pr.numero} FALHOU (${motivo})` });
    }
    save();
    broadcast("publicar", { slug });
    broadcast("state");
  });
  return { ok: true, iniciado: desde, slug, prs: sobem.map((x) => x.numero) };
}

/** Depois do comando: a versão no ar bate com a main que subiu? Tenta algumas vezes (o container leva um tempo). */
async function conferirDepois(slug, id, mainSha) {
  const cfg = configPublicar(slug);
  let ultima = null;
  for (let i = 0; i < CONFERIR_TENTATIVAS; i++) {
    if (i) await espera(CONFERIR_INTERVALO_MS);
    const dir = listProjects().find((x) => x.slug === slug)?.dir;
    const repo = dir ? repoDoProjeto(dir) : null;
    const { commits } = repo ? await commitsDaMain(repo) : { commits: [] };
    ultima = await lerNoAr(cfg?.conferir || "", commits);
    if (ultima.hash && mainSha && mainSha.startsWith(ultima.hash)) {
      logEvent(id, { t: "conferido", ok: true, hash: ultima.hash, texto: `✓ no ar: ${ultima.hash.slice(0, 7)} — é a main que subiu` });
      return { ok: true, hash: ultima.hash, em: now() };
    }
  }
  const texto = ultima?.hash ? `⚠ no ar: ${ultima.hash.slice(0, 7)}, mas a main que subiu é ${String(mainSha || "?").slice(0, 7)}` : `⚠ não consegui conferir a versão no ar: ${ultima?.erro || "sem leitura"}`;
  logEvent(id, { t: "conferido", ok: false, hash: ultima?.hash || null, texto });
  return { ok: false, hash: ultima?.hash || null, em: now(), erro: texto };
}
