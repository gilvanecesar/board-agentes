// `board tela <destino>` (#293): a Central muda a tela do dono, SÓ navegação (e, desde a #302, abre um link em aba nova). Lista fechada de destinos, resolvida AQUI; a tela
// recebe um destino já validado e confere de novo. 🔴 Não existe destino que clique: Aprovar, Mesclar, Publicar, permissão e
// tecla de sessão continuam atrás do Origin da tela, e este módulo não chama nenhum deles.
//
// "O aparelho que está usando o board agora" = a aba conectada com a interação mais recente (toque, tecla, foco, fala), de até
// BOARD_TELA_ATIVA_MIN atrás. Cada aba tem um id próprio (o da /api/events?tela=) e só ela recebe o pedido. Sem nenhuma: erro.
import { randomBytes } from "crypto";
import { cut } from "./config.mjs";
import { broadcast, logEvent, state, taskById } from "./estado.mjs";
import { projetosVisiveis } from "./projetos.mjs";
import { listarSessoesTerminal } from "./sessoes.mjs";
import { daTela } from "./origem.mjs";
import { apontaParaDentro, lerLink } from "./tela-link.mjs";

const ATIVA_MS = () => Number(process.env.BOARD_TELA_ATIVA_MIN || 30) * 60000;
const ESPERA_MS = () => Number(process.env.BOARD_TELA_ESPERA_MS || 4000);
const ID_TELA = /^[a-z0-9]{8,32}$/;
export const LOG_TELA = "tela";

// A chave é o que se escreve depois de `board tela`; `aba` é a da navegação da tela (`navigateBoard`).
const ABA = (aba, rotulo) => ({ tipo: "aba", aba, rotulo });
const QUADRO = ABA("board", "Meu quadro"), CONVERSAS = ABA("conversa", "Conversas"), PRS = ABA("prs", "Pull Requests");
export const ABAS = {
  quadro: QUADRO, "meu quadro": QUADRO, board: QUADRO,
  central: ABA("central", "Central"),
  conversa: CONVERSAS, conversas: CONVERSAS,
  sessoes: ABA("sessoes", "Sessões"),
  busca: ABA("busca", "Buscar"), buscar: ABA("busca", "Buscar"),
  prs: PRS, "pull requests": PRS, "pull-requests": PRS,
  controle: ABA("controle", "Controle"),
};
// Telas que saíram do menu em 04/11 (pedido do dono). O destino responde ✗ dizendo isso, em vez de "não existe": a Central
// aprende o motivo e não insiste. O que funcionava por baixo (Chrome dos agentes, memória, /api/monitoring, /api/claude-uso) fica.
export const TELAS_REMOVIDAS = {
  navegador: "Navegador", memoria: "Memória", consumo: "Consumo",
  monitoramento: "Monitoramento", monitoring: "Monitoramento", status: "Monitoramento",
};
export const DESTINOS_TXT = "quadro, central, conversa [projeto], sessoes, busca, prs, controle, tarefa <número>, sessao <nome>, link <endereço completo http(s)>";

const normal = (s) => String(s).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
const fora = (texto) => ({ code: 400, erro: `destino "${cut(String(texto), 60)}" não existe. Vale: ${DESTINOS_TXT}` });

// #302: o endereço não passa pelo `normal()`, que trocaria maiúsculas de caminho e consulta.
const ehLink = (texto) => typeof texto === "string" && /^\s*link\s+\S/i.test(texto);
async function destinoDeLink(endereco) {
  const l = lerLink(endereco);
  if (l.erro) return { code: 400, erro: `esse link não abre: ${l.erro}` };
  if (await apontaParaDentro(l.url)) return { code: 400, erro: `esse link não abre: endereço interno: ${l.host}` };
  return { tipo: "link", url: l.url, host: l.host, rotulo: `link ${l.host}` };
}
/** Link abre aba no aparelho do dono: não por agente de tarefa (rodam sem ele olhando) nem em turno de outra sessão da Central. */
function barreiraDoLink(quem) {
  if (/^tarefa\b/i.test(quem)) return { code: 403, erro: "link só abre a pedido do dono: agente de tarefa não abre aba" };
  if (state.conversas?.central?.ouvindo) return { code: 409, erro: "link só abre a pedido do dono: a Central está num turno de outra sessão" };
  return null;
}

/** O texto do comando → destino validado ({tipo, …, rotulo}) ou {code, erro}. Só o que está aqui existe: nada vai cru à tela. */
export async function resolverDestino(texto) {
  if (ehLink(texto)) return destinoDeLink(texto.trim().replace(/^\S+\s+/, ""));
  if (typeof texto !== "string" || !texto.trim() || texto.length > 120) return fora(typeof texto === "string" ? texto : "");
  const t = normal(texto);
  if (Object.hasOwn(ABAS, t)) return ABAS[t];
  const removida = Object.hasOwn(TELAS_REMOVIDAS, t) && TELAS_REMOVIDAS[t];
  if (removida) return { code: 410, erro: `a tela ${removida} foi removida em 04/11 (pedido do dono) e não abre mais. Vale: ${DESTINOS_TXT}` };
  const [cab, ...resto] = t.split(" "), arg = resto.join(" ");
  if (!arg) return fora(texto);
  if (cab === "tarefa") {
    if (!/^#?\d{1,9}$/.test(arg)) return fora(texto);
    const task = taskById(arg.replace("#", ""));
    if (!task) return { code: 404, erro: `a tarefa #${arg.replace("#", "")} não existe` };
    return { tipo: "tarefa", id: task.id, rotulo: `tarefa #${task.id}` };
  }
  if (cab === "conversa" || cab === "conversas") {
    const p = projetosVisiveis().find((x) => normal(x.slug) === arg || normal(x.label) === arg);
    if (!p) return { code: 404, erro: `não há conversa do projeto "${cut(arg, 60)}" na seleção do board` };
    return { tipo: "conversa", slug: p.slug, rotulo: `Conversa de ${p.label}` };
  }
  if (cab === "sessao" || cab === "sessoes") {
    const d = await listarSessoesTerminal({ fresco: true });
    const todas = [...(d.sessoes || []), ...(d.encerradas || [])];
    const achadas = todas.filter((s) => normal(s.nome) === arg || String(s.pid) === arg);
    if (!achadas.length) return { code: 404, erro: `não há sessão "${cut(arg, 60)}" aberta` };
    if (achadas.length > 1) return { code: 409, erro: `há ${achadas.length} sessões "${cut(arg, 60)}": diga o número (pid): ${achadas.map((s) => s.pid).join(", ")}` };
    return { tipo: "sessao", pid: achadas[0].pid, rotulo: `sessão ${achadas[0].nome}` };
  }
  return fora(texto);
}

// ── Quem está usando ────────────────────────────────────────────────────────
const TELAS = new Map(); // id → { res, usadaEm }
const PEDIDOS = new Map(); // id do pedido → { tela, responder }
let ultimaAtual = null;

/** A aba mais recentemente usada, dentro do prazo. Aba só conectada (nunca usada) não conta: ninguém está nela. */
export function telaEmUso() {
  let melhor = null;
  for (const [id, t] of TELAS) if (t.usadaEm && Date.now() - t.usadaEm <= ATIVA_MS() && (!melhor || t.usadaEm > melhor.usadaEm)) melhor = { id, ...t };
  return melhor;
}
/** A aba abriu o canal ao vivo. A saída apaga o registro: quem reconecta avisa de novo há quanto tempo foi usada. */
export function ligarTela(id, res, req) {
  if (!ID_TELA.test(String(id))) return;
  TELAS.set(id, { res, usadaEm: 0 });
  req.on("close", () => { if (TELAS.get(id)?.res === res) TELAS.delete(id); });
}
function marcarUso(id, haMs) {
  const t = TELAS.get(id); if (!t) return false;
  t.usadaEm = Math.max(t.usadaEm, Date.now() - Math.max(0, Number(haMs) || 0));
  const atual = telaEmUso()?.id || null;
  if (atual !== ultimaAtual) { ultimaAtual = atual; broadcast("tela-atual", { tela: atual }); } // a aba que deixou de ser a atual volta a avisar na hora
  return true;
}

/** Leva a tela em uso ao destino e espera ela dizer o que fez: quem pede nunca ouve "mudou" sem a tela ter respondido. */
export async function levarTela(texto, quemPediu) {
  const quem = cut(String(quemPediu || "não informado"), 80);
  const d = await resolverDestino(texto), link = ehLink(texto);
  const registrar = (resultado, extra = {}) => logEvent(LOG_TELA, { t: "tela", destino: d.rotulo || "link", ...(link ? { url: d.url || cut(texto, 2100) } : {}), quem, resultado, ...extra });
  const barrado = d.erro ? d : link ? barreiraDoLink(quem) : null;
  if (barrado) { if (link) registrar("recusado", { motivo: barrado.erro }); return { code: barrado.code, error: barrado.erro }; }
  const alvo = telaEmUso();
  if (!alvo) { if (link) registrar("ninguém usando"); return { code: 409, error: `ninguém está usando o board agora: nenhuma tela aberta foi usada nos últimos ${Math.round(ATIVA_MS() / 60000)} min` }; }
  const pedido = randomBytes(8).toString("hex"), { rotulo } = d;
  let aceitou = false;
  const resposta = new Promise((ok) => {
    const vencer = () => { PEDIDOS.delete(pedido); ok(null); };
    let timer = setTimeout(vencer, ESPERA_MS());
    PEDIDOS.set(pedido, { tela: alvo.id, link, get aceitou() { return aceitou; },
      aceitar: () => { aceitou = true; clearTimeout(timer); timer = setTimeout(vencer, ESPERA_MS()); },
      responder: (r) => { clearTimeout(timer); PEDIDOS.delete(pedido); ok(r); } });
  });
  // Só para esta aba: é aqui que as outras abas e aparelhos ficam de fora.
  alvo.res.write(`event: tela-destino\ndata: ${JSON.stringify({ ...d, pedido })}\n\n`);
  const resultado = await resposta;
  registrar(resultado || "sem resposta");
  if (!resultado) return { code: 504, error: aceitou ? `a tela aceitou o ${rotulo} e não disse se abriu` : `a tela em uso não respondeu: ela não mudou (${rotulo})` };
  if (resultado === "recusou") return { code: 400, error: `a tela recusou o destino ${rotulo}` };
  return { code: 200, ok: true, resultado, destino: rotulo, ...(link ? { link: true } : {}) };
}

// A aba nova tem de abrir DEPOIS de saber que o pedido vale (vencido não abre) e o resultado só existe depois de abrir: link responde duas vezes.
const RESPOSTAS = { tela: ["mudou", "segurou", "recusou"], link: ["abrindo", "segurou", "recusou"], aceito: ["abriu", "bloqueou"] };
const respostaVale = (p, r) => RESPOSTAS[!p.link ? "tela" : p.aceitou ? "aceito" : "link"].includes(r);

export async function rotaTela(req, res, url, { json, readBody }) {
  const path = url.pathname;
  if (req.method !== "POST" || !path.startsWith("/api/tela")) return false;
  const daPropriaTela = daTela(req);
  if (req.headers.origin && !daPropriaTela) { json(res, 403, { error: "só a tela do board ou a CLI pedem isto" }); return true; }
  if (path === "/api/tela") {
    const b = await readBody(req);
    const { code, ...r } = await levarTela(b.destino, b.quem);
    json(res, code, r);
    return true;
  }
  // As duas abaixo são a própria tela falando de si: sem Origin dela, 403 (a CLI não finge ser o aparelho do dono).
  if (path !== "/api/tela/ativa" && path !== "/api/tela/resposta") return false;
  if (!daPropriaTela) { json(res, 403, { error: "só a tela do board informa isto" }); return true; }
  const b = await readBody(req);
  if (path === "/api/tela/ativa") { json(res, marcarUso(b.tela, b.haMs) ? 200 : 409, { ok: TELAS.has(b.tela) }); return true; }
  const p = PEDIDOS.get(b.pedido);
  // Pedido vencido (a tela ficou parada num confirm do navegador, ou no celular dormindo): ela NÃO navega depois.
  if (!p || p.tela !== b.tela || !respostaVale(p, b.resultado)) { json(res, 410, { error: "pedido vencido" }); return true; }
  if (b.resultado === "abrindo") p.aceitar(); else p.responder(b.resultado);
  json(res, 200, { ok: true });
  return true;
}
