// A volta do ⚡: o trabalho aprovado na cópia entra na pasta principal — direto, ou por três vias com o portão rodando antes;
// conflito volta para o próprio agente resolver na cópia, e trabalho já aplicado à mão na pasta encerra o conflito sozinho.
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { createHash } from "crypto";
import { AGENTES_DIR, JUNTAR_CONFERIR_MS, JUNTAR_TENTATIVAS, cut, now } from "./config.mjs";
import { broadcast, logEvent, save } from "./estado.mjs";
import { SEM_NODE_MODULES, arvoreDaPasta, commitSolto, fotografarPasta, git, ligarNodeModules, projetoBase } from "./projetos.mjs";
import { gateCommand, runGate } from "./esteira.mjs";

/** Tarefas com junção em andamento (o portão do resultado leva minutos). Em memória: reinício só sai com ela vazia. */
export const JUNTANDO = new Set();

const sha = (buf) => (buf === null ? null : createHash("sha1").update(buf).digest("hex"));
const iguais = (a, b) => (a === null || b === null ? a === b : a.equals(b));
const binario = (buf) => buf !== null && buf.subarray(0, 8000).includes(0);

/** O arquivo como está na pasta principal (null = não existe). Pasta ou link não entram na mescla. */
function lerNaPasta(dir, caminho) {
  const arq = join(dir, caminho);
  let st; try { st = lstatSync(arq); } catch { return { buf: null }; }
  if (!st.isFile()) return { buf: null, estranho: st.isSymbolicLink() ? "link" : "pasta" };
  return { buf: readFileSync(arq) };
}
const blob = (dir, arvore, caminho) => git(dir, ["cat-file", "blob", `${arvore}:${caminho}`], { encoding: "buffer" });
const blobOuNada = (dir, arvore, caminho) => { try { return blob(dir, arvore, caminho); } catch { return null; } };
const ESPECIAL = ["120000", "160000"]; // link e submódulo: não entram na mescla
const MARCADOR = /^(<<<<<<< pasta principal|>>>>>>> cópia #)/m;

/** O trabalho da cópia como árvore git (o índice da cópia é dela: pode mexer). */
function arvoreDaCopia(wt) {
  git(wt.dir, ["add", "-A", ...SEM_NODE_MODULES]);
  return git(wt.dir, ["write-tree"]).trim();
}


/** O que mudou na cópia entre a última junção e agora: [{caminho, modo, status}] (sem renomeação: vira apaga + cria). */
function mudancas(dir, de, para) {
  const raw = git(dir, ["diff-tree", "-r", "-z", "--no-renames", "--raw", de, para]);
  const partes = raw.split("\0"); const out = [];
  for (let i = 0; i + 1 < partes.length; i += 2) {
    const m = partes[i].match(/^:(\d+) (\d+) \S+ \S+ (\w)/);
    if (m) out.push({ modoAntes: m[1], modo: m[2], status: m[3], caminho: partes[i + 1] });
  }
  return out;
}

/**
 * A mescla de três vias, arquivo por arquivo. base = a árvore da última junção (na 1ª, o ponto de onde a cópia
 * partiu), "pasta" = o arquivo no disco da pasta principal agora, "cópia" = o que o agente deixou.
 * Devolve {resultado: [{caminho, conteudo|null, modo, antes}], conflitos: [caminho], iguaisNaPasta: [caminho]}. Não escreve nada.
 */
function mesclar(task, pasta) {
  const wt = task.worktree, resultado = [], conflitos = [], iguaisNaPasta = [];
  for (const m of mudancas(wt.dir, wt.aplicado, wt.arvoreNova)) {
    const { caminho } = m;
    if (ESPECIAL.includes(m.modo) || ESPECIAL.includes(m.modoAntes)) { conflitos.push(caminho); continue; }
    const base = m.status === "A" ? null : blob(wt.dir, wt.aplicado, caminho);
    const delas = m.status === "D" ? null : blob(wt.dir, wt.arvoreNova, caminho);
    const nossa = lerNaPasta(pasta, caminho);
    if (nossa.estranho) { conflitos.push(caminho); continue; }
    const aqui = nossa.buf, antes = sha(aqui);
    if (iguais(aqui, delas)) { iguaisNaPasta.push(caminho); continue; } // a pasta já tem isso (arquivo novo idêntico inclusive)
    if (iguais(aqui, base)) { resultado.push({ caminho, conteudo: delas, modo: m.modo, antes }); continue; } // só a cópia mexeu
    if (aqui === null || base === null || delas === null || binario(aqui) || binario(base) || binario(delas)) { conflitos.push(caminho); continue; }
    const tmp = mkdtempSync(join(tmpdir(), "board-tresvias-"));
    try {
      const [a, b, c] = ["pasta", "base", "copia"].map((n) => join(tmp, n));
      writeFileSync(a, aqui); writeFileSync(b, base); writeFileSync(c, delas);
      const r = spawnSync("git", ["merge-file", "-p", a, b, c], { maxBuffer: 64 << 20 });
      if (r.status === 0) resultado.push({ caminho, conteudo: r.stdout, modo: m.modo, antes, mesclado: true });
      else conflitos.push(caminho);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
  return { resultado, conflitos, iguaisNaPasta };
}

function escrever(dir, itens) {
  for (const it of itens) {
    const arq = join(dir, it.caminho);
    if (it.conteudo === null) { try { unlinkSync(arq); } catch { /* já não existe */ } continue; }
    const novo = !existsSync(arq);
    mkdirSync(dirname(arq), { recursive: true });
    writeFileSync(arq, it.conteudo);
    if (novo && it.modo === "100755") chmodSync(arq, 0o755);
  }
}

/**
 * O portão no RESULTADO, antes de tocar na pasta: uma cópia temporária com o estado atual da pasta principal
 * (o que está sem commit e os arquivos novos inclusive) + os arquivos mesclados. Sem portão no projeto, vale a mescla limpa.
 */
async function portaoNoResultado(task, p, itens) {
  const comando = gateCommand(p);
  if (!comando) return { ok: true, comando: "" };
  // A pasta INTEIRA, arquivos novos sem commit inclusive: com `git stash create` eles ficavam de fora e o portão quebrava
  // por falta deles (27/10: `servidor/publicar.mjs` da #205 → ERR_MODULE_NOT_FOUND → conflito falso na junção).
  const base = fotografarPasta(p.dir);
  const dir = join(AGENTES_DIR, `${p.slug}-${task.id}-juntando`);
  mkdirSync(AGENTES_DIR, { recursive: true });
  if (existsSync(dir)) { try { git(p.dir, ["worktree", "remove", "--force", dir]); } catch { rmSync(dir, { recursive: true, force: true }); } }
  git(p.dir, ["worktree", "add", "--detach", dir, base]);
  try {
    escrever(dir, itens);
    ligarNodeModules(p.dir, dir);
    const g = await runGate(task, { ...p, dir }, comando);
    return { ...g, comando };
  } finally {
    try { git(p.dir, ["worktree", "remove", "--force", dir]); } catch { rmSync(dir, { recursive: true, force: true }); try { git(p.dir, ["worktree", "prune"]); } catch { /* fica pro próximo */ } }
  }
}

function naoJuntou(task, motivo, extra = {}) {
  const wt = task.worktree;
  wt.juntar = "conflito";
  wt.conflito = { em: now(), motivo, ...extra };
  logEvent(task.id, { t: "solto", texto: `⚠ não deu para juntar na pasta principal — ${motivo}. Nada foi aplicado; o trabalho continua na cópia ${wt.dir}.`
    + (extra.arquivos?.length ? ` Arquivos: ${extra.arquivos.slice(0, 12).join(", ")}${extra.arquivos.length > 12 ? "…" : ""}.` : "")
    + (extra.erro ? ` ${extra.erro}` : "") + (extra.esgotou ? ` O agente já tentou resolver ${extra.esgotou}x sozinho — precisa de você.` : "") });
}

function juntou(task, arvore, texto) {
  const wt = task.worktree;
  wt.aplicado = arvore; wt.juntar = "ok"; wt.erroJuntar = null; wt.conflito = null; wt.consertosJuntar = 0; wt.marcados = [];
  logEvent(task.id, { t: "solto", texto });
}

/**
 * Prepara a cópia para o agente resolver o conflito: ela passa a ter o estado ATUAL da pasta principal (HEAD da cópia =
 * esse estado, num commit solto — `git diff` mostra só o trabalho do agente) e o trabalho dele por cima, mesclado por
 * três vias. Onde os dois lados mexeram no mesmo trecho ficam os marcadores; onde não dá para mesclar (binário, apagou ×
 * mudou), fica a versão da cópia e a da pasta está em `git show HEAD:<arquivo>`. `wt.aplicado` vira a árvore da pasta:
 * a próxima junção leva só o que o agente mudou EM CIMA dela.
 */
function trazerPastaParaCopia(task, p, arvore) {
  const wt = task.worktree, nome = `cópia #${task.agente || "agente"}`;
  const arvorePasta = arvoreDaPasta(p.dir);
  const ms = mudancas(wt.dir, wt.aplicado, arvore);
  git(wt.dir, ["read-tree", "--reset", "-u", arvorePasta]);
  const commit = commitSolto(wt.dir, arvorePasta, `board: estado da pasta principal (junção da #${task.id})`);
  git(wt.dir, ["reset", "-q", "--soft", commit]);
  const marcados = [], decidir = [];
  for (const m of ms) {
    const { caminho } = m;
    if (ESPECIAL.includes(m.modo) || ESPECIAL.includes(m.modoAntes)) { decidir.push(`${caminho} (link/submódulo: ficou a versão da pasta)`); continue; }
    const base = m.status === "A" ? null : blobOuNada(wt.dir, wt.aplicado, caminho);
    const delas = m.status === "D" ? null : blobOuNada(wt.dir, arvore, caminho);
    const aqui = blobOuNada(wt.dir, arvorePasta, caminho);
    if (iguais(aqui, delas)) continue;                                                     // a pasta já tem isso
    if (iguais(aqui, base)) { escrever(wt.dir, [{ caminho, conteudo: delas, modo: m.modo }]); continue; } // só a cópia mexeu
    if (aqui === null || delas === null || binario(aqui) || binario(delas) || binario(base)) {
      escrever(wt.dir, [{ caminho, conteudo: delas, modo: m.modo }]);
      decidir.push(`${caminho} (${aqui === null ? "a pasta apagou, a cópia mudou" : delas === null ? "a cópia apagou, a pasta mudou" : "binário mudou dos dois lados"})`);
      continue;
    }
    const tmp = mkdtempSync(join(tmpdir(), "board-tresvias-"));
    try {
      const [a, b, c] = ["pasta", "base", "copia"].map((n) => join(tmp, n));
      writeFileSync(a, aqui); writeFileSync(b, base || ""); writeFileSync(c, delas);
      const r = spawnSync("git", ["merge-file", "-p", "-L", "pasta principal", "-L", "base", "-L", nome, a, b, c], { maxBuffer: 64 << 20 });
      if (r.error || r.status === null || r.status > 127) throw new Error(`git merge-file falhou em ${caminho}`);
      escrever(wt.dir, [{ caminho, conteudo: r.stdout, modo: m.modo }]);
      if (r.status > 0) marcados.push(caminho);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
  wt.aplicado = arvorePasta;
  return { marcados, decidir };
}

/** O pedido da rodada de conserto: o que aconteceu, o que o board fez na cópia e o que o agente tem de fazer. */
function pedidoDeConserto(task, motivo, extra, { marcados, decidir }, n) {
  const linhas = [
    `A JUNÇÃO do seu trabalho na pasta principal deu conflito: ${motivo}. Nada entrou na pasta. Em vez de parar no dono, o board devolveu a tarefa para você resolver (tentativa ${n} de ${JUNTAR_TENTATIVAS}).`,
    "",
    "O board trouxe para a SUA CÓPIA o estado ATUAL da pasta principal (inclusive o que está sem commit lá: trabalho do dono ou de outra tarefa) e reaplicou o seu trabalho por cima. O HEAD da cópia agora é esse estado da pasta, então `git diff` mostra só o seu trabalho; a versão da pasta de qualquer arquivo está em `git show HEAD:<arquivo>`.",
  ];
  if (marcados.length) linhas.push("", `Arquivos com MARCADORES de conflito (<<<<<<< pasta principal … >>>>>>> cópia #${task.agente}): ${marcados.join(", ")}.`);
  if (decidir.length) linhas.push("", `Arquivos que mudaram dos dois lados sem mescla possível — ficou a SUA versão; compare com a da pasta e decida: ${decidir.join("; ")}.`);
  if (extra.portao) linhas.push("", "A mescla saiu limpa, mas o PORTÃO do projeto falhou no resultado (a cópia já está com esse resultado):", "", "$ " + extra.portao.comando, String(extra.portao.saida || "").slice(-4000));
  linhas.push("", "Resolva mantendo as DUAS mudanças: a da pasta não é sua — não a descarte nem desfaça. Tire todos os marcadores, rode a verificação do projeto e responda o que fez. Não faça commit: quando a conferência aprovar, o board junta de novo.");
  if (!task.sessionId) linhas.unshift(`Tarefa #${task.id} do board:`, task.text, "", "---", "");
  return linhas.join("\n");
}

/**
 * Conflito na junção (pedido do dono em 27/10: "quando acontecer isso, resolva automaticamente"): o PRÓPRIO agente
 * resolve, na cópia, com a pasta atual trazida para ela — e a esteira (portão → revisor → QA) roda de novo antes de
 * outra junção. Até BOARD_JUNTAR_TENTATIVAS vezes; esgotou (ou a tarefa não está mais "executada"), aí sim "não juntada".
 */
function conflitoNaJuntada(task, p, arvore, motivo, extra = {}) {
  const wt = task.worktree, n = (wt.consertosJuntar || 0) + 1;
  if (task.status !== "executada" || n > JUNTAR_TENTATIVAS) {
    return naoJuntou(task, motivo, { ...extra, ...(n > 1 ? { esgotou: n - 1 } : {}) });
  }
  let preparo;
  try { preparo = trazerPastaParaCopia(task, p, arvore); }
  catch (e) { return naoJuntou(task, motivo, { ...extra, erro: "e não consegui trazer a pasta para a cópia: " + cut(String(e.stderr || e.message), 300) }); }
  preparo.marcados = [...new Set([...preparo.marcados, ...(extra.marcadores || [])])];
  wt.marcados = preparo.marcados; // a próxima junção confere que o agente tirou os marcadores
  wt.consertosJuntar = n; wt.juntar = "consertando"; wt.conflito = null;
  task.consertoJuntar = { em: now(), motivo, arquivos: extra.arquivos || [], marcados: preparo.marcados, decidir: preparo.decidir, n, max: JUNTAR_TENTATIVAS,
    pedido: pedidoDeConserto(task, motivo, extra, preparo, n) };
  task.status = "fila"; task.retomar = false; task.retentativa = null; task.updatedAt = now();
  logEvent(task.id, { t: "solto", texto: `⇄ a junção deu conflito (${motivo}${extra.arquivos?.length ? `: ${extra.arquivos.slice(0, 8).join(", ")}` : ""}). O board trouxe o estado atual da pasta para a cópia e devolveu a tarefa a #${task.agente} para resolver (tentativa ${n} de ${JUNTAR_TENTATIVAS}); depois, portão, revisor e QA de novo e nova junção.` });
}

/**
 * O trabalho da cópia já está na pasta? (o dono — ou outra sessão — aplicou à mão.) Todo arquivo que a cópia mudou desde
 * a última junção está IGUAL na pasta. Só lê; devolve a árvore da cópia para quem for marcar como juntada.
 */
export function jaEstaNaPasta(task) {
  const wt = task.worktree, p = projetoBase(task);
  const arvore = arvoreDaCopia(wt);
  for (const m of mudancas(wt.dir, wt.aplicado, arvore)) {
    if (ESPECIAL.includes(m.modo)) return null;
    const nossa = lerNaPasta(p.dir, m.caminho);
    if (nossa.estranho || !iguais(nossa.buf, m.status === "D" ? null : blob(wt.dir, arvore, m.caminho))) return null;
  }
  return arvore;
}

const CONFERIDA = new Map(); // id → última vez que o runner olhou se a "não juntada" já está na pasta
/** Chamado pelo runner: "não juntada" cujo trabalho já apareceu na pasta deixa de ser conflito sozinha (sem o botão). */
export function conferirNaoJuntadas(tasks, { cadaMs = JUNTAR_CONFERIR_MS } = {}) {
  const agora = Date.now();
  for (const t of tasks) {
    const wt = t.worktree;
    if (wt?.juntar !== "conflito" || wt.removida || wt.producao || JUNTANDO.has(t.id) || t.status === "rodando" || t.busy) continue;
    if (agora - (CONFERIDA.get(t.id) || 0) < cadaMs || !existsSync(wt.dir)) continue;
    CONFERIDA.set(t.id, agora);
    let arvore = null;
    try { arvore = jaEstaNaPasta(t); } catch { /* lê na próxima volta */ }
    if (!arvore) continue;
    juntou(t, arvore, "⇲ o trabalho da cópia já está na pasta principal (aplicado à mão) — o conflito se resolveu sozinho, sem precisar do botão");
    save(); broadcast("state");
  }
}

/**
 * Traz o trabalho da cópia para a pasta principal, como se o agente tivesse trabalhado lá (sem commit — igual ao
 * modo "direto"). 1º `git apply` (tudo-ou-nada). Recusou? Mescla de três vias arquivo por arquivo e o PORTÃO roda no
 * resultado numa cópia temporária; só com mescla limpa e portão verde os arquivos entram na pasta. Arquivo que a pasta
 * já tem IGUAL não é conflito (a #205: arquivos novos da #203 sem commit); tudo já igual = juntada, sem portão. Conflito
 * (ou portão vermelho no resultado) volta para o agente resolver na cópia (`conflitoNaJuntada`); só esgotadas as
 * tentativas a tarefa vira "não juntada — conflito" (26/10: a #200 ficou na cópia marcada como executada).
 * Incremental: só o que mudou desde a última junção. `livre()` é conferido de novo antes de escrever.
 */
export async function juntarNaPasta(task, { livre = () => true } = {}) {
  const wt = task.worktree, p = projetoBase(task);
  if (!wt || wt.producao || !existsSync(wt.dir) || JUNTANDO.has(task.id)) return;
  let patch = "", arvore = "", erro = "";
  try {
    arvore = arvoreDaCopia(wt);
    if (arvore !== wt.aplicado) patch = git(wt.dir, ["diff-tree", "-p", "--binary", "-r", wt.aplicado, arvore]);
  } catch (e) { patch = null; erro = cut(String(e.stderr || e.message), 300); }
  if (patch === "") { wt.juntar = "ok"; wt.conflito = null; wt.consertosJuntar = 0; save(); broadcast("state"); return; }
  if (patch === null) { naoJuntou(task, "não consegui ler o trabalho da cópia", { erro }); save(); broadcast("state"); return; }
  // Marcador que o board pôs na cópia (conserto da junção) e o agente não tirou NUNCA vai para a pasta do dono.
  const comMarcador = (wt.marcados || []).filter((c) => MARCADOR.test(String(blobOuNada(wt.dir, arvore, c) || "")));
  if (comMarcador.length) {
    conflitoNaJuntada(task, p, arvore, "ficaram marcadores de conflito na cópia", { arquivos: comMarcador, marcadores: comMarcador });
    save(); broadcast("state"); return;
  }
  const arq = join(tmpdir(), `board-juntar-${task.id}-${Date.now()}.patch`);
  writeFileSync(arq, patch);
  let ok = false;
  try { git(p.dir, ["apply", "--binary", "--whitespace=nowarn", arq]); ok = true; }
  catch (e) { erro = cut(String(e.stderr || e.message), 300); }
  try { unlinkSync(arq); } catch { /* tmp */ }
  if (ok) {
    juntou(task, arvore, `⇲ #${task.agente} juntou o trabalho na pasta principal (${p.dir})`);
    save(); broadcast("state"); return;
  }

  // A junção simples recusou: três vias, arquivo por arquivo.
  JUNTANDO.add(task.id);
  try {
    wt.arvoreNova = arvore;
    const { resultado, conflitos, iguaisNaPasta } = mesclar(task, p.dir);
    if (conflitos.length) { conflitoNaJuntada(task, p, arvore, "os mesmos trechos mudaram na pasta e na cópia", { arquivos: conflitos }); return; }
    const jaIguais = iguaisNaPasta.length ? `${iguaisNaPasta.length} arquivo(s) já estavam IGUAIS na pasta (aceitos: ${iguaisNaPasta.slice(0, 8).join(", ")}${iguaisNaPasta.length > 8 ? "…" : ""})` : "";
    if (!resultado.length) {
      juntou(task, arvore, `⇲ o trabalho da cópia já estava na pasta principal — ${jaIguais || "nada a aplicar"}; junção concluída sem mexer na pasta`);
      return;
    }
    const mesclados = resultado.filter((r) => r.mesclado).length;
    logEvent(task.id, { t: "solto", texto: `⇄ a junção simples recusou (a pasta mudou desde que a cópia partiu); a de três vias mesclou ${resultado.length} arquivo(s)${mesclados ? `, ${mesclados} com mudança dos dois lados` : ""}${jaIguais ? `; ${jaIguais}` : ""} — rodando o portão no resultado antes de pôr na pasta` });
    broadcast("state");
    const g = await portaoNoResultado(task, p, resultado);
    if (!g.ok) {
      const extra = { arquivos: resultado.map((r) => r.caminho), portao: { comando: g.comando, saida: cut(g.saida || "", 2000) } };
      // Portão cortado por tempo não é defeito para o agente consertar.
      if (g.estourou) naoJuntou(task, "o portão no resultado da mescla passou do tempo", extra);
      else conflitoNaJuntada(task, p, arvore, "a mescla saiu limpa, mas o portão ficou vermelho no resultado", extra);
      return;
    }
    // Entre a mescla e agora (o portão leva minutos) a pasta pode ter mudado ou ganhado um agente: tenta na próxima volta.
    const mudou = resultado.some((r) => sha(lerNaPasta(p.dir, r.caminho).buf) !== r.antes);
    if (mudou || !livre()) { logEvent(task.id, { t: "solto", texto: "⇲ a pasta principal mudou (ou ficou ocupada) enquanto o portão rodava — a junção tenta de novo" }); return; }
    escrever(p.dir, resultado);
    juntou(task, arvore, `⇲ #${task.agente} juntou por três vias na pasta principal (${p.dir}): ${resultado.length} arquivo(s)${g.comando ? `, portão verde no resultado (${g.comando})` : ", projeto sem portão"}`);
  } catch (e) {
    naoJuntou(task, "a junção de três vias falhou", { erro: cut(String(e.stderr || e.message), 300) });
  } finally {
    delete wt.arvoreNova;
    JUNTANDO.delete(task.id);
    save(); broadcast("state");
  }
}

/** O dono resolveu na pasta (ou quer tentar de novo): a junção volta para a fila do runner. */
export function tentarJuntarDeNovo(task) {
  const wt = task.worktree;
  if (!wt || wt.producao || wt.removida || !existsSync(wt.dir)) throw Object.assign(new Error("esta tarefa não tem cópia para juntar"), { status: 400 });
  if (wt.juntar !== "conflito") throw Object.assign(new Error("a junção desta tarefa não está em conflito"), { status: 409 });
  wt.juntar = "pendente"; wt.conflito = null; wt.consertosJuntar = 0; // pedido do dono: o agente ganha as tentativas de novo
  logEvent(task.id, { t: "solto", texto: "⇲ o dono pediu para tentar juntar de novo" });
  save(); broadcast("state");
}
