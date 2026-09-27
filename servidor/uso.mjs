// O plano de cada motor (/usage), a cota, a passagem de bastão entre motores e o consumo do board.
import { spawn, execFileSync } from "child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { C, MOTOR_PADRAO, MOTOR_QA, MOTOR_REVISOR, ROOT, cut, modeloServe, now, stripAnsi } from "./config.mjs";
import { broadcast, logEvent, readLog, save, state, taskById } from "./estado.mjs";
import { projectOf } from "./projetos.mjs";
import { MOTORES, motoresDisponiveis, temBin } from "./motores.mjs";

// ── uso do plano do Claude (/usage) ───────────────────────────────────────────
/**
 * O PLANO — o /usage do Claude Code roda no modo `-p` SEM gastar nada (0 turnos, custo 0) e
 * devolve o painel da assinatura: quanto da sessão e da semana já foi usado e quando renova.
 * O board só LÊ e traduz esse painel; não estima nem inventa saldo. (Em 15/09 eu disse ao dono
 * que isso não saía pela CLI — estava errado: não tinha testado o `/usage` no modo -p.)
 * Cache de 60 s: cada leitura sobe um processo do CLI.
 */
export let usoCache = null, usoEmVoo = null;
export const MESES = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** "Sep 17 at 9:59am (America/Sao_Paulo)" → ISO. O Mac do dono está no mesmo fuso. */
export function parseQuando(txt) {
  const m = String(txt || "").match(/\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm))?/i);
  if (!m || MESES[m[1].toLowerCase()] === undefined) return null;
  const agora = new Date();
  let h = m[3] ? Number(m[3]) % 12 : 0; if (m[5] && /pm/i.test(m[5])) h += 12;
  const d = new Date(agora.getFullYear(), MESES[m[1].toLowerCase()], Number(m[2]), h, Number(m[4] || 0));
  if (d.getTime() < agora.getTime() - 180 * 86400000) d.setFullYear(d.getFullYear() + 1); // virada de ano
  return d.toISOString();
}

/** As frases fixas do painel em português; o que não reconhecer passa como veio. */
export function traduzUso(s) {
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

export function parseUso(texto) {
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
export const USO_TTL = 5 * 60000;
/**
 * O uso do plano do GEMINI, pelo `agy -p "/usage"` (roda sem gastar: 0 turnos). Ele devolve o que
 * RESTA; aqui vira "usado" para a tela falar a mesma língua do Claude.
 * Linhas: "Grupo\tWeekly Limit Remaining\t91%\t2026-09-29T12:04:59Z".
 */
export function usoDoGemini() {
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
export function usoDoCodex() {
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

export function lerUsoClaude({ fresco = false } = {}) {
  if (!fresco && usoCache) {
    if (Date.now() - usoCache.t >= USO_TTL) buscarUsoClaude();
    return Promise.resolve(usoCache.v);
  }
  return buscarUsoClaude();
}

export function buscarUsoClaude() {
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
export let usosCache = null, usosEmVoo = null;
export function lerUsos({ fresco = false } = {}) {
  if (!fresco && usosCache) {
    if (Date.now() - usosCache.t >= USO_TTL) buscarUsos();
    return Promise.resolve(usosCache.v);
  }
  return buscarUsos();
}
export function buscarUsos() {
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
export const RESERVA = (process.env.BOARD_MOTORES_RESERVA || "gemini,codex,opencode").split(",").map((x) => x.trim()).filter(Boolean);
export const TETO_COTA = Number(process.env.BOARD_COTA_TETO || 98); // % a partir do qual consideramos esgotado

/** A janela mais apertada de um motor (as curtas mandam; sem elas, o que houver). Sem leitura, null. */
export function pctDeLimites(u) {
  if (!u || !u.ok || !u.limites?.length) return null;
  const curtos = u.limites.filter((l) => !/semana|week/i.test(l.nome));
  return Math.max(...(curtos.length ? curtos : u.limites).map((l) => l.pct));
}

/** Este motor está sem cota? A regra é uma só — a tela pinta de vermelho pelo mesmo critério. */
export function semCotaDoUso(u) {
  const p = pctDeLimites(u);
  if (p == null) return false; // sem informação, não é motivo para descartar o motor
  return p >= TETO_COTA || u.limites.some((l) => l.pct >= 100);
}

/** O motor tem cota? Usa o painel já lido (não chama CLI nenhum aqui). */
export function temCota(id) {
  return !semCotaDoUso(usosCache?.v?.motores?.[id]);
}

/** Quanto do plano deste motor já foi usado (a janela mais apertada). Sem dado, neutro. */
export function usoDoMotor(id) {
  const p = pctDeLimites(usosCache?.v?.motores?.[id]);
  return p == null ? 50 : p;
}

/** O motor com MAIS folga entre os que têm cota — a ordem da reserva só desempata. */
export function proximoMotorComCota(atual) {
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
export function escolherMotor(quem, task) {
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
export function passarBastao(task, novo, motivo = "pedido do dono") {
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
export function textoDaPassagem(task, de, para, motivo) {
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
export function usage() {
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
