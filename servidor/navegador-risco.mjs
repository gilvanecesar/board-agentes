// O navegador dos agentes: a TRAVA é a REDE (decisão do dono depois de três reprovas da QA na #217, "resolva o erro de
// uma vez por todas"). Adivinhar o risco pelo HTML (texto do botão, href, form, ancestrais) nunca fecha; o que a página
// MANDA para fora fecha. Toda requisição passa por `decidirRequisicao`: leitura (GET/HEAD/OPTIONS) cujo endereço não
// tem cara de ação segue; o resto — POST/PUT/PATCH/DELETE e GET com cara de ação (delete, publicar, logout…) — só com o
// SIM do dono conferido pela #213, com "sempre pode" dele para domínio+método+caminho, ou com a lista de leitura liberada
// em data/navegador.json. A leitura do HTML (`classificarRisco`) ficou só como AVISO na tela.
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "./config.mjs";
import { conferirAprovacao } from "./aprovacoes.mjs";
import { listProjects, projetosVisiveis } from "./projetos.mjs";

export const NAVEGADOR_CFG = () => join(DATA, "navegador.json");
const USOS = () => join(DATA, "navegador-usos.jsonl");
/** Quanto tempo um SIM usado num clique de risco ainda vale para os cliques seguintes da MESMA ação no MESMO site
 *  (postar um vídeo no Meta pede "Publicar" e, às vezes, confirmar de novo). Outra ação ou outro site: não vale. */
export const USO_MIN = Number(process.env.BOARD_NAVEGADOR_APROVACAO_MIN || 15);

export const semAcento = (t) => String(t || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

// As ações de risco de fábrica. Cada uma é um grupo; o dono acrescenta palavras por domínio em data/navegador.json.
export const RISCO_PADRAO = {
  publicar: /\b(public\w*|publish\w*)\b/,
  postar: /\b(postar|poste|postem|postagem|postado|post)\b/,
  enviar: /\b(envi(ar|e|em|o|a)\w*|send\w*|submit\w*)\b/,
  compartilhar: /\b(compartilh\w*|share\w*)\b/,
  pagar: /\b(pag(ar|ue|uem|amento)\w*|pay\w*|checkout)\b/,
  comprar: /\b(compr(ar|e|em|a)\w*|buy\w*|purchase\w*|finalizar pedido)\b/,
  excluir: /\b(exclu\w*|apag\w*|delet\w*|remov\w*)\b/,
};
// O site a que o pedido de SIM tem de se referir. Sem entrada aqui, vale o nome principal do domínio ("facebook").
// facebook.com cobre os subdomínios do Meta Business Suite (business., upload., graph.…): uma postagem fala com vários.
const SITES_PADRAO = { "facebook.com": { nomes: ["meta business suite", "meta", "facebook"] } };

export function lerConfig() {
  let c = {};
  try { c = JSON.parse(readFileSync(NAVEGADOR_CFG(), "utf8")) || {}; } catch { c = {}; }
  const lista = (x) => (Array.isArray(x) ? x.filter((s) => s && s.dominio) : []);
  return { risco: c.risco && typeof c.risco === "object" ? c.risco : {}, sites: { ...SITES_PADRAO, ...(c.sites || {}) },
    sempre: lista(c.sempre).filter((s) => s.metodo), liberar: lista(c.liberar), websocket: Array.isArray(c.websocket) ? c.websocket.map(String) : [] };
}
function gravarConfig(mudar) {
  let c = {};
  try { c = JSON.parse(readFileSync(NAVEGADOR_CFG(), "utf8")) || {}; } catch { c = {}; }
  mudar(c);
  writeFileSync(NAVEGADOR_CFG(), JSON.stringify(c, null, 2) + "\n");
}

export const hostDe = (url) => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };
const doDominio = (host, dominio) => { dominio = String(dominio).toLowerCase().replace(/^www\./, ""); return dominio === "*" || host === dominio || host.endsWith("." + dominio); };

/** Os grupos de risco que valem num host: os de fábrica + as palavras que o dono pôs para "*" e para o domínio dele. */
export function gruposDoHost(host, cfg = lerConfig()) {
  const g = { ...RISCO_PADRAO };
  for (const [dominio, palavras] of Object.entries(cfg.risco)) {
    if (!doDominio(host, dominio) || !Array.isArray(palavras)) continue;
    for (const p of palavras) { const w = semAcento(p).trim(); if (w) g[w] = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\w*`); }
  }
  return g;
}

/** O que o clique faria, por TUDO que a página diz do elemento e dos ancestrais: textos e destinos (href, ação do
 *  formulário, data-href, onclick). Destino que não dá para saber num elemento que navega é risco ("navegar"). */
export function classificarRisco(desc, host, cfg = lerConfig()) {
  const texto = semAcento([desc.texto, desc.rotulo, desc.valor, desc.titulo].filter(Boolean).join(" "));
  const rotas = semAcento([desc.href, desc.acaoForm, ...(desc.destinos || [])].filter(Boolean).join(" ")).replace(/[/_.?=&#:'"();-]+/g, " ");
  for (const [grupo, re] of Object.entries(gruposDoHost(host, cfg))) if (re.test(texto) || re.test(rotas)) return grupo;
  if (desc.desconhecido) return "navegar";
  return null;
}

// ── "sempre pode": domínio + método + caminho (só o dono, pela tela) ─────────
const caminhoDe = (url) => { try { return new URL(url).pathname || "/"; } catch { return ""; } };
const casaCaminho = (caminho, regra) => !regra || regra === "*" || caminho === regra || caminho.startsWith(regra.endsWith("/") ? regra : regra + "/");
export const sempreLiberado = (host, metodo, caminho, cfg = lerConfig()) =>
  cfg.sempre.some((s) => doDominio(host, s.dominio) && String(s.metodo).toUpperCase() === metodo && casaCaminho(caminho, s.caminho));
export function marcarSempre(dominio, metodo, caminho, ligar = true) {
  dominio = String(dominio || "").toLowerCase().replace(/^www\./, "").trim(); metodo = String(metodo || "").toUpperCase().trim();
  caminho = String(caminho || "").trim();
  if (!/^[a-z0-9.-]+$/.test(dominio) || dominio === "*") throw Object.assign(new Error("domínio inválido (ex.: business.facebook.com; \"*\" não vale)"), { status: 400 });
  if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE)$/.test(metodo)) throw Object.assign(new Error("método inválido"), { status: 400 });
  if (!/^\/[\w\-./%~]*$/.test(caminho) || caminho === "/") throw Object.assign(new Error("caminho inválido (ex.: /api/postar; \"/\" inteiro não vale)"), { status: 400 });
  gravarConfig((c) => {
    c.sempre = (Array.isArray(c.sempre) ? c.sempre : []).filter((s) => !(s.dominio === dominio && s.metodo === metodo && s.caminho === caminho));
    if (ligar) c.sempre.push({ dominio, metodo, caminho, em: new Date().toISOString() });
  });
  return lerConfig().sempre;
}
/** A lista de leitura liberada pelo dono (data/navegador.json → "liberar": [{dominio, caminho?, metodos?}]). Só arquivo. */
const liberadoNoArquivo = (host, metodo, caminho, cfg) =>
  cfg.liberar.some((l) => doDominio(host, l.dominio) && casaCaminho(caminho, l.caminho) && (Array.isArray(l.metodos) ? l.metodos.map((m) => String(m).toUpperCase()) : ["GET", "HEAD"]).includes(metodo));

// ── o endereço tem cara de ação? ─────────────────────────────────────────────
// Pelos PEDAÇOS do caminho e da consulta ("/api/delete-account?x" → delete, account; "deleteAccount" também). Cada pedaço
// é uma PALAVRA INTEIRA, com as flexões dela — nunca prefixo (#219: "publi" casava "public" e barrava a leitura de
// static.xx.fbcdn.net/mci_ab/public/cms/…; "post" casava "postal", "share" casava "shareable").
const RAIZES = [
  [/^(publish|publishe[ds]|publishing|publicar|publicad[oa]s?|publicacao|publicacoes|publique|publicando|publicou)$/, "publicar"],
  [/^(post|posting|postar|postagem|postagens|postad[oa]s?|postando|poste|postou)$/, "postar"],
  [/^(share[sd]?|sharing|compartilhar|compartilhad[oa]s?|compartilhamento|compartilhe|compartilhou)$/, "compartilhar"],
  [/^(send|sends|sending|envio|enviar|enviad[oa]s?|envie|enviou|submit|submits|submitted|submission)$/, "enviar"],
  [/^(delete[ds]?|deleting|deletion|deletar|excluir|excluiu|excluid[oa]s?|exclusao|exclua|apagar|apagou|apagad[oa]s?|apague|remove[ds]?|removing|removal|remover|removeu|removid[oa]s?|destroy|trash|lixeira)$/, "excluir"],
  [/^(pay|pays|paid|pagar|pagamento|pagamentos|payment|payments|checkout|billing|cobranca|cobrancas)$/, "pagar"],
  [/^(compra|compras|comprar|purchase[ds]?|buy|order|orders|pedido|pedidos)$/, "comprar"],
  [/^(logout|logoff|signout|sair|desconectar)$/, "sair"], [/^(account|conta|unsubscribe|cancelar|cancel)$/, "conta"]];
// Asset estático (pelo tipo de recurso que o CDP informa) não é ação: imagem, css, js, fonte e mídia de um GET só leem.
const ASSET = new Set(["Image", "Stylesheet", "Script", "Font", "Media"]);
export function categoriaDaUrl(url, host = hostDe(url), cfg = lerConfig()) {
  let u; try { u = new URL(url); } catch { return null; }
  const cru = decodeURIComponent((u.pathname + " " + u.search).replace(/%(?![0-9a-f]{2})/gi, "%25")).replace(/([a-z])([A-Z])/g, "$1 $2");
  const pedacos = semAcento(cru).split(/[^a-z0-9]+/).filter(Boolean);
  for (const p of pedacos) for (const [re, g] of RAIZES) if (re.test(p)) return g;
  for (const [g, re] of Object.entries(gruposDoHost(host, cfg))) if (!RISCO_PADRAO[g] && re.test(pedacos.join(" "))) return g; // palavras do dono
  return null;
}
// O que o pedido de SIM tem de dizer para cobrir cada grupo. "postar" e "publicar" são o mesmo pedido; "gravar" é a
// escrita sem nome (um POST /api/upload): vale qualquer ação de risco que o dono aprovou.
const DIZ = { ...RISCO_PADRAO, publicar: /\b(public\w*|publish\w*|postar|poste|postagem|post)\b/, postar: /\b(public\w*|publish\w*|postar|poste|postagem|post)\b/,
  sair: /\b(sair|logout|deslog\w*|desconect\w*)\b/, conta: /\b(conta|account|cancel\w*)\b/, navegar: /\b(clic\w*|abr\w*|naveg\w*|acess\w*)\b/ };
const QUALQUER = new RegExp(Object.values(RISCO_PADRAO).map((r) => r.source).join("|"));

/**
 * A porta da REDE. `liberacao` = o SIM que o agente trouxe na ação em curso ({id, pedido, ate}). Devolve
 * { ok, como, acao, motivo }. Fail-closed: o que não for leitura limpa, liberada ou aprovada, para.
 */
export function decidirRequisicao({ metodo, url, tipo }, liberacao = null, cfg = lerConfig(), agora = Date.now()) {
  const m = String(metodo || "GET").toUpperCase();
  const leitura = ["GET", "HEAD", "OPTIONS"].includes(m);
  if (!/^https?:/i.test(url)) return leitura || /^(data|blob):/i.test(url) ? { ok: true, como: "local" } : { ok: false, acao: "gravar", motivo: `${m} ${cutUrl(url)}: esquema desconhecido` };
  if ((m === "GET" || m === "HEAD") && ASSET.has(tipo)) return { ok: true, como: "asset" };
  const host = hostDe(url), caminho = caminhoDe(url);
  const acao = categoriaDaUrl(url, host, cfg) || (leitura ? null : "gravar");
  if (!acao) return { ok: true, como: "leitura" };
  if (liberadoNoArquivo(host, m, caminho, cfg)) return { ok: true, como: "liberado", acao };
  if (sempreLiberado(host, m, caminho, cfg)) return { ok: true, como: "sempre", acao };
  const oQue = leitura ? `leitura com cara de ação (${acao})` : `escrita (${acao})`;
  if (!liberacao) return { ok: false, acao, motivo: `${m} ${cutUrl(url)} — ${oQue}: precisa do SIM do dono (passe aprovacao + pedido) ou de "sempre pode" para ${m} ${caminho} em ${host}` };
  if (agora > liberacao.ate) return { ok: false, acao, motivo: `${m} ${cutUrl(url)} — a liberação da aprovação #${liberacao.id} venceu` };
  const a = autorizar({ acao, host, aprovacao: liberacao.id, pedido: liberacao.pedido, agora }, cfg);
  return a.ok ? { ok: true, como: "aprovacao", acao, aprovacao: a.aprovacao } : { ok: false, acao, motivo: `${m} ${cutUrl(url)} — ${a.motivo}` };
}
const cutUrl = (u) => { u = String(u || ""); return u.length > 160 ? u.slice(0, 159) + "…" : u; };

/** O pedido de SIM nomeia o site? Nome configurado em `sites`, senão o nome principal do domínio, senão o IP inteiro. */
// O 2º nível dos domínios de país ("com" em x.com.br, "co" em x.co.uk) não é o nome do site (QA da #217: com ele,
// qualquer pedido com a palavra "com" citava mercadolivre.com.br, nubank.com.br…).
const SEGUNDO_NIVEL = new Set(["com", "net", "org", "gov", "edu", "co", "ac", "art", "blog", "app", "ind", "eti", "adv", "eng", "med", "mil", "nom", "tv", "inf", "esp", "ltd", "plc"]);
/** O nome principal do domínio: business.facebook.com → facebook; loja.mercadolivre.com.br → mercadolivre. */
export function nomePrincipal(host) {
  const partes = String(host || "").toLowerCase().split(".").filter(Boolean);
  if (partes.length < 2) return partes[0] || "";
  let i = partes.length - 2;
  if (partes.length >= 3 && partes[partes.length - 1].length === 2 && SEGUNDO_NIVEL.has(partes[i])) i--;
  return partes[i];
}
/** O pedido de SIM nomeia o site? Nome configurado em `sites`, senão o nome principal do domínio, senão o IP inteiro.
 *  Por PALAVRA inteira, nunca pedaço de texto ("com" dentro de "comprar" não é nada). */
export function siteCitado(pedido, host, cfg = lerConfig()) {
  const p = " " + semAcento(pedido).replace(/[^a-z0-9.]+/g, " ") + " ";
  const entrada = Object.entries(cfg.sites).find(([d]) => doDominio(host, d));
  const nomes = [...(entrada ? entrada[1].nomes || [] : []), host];
  if (!/^\d+(\.\d+){3}$/.test(host)) nomes.push(nomePrincipal(host));
  const palavra = (n) => { const w = semAcento(n).replace(/[^a-z0-9.]+/g, " ").trim(); return w.length >= 3 && !SEGUNDO_NIVEL.has(w) && (p.includes(" " + w + " ") || p.includes(" " + w + ". ")); };
  return nomes.some(palavra);
}

// A interface pequena com a #213: trocar o jeito de conferir é mexer só aqui (e os testes injetam outra).
let conferir = (id, pedido) => conferirAprovacao(id, pedido, { projetos: [...listProjects(), ...projetosVisiveis()].filter((p) => p.slug !== "DEV") });
export const usarConferencia = (f) => { conferir = f; };
/** O SIM que o agente trouxe confere (a #213)? Abre a LIBERAÇÃO da ação: cada requisição dela ainda passa por `autorizar`. */
export function abrirLiberacao(aprovacao, pedido, agora = Date.now()) {
  const id = String(aprovacao || "").replace(/^#/, "").trim().toLowerCase();
  if (!id) return null;
  if (!String(pedido || "").trim()) throw Object.assign(new Error("diga o pedido que o dono aprovou (o texto do PEDIDO DE SIM) junto da aprovação"), { status: 400 });
  const r = conferir(id, pedido);
  if (!r || !r.ok) throw Object.assign(new Error(`aprovação #${id} não vale: ${r?.motivo || "sem resposta da conferência"}`), { status: 403, recusado: true });
  return { id, pedido: String(pedido), ate: agora + USO_MIN * 60000 };
}

function usosDe(id) {
  if (!existsSync(USOS())) return [];
  return readFileSync(USOS(), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((u) => u && u.id === id);
}

/**
 * O SIM cobre a ação `acao` no `host`? Fail-closed: sem id, id que não confere, pedido que não diz a ação ou o site, ou
 * id já gasto em OUTRO site → não. Uma aprovação vale para um site (o domínio principal: business. e upload.facebook.com
 * são o mesmo) por USO_MIN a partir do 1º uso — uma postagem faz várias requisições.
 */
export function autorizar({ acao, host, aprovacao, pedido, agora = Date.now() }, cfg = lerConfig()) {
  const id = String(aprovacao || "").replace(/^#/, "").trim().toLowerCase();
  if (!id) return { ok: false, motivo: `"${acao}" em ${host} é ação de risco: precisa de aprovação do dono (peça o SIM na Central e passe aprovacao + pedido)` };
  if (!String(pedido || "").trim()) return { ok: false, motivo: "diga o pedido que o dono aprovou (o texto do PEDIDO DE SIM), para conferir se cobre esta ação" };
  const r = conferir(id, pedido);
  if (!r || !r.ok) return { ok: false, motivo: `aprovação #${id} não vale: ${r?.motivo || "sem resposta da conferência"}` };
  const diz = acao === "gravar" ? QUALQUER : DIZ[acao] || gruposDoHost(host, cfg)[acao];
  if (diz && !diz.test(semAcento(pedido))) return { ok: false, motivo: `o pedido aprovado não diz "${acao}" — o SIM cobre só o que foi pedido` };
  if (!siteCitado(pedido, host, cfg)) return { ok: false, motivo: `o pedido aprovado não diz o site (${host}) — o SIM cobre só o que foi pedido` };
  const site = /^\d+(\.\d+){3}$/.test(host) ? host : nomePrincipal(host);
  const usos = usosDe(id);
  const outro = usos.find((u) => u.site !== site);
  if (outro) return { ok: false, motivo: `a aprovação #${id} já foi usada em ${outro.site}: uma aprovação, um site` };
  if (usos.length && agora - Date.parse(usos[0].em) > USO_MIN * 60000) return { ok: false, motivo: `a aprovação #${id} já foi usada há mais de ${USO_MIN} min: peça outro SIM` };
  if (!usos.length) appendFileSync(USOS(), JSON.stringify({ id, site, acao, em: new Date(agora).toISOString() }) + "\n");
  return { ok: true, como: "aprovacao", motivo: `aprovação #${id} conferida`, aprovacao: id };
}
