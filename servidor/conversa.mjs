// A conversa por projeto: um fio por projeto, com o processo do claude vivo entre as mensagens.
import { spawn } from "child_process";
import { appendFileSync } from "fs";
import { CONVERSA_CHROME, CONVERSA_PERMISSION, CONVERSA_TIMEOUT_MS, DONO, RAW_LIGADO, ROOT, TOOLS, cut, now, stripAnsi } from "./config.mjs";
import { broadcast, logEvent, rawPath, readLog, running, save, state } from "./estado.mjs";
import { listProjects, projetosVisiveis } from "./projetos.mjs";
import { MOTORES, modeloPara, runAgent } from "./motores.mjs";
import { escolherMotor } from "./uso.mjs";
import { anexosValidos, comAnexos } from "./anexos.mjs";
import { nucleoDoDono } from "./memoria.mjs";
import { MOTIVO_CLASSIFICADOR, argsPermissao, comRegras, ganchos, gastarUmaVez, registrarBarrado, umaVezDe } from "./permissoes.mjs";

// ── Conversa por projeto: falar com o agente sem abrir tarefa ─────────────────
/**
 * O dono pensa no terminal, com meia dúzia de abas abertas, e a cada aba precisa dizer de novo em
 * que projeto está. A conversa põe isso no board: UM FIO POR PROJETO, na pasta dele, retomando a
 * sessão (`--resume`), com o motor que ele escolher. Serve pra perguntar, pesquisar, ler código —
 * e, quando a conversa chega lá, virar tarefa pelo `board-cli.mjs`.
 *
 * Não entra na fila e não gasta vaga de paralelismo: quem está falando é o dono, não a esteira.
 * Por isso pode haver tarefa rodando na MESMA pasta — daí o aviso nas regras (só leitura).
 */
export const conversaId = (slug) => `conversa-${slug}`;
export const conversaOcupada = () => Object.values(state.conversas || {}).some((c) => c && c.busy);

export function conversaDe(slug) {
  state.conversas = state.conversas || {};
  state.conversas[slug] = state.conversas[slug] || { sessionId: null, motor: null, modelo: null, busy: false, custo: 0, updatedAt: now() };
  return state.conversas[slug];
}

/**
 * Cada CLI tem a SUA sessão: a do Claude não existe no agy, e vice-versa. Com um número só, trocar
 * para o Gemini mandava a sessão do Claude (`conversation … not found`, fio começando do zero) e,
 * na volta, o Claude recebia a do Gemini e perdia o fio inteiro. Fio antigo (sessionId solto) é do
 * motor que deu a última resposta no log.
 */
export function sessoesDe(slug) {
  const c = conversaDe(slug);
  if (!c.sessoes) {
    c.sessoes = {};
    if (c.sessionId) c.sessoes[readLog(conversaId(slug)).filter((e) => e.t === "resultado" && e.motor).pop()?.motor || "claude"] = c.sessionId;
  }
  return c.sessoes;
}

/** O que foi dito desde a última resposta DESTE motor, para ele não chegar no meio sem saber de nada. */
export function oQuePerdeu(slug, motorId, max = 12, jaNoLog = 0) {
  let evs = readLog(conversaId(slug)).filter((e) => e.t === "dono" || (e.t === "resultado" && e.texto));
  if (jaNoLog) {
    // As mensagens que esperaram a vez vão juntas como pedido: tiro as últimas N "na vez" do contexto.
    const fora = new Set(evs.map((e, i) => e.t === "dono" && e.naVez ? i : -1).filter((i) => i >= 0).slice(-jaNoLog));
    evs = evs.filter((_, i) => !fora.has(i));
  } else if (evs.at(-1)?.t === "dono") evs.pop(); // a mensagem que acabou de chegar vai como pedido, não como contexto
  let i = evs.length; while (i > 0 && !(evs[i - 1].t === "resultado" && evs[i - 1].motor === motorId)) i--;
  const perdeu = evs.slice(i).slice(-max);
  if (!perdeu.length) return "";
  return [`[Contexto] Esta conversa seguiu ${i ? "em outro motor enquanto você estava fora" : "antes de você entrar"}. O que foi dito, em ordem (a sessão de outro CLI não atravessa, só este texto):`,
    ...perdeu.map((e) => e.t === "dono" ? `\nDono: ${cut(comCitacao(e.texto, e.cita), 1500)}` : `\nAgente (${e.motor || "?"}${e.n ? `, R${e.n}` : ""}): ${cut(e.texto, 1500)}`),
    "\n[Mensagem nova do dono]\n"].join("\n");
}

/** Pasta errada (23/10): pedido claramente de outro projeto não se resolve nesta pasta — avisa e oferece a tarefa lá. */
function outrosProjetos(slug) {
  const outros = projetosVisiveis().filter((p) => p.slug !== slug && p.slug !== "DEV");
  if (!outros.length) return "";
  return `- Se o pedido for claramente de OUTRO projeto (${outros.map((p) => `${p.label} = ${p.slug}`).join(", ")}), NÃO mexa nesta pasta: diga isso logo na primeira linha e ofereça mandar como tarefa para o projeto certo (board-cli add com o slug dele). Na dúvida, pergunte.`;
}

export function regrasConversa(project, tarefaRodando) {
  return [
    `Você é o agente de trabalho do dono${DONO}, conversando pelo board dele, na pasta do projeto "${project.slug}" (${project.dir}).`,
    "Trabalhe exatamente como no Claude Code do terminal: este é o lugar único onde ele trabalha. O fio continua de onde parou.",
    `- Leia ${project.dir}/CLAUDE.md antes de afirmar qualquer coisa sobre o projeto. Consulte o ai-memory quando precisar de histórico ou decisão antiga.`,
    "- Faça o que ele pedir, na hora: ler, pesquisar, rodar comando, testar, EDITAR arquivo, commitar local. Não transforme pedido em tarefa a menos que ele peça.",
    "- Você tem as MESMAS ferramentas do terminal, inclusive os conectores MCP (navegador, Gmail, Drive, Calendar, Figma…): use quando o pedido precisar. Mandar algo em nome dele (e-mail, mensagem, convite, publicar) só quando ele pedir com essas palavras.",
    CONVERSA_CHROME ? "- Navegador: o Claude in Chrome (mcp__claude-in-chrome__*) é o Chrome DELE, logado. Abra aba própria, não feche nem mexa nas abas dele, e feche as que você abriu ao terminar." : "",
    "- Push, PR ou qualquer coisa visível a outros: só com pedido explícito. Nunca deploy, nunca banco de produção, nunca mesclar PR, nunca push forçado.",
    "- Responda em português BR, curto e direto. A tela renderiza markdown: use tabela, lista e bloco de código quando ajudarem; nada de parede de texto.",
    "- Nunca escreva número que o sistema não contou.",
    `- Mandar para a fila (quando ele disser \"vira tarefa\"): node ${ROOT}/board-cli.mjs add \"<o que fazer>\" ${project.slug} [--fila] [--pr] — e diga o número que saiu.`,
    outrosProjetos(project.slug),
    nucleoDoDono(),
    tarefaRodando ? "⚠️ Há uma TAREFA RODANDO nesta mesma pasta agora: não edite arquivo; só leia e responda. Dois agentes escrevendo na mesma árvore se atropelam." : "",
  ].filter(Boolean).join("\n");
}

/*
 * Conversa com o Claude: UM processo vivo por projeto (`--input-format stream-json`), que recebe
 * cada mensagem pela entrada. Subir um `claude -p --resume` por mensagem custava a partida inteira
 * (MCP, hooks, CLAUDE.md) antes de ele começar a pensar. O processo morre sozinho depois de
 * BOARD_CONVERSA_VIVA_MIN parado, e é refeito (com --resume) quando mudam regras ou modelo.
 * ⚠️ Nesse modo o `total_cost_usd` do `result` é ACUMULADO do processo: aqui vira o da mensagem.
 */
export const CONVERSA_VIVA_MS = Number(process.env.BOARD_CONVERSA_VIVA_MIN || 30) * 60000;
export const vivos = new Map(); // slug → { cp, chave, turno, custoAcum, ocioso, buf }

/*
 * Fios especiais (a 💬 Central, 26/10): um fio que não é de projeto registra aqui a pasta, as regras, as
 * ferramentas e as opções do processo vivo. Quem registra é o módulo dele (central.mjs); a conversa só consulta.
 */
export const fiosEspeciais = new Map(); // slug → { project(), regras(), tools, vivo: { extra, semOcioso, espontaneo, aoUsuario }, antes(c) }

export function matarVivo(slug) {
  const v = vivos.get(slug);
  if (!v) return;
  vivos.delete(slug);
  clearTimeout(v.ocioso);
  try { v.cp.kill("SIGTERM"); } catch { /* já tinha saído */ }
}
process.on("exit", () => { for (const v of vivos.values()) { try { v.cp.kill("SIGTERM"); } catch { /* já saiu */ } } });

export function abrirVivo(slug, project, { chave, regras, tools, modelo, resume, extra = [], espontaneo = null, aoUsuario = null }) {
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--include-partial-messages", "--append-system-prompt", regras, "--allowedTools", tools, ...extra,
    // Pedido de permissão vira cartão na tela (#232) em vez de ficar preso numa janela de terminal que ninguém olha.
    ...argsPermissao({ slug, papel: slug === "central" ? "central" : "conversa" })];
  if (CONVERSA_PERMISSION === "bypass") args.push("--dangerously-skip-permissions");
  else args.push("--permission-mode", CONVERSA_PERMISSION);
  if (CONVERSA_CHROME) args.push("--chrome");
  if (modelo) args.push("--model", modelo);
  if (resume) args.push("--resume", resume);
  const env = { ...process.env, BOARD_QUEM: slug === "central" ? "Central" : "conversa de " + slug, PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:${process.env.PATH || ""}` };
  let cp;
  try { cp = spawn("claude", args, { cwd: project.dir, env, stdio: ["pipe", "pipe", "pipe"] }); }
  catch { return null; }
  const id = conversaId(slug);
  const v = { cp, chave, turno: null, custoAcum: 0, ocioso: null, buf: "", espontaneo, aoUsuario, usos: new Map() };
  vivos.set(slug, v);
  cp.stdin.on("error", () => { /* processo caiu: o close encerra o turno */ });

  const linha = (line) => {
    const s = stripAnsi(line).trim();
    if (!s) return;
    if (RAW_LIGADO) appendFileSync(rawPath(id), s + "\n");
    let t = v.turno;
    if (!t) {
      // Sem turno do dono: só um fio que ESCUTA (a Central) aproveita — é outra sessão que escreveu e acordou o agente.
      // O turno começa no `command_lifecycle` "started" ou no primeiro sinal de trabalho; o rabo do turno anterior
      // ("completed", limite de uso, ganchos do sistema) não abre turno nenhum.
      let ev0; try { ev0 = JSON.parse(s); } catch { return; }
      const acorda = ev0.type === "assistant" || ev0.type === "user" || ev0.type === "result"
        || (ev0.type === "command_lifecycle" && ev0.state === "started");
      if (!v.espontaneo || !acorda) return;
      t = v.turno = v.espontaneo(v);
      if (ev0.type === "command_lifecycle") return;
    }
    if (!s.startsWith("{")) {
      t.out.ultimoSolto = cut(s, 300);
      if (/No conversation found with session ID/i.test(s)) t.out.sessaoPerdida = true;
      logEvent(id, { t: "solto", texto: cut(s, 400) });
      return;
    }
    let ev; try { ev = JSON.parse(s); } catch { return; }
    if (ev.type === "stream_event") {
      // Texto chegando aos pedaços: vai pra tela pelo SSE, sem gravar no log (o bloco inteiro
      // chega logo depois como evento "assistant" e esse sim vira evento da conversa).
      const e = ev.event || {};
      if (e.type === "message_start" || e.type === "content_block_start") t.parcial = "";
      else if (e.type === "content_block_delta" && e.delta?.type === "text_delta") {
        t.parcial += e.delta.text || "";
        if (Date.now() - t.ultimoEnvio > 120) { t.ultimoEnvio = Date.now(); broadcast("parcial", { id, texto: t.parcial }); }
      }
      return;
    }
    // O classificador do modo auto barrou (#232): não passa pela ferramenta de permissão — o board lê aqui e mostra o
    // cartão. Para isso guarda o que cada tool_use pediu (o tool_result só traz o id).
    if (ev.type === "assistant") for (const b of ev.message?.content || []) if (b.type === "tool_use" && b.id) v.usos.set(b.id, { nome: b.name, entrada: b.input || {} });
    if (ev.type === "user" && Array.isArray(ev.message?.content)) for (const b of ev.message.content) {
      const txt = b.type === "tool_result" ? (typeof b.content === "string" ? b.content : (b.content || []).map((x) => x.text || "").join("\n")) : "";
      const m = txt.match(MOTIVO_CLASSIFICADOR), uso = m && v.usos.get(b.tool_use_id);
      if (uso) registrarBarrado({ slug, ferramenta: uso.nome, entrada: uso.entrada, motivo: m[1] || "classificador do modo auto", toolUseId: b.tool_use_id });
    }
    // Com --replay-user-messages (só a Central) o CLI repete o que entrou: o texto do dono (já está no log) e a
    // mensagem de outra sessão — essa vai para o log pelo aoUsuario. Resultado de ferramenta segue o caminho normal.
    if (v.aoUsuario && ev.type === "user") {
      const cont = ev.message?.content;
      if (typeof cont === "string" || (Array.isArray(cont) && cont.every((c) => c.type === "text"))) {
        v.aoUsuario(typeof cont === "string" ? cont : cont.map((c) => c.text).join("\n"));
        return;
      }
    }
    if (ev.type === "result") {
      const total = ev.total_cost_usd || 0;
      ev = { ...ev, total_cost_usd: Math.max(0, total - v.custoAcum) };
      v.custoAcum = total;
    }
    MOTORES.claude.trata(ev, t.ctx);
    if (ev.type === "result") t.fim();
  };
  cp.stdout.on("data", (d) => { v.buf += d; const L = v.buf.split(/\r?\n/); v.buf = L.pop(); L.forEach(linha); });
  cp.stderr.on("data", (d) => String(d).split(/\r?\n/).forEach(linha));
  cp.on("error", (e) => { if (v.turno) v.turno.out.error = "não consegui falar com o claude (está no PATH?): " + e.message; });
  cp.on("close", (code) => {
    if (vivos.get(slug) === v) vivos.delete(slug);
    clearTimeout(v.ocioso);
    if (v.buf.trim()) linha(v.buf);
    if (!v.turno) return;
    const o = v.turno.out;
    o.code = code;
    if (!o.result && !o.error) o.error = o.ultimoSolto || (code === null ? "parado" : `o claude saiu com código ${code}`);
    v.turno.fim();
  });
  return v;
}

export async function turnoVivo(slug, project, task, prompt, opts) {
  // Outra sessão acordou o agente (Central) e ele ainda está nesse turno: a mensagem do dono ESPERA ele terminar,
  // em vez de matar o processo no meio (a resposta da outra sessão se perderia).
  for (let v = vivos.get(slug); v?.turno?.espontaneo; v = vivos.get(slug)) await v.turno.acabou;
  return turnoVivoAgora(slug, project, task, prompt, opts);
}

function turnoVivoAgora(slug, project, task, prompt, { regras, tools: toolsBase, modelo, extra = [], semOcioso = false, espontaneo = null, aoUsuario = null }) {
  return new Promise((done) => {
    // As regras que o dono liberou pela tela (#232): "sempre" do projeto + "uma vez" deste turno. Mudou → processo novo (--resume).
    const usadas = umaVezDe(slug), tools = comRegras(toolsBase, slug);
    const chave = JSON.stringify([regras, tools, modelo, CONVERSA_PERMISSION, extra]);
    let v = vivos.get(slug);
    if (v && (v.chave !== chave || v.turno)) { matarVivo(slug); v = null; }
    if (!v) v = abrirVivo(slug, project, { chave, regras, tools, modelo, resume: task.sessionId || undefined, extra, espontaneo, aoUsuario });
    if (!v) return done({ result: "", error: "não consegui iniciar o claude" });
    clearTimeout(v.ocioso);
    const id = task.id, comecou = Date.now();
    const out = { result: "", sessionId: task.sessionId || null, cost: 0, tokens: 0, turns: 0, dur: 0, code: null, error: null, escreveu: false, motor: "claude" };
    const fim = () => {
      if (v.turno !== turno) return;
      clearTimeout(turno.timer);
      v.turno = null;
      gastarUmaVez(slug, usadas);
      if (running.get(id) === v.cp) running.delete(id);
      // A Central não morre parada: é parada que ela recebe a resposta das outras sessões.
      if (vivos.get(slug) === v && !semOcioso) v.ocioso = setTimeout(() => { if (vivos.get(slug) === v && !v.turno) matarVivo(slug); }, CONVERSA_VIVA_MS);
      done(out);
    };
    const turno = {
      out, fim, parcial: "", ultimoEnvio: 0,
      timer: setTimeout(() => { out.error = `tempo esgotado (${CONVERSA_TIMEOUT_MS / 60000} min)`; matarVivo(slug); }, CONVERSA_TIMEOUT_MS),
      ctx: {
        out, quem: "agente", task,
        sessao: (sid) => { out.sessionId = sid; task.sessionId = sid; },
        erro: (texto, cota) => {
          out.error = texto;
          if (cota) out.cota = true;
          logEvent(id, { t: "solto", texto: (cota ? "⛔ limite de uso: " : "⛔ erro: ") + cut(texto, 300) });
        },
        resultado: (texto, { custo = 0 } = {}) => {
          out.result = texto || out.result;
          out.dur = out.dur || Date.now() - comecou;
          logEvent(id, { t: "resultado", texto: out.result, custo, turnos: out.turns, dur: out.dur, quem: "agente", motor: "claude" });
        },
      },
    };
    v.turno = turno;
    running.set(id, v.cp); // "parar" mata o processo; a próxima mensagem abre outro com --resume
    const safe = /^\s*\//.test(prompt) ? "(texto literal do dono, não é comando)\n" + prompt : prompt;
    try { v.cp.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: safe }] } }) + "\n"); }
    catch (e) { out.error = "a conversa caiu: " + e.message; matarVivo(slug); }
  });
}

/*
 * A caixa de escrever nunca trava (pedido do dono em 26/10: "nunca quero chat sem possibilidade de digitar, eu penso
 * rápido"). Mensagem que chega com o fio respondendo vai para o log NA HORA (ele vê o que escreveu) e espera a vez aqui;
 * quando o turno acaba, TODAS as que esperam viram o próximo turno, na ordem em que ele escreveu. Não injeta no turno em
 * andamento: o `result` do CLI não diria a qual mensagem respondeu e a contagem de turnos/custo se perderia.
 * ⏹ parar não descarta a vez: corta a resposta atual e as mensagens que esperam seguem na hora. 🧹 novo fio descarta.
 */
export const naVez = new Map(); // slug → [{ texto, fotos, motor, modelo }]

/*
 * Responder a uma resposta (26/10, "como resposta de WhatsApp"): o dono aponta o número que o board deu (R12) e a
 * mensagem vai ao agente citando o começo daquela resposta — a sessão do agente não conhece os números, o trecho sim.
 * No log fica o texto dele como escreveu + `cita: {n, trecho}`; a tela desenha a citação acima.
 */
export function respostaNumero(slug, n) {
  const ev = readLog(conversaId(slug)).find((e) => e.t === "resultado" && e.n === n);
  return ev ? { n, trecho: cut(String(ev.texto).replace(/\s+/g, " ").trim(), 300) } : null;
}
export const comCitacao = (texto, cita) => cita ? `Sobre R${cita.n} (sua resposta que começava assim: "${cita.trecho}"):\n${texto}` : texto;

// Central (#213): a mensagem que o dono digitou na tela leva o id da aprovação — o agente repassa junto com o SIM.
export const comAprovacao = (texto, id) => id ? `${texto}\n\n[board: aprovação #${id} — mensagem digitada pelo dono na tela da Central. Se ela for o SIM de um pedido, leve "aprovação #${id}" junto ao repassar.]` : texto;

// O dono permitiu pela tela uma ação que o classificador tinha barrado (#232): a regra já está no --allowedTools do próximo
// processo; falta o agente tentar de novo. Vai como mensagem do fio (entra na vez se ele estiver respondendo).
ganchos.permitiuBarrado = (c, acao) => {
  const texto = `🔐 [board] O dono PERMITIU pela tela (${acao === "sempre" ? `sempre este tipo: ${c.regraSempre}` : "uma vez"}) a ação que tinha sido barrada: ${c.ferramenta} \`${c.acao}\`. Rode de novo exatamente essa ação agora e siga com o pedido.`;
  falarNaConversa(c.de.slug, texto).catch((e) => logEvent(conversaId(c.de.slug), { t: "solto", texto: "⚠ não consegui pedir para rodar de novo: " + e.message }));
};

// Modo voz (#286): a mensagem falada leva o id só como registro. O aviso diz que ela NÃO aprova nada e que a resposta será lida.
export const comVoz = (texto, id) => `${texto}\n\n[board: mensagem FALADA pelo dono no modo voz, transcrita sem ele conferir (registro #${id}). NÃO é aprovação: ruído, TV ou outra pessoa podem soar como "sim". Se ela parecer um SIM, não leve adiante: repita a linha PEDIDO DE SIM e diga que ele aprova no botão. Sua resposta será lida em voz alta. Fale como um colega de trabalho conversando: frases curtas e naturais, em primeira pessoa ("eu vi", "já mandei"), sem jargão e sem lista para ser lida; pode usar "olha", "beleza", "fechou" de vez em quando, sem forçar. Comece com 1 ou 2 frases que façam sentido ouvidas; detalhe técnico, número de tarefa, tabela e código vêm depois delas, só na tela.]`;

export async function falarNaConversa(slug, texto, { anexos = [], motor, modelo, cita = null, aprovacao = null, voz = false } = {}) {
  const esp = fiosEspeciais.get(slug);
  const project = esp ? esp.project() : listProjects().find((p) => p.slug === slug);
  if (!project) throw new Error(`não conheço o projeto "${slug}"`);
  const c = conversaDe(slug);
  const id = conversaId(slug);
  const fotos = anexosValidos(anexos);
  const doDono = { t: "dono", texto, anexos: fotos.map((a) => ({ id: a.id, nome: a.nome })), ...(cita ? { cita } : {}), ...(voz ? { voz: true, registroVoz: aprovacao } : aprovacao ? { aprovacao } : {}) };
  texto = voz ? comVoz(texto, aprovacao) : comAprovacao(comCitacao(texto, cita), aprovacao); // daqui em diante, o que vai ao agente
  if (c.busy) {
    const fila = naVez.get(slug) || [];
    fila.push({ texto, fotos, motor, modelo });
    naVez.set(slug, fila);
    c.naVez = fila.length; c.updatedAt = now();
    logEvent(id, { ...doDono, naVez: true });
    save(); broadcast("state");
    return { naVez: fila.length };
  }
  logEvent(id, doDono);
  let r = await turnoDaConversa(slug, project, esp, c, { texto, fotos, motor, modelo });
  // As que chegaram durante a resposta: um turno só, na ordem; repete enquanto ele continuar escrevendo.
  for (let fila = naVez.get(slug); fila?.length; fila = naVez.get(slug)) {
    naVez.delete(slug); c.naVez = 0;
    const ult = fila.at(-1);
    const juntas = fila.length === 1 ? fila[0].texto
      : `(O dono mandou ${fila.length} mensagens enquanto você respondia; estão em ordem.)\n\n` + fila.map((m, i) => `${i + 1}. ${m.texto}`).join("\n\n");
    r = await turnoDaConversa(slug, project, esp, c, { texto: juntas, fotos: fila.flatMap((m) => m.fotos), motor: ult.motor, modelo: ult.modelo, jaNoLog: fila.length });
  }
  return r;
}

async function turnoDaConversa(slug, project, esp, c, { texto, fotos, motor, modelo, jaNoLog = 0 }) {
  if (esp?.antes) esp.antes(c);
  if (motor !== undefined) c.motor = motor || null;
  if (modelo !== undefined) c.modelo = modelo || null;
  const id = conversaId(slug);
  c.busy = true; c.updatedAt = now(); save(); broadcast("state");
  // Pseudo-tarefa: é o que runMotor precisa (id pro log, pasta, sessão, motor, imagens). Ela NÃO
  // entra em state.tasks — senão apareceria no quadro como tarefa e contaria vaga na fila.
  const sessoes = sessoesDe(slug);
  const falsa = { id, project: slug, text: texto, anexos: fotos, sessionId: null, motor: c.motor, modelo: c.modelo, porte: null };
  const rodando = state.tasks.some((t) => t.project === slug && !t.paralelo && (t.status === "rodando" || t.busy));
  const regras = esp ? esp.regras() : regrasConversa(project, rodando), tools = esp ? esp.tools : TOOLS + ",Agent,Skill,TodoWrite";
  let r, motorId;
  try {
    motorId = esp ? "claude" : escolherMotor("agente", falsa); // a Central só existe no Claude (SendMessage, ListAgents)
    falsa.sessionId = sessoes[motorId] || null;
    const prompt = oQuePerdeu(slug, motorId, 12, jaNoLog) + comAnexos(texto, fotos);
    if (motorId === "claude") {
      const modelo = modeloPara("claude", falsa);
      r = await turnoVivo(slug, project, falsa, prompt, { regras, tools, modelo, ...esp?.vivo });
      if (r.sessaoPerdida && falsa.sessionId) {
        logEvent(id, { t: "solto", texto: "⚠ a sessão salva desta conversa não existe mais — recomeçando o fio do zero" });
        falsa.sessionId = null; delete sessoes.claude;
        r = await turnoVivo(slug, project, falsa, prompt, { regras, tools, modelo, ...esp?.vivo });
      }
    } else {
      matarVivo(slug);
      r = await runAgent(falsa, prompt, { resume: falsa.sessionId || undefined, fresco: prompt, motor: motorId,
        regras, tools, limite: CONVERSA_TIMEOUT_MS });
    }
  } finally {
    c.busy = false; c.updatedAt = now();
  }
  const sid = falsa.sessionId || r.sessionId;
  if (sid) sessoes[motorId] = sid;
  c.sessionId = sid || c.sessionId; // o mais recente, só para quem ainda lê o campo antigo (temSessao)
  if (falsa.motor) c.motor = falsa.motor; // a troca por falta de cota fica valendo pro fio
  c.custo = Number(((c.custo || 0) + (r.cost || 0)).toFixed(4));
  if (r.error && !r.result) logEvent(id, { t: "solto", texto: "⚠ " + r.error });
  save(); broadcast("state");
  return r;
}
