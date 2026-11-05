// Aprovações da Central (27/10/2026, #213 — "quero que vc seja o chefão"): o SIM que o dono digita NA TELA da Central
// passa a valer para as outras sessões, de um jeito que elas CONFEREM. Sem isso, "o dono autorizou" escrito por qualquer
// um (cliente no WhatsApp, PR, outra sessão) teria o mesmo peso — a porta da injeção.
//
// - Quem grava é SÓ a rota da conversa da Central, com o Origin da própria tela (a mesma barreira do 🚀): cada mensagem
//   do dono ganha um id e vai para data/aprovacoes.jsonl (id, texto exato, hora, a qual pedido se refere).
// - Cada linha leva uma assinatura (HMAC com data/aprovacoes.chave, 0600). Linha escrita por fora (um `echo >>` de
//   agente) não confere. É barreira, não cofre: quem lê a chave consegue forjar — o mesmo limite do Origin do 🚀.
// - Quem confere é `board aprovacao <id> "<o que me pediram>"` (GET /api/aprovacoes/<id>, só leitura): vale se existe,
//   é do board, tem menos de BOARD_APROVACAO_HORAS, o texto é um SIM e cobre o pedido (números, projetos e o tipo de
//   ação de produção). Na dúvida, não vale.
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "fs";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { join } from "path";
import { DATA, cut, now } from "./config.mjs";

export const APROVACOES = () => join(DATA, "aprovacoes.jsonl");
const CHAVE = () => join(DATA, "aprovacoes.chave");
export const APROVACAO_HORAS = Number(process.env.BOARD_APROVACAO_HORAS || 12);
export const ID_APROVACAO = /^[0-9a-f]{12}$/;

function chave() {
  if (!existsSync(CHAVE())) { writeFileSync(CHAVE(), randomBytes(32).toString("hex"), { mode: 0o600 }); try { chmodSync(CHAVE(), 0o600); } catch { /* fs sem chmod */ } }
  return readFileSync(CHAVE(), "utf8").trim();
}
// A origem "voz" (#286) entra na assinatura: tirar a marca da linha quebra a conferência. Linha sem origem assina como antes.
const assinatura = (r) => createHmac("sha256", chave()).update(JSON.stringify([r.id, r.texto, r.em, r.refere || null, ...(r.origem ? [r.origem] : [])])).digest("hex");

// NFKC antes (5ª reprova da QA na #213): letra de largura cheia ("ｐｕｂｌｉｃａｒ") e ligaduras viram as letras comuns; o que não
// vira [a-z0-9] depois disso (cirílico, chinês, "р" no lugar de "p") é recusado pela conferência, nunca descartado.
const semAcento = (t) => String(t || "").normalize("NFKC").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
// O que sobra fora do alfabeto aceito: letras/números ASCII, espaço, pontuação ASCII e a tipográfica comum (— “ ” ‘ ’ « » ·).
export const foraDoAlfabeto = (t) => [...new Set(semAcento(t).replace(/[a-z0-9\s!-\/:-@\[-`{-~\u2010-\u2015\u2018-\u201f\u00ab\u00bb\u00b7]/g, ""))];
/** Nome da pasta e rótulo do mesmo projeto ("loja-online" = "Loja") viram UM token antes de comparar. */
function comProjetosUnificados(t, projetos) {
  let s = semAcento(t);
  const nomes = projetos.flatMap((p) => [p.slug, p.label].filter(Boolean).map((n) => ({ n: semAcento(n), tok: semAcento(p.slug).replace(/[^a-z0-9]/g, "") })))
    .filter((x) => x.n.length >= 2).sort((a, b) => b.n.length - a.n.length);
  for (const { n, tok } of nomes) s = s.replace(new RegExp(`(^|[^a-z0-9-])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^a-z0-9-])`, "g"), `$1${tok}`);
  return s;
}

/** O pedido de SIM que a Central escreve no fim da resposta (a regra dela manda): "PEDIDO DE SIM: <ação>". */
export function pedidoDeSim(texto) {
  const m = String(texto || "").match(/^[\s>*_-]*PEDIDO DE SIM[*_]*\s*:[*_]*\s*(.+?)\s*$/im);
  return m ? cut(m[1].replace(/[*_`]+$/g, "").trim(), 500) || null : null;
}

/**
 * A qual pedido a mensagem do dono se refere: a resposta citada (↩ R12 / botão Aprovar) ou, sem citação, a última
 * resposta da Central. Guarda o pedido de SIM dela, quando há, e o começo do texto.
 */
export function refereDe(eventos, cita) {
  const res = eventos.filter((e) => e.t === "resultado" && e.texto);
  const ev = cita ? res.find((e) => e.n === cita.n) : res.at(-1);
  if (!ev) return null;
  return { n: ev.n ?? null, pedido: ev.pedidoSim || pedidoDeSim(ev.texto), trecho: cut(ev.texto, 300) };
}

/** Grava a aprovação. Só a rota da Central (e a do modo voz, com `origem: "voz"`) chama, depois de conferir o Origin. */
export function registrarAprovacao({ texto, refere = null, origem = null }) {
  const r = { id: randomBytes(6).toString("hex"), texto: String(texto), em: now(), refere, ...(origem ? { origem } : {}) };
  appendFileSync(APROVACOES(), JSON.stringify({ ...r, assinatura: assinatura(r) }) + "\n");
  return r;
}

function acharAprovacao(id) {
  let raw = ""; try { raw = readFileSync(APROVACOES(), "utf8"); } catch { return null; }
  let achou = null;
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (j.id === id) achou = j; // id repetido: vale a ÚLTIMA linha, que é a que um forjador acrescentaria — e não confere
  }
  return achou;
}

// O "sim" do dono (fail-closed; a QA da #213 achou "faz sentido mesclar o PR 112?" e depois "sim, sem publicar" passando):
// - o texto ABRE com a aprovação ("sim", "pode mesclar", "aprovado", "ok, manda") — palavra no meio não conta; a palavra
//   tem de terminar ali ("s/n" não é "s");
// - pergunta não é SIM: qualquer "?" derruba;
// - nenhuma palavra de recusa, dúvida, RESTRIÇÃO ou mera ciência: "sim, sem publicar", "sim (menos publicar)", "só mescla",
//   "exceto o 113", "fica pra amanhã", "ok, entendi". A conferência acha "publicar" e "113" escritos pelo dono, mas não sabe
//   se ele permitiu ou proibiu — então SIM com ressalva não vale, e o dono que quiser restringir manda um SIM limpo ao
//   pedido certo (o botão Aprovar manda "SIM").
const RECUSA = /\b(nao|nem|nunca|negad[oa]|recuso|cancela\w*|espera|aguarda\w*|depois|calma|pera|mas|porem|antes|talvez|sera|acho|duvida|explica\w*|pergunt\w*|se|sem|menos|exceto|excecao|salvo|tirando|fora|so|somente|apenas|amanha|fica|entendi|entendido|ciente|anotado|visto|vi)\b/;
const PALAVRA_SIM = "(sim|s|pode|aprovad[oa]|aprovo|autorizo|autorizad[oa]|confirmo|confirmad[oa]|ok|okay|manda|segue|bora|faca)";
const ABRE_COM_SIM = new RegExp(`^[\\s"'“(*_-]*${PALAVRA_SIM}(?=$|[\\s,.!;:)*_"'”])`);
export const ehSim = (texto) => { const t = semAcento(texto); return !t.includes("?") && ABRE_COM_SIM.test(t) && !RECUSA.test(t); };
// Só a palavra de aprovação, sem dizer o quê ("SIM", "ok", "pode"): o que ela cobre é o pedido a que responde.
const SO_SIM = /^[\s"'“(*_-]*(sim|s|pode|aprovad[oa]|aprovo|autorizo|autorizad[oa]|confirmo|confirmad[oa]|ok|okay|manda|segue|bora|faca)[\s!.,)*_"'”]*(pode|sim|manda|segue|bora)?[\s!.,)*_"'”]*$/;

// Os tipos de ação que pedem o SIM: um SIM para mesclar não vira SIM para publicar nem para mexer no banco.
const ACOES = [
  ["mesclar", /\b(mescl\w*|merge\w*)\b/],
  ["publicar", /\b(public\w*|deploy\w*|subir|sobe|suba)\b/],
  ["banco", /\b(banco|migra\w*|migration\w*|sql|delete|drop|truncate)\b/],
  ["push", /\b(push\w*)\b/],
  ["enviar", /\b(envi\w*|e-?mail\w*|mensage\w*|whatsapp)\b/],
  ["apagar", /\b(apag\w*|exclu\w*|delet\w*|remov\w*)\b/],
  ["fechar", /\b(fech\w*|close)\b/],
];

/*
 * O que o SIM pode aprovar (3ª reprova da QA na #213: "sim, mescla o 112, nada de publicar" aprovava publicar). A conferência
 * não entende negação, então a regra é de ESTRUTURA, não de lista de palavras:
 * 1. a fonte do que pode ser aprovado é SÓ o pedido a que o dono respondeu (`refere.pedido`, senão o trecho da resposta) —
 *    ação, número ou projeto que aparece só no texto do dono nunca vira cobertura;
 * 2. o dono escreveu mais que um SIM limpo? Cada palavra a mais tem de estar no pedido (ele só repetiu o pedido). Palavra
 *    nova ("nada", "jamais", "segura", "quieto", "negativo") pode ser uma restrição: não vale;
 * 3. repetiu o pedido? A ação e o número conferidos têm de estar TAMBÉM no que ele repetiu ("sim, mesclar o 112" não aprova o
 *    "publicar" do pedido). O projeto pode faltar na repetição: omitir o projeto não restringe nada.
 */
const BASE = (a) => a.refere?.pedido || a.refere?.trecho || "";
const palavrasDe = (t) => semAcento(t).match(/[a-z0-9]+/g) || [];
// Palavras que não dizem o quê: a aprovação em si e as de ligação.
const NEUTRAS = new Set(["sim", "s", "pode", "aprovado", "aprovada", "aprovo", "autorizo", "autorizado", "autorizada", "confirmo",
  "confirmado", "confirmada", "ok", "okay", "manda", "segue", "bora", "faca", "o", "a", "os", "as", "do", "da", "dos", "das", "de",
  "e", "no", "na", "nos", "nas", "em", "um", "uma", "pr", "prs", "isso", "esse", "essa", "este", "esta", "ai", "la", "aqui", "por",
  "favor", "pf", "pfv", "obrigado", "valeu", "tarefa", "numero", "n", "ja", "agora", "entao", "tambem"]);
/** As palavras do dono que não estão no pedido (nem são neutras). Vazia = ele disse SIM e, no máximo, repetiu o pedido. */
export function palavrasAMais(texto, base) {
  const doPedido = palavrasDe(base);
  const noPedido = (w) => doPedido.some((p) => p === w || (w.length >= 5 && p.length >= 5 && (p.startsWith(w.slice(0, 5)))));
  return [...new Set(palavrasDe(texto).filter((w) => !NEUTRAS.has(w) && !noPedido(w)))];
}

/*
 * Cada ação com os SEUS números (6ª reprova da QA na #213: um SIM a "fechar o PR 112 e mesclar o PR 113" conferia "mesclar o
 * PR 112" — as palavras e os números estavam todos no pedido, só que trocados). O texto é partido em trechos que começam num
 * verbo de ação; cada trecho leva os números que vêm depois dele até o próximo verbo (os de antes do 1º verbo vão para ele).
 */
export function trechosDeAcao(t) {
  const marcas = [];
  for (const [grupo, re] of ACOES) for (const m of t.matchAll(new RegExp(re.source, "g"))) marcas.push({ grupo, i: m.index });
  marcas.sort((a, b) => a.i - b.i);
  const posicoes = [...new Set(marcas.map((m) => m.i))];
  const trechos = marcas.map((m) => {
    const k = posicoes.indexOf(m.i), ini = k === 0 ? 0 : m.i, fim = posicoes[k + 1] ?? t.length;
    return { grupo: m.grupo, i: m.i, nums: new Set(t.slice(ini, fim).match(/\d+/g) || []) };
  });
  // Verbos coordenados ("mesclar e fechar o PR 112"): o verbo sem número próprio leva os números do PRÓXIMO trecho que
  // tem número (revisor da #213: "mesclar e fechar o PR 112" escapava da conferência por um trecho vazio ser pulado).
  for (let k = trechos.length - 2; k >= 0; k--)
    if (!trechos[k].nums.size) { const prox = trechos.slice(k + 1).find((x) => x.i > trechos[k].i && x.nums.size); if (prox) trechos[k].nums = new Set(prox.nums); }
  return trechos;
}

export function cobre(aprovacao, acao, projetos = []) {
  const base = semAcento(BASE(aprovacao));
  const limpo = SO_SIM.test(semAcento(aprovacao.texto));
  const doDono = semAcento(aprovacao.texto);
  const pedido = semAcento(acao);
  const faltam = [];
  const numeros = (t) => new Set(t.match(/\d+/g) || []);
  const noPedido = numeros(base), noDono = numeros(doDono);
  for (const n of numeros(pedido)) if (!noPedido.has(n) || (!limpo && !noDono.has(n))) faltam.push(`o número ${n}`);
  const palavra = (t, w) => new RegExp(`(^|[^a-z0-9-])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9-])`).test(t);
  for (const p of projetos) {
    const nomes = [...new Set([p.slug, p.label].filter(Boolean).map(semAcento))].filter((w) => w.length >= 2);
    if (nomes.some((w) => palavra(pedido, w)) && !nomes.some((w) => palavra(base, w))) faltam.push(`o projeto ${p.label || p.slug}`);
  }
  for (const [nome, re] of ACOES) if (re.test(pedido) && (!re.test(base) || (!limpo && !re.test(doDono)))) faltam.push(`a ação "${nome}"`);
  // 4. (revisor da #213: "reiniciar o nginx" e "alterar a env STRIPE_KEY" passavam por qualquer SIM — ação fora da lista
  //    ACOES não era conferida.) Toda palavra do que a sessão recebeu tem de estar no pedido aprovado: o que não está, o
  //    dono não aprovou. Os números já foram contados acima.
  for (const w of palavrasAMais(acao, BASE(aprovacao))) if (!/^\d+$/.test(w)) faltam.push(`"${w}" (não está no pedido)`);
  // 7. Ação e número juntos como no pedido: cada trecho da ação acha no pedido um trecho do mesmo tipo com esses números.
  const doPedidoAprovado = trechosDeAcao(base);
  for (const t of trechosDeAcao(pedido)) {
    if (!t.nums.size) {
      // Ação sem número, quando o pedido aprovado só tem essa ação COM número: não diz qual PR/tarefa — não confere.
      const doGrupo = doPedidoAprovado.filter((b) => b.grupo === t.grupo);
      if (doGrupo.length && doGrupo.every((b) => b.nums.size)) faltam.push(`o número de "${t.grupo}" (no pedido aprovado essa ação tem número)`);
      continue;
    }
    if (!doPedidoAprovado.some((b) => b.grupo === t.grupo && [...t.nums].every((n) => b.nums.has(n))))
      faltam.push(`"${t.grupo}" com ${[...t.nums].map((n) => "o " + n).join(" e ")} (no pedido aprovado essa ação não vai com esse número)`);
  }
  // 5. (4ª reprova da QA na #213: um SIM a "mesclar o PR 112 do Loja" conferia "mesclar" e até "o".) A ação tem de
  //    dizer O QUÊ e ONDE: conteúdo próprio, o projeto que o pedido nomeia e, para o que se faz por PR/tarefa (mesclar,
  //    fechar, apagar), o número quando o pedido tem número.
  if (!palavrasDe(acao).some((w) => !NEUTRAS.has(w))) faltam.push("o que fazer (o pedido conferido está vazio)");
  for (const p of projetos) {
    const nomes = [...new Set([p.slug, p.label].filter(Boolean).map(semAcento))].filter((w) => w.length >= 2);
    if (nomes.some((w) => palavra(base, w)) && !nomes.some((w) => palavra(pedido, w))) faltam.push(`o nome do projeto ${p.label || p.slug} na ação`);
  }
  const porNumero = ACOES.filter(([n]) => ["mesclar", "fechar", "apagar"].includes(n)).some(([, re]) => re.test(pedido));
  if (porNumero && noPedido.size && !numeros(pedido).size) faltam.push("o número (PR/tarefa) na ação");
  return { ok: faltam.length === 0, faltam };
}

/** A conferência que a sessão que recebeu o SIM faz. Fail-closed: qualquer coisa fora do esperado, não vale. */
export function conferirAprovacao(id, acao, { projetos = [], agora = Date.now() } = {}) {
  id = String(id || "").replace(/^#/, "").trim().toLowerCase();
  if (!ID_APROVACAO.test(id)) return { ok: false, motivo: "id de aprovação inválido (são 12 caracteres 0-9a-f)" };
  const j = acharAprovacao(id);
  if (!j) return { ok: false, motivo: `a aprovação #${id} não existe no board` };
  const r0 = { id: j.id, texto: j.texto, em: j.em, refere: j.refere || null, ...(j.origem ? { origem: j.origem } : {}) };
  let assinada = false;
  try { const a = Buffer.from(String(j.assinatura || ""), "hex"), b = Buffer.from(assinatura(r0), "hex"); assinada = a.length === b.length && timingSafeEqual(a, b); } catch { assinada = false; }
  if (!assinada) return { ok: false, motivo: `a aprovação #${id} não foi gravada pelo board (assinatura não confere): não vale` };
  const horas = (agora - Date.parse(r0.em)) / 3600000;
  const aprovacao = { ...r0, idadeHoras: Number(horas.toFixed(2)), validaPorHoras: APROVACAO_HORAS };
  // 🔴 #286: mensagem do modo voz nunca é SIM, nem "sim" limpo a um pedido certo: ruído, TV ou outra pessoa podem soar como sim.
  if (r0.origem) return { ok: false, motivo: "SIM por voz não vale: use o ✓ Aprovar", aprovacao };
  if (!(horas >= -0.1 && horas <= APROVACAO_HORAS)) return { ok: false, motivo: `a aprovação #${id} venceu (tem ${horas.toFixed(1)} h; vale ${APROVACAO_HORAS} h)`, aprovacao };
  if (!ehSim(r0.texto)) return { ok: false, motivo: "o texto do dono não é um SIM", aprovacao };
  // Daqui em diante tudo é comparado com o nome da pasta e o rótulo de cada projeto unificados (o que a tela mostra é o original).
  const uni = (t) => (t == null ? t : comProjetosUnificados(t, projetos));
  const r = { ...r0, texto: uni(r0.texto), refere: r0.refere && { ...r0.refere, pedido: uni(r0.refere.pedido), trecho: uni(r0.refere.trecho) } };
  const projetosUni = projetos.map((p) => { const tok = semAcento(p.slug).replace(/[^a-z0-9]/g, ""); return { slug: tok, label: p.label || p.slug }; });
  // "SIM" solto sem pedido a que se refira não aprova nada — senão cobriria qualquer ação que não cite número nem projeto.
  // O SIM só aprova o pedido a que respondeu: sem pedido nem resposta da Central antes dele, não aprova nada.
  if (!BASE(r)) return { ok: false, motivo: "o SIM do dono não diz a que se refere (não há pedido nem resposta da Central antes dele)", aprovacao };
  // 4ª reprova da QA: "mesclar o PR 112, não publicar" é um pedido que NEGA uma ação; a conferência não entende negação e
  // leria "publicar" como aprovado. Pedido com negação/restrição não serve de base — a Central pede só o que será feito.
  const ressalva = semAcento(BASE(r)).match(RECUSA);
  if (ressalva) return { ok: false, motivo: `o pedido aprovado tem negação ou restrição ("${ressalva[1]}"): a conferência não sabe o que ficou de fora — a Central tem de pedir o SIM só com o que será feito`, aprovacao };
  const aMais = SO_SIM.test(semAcento(r.texto)) ? [] : palavrasAMais(r.texto, BASE(r));
  if (aMais.length) return { ok: false, motivo: `o dono escreveu mais do que o SIM ao pedido (${aMais.slice(0, 5).map((w) => `"${w}"`).join(", ")}) — pode ser uma restrição; só vale SIM limpo ou o pedido repetido`, aprovacao };
  if (!String(acao || "").trim()) return { ok: false, motivo: "diga o que te pediram para conferir se o SIM cobre (board aprovacao <id> \"<o pedido>\")", aprovacao };
  // 5ª reprova da QA: palavra fora de [a-z0-9] era DESCARTADA ("e 发布到生产" passava). Fail-closed: recusa.
  const estranhos = foraDoAlfabeto(acao);
  if (estranhos.length) return { ok: false, motivo: `a ação tem caracteres fora do alfabeto aceito (${estranhos.slice(0, 8).join(" ")}): escreva só com letras comuns — não dá para conferir o que não se lê`, aprovacao };
  const c = cobre(r, uni(acao), projetosUni);
  if (!c.ok) return { ok: false, motivo: `o SIM do dono não cobre ${c.faltam.join(", ")}`, aprovacao, faltam: c.faltam };
  return { ok: true, motivo: "confere: o dono disse SIM a isto na tela da Central", aprovacao };
}
