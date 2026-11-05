// 🖥→💬 Trazer uma sessão do terminal para a Conversa do projeto (#234, 28/10/2026). Pedido do dono: "não quero terminal
// nenhum rodando, nem tmux escondido". A sessão que ele abriu no terminal (erp, crm, robo…) passa a ser o fio da Conversa
// do projeto da pasta dela: o processo vivo do board (`claude -p --resume <sessionId>`) continua a MESMA conversa — o
// histórico mora no transcrito do CLI (~/.claude/projects/*/<sessionId>.jsonl), sem handoff escrito.
// Provado antes de codar: `claude -p --resume <id>` rodado de OUTRA pasta achou o transcrito e manteve o session_id.
// Travas: só depois que a cópia do terminal SAIU (duas cópias da mesma sessão se atropelam; o board nunca mata a de
// fora), e o fio que a Conversa já tem só é trocado com o dono confirmando — e mesmo assim vai para o arquivo, não some.
import { execFileSync } from "child_process";
import { closeSync, fstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { DATA, cut, now } from "./config.mjs";
import { broadcast, logEvent, logPath, readLog, save } from "./estado.mjs";
import { listProjects, projetosVisiveis, rotuloDoProjeto, tornarVisivel } from "./projetos.mjs";
import { conversaDe, conversaId, matarVivo, naVez, sessoesDe } from "./conversa.mjs";

const VISTAS_FILE = () => join(DATA, "sessoes-vistas.json");
const LEMBRAR_MS = () => Number(process.env.BOARD_SESSOES_LEMBRAR_DIAS || 7) * 86400000;
const IMPORTAR = () => Math.max(0, Math.min(Number(process.env.BOARD_SESSOES_IMPORTAR ?? 100), 1000)); // mensagens trazidas para a tela
const CAUDA = 8 * 1024 * 1024; // o transcrito do ERP passa de 100 MB: as últimas mensagens moram no fim

const falha = (status, msg, extra = {}) => Object.assign(new Error(msg), { status, extra });

// ── a memória das sessões vistas ─────────────────────────────────────────────
// O CLI apaga ~/.claude/sessions/<pid>.json quando a sessão sai. Sem lembrar dela, o /exit que o dono dá para poder
// trazer a sessão a faria sumir da lista — e o botão junto. O board guarda o que viu: sessionId → {pid, nome, cwd, vista}.
function lerVistas() { try { return JSON.parse(readFileSync(VISTAS_FILE(), "utf8")); } catch { return {}; } }
function gravarVistas(v) { writeFileSync(VISTAS_FILE(), JSON.stringify(v, null, 1) + "\n"); }

/** Anota as sessões vivas do registro (chamado a cada leitura da lista e por uma vigia de fundo). */
export function lembrarSessoes(reg) {
  const v = lerVistas(); let mudou = false;
  const t = now();
  for (const j of reg) {
    const atual = v[j.sessionId] || {};
    const novo = { ...atual, pid: j.pid, nome: j.name || pastaNaTela(j.cwd) || String(j.pid), nomeDado: !!j.name, cwd: j.cwd || "", vista: t };
    // Reaberta no terminal depois de trazida: as duas cópias existem de novo, e a lista avisa.
    if (atual.trazida && atual.pid !== j.pid) novo.reaberta = true;
    if (!atual.vista || atual.pid !== j.pid || atual.nome !== novo.nome || Date.parse(t) - Date.parse(atual.vista) > 60000) { v[j.sessionId] = novo; mudou = true; }
  }
  // A hora em que saiu (#345): anotada na 1ª leitura sem ela no registro. Com o board fora do ar no meio, a última vez
  // vista viva é o que se sabe (dita como "saiu por volta de"), nunca a hora em que o board voltou.
  const vivos = new Set(reg.map((j) => j.sessionId));
  for (const [sid, x] of Object.entries(v)) {
    if (vivos.has(sid)) { if (x.saiu) { delete x.saiu; mudou = true; } continue; }
    if (!x.saiu) { x.saiu = x.vista && Date.parse(t) - Date.parse(x.vista) < 120000 ? t : (x.vista || t); mudou = true; }
  }
  for (const [sid, x] of Object.entries(v)) if (Date.now() - Date.parse(x.trazida?.em || x.saiu || x.vista || 0) > LEMBRAR_MS()) { delete v[sid]; mudou = true; }
  if (mudou) gravarVistas(v);
  return v;
}

// ── onde está o histórico ────────────────────────────────────────────────────
/** O transcrito do CLI da sessão: ~/.claude/projects/<qualquer pasta>/<sessionId>.jsonl (o mais recente, se houver dois). */
export function transcritoDe(sessionId) {
  if (!/^[\w-]{8,80}$/.test(String(sessionId || ""))) return null;
  const raiz = join(process.env.HOME || "", ".claude", "projects");
  let dirs = []; try { dirs = readdirSync(raiz); } catch { return null; }
  let melhor = null;
  for (const d of dirs) {
    const f = join(raiz, d, sessionId + ".jsonl");
    try { const s = statSync(f); if (s.isFile() && (!melhor || s.mtimeMs > melhor.m)) melhor = { f, m: s.mtimeMs }; } catch { /* não está aqui */ }
  }
  return melhor?.f || null;
}

const ruido = (t) => /^\s*<(command-|local-command|system-reminder|bash-|task-notification|user-prompt-submit-hook)/.test(t) || /^\s*\[Request interrupted/.test(t) || /^Caveat: /.test(t);
const textoDe = (content) => typeof content === "string" ? content
  : Array.isArray(content) ? content.filter((p) => p?.type === "text" && p.text).map((p) => p.text).join("\n") : "";

/**
 * As últimas mensagens do transcrito, como a Conversa mostra: o que o dono escreveu e o que o agente respondeu em texto
 * (as falas de um turno viram uma resposta). Ferramentas, subagentes, lembretes do sistema e comandos ficam de fora.
 */
export function historicoDoTranscrito(arquivo, max = IMPORTAR()) {
  const fd = openSync(arquivo, "r");
  let txt;
  try {
    const tam = fstatSync(fd).size, ini = Math.max(0, tam - CAUDA);
    const buf = Buffer.alloc(tam - ini); readSync(fd, buf, 0, buf.length, ini);
    txt = buf.toString("utf8"); if (ini) txt = txt.slice(txt.indexOf("\n") + 1); // a 1ª linha da cauda vem cortada
  } finally { closeSync(fd); }
  const msgs = [];
  for (const l of txt.split("\n")) {
    if (!l.trim()) continue;
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (j.isSidechain || j.isMeta || !j.message) continue;
    const t = textoDe(j.message.content).trim();
    if (!t) continue;
    if (j.type === "user") { if (!ruido(t)) msgs.push({ t: "dono", texto: t }); }
    else if (j.type === "assistant") {
      const ult = msgs.at(-1);
      if (ult?.t === "resultado") ult.texto += "\n\n" + t; else msgs.push({ t: "resultado", texto: t });
    }
  }
  const total = msgs.length;
  // Corta sem o `cut`: ele junta os espaços numa linha só, e a resposta é markdown (parágrafos, listas, tabelas).
  const corta = (t) => (t.length > 8000 ? t.slice(0, 7999) + "…" : t);
  return { total, msgs: msgs.slice(-max).map((m) => ({ ...m, texto: corta(m.texto) })) };
}

// ── conferências ─────────────────────────────────────────────────────────────
const real = (d) => { try { return realpathSync(d); } catch { return d; } };
/** O projeto do board cuja pasta é a pasta da sessão (exata: o transcrito e as regras do projeto são dela). */
export function projetoDaPasta(cwd) {
  if (!cwd) return null;
  const alvo = real(cwd);
  const p = listProjects().find((x) => real(x.dir) === alvo);
  if (!p) return null;
  const vis = projetosVisiveis().find((x) => x.slug === p.slug);
  return { slug: p.slug, label: vis?.label || rotuloDoProjeto(p.slug), visivel: !!vis };
}
/** A pasta de uma sessão NA TELA (#249): o rótulo do projeto ("CRM"), nunca o slug da pasta; fora de projeto, o nome dela. */
export const pastaNaTela = (cwd) => cwd ? projetoDaPasta(cwd)?.label || basename(cwd) : "";

/** A cópia do terminal ainda está aberta? Registro vivo com o mesmo sessionId, ou o pid dela ainda é um claude. */
function aberta(sessionId, v, reg) {
  const r = reg.find((j) => j.sessionId === sessionId);
  if (r) return r.pid;
  if (Number.isInteger(v?.pid)) {
    // pid reaproveitado (reinício da máquina) por OUTRA sessão do registro: não é esta (#345: a robo de hoje com o pid de uma antiga).
    if (reg.some((j) => j.pid === v.pid && j.sessionId !== sessionId)) return 0;
    try { process.kill(v.pid, 0); } catch { return 0; }
    try { if (/claude/i.test(execFileSync("ps", ["-o", "command=", "-p", String(v.pid)], { encoding: "utf8" }))) return v.pid; } catch { /* saiu agora */ }
  }
  return 0;
}

/** Para a lista do menu: as que saíram do terminal e podem vir, e as que já vieram (com o link da Conversa). */
export function sessoesParaConversa(reg) {
  const v = lembrarSessoes(reg);
  const vivos = new Set(reg.map((j) => j.sessionId));
  const encerradas = [], trazidas = [];
  for (const [sessionId, x] of Object.entries(v)) {
    if (x.trazida) {
      if (!vivos.has(sessionId)) trazidas.push({ sessionId, nome: x.nome, slug: x.trazida.slug, label: x.trazida.label || x.trazida.slug, em: x.trazida.em });
      continue;
    }
    if (vivos.has(sessionId)) continue;
    encerradas.push({ sessionId, nome: x.nome, nomeDado: !!x.nomeDado, cwd: x.cwd, pasta: pastaNaTela(x.cwd), pid: x.pid, vista: x.vista,
      saiu: x.saiu || x.vista || null, historico: !!transcritoDe(sessionId), projeto: projetoDaPasta(x.cwd) });
  }
  // #345: a robo roda num laço que sobe um claude NOVO (sessionId novo) a cada saída — sem isto, uma aba "saiu" por
  // reinício. Mesmo nome e pasta = a mesma sessão para o dono: com uma viva, as que saíram vão todas para "anteriores";
  // sem viva, fica à vista só a que saiu por último.
  const chave = (x) => `${x.nome}\u0000${x.cwd || ""}`;
  const comViva = new Set(reg.map((j) => chave({ nome: j.name || pastaNaTela(j.cwd) || String(j.pid), cwd: j.cwd })));
  encerradas.sort((a, b) => String(b.saiu || "").localeCompare(String(a.saiu || "")));
  const vistas = [], anteriores = [], ja = new Set();
  for (const e of encerradas) {
    const k = chave(e);
    if (comViva.has(k) || ja.has(k)) anteriores.push({ ...e, anterior: comViva.has(k) ? "viva" : "recente" });
    else { ja.add(k); vistas.push(e); }
  }
  vistas.sort((a, b) => a.nome.localeCompare(b.nome));
  trazidas.sort((a, b) => String(b.em).localeCompare(String(a.em)));
  return { encerradas: vistas, anteriores, trazidas, reaberta: Object.entries(v).filter(([sid, x]) => x.trazida && vivos.has(sid)).map(([sid]) => sid) };
}

/**
 * 🧹 Esquecer as que saíram (#345, só pela tela): tira de data/sessoes-vistas.json as sessões que não estão vivas.
 * Não toca em sessão viva (registro ou pid ainda claude), nas trazidas para a Conversa (a lista delas e o aviso de
 * "reaberta" moram ali), nas que o board está abrindo no tmux (`poupar`) nem em transcrito nenhum — o histórico do CLI fica.
 */
export function esquecerEncerradas(reg, poupar = () => false, quem = "dono (tela)") {
  const v = lembrarSessoes(reg);
  const vivos = new Set(reg.map((j) => j.sessionId));
  const foram = [];
  for (const [sid, x] of Object.entries(v)) {
    if (vivos.has(sid) || x.trazida || poupar(sid) || aberta(sid, x, reg)) continue;
    foram.push(x.nome); delete v[sid];
  }
  if (foram.length) gravarVistas(v);
  logEvent("sessoes", { t: "esqueceu", quantas: foram.length, quem });
  return { ok: true, esquecidas: foram.length };
}

// ── trazer ───────────────────────────────────────────────────────────────────
/**
 * A sessão `sessionId` (só uma que o board VIU no registro — nada do cliente vale como pasta ou nome) vira o fio da
 * Conversa do projeto da pasta dela. `porVisivel` = o dono aceitou pôr o projeto na seleção; `substituir` = o dono
 * escolheu esta sessão no lugar do fio que a Conversa já tinha (que vai para o arquivo).
 */
export function trazerParaConversa(sessionId, { porVisivel = false, substituir = false } = {}, reg, quem = "dono (tela)") {
  const vistas = lembrarSessoes(reg);
  const v = vistas[sessionId];
  if (!v) throw falha(404, "não conheço esta sessão (o board só traz sessão que viu aberta no registro do Claude)");
  if (v.trazida && !substituir && conversaDe(v.trazida.slug).sessoes?.claude === sessionId)
    return { ok: true, jaEstava: true, slug: v.trazida.slug, url: "#/c/" + v.trazida.slug };
  const pid = aberta(sessionId, v, reg);
  if (pid) throw falha(409, `a sessão ${v.nome} ainda está aberta no terminal (pid ${pid}). Dê /exit nela primeiro — duas cópias da mesma conversa se atropelam, e o board nunca fecha a sessão de fora.`, { viva: pid });
  const proj = projetoDaPasta(v.cwd);
  if (!proj) throw falha(409, `a pasta da sessão (${v.cwd || "?"}) não é um projeto do board — a Conversa roda na pasta de um projeto em ${listProjects()[0]?.dir || "DEV"}`);
  const arquivo = transcritoDe(sessionId);
  if (!arquivo) throw falha(409, `não achei o histórico da sessão ${v.nome} (~/.claude/projects/*/${sessionId}.jsonl): a Conversa começaria do zero`);
  if (!proj.visivel) {
    if (!porVisivel) throw falha(409, `${proj.label} não está na seleção de projetos da tela`, { precisaVisivel: proj });
    tornarVisivel(proj.slug);
  }
  const slug = proj.slug, c = conversaDe(slug), id = conversaId(slug);
  if (c.busy) throw falha(409, `a Conversa de ${proj.label} está respondendo agora — espere terminar`);
  const atual = sessoesDe(slug).claude || c.sessionId || null;
  const eventos = readLog(id);
  const falas = eventos.filter((e) => e.t === "dono" || (e.t === "resultado" && e.texto));
  if ((falas.length || (atual && atual !== sessionId)) && !substituir) {
    throw falha(409, `a Conversa de ${proj.label} já tem um fio`, { conflito: {
      slug, label: proj.label, sessionId: atual, mensagens: falas.length, ultima: falas.at(-1)?.at || null,
      trecho: cut(falas.filter((e) => e.t === "dono").at(-1)?.texto || "", 140), nova: v.nome } });
  }
  // O fio de antes não é apagado: o log vai para o arquivo (com o sessionId dele no registro), e dá para voltar a ele.
  let arquivado = null;
  if (eventos.length) {
    arquivado = `${id}.arquivo-${now().replace(/[:.]/g, "-")}.jsonl`;
    renameSync(logPath(id), join(dirname(logPath(id)), arquivado));
  }
  matarVivo(slug); naVez.delete(slug);
  Object.assign(c, { sessoes: { claude: sessionId }, sessionId, motor: "claude", modelo: null, custo: 0, naVez: 0, updatedAt: now() });
  broadcast("conversa-limpa", { slug }); // a tela aberta nesta Conversa recomeça antes de o histórico chegar
  const { total, msgs } = historicoDoTranscrito(arquivo);
  logEvent(id, { t: "solto", texto: `🖥 Sessão ${v.nome} trazida do terminal: esta Conversa continua a mesma conversa (${msgs.length < total ? `as últimas ${msgs.length} de ${total} mensagens abaixo` : `${total} mensage${total === 1 ? "m" : "ns"} abaixo`}).${arquivado ? " O fio de antes foi para o arquivo." : ""}` });
  // motor "claude" na resposta: o oQuePerdeu não reenvia nada disso ao agente — a sessão dele já tem tudo.
  for (const m of msgs) logEvent(id, { ...m, importado: true, ...(m.t === "resultado" ? { motor: "claude" } : {}) });
  vistas[sessionId] = { ...v, trazida: { slug, label: proj.label, em: now() }, reaberta: false };
  gravarVistas(vistas);
  logEvent("sessoes", { t: "trazida", sessao: v.nome, sessionId, projeto: slug, quem, mensagens: total, ...(atual && atual !== sessionId ? { substituiu: atual } : {}), ...(arquivado ? { arquivado } : {}) });
  save(); broadcast("state");
  return { ok: true, slug, label: proj.label, url: "#/c/" + slug, mensagens: total, mostradas: msgs.length, arquivado };
}

/** Lê o registro de tempos em tempos para lembrar das sessões mesmo com o menu fechado. */
export function vigiarSessoes(lerRegistro, ms = 60000) {
  const volta = () => { try { lembrarSessoes(lerRegistro()); } catch { /* registro ilegível: tenta na próxima */ } };
  volta();
  const t = setInterval(volta, ms); t.unref?.();
  return t;
}
