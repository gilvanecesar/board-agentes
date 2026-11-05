// Pull Requests (o menu 🔀, 23/10/2026): os PRs de cada projeto da seleção, lidos do GitHub pelo `gh`, e o
// "Mesclar" que o DONO clica. Pedido dele: "colocar no board os PRs de cada projeto… e que dê pra eu mesclar por aqui".
import { execFile } from "child_process";
import { tmpdir } from "os";
import { cut, now } from "./config.mjs";
import { broadcast, logEvent, save, state } from "./estado.mjs";
import { git, projetosVisiveis } from "./projetos.mjs";

const ENV = () => ({ ...process.env, PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}` });
// ⚠️ cwd fora de qualquer projeto: `gh pr merge --delete-branch` dentro da pasta do dono trocaria a branch
// dele e apagaria a local. Pela URL, o gh trabalha só no GitHub.
const gh = (args, timeout = 30000) => new Promise((ok) => execFile("gh", args, { cwd: tmpdir(), env: ENV(), timeout, maxBuffer: 16 << 20 },
  (err, stdout, stderr) => ok({ ok: !err, out: String(stdout || ""), err: cut(String(stderr || err?.message || ""), 400) })));

/** "dono/repo" do GitHub a partir do remoto `origin` (https ou ssh). null = projeto sem GitHub ainda. */
export function repoDoProjeto(dir) {
  try {
    const url = git(dir, ["remote", "get-url", "origin"]).trim();
    const m = url.match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
    return m ? `${m[1]}/${m[2]}` : null;
  } catch { return null; }
}

/** Os checks do GitHub em uma palavra: o que a linha do PR precisa dizer. */
export function resumoChecks(rollup = []) {
  const estados = (rollup || []).map((c) => String(c.conclusion || c.state || c.status || "").toUpperCase());
  if (!estados.length) return { estado: "sem", texto: "sem checks" };
  const falhou = estados.filter((e) => ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(e)).length;
  const pend = estados.filter((e) => ["PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", "WAITING", ""].includes(e)).length;
  if (falhou) return { estado: "falhou", texto: `${falhou} de ${estados.length} falharam` };
  if (pend) return { estado: "rodando", texto: `${pend} de ${estados.length} rodando` };
  return { estado: "ok", texto: `${estados.length} passaram` };
}

/** Os checks que falharam de verdade: cancelado ou esperando aprovação não é código a consertar (a vigia só olha estes). */
export function checksQueFalharam(rollup = []) {
  const falhou = (rollup || []).filter((c) => ["FAILURE", "ERROR", "TIMED_OUT"].includes(String(c.conclusion || c.state || "").toUpperCase()));
  return [...new Set(falhou.map((c) => c.name || c.context || "check"))];
}

/** A tarefa do board que abriu este PR (prUrl ou um dos extras), com o que a conferência disse. */
export function tarefaDoPr(url) {
  const t = state.tasks.find((x) => x.prUrl === url) || state.tasks.find((x) => (x.prExtras || []).includes(url));
  if (!t) return null;
  const conferindo = t.status === "rodando" || t.status === "fila" || !!t.busy || !!t.etapa;
  // Tudo que não é APROVADO: parecer sem veredito ou sem classificação (#300) é reprova, e a trava da #188 tem de ver.
  const reprovado = [t.revisor, t.qa].some((x) => x && x.veredito !== "APROVADO");
  const vigia = t.prVigia ? { estado: t.prVigia.estado, motivo: t.prVigia.motivo, n: t.prVigia.n, max: t.prVigia.max } : null;
  return { id: t.id, title: t.title, status: t.status, revisor: t.revisor?.veredito || null, qa: t.qa?.veredito || null, conferindo, reprovado, vigia };
}

const CAMPOS_ABERTOS = "number,title,url,headRefName,author,createdAt,updatedAt,isDraft,mergeable,reviewDecision,statusCheckRollup";
const CAMPOS_MESCLADOS = "number,title,url,headRefName,mergedAt";
let CACHE = null; // { em, dados }
const TTL = 30000;

/** Os PRs abertos (e os 8 últimos mesclados) de cada projeto da seleção. Projeto sem GitHub aparece dizendo isso. */
export async function listarPrs({ fresco = false } = {}) {
  if (!fresco && CACHE && Date.now() - CACHE.em < TTL) return CACHE.dados;
  const projetos = projetosVisiveis().filter((p) => p.slug !== "DEV");
  const porProjeto = await Promise.all(projetos.map(async (p) => {
    const repo = repoDoProjeto(p.dir);
    if (!repo) return { slug: p.slug, label: p.label, repo: null, erro: "sem repositório no GitHub (nasce na 1ª tarefa entregue por PR)", abertos: [], mesclados: [] };
    const [a, m] = await Promise.all([
      gh(["pr", "list", "-R", repo, "--state", "open", "--limit", "50", "--json", CAMPOS_ABERTOS]),
      gh(["pr", "list", "-R", repo, "--state", "merged", "--limit", "8", "--json", CAMPOS_MESCLADOS]),
    ]);
    if (!a.ok) return { slug: p.slug, label: p.label, repo, erro: "não consegui ler os PRs: " + a.err, abertos: [], mesclados: [] };
    let abertos = [], mesclados = [];
    try { abertos = JSON.parse(a.out || "[]"); } catch { /* gh respondeu outra coisa */ }
    try { mesclados = m.ok ? JSON.parse(m.out || "[]") : []; } catch { mesclados = []; }
    return {
      slug: p.slug, label: p.label, repo, erro: null,
      abertos: abertos.map((pr) => ({
        numero: pr.number, titulo: pr.title, url: pr.url, branch: pr.headRefName, autor: pr.author?.login || "",
        criadoEm: pr.createdAt, atualizadoEm: pr.updatedAt, rascunho: !!pr.isDraft,
        conflito: pr.mergeable === "CONFLICTING", mesclavel: pr.mergeable, revisao: pr.reviewDecision || "",
        checks: resumoChecks(pr.statusCheckRollup), checksFalhos: checksQueFalharam(pr.statusCheckRollup), tarefa: tarefaDoPr(pr.url),
      })),
      mesclados: mesclados.map((pr) => ({ numero: pr.number, titulo: pr.title, url: pr.url, branch: pr.headRefName, mescladoEm: pr.mergedAt, tarefa: tarefaDoPr(pr.url) })),
    };
  }));
  const dados = { lidoEm: now(), projetos: porProjeto };
  CACHE = { em: Date.now(), dados };
  return dados;
}

/**
 * O dono clicou "Mesclar". Só PR ABERTO de um projeto da seleção (nada de URL qualquer vinda da tela).
 * ⚠️ A trava da #188: o PR #112 foi mesclado com o board ainda conferindo, e o conserto ficou fora da main.
 * Tarefa ligada conferindo ou reprovada → 409 com o motivo; só passa com `forcar` (o dono confirmou de novo).
 * Só mescla (squash + apaga a branch, como o "Mesclar e publicar"); publicar continua à parte.
 */
export async function mesclarPr({ url, forcar = false } = {}) {
  const falha = (status, msg, extra = {}) => Object.assign(new Error(msg), { status, ...extra });
  const dados = await listarPrs({ fresco: true });
  const achado = dados.projetos.flatMap((p) => p.abertos.map((pr) => ({ ...pr, projeto: p }))).find((pr) => pr.url === url);
  if (!achado) throw falha(404, "esse PR não está aberto em nenhum projeto da seleção");
  if (achado.rascunho) throw falha(409, "o PR ainda é rascunho (draft) — marque como pronto no GitHub antes");
  if (achado.conflito) throw falha(409, "o PR tem conflito com a main — precisa resolver antes de mesclar");
  const t = achado.tarefa;
  if (t && (t.conferindo || t.reprovado) && !forcar)
    throw falha(409, t.conferindo
      ? `a tarefa #${t.id} ainda está sendo conferida (portão/revisor/QA) — mesclar agora pode deixar o conserto de fora, como na #188`
      : `a conferência da tarefa #${t.id} REPROVOU (revisor: ${t.revisor || "—"} · QA: ${t.qa || "—"})`, { precisaConfirmar: true });
  const r = await gh(["pr", "merge", url, "--squash", "--delete-branch"], 120000);
  if (!r.ok) throw falha(502, "o GitHub recusou o merge: " + r.err);
  if (t) {
    const task = state.tasks.find((x) => x.id === t.id);
    if (task) { task.merged = { em: now(), url, pelaTela: true }; task.updatedAt = now(); }
    logEvent(t.id, { t: "solto", texto: `🔀 PR mesclado pelo dono no menu Pull Requests: ${url}${forcar ? " (confirmou passando por cima da conferência)" : ""}` });
    save();
  }
  CACHE = null;
  broadcast("prs");
  return { ok: true, url, projeto: achado.projeto.slug, tarefa: t?.id || null };
}
