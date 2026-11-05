// Pedidos de permissão das sessões na tela do board (#232, 28/10: "não dá pra trazer elas pra cá? senão vou ter que ficar
// com o terminal aberto também").
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import { DATA, PORT, ROOT, cut, now } from "./config.mjs";
import { broadcast, logEvent, readLog } from "./estado.mjs";

/*
 * Dois caminhos, porque o CLI tem dois jeitos de barrar (medido com o claude real em 28/10, numa pasta de teste):
 *
 * 1. PEDIDO (o agente ESPERA): `--permission-prompt-tool mcp__board-permissao__pedir` + `--mcp-config` com o
 *    `permissao-mcp.mjs`. Tudo o que o CLI perguntaria a uma pessoa vira chamada dessa ferramenta, com
 *    `{tool_name, input, tool_use_id}`; ela repassa ao board (POST /api/permissoes/pedido, que segura a resposta) e devolve
 *    `{"behavior":"allow","updatedInput":…}` ou `{"behavior":"deny","message":…}`. Vale nas TAREFAS (acceptEdits + lista:
 *    o que está fora da lista pergunta) e, na conversa em modo auto, no que o modo manda perguntar.
 * 2. BARRADO (o agente JÁ ouviu não): no modo `auto` (o das conversas) o bloqueio do CLASSIFICADOR não passa pela
 *    ferramenta — 0 chamadas na sonda; chega como tool_result "denied by the Claude Code auto mode classifier" e o agente
 *    para. O board lê isso no stream e mostra o cartão. Permitir = uma regra EXATA no `--allowedTools` do próximo processo
 *    (provado na sonda: regra exata vence o classificador) + uma mensagem pedindo para rodar de novo.
 *
 * Sem resposta em BOARD_PERMISSAO_MIN (10), o pedido é NEGADO. Só a tela (Origin dela) responde. Tudo vai para
 * data/logs/permissoes.jsonl (auditoria) e para a linha do tempo da conversa/tarefa.
 */
// Nome próprio: `BOARD_PERMISSAO` já é o MODO de permissão das tarefas (config.mjs) — "0" ali virava `--permission-mode 0`
// e derrubava todas as tarefas (revisor da #232).
export const PERMISSAO_LIGADA = process.env.BOARD_PERMISSAO_TELA !== "0";
export const PERMISSAO_MS = Number(process.env.BOARD_PERMISSAO_MIN || 10) * 60000;
export const PERMISSOES_FILE = join(DATA, "permissoes.json");
export const LOG_PERMISSOES = "permissoes";
export const FERRAMENTA_PERMISSAO = "mcp__board-permissao__pedir";
export const MCP_PERMISSAO = join(ROOT, "permissao-mcp.mjs");

export const pendentes = new Map(); // id → cartão (+ resolver, timer — fora do que vai à tela)
const umaVez = new Map(); // slug → [regras exatas] para o PRÓXIMO turno da conversa (o "permitir uma vez" do barrado)

/** Os argumentos que ligam o caminho 1 num `claude`. `de` = { slug, tarefa?, papel } — quem vai aparecer no cartão. */
export function argsPermissao(de) {
  if (!PERMISSAO_LIGADA) return [];
  const cfg = { mcpServers: { "board-permissao": { command: process.execPath, args: [MCP_PERMISSAO],
    env: { BOARD_URL: `http://127.0.0.1:${PORT}`, BOARD_PERMISSAO_DE: JSON.stringify(de) } } } };
  return ["--mcp-config", JSON.stringify(cfg), "--permission-prompt-tool", FERRAMENTA_PERMISSAO];
}

// ── regras "sempre permitir" por projeto (data/permissoes.json = { "regras": { slug: ["Bash(git push *)", …] } }) ──
export function lerRegras() {
  try { const d = JSON.parse(readFileSync(PERMISSOES_FILE, "utf8")); return d && typeof d.regras === "object" ? d : { regras: {} }; }
  catch { return { regras: {} }; }
}
export const regrasDe = (slug) => (lerRegras().regras[slug] || []).filter((r) => regraSegura(r));
function gravarRegra(slug, regra) {
  const d = lerRegras();
  if (!regraSegura(regra)) throw Object.assign(new Error("regra recusada: " + regra), { status: 400 });
  const l = d.regras[slug] = d.regras[slug] || [];
  if (!l.includes(regra)) l.push(regra);
  writeFileSync(PERMISSOES_FILE, JSON.stringify(d, null, 2) + "\n");
}
export function tirarRegra(slug, regra) {
  const d = lerRegras();
  d.regras[slug] = (d.regras[slug] || []).filter((r) => r !== regra);
  if (!d.regras[slug].length) delete d.regras[slug];
  writeFileSync(PERMISSOES_FILE, JSON.stringify(d, null, 2) + "\n");
}

/*
 * A regra vai para o `--allowedTools`, que o CLI separa por VÍRGULA (QA da #232, provado com o claude real: com
 * "Bash(ls),Bash(touch *)" o `touch` rodou). Entrada do agente com `,` `(` `)` vira OUTRA regra: um file_path
 * "/tmp/a),Bash(*" fazia o "permitir uma vez" liberar todo Bash. E `*` vira curinga ("rm *" como comando exato liberaria
 * todo rm). Por isso o pedaço que vem do agente não pode ter `( ) , *` nem quebra de linha — senão não há regra (null) —,
 * e toda regra passa por `regraSegura` antes de entrar no `--allowedTools`, inclusive as do data/permissoes.json.
 */
const TRECHO_SEGURO = /^[^(),*\n\r]+$/;
const seguro = (t) => TRECHO_SEGURO.test(String(t));
export const regraSegura = (r) => typeof r === "string" && (/^[\w-]+$/.test(r)
  || /^[\w-]+\((?:domain:[a-z0-9.-]+|[^(),*\n\r]+?(?: \*|\/\*\*)?)\)$/i.test(r));
/** O que acrescentar ao `--allowedTools` de um processo deste projeto: as regras "sempre" + as "uma vez" pendentes. */
export const regrasExtras = (slug) => [...regrasDe(slug), ...(umaVez.get(slug) || [])].filter(regraSegura);
export const comRegras = (tools, slug) => [tools, ...regrasExtras(slug)].filter(Boolean).join(",");
export const umaVezDe = (slug) => [...(umaVez.get(slug) || [])];
/** O turno que levou as regras "uma vez" acabou: só ELAS saem (o próximo processo nasce sem); as que o dono deu no meio ficam. */
export function gastarUmaVez(slug, usadas = []) {
  const resto = (umaVez.get(slug) || []).filter((r) => !usadas.includes(r));
  if (resto.length) umaVez.set(slug, resto); else umaVez.delete(slug);
}

// Comando com mais de um comando dentro nunca casa com regra de prefixo: "git status && rm -rf x" não pode passar pela
// regra "Bash(git status *)". Qualquer & (&&, & em segundo plano, &>), |, ;, crase, $(…), redirecionamento (> <, que
// pega também <( e >( ) e quebra de linha (\n ou \r) contam — o revisor da #232 achou "git status & rm -rf ~/x" passando.
const COMPOSTO = /[&|;`\n\r<>]|\$\(/;
const descreveEntrada = (ferramenta, e = {}) => e.command || e.file_path || e.notebook_path || e.url || e.path || e.pattern
  || (ferramenta.startsWith("mcp__") ? JSON.stringify(e) : "") || "";

/** A regra EXATA desta ação (permitir uma vez). null = a entrada não cabe numa regra sem virar outra (ver regraSegura). */
export function regraExata(ferramenta, e = {}) {
  let r = ferramenta;
  if (ferramenta === "Bash") r = e.command && seguro(e.command) ? `Bash(${e.command})` : null;
  else if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(ferramenta)) { const p = e.file_path || e.notebook_path; r = p && seguro(p) ? `Edit(/${p})` : null; }
  else if (ferramenta === "Read") r = e.file_path && seguro(e.file_path) ? `Read(/${e.file_path})` : null;
  else if (ferramenta === "WebFetch") { try { r = `WebFetch(domain:${new URL(e.url).hostname})`; } catch { r = null; } }
  return regraSegura(r) ? r : null;
}

/** A regra do TIPO (sempre permitir): "git push …" → Bash(git push *); arquivo → a pasta dele. null = não dá para generalizar. */
export function regraDoTipo(ferramenta, e = {}) {
  if (ferramenta === "Bash") {
    const cmd = String(e.command || "").trim();
    if (!cmd || COMPOSTO.test(cmd)) return null; // comando composto: só "uma vez"
    const [a, b] = cmd.split(/\s+/);
    const pre = b && /^[a-z][\w.-]*$/i.test(b) ? `${a} ${b}` : a;
    return seguro(pre) && regraSegura(`Bash(${pre} *)`) ? `Bash(${pre} *)` : null;
  }
  if (/^(Edit|Write|MultiEdit|NotebookEdit|Read)$/.test(ferramenta)) {
    const p = String(e.file_path || e.notebook_path || "");
    if (!p.startsWith("/") || !seguro(p)) return null;
    const r = `${ferramenta === "Read" ? "Read" : "Edit"}(/${p.replace(/\/[^/]*$/, "")}/**)`;
    return regraSegura(r) ? r : null;
  }
  if (ferramenta === "WebFetch") return regraExata(ferramenta, e);
  return regraSegura(ferramenta) ? ferramenta : null;
}

/** A regra cobre esta ação? (o board responde sozinho o pedido que uma regra "sempre" já cobre) */
export function regraCobre(regra, ferramenta, e = {}) {
  const m = String(regra).match(/^([\w-]+)(?:\((.*)\))?$/s);
  if (!m) return false;
  const [, nome, conteudo] = m;
  const grupoEdit = /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(ferramenta) ? "Edit" : ferramenta;
  if (nome !== ferramenta && nome !== grupoEdit) return false;
  if (conteudo === undefined) return true;
  if (ferramenta === "Bash") {
    const cmd = String(e.command || "").trim();
    if (conteudo.endsWith(" *")) { const pre = conteudo.slice(0, -2); return !COMPOSTO.test(cmd) && (cmd === pre || cmd.startsWith(pre + " ")); }
    return cmd === conteudo;
  }
  if (/^(Edit|Read)$/.test(nome)) {
    const p = "/" + String(e.file_path || e.notebook_path || "");
    if (conteudo.endsWith("/**")) { const dir = conteudo.slice(0, -3); return p.startsWith(dir + "/") && !p.slice(dir.length).includes("/../"); }
    return p === conteudo;
  }
  if (nome === "WebFetch" && conteudo.startsWith("domain:")) { try { return new URL(e.url).hostname === conteudo.slice(7); } catch { return false; } }
  return false;
}

// ── os cartões ──────────────────────────────────────────────────────────────
const logDe = (de) => de.tarefa ? de.tarefa : `conversa-${de.slug}`;
const publico = ({ resolver, timer, ...c }) => c;
export const listarPendentes = () => [...pendentes.values()].map(publico);
export const historico = (n = 50) => readLog(LOG_PERMISSOES).slice(-n);

function novoCartao(tipo, de, ferramenta, entrada, extra = {}) {
  const c = {
    id: randomBytes(6).toString("hex"), tipo, de, ferramenta, entrada,
    acao: cut(descreveEntrada(ferramenta, entrada) || ferramenta, 2000),
    regraUmaVez: regraExata(ferramenta, entrada), regraSempre: regraDoTipo(ferramenta, entrada),
    em: now(), ...extra,
  };
  pendentes.set(c.id, c);
  logEvent(LOG_PERMISSOES, { t: "pedido", id: c.id, tipo, de, ferramenta, acao: c.acao, ...(extra.motivo ? { motivo: extra.motivo } : {}) });
  logEvent(logDe(de), { t: "permissao", id: c.id, tipo, ferramenta, acao: c.acao, ...(extra.motivo ? { motivo: extra.motivo } : {}) });
  broadcast("permissao", { novo: publico(c) });
  return c;
}

function fechar(c, decisao, quem, extra = {}) {
  pendentes.delete(c.id);
  clearTimeout(c.timer);
  logEvent(LOG_PERMISSOES, { t: "resposta", id: c.id, de: c.de, ferramenta: c.ferramenta, acao: c.acao, decisao, quem, ...extra });
  logEvent(logDe(c.de), { t: "permissao-resposta", id: c.id, decisao, quem, ferramenta: c.ferramenta, acao: c.acao, ...extra });
  broadcast("permissao", { fechado: c.id, decisao });
}

/**
 * Caminho 1: a ferramenta do CLI pergunta e ESPERA. Devolve o que o CLI entende: {behavior:"allow", updatedInput} ou
 * {behavior:"deny", message}. Regra "sempre" do projeto que cobre a ação responde na hora (e fica no registro).
 */
export function pedirPermissao({ de = {}, tool_name, input = {} } = {}) {
  const ferramenta = String(tool_name || "");
  const slug = String(de.slug || "");
  if (!ferramenta || !slug) return Promise.resolve({ behavior: "deny", message: "pedido sem ferramenta ou sem projeto" });
  const dono = { slug, ...(de.tarefa ? { tarefa: String(de.tarefa) } : {}), papel: String(de.papel || "agente") };
  const regra = regrasDe(slug).find((r) => regraCobre(r, ferramenta, input));
  if (regra) {
    logEvent(LOG_PERMISSOES, { t: "resposta", de: dono, ferramenta, acao: cut(descreveEntrada(ferramenta, input), 500), decisao: "permitida", quem: `regra "${regra}"` });
    return Promise.resolve({ behavior: "allow", updatedInput: input });
  }
  let id = null;
  const p = new Promise((ok) => {
    const c = novoCartao("pedido", dono, ferramenta, input, { expira: new Date(Date.now() + PERMISSAO_MS).toISOString() });
    c.resolver = ok; id = c.id;
    c.timer = setTimeout(() => {
      if (!pendentes.has(c.id)) return;
      fechar(c, "negada", `sem resposta em ${PERMISSAO_MS / 60000} min`);
      ok({ behavior: "deny", message: `O dono não respondeu ao pedido de permissão em ${PERMISSAO_MS / 60000} min: negado. Não tente de novo do mesmo jeito; siga com o resto e diga no resumo o que ficou faltando.` });
    }, PERMISSAO_MS);
  });
  p.id = id; // quem segura o HTTP aberto precisa dele para cancelar se a ferramenta cair
  return p;
}

/** A ferramenta caiu (o processo do agente morreu, o HTTP fechou): o cartão some, com o motivo no registro. */
export function abandonarPedido(id, motivo) {
  const c = pendentes.get(id);
  if (!c || c.tipo !== "pedido") return;
  fechar(c, "cancelada", motivo);
  c.resolver?.({ behavior: "deny", message: motivo });
}

const vistos = new Set(); // tool_use_id já virou cartão (o stream repete em algumas situações)
/** Caminho 2: o classificador do modo auto barrou. Chamado pela conversa ao ler o stream. */
export function registrarBarrado({ slug, ferramenta, entrada = {}, motivo = "", toolUseId = "" }) {
  if (!PERMISSAO_LIGADA || !slug || !ferramenta) return null;
  if (toolUseId) { if (vistos.has(toolUseId)) return null; vistos.add(toolUseId); }
  return novoCartao("barrado", { slug, papel: slug === "central" ? "central" : "conversa" }, ferramenta, entrada, { motivo: cut(motivo, 300) });
}
export const MOTIVO_CLASSIFICADOR = /denied by the Claude Code auto mode classifier(?:\. Reason: \[?([^\].]*)\]?)?/i;

/** Quem manda o "rode de novo" quando o dono permite um barrado: a conversa registra (sem importar este módulo de volta). */
export const ganchos = { permitiuBarrado: null };

/**
 * A resposta do dono (só a rota com o Origin da tela chama). acao: "uma" | "sempre" | "negar".
 * Devolve o cartão fechado; erro com status quando não existe ou a ação não serve.
 */
export function responderPermissao(id, acao, quem = "o dono (clique na tela)") {
  const c = pendentes.get(id);
  if (!c) throw Object.assign(new Error("esse pedido não está mais aberto (já respondido ou vencido)"), { status: 404 });
  if (!["uma", "sempre", "negar"].includes(acao)) throw Object.assign(new Error("ação inválida"), { status: 400 });
  if (acao === "sempre" && !c.regraSempre) throw Object.assign(new Error("esta ação não tem um TIPO seguro para liberar sempre (comando composto?): permita uma vez"), { status: 400 });
  const decisao = acao === "negar" ? "negada" : acao === "sempre" ? "permitida sempre" : "permitida uma vez";
  // Barrado sem regra exata segura: não há como liberar SÓ esta ação (a regra viraria outra) — o dono responde no fio.
  if (acao === "uma" && c.tipo === "barrado" && !c.regraUmaVez) throw Object.assign(new Error("esta ação tem caractere que o --allowedTools lê como outra regra ( ( ) , * ): não dá para liberar só ela pelo board — negue ou responda na conversa"), { status: 400 });
  if (acao === "sempre") gravarRegra(c.de.slug, c.regraSempre);
  fechar(c, decisao, quem, acao === "sempre" ? { regra: c.regraSempre } : acao === "uma" && c.tipo === "barrado" ? { regra: c.regraUmaVez } : {});
  if (c.tipo === "pedido") {
    c.resolver(acao === "negar" ? { behavior: "deny", message: "O dono NEGOU pela tela do board. Não tente de novo do mesmo jeito." }
      : { behavior: "allow", updatedInput: c.entrada });
  } else if (acao !== "negar") {
    if (acao === "uma") umaVez.set(c.de.slug, [...(umaVez.get(c.de.slug) || []), c.regraUmaVez]);
    ganchos.permitiuBarrado?.(c, acao);
  }
  broadcast("state");
  return publico(c);
}
