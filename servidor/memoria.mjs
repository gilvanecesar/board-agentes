// A memória como galpão: grafo, mentes, romaneio (o picking de cada tarefa) e o inventário da madrugada.
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync } from "fs";
import { join, relative } from "path";
import { COM_ROTINAS, DATA, ESPELHO_MEMORIA, cut, now } from "./config.mjs";
import { logEvent, state } from "./estado.mjs";
import { envMemoria } from "./infra.mjs";
import { configBusca, indexarMemoria, vetoresDaMemoria, vetorDoPedido, parecenca } from "../busca.mjs";

// TEMAS cortam os projetos: a memória de um projeto pode morar quase toda no _global (veio da memória portátil,
// que vale para todos), então "projeto" não acha ela — o tema acha pelo assunto do texto.
// Os temas vêm de data/mentes.json ("temas": {"Nome": "regex"}); sem arquivo, não há temas.
export const temasDaMemoria = () => Object.fromEntries(Object.entries((lerMentes() || {}).temas || {}).map(([k, v]) => [k, new RegExp(v, "i")]));
export let grafoCache = { em: 0, dado: null };
export function tiraCabecalhos(txt) { // as páginas importadas têm DOIS frontmatters (o do ai-memory e o original)
  let t = String(txt); for (let i = 0; i < 3 && /^---\n/.test(t); i++) { const f = t.indexOf("\n---", 4); if (f < 0) break; t = t.slice(f + 4).replace(/^\n+/, ""); }
  return t;
}
// Quando a memória foi mexida DE VERDADE. A data do arquivo não serve: a migração de 25/09/2026 regravou todas.
// Ordem: "modified" (a última edição, que veio da memória do Claude) → "generated.at" (quando entrou no ai-memory).
export function dataDaMemoria(bruto) {
  const m = bruto.match(/^\s+modified:\s*['"]?(\d{4}-\d\d-\d\dT[\d:.]+Z?)/m) || bruto.match(/^generated:\s*\n(?:\s+.*\n)*?\s+at:\s*['"]?(\d{4}-\d\d-\d\dT[\d:.]+Z?)/m);
  const t = m ? Date.parse(m[1]) : NaN;
  return Number.isFinite(t) ? t : null;
}

// ── Mentes: o endereçamento das memórias por ASSUNTO (o porta-palete do Galpão) ─────────────────────────
// Decisão do dono (26/09): 9 mentes + triagem; cada memória mora numa mente só, com "também serve para".
// O mapa vive em data/mentes.json: um agente PROPÕE, o dono confere as duvidosas e aprova. Nada disto escreve
// no ai-memory — levar a mente para lá é outro passo, depois da aprovação.
export const MENTES_PADRAO = [
  { id: "dono", nome: "O Dono", icone: "🧭", desc: "como o dono trabalha e quer as coisas · área comum, todos carregam" },
  { id: "produto", nome: "Produto", icone: "📦", desc: "regras de negócio e funcionalidades do produto" },
  { id: "financeiro", nome: "Financeiro", icone: "💰", desc: "cobrança, pagamentos, dinheiro" },
  { id: "comercial", nome: "Comercial", icone: "📣", desc: "clientes, vendas, marketing" },
  { id: "design", nome: "Design e Telas", icone: "🎨", desc: "padrões de interface" },
  { id: "engenharia", nome: "Engenharia e Infra", icone: "🛠️", desc: "código, deploy, servidores, ferramentas" },
  { id: "seguranca", nome: "Segurança e Qualidade", icone: "🛡️", desc: "auditorias, testes, bugs que se repetem · revisor e QA" },
  { id: "triagem", nome: "Triagem", icone: "📥", desc: "área de recebimento: sem mente clara, ninguém carrega" },
];
// As mentes do dono (e as pistas e a mente de cada projeto) moram em data/mentes.json, fora do git.
export const mentesDef = () => (lerMentes() || {}).definicoes || MENTES_PADRAO;
export const MENTES_FILE = join(DATA, "mentes.json");
export function lerMentes() { try { return JSON.parse(readFileSync(MENTES_FILE, "utf8")); } catch { return null; } }
export function gravarMentes(m) { writeFileSync(MENTES_FILE + ".tmp", JSON.stringify(m, null, 1)); renameSync(MENTES_FILE + ".tmp", MENTES_FILE); }
export function resumoMentes(m) {
  const mapa = (m && m.mapa) || {}; const v = Object.values(mapa);
  const conta = (f) => v.reduce((a, x) => { a[f(x)] = (a[f(x)] || 0) + 1; return a; }, {});
  return { existe: !!m, status: m ? m.status : null, geradoEm: m ? m.geradoEm : null, aprovadaEm: m ? m.aprovadaEm || null : null,
    total: v.length, porMente: conta((x) => x.mente), porConfianca: conta((x) => x.confianca),
    aRevisar: v.filter((x) => x.confianca === "media" || x.confianca === "baixa").length, mentes: mentesDef() };
}

// ── Romaneio: o picking da memória para cada tarefa (a doca do galpão) ─────────────────────────────────
// Na 1ª rodada (ou quando outro motor assume), o board separa as memórias que a tarefa pede e manda junto,
// escritas no pedido — então serve para QUALQUER motor, até sem MCP. Sem IA no picking: palavra do pedido
// contra a memória (IDF), dentro das mentes escolhidas. "O Dono" vai sempre, em forma de lista curta.
// Só roda com o endereçamento APROVADO. Desligar: BOARD_ROMANEIO=0. Tudo fica registrado na tarefa (task.romaneio)
// e na linha do tempo — é isso que permite medir turnos/custo com e sem romaneio.
export const ROMANEIO_LIGADO = process.env.BOARD_ROMANEIO !== "0";
export const PISTAS_PADRAO = {
  financeiro: "\\b(financ|boleto|pix|carteira|saldo|cobranc|assinatura|checkout|preco|plano|fatura|pagamento|dinheiro)",
  comercial: "\\b(crm|lead|campanha|prospec|e-?mail|marketing|funil|landing|cliente)",
  design: "\\b(tela|layout|botao|design|redesign|visual|css|cor|fonte|mobile|responsiv|ux|ui|modal|componente)",
  engenharia: "\\b(deploy|docker|nginx|servidor|backup|build|git|teste|migra|banco|postgres|redis|api|rota|endpoint|script|erro|bug|performance)",
  seguranca: "\\b(seguranc|idor|permiss|acesso|senha|token|auth|login|lgpd|vazamento|ataque|rate limit|valida|auditoria)",
};
export const mentePorProjeto = () => (lerMentes() || {}).mentePorProjeto || {};
export const pistasDaMente = () => Object.fromEntries(Object.entries((lerMentes() || {}).pistas || PISTAS_PADRAO).map(([k, v]) => [k, new RegExp(v)]));
export const PARADAS = new Set("para pelo pela como mais sobre entre quando onde sem com uma um uns umas dos das nos nas que por isso esse essa este esta aqui tudo cada todo toda fazer faz feito tem ter vai vou ser está estão também ainda depois antes agora hoje".split(" "));
export const palavrasDe = (t) => [...new Set(semAcentoServidor(t).match(/[a-z0-9]{4,}/g) || [])].filter((w) => !PARADAS.has(w));
export function semAcentoServidor(t) { return String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(); }
export function montarRomaneio(task, { todasMentes = false, ate = null, sentido = null } = {}) {
  const m = lerMentes(); if (!m || m.status !== "aprovada") return null;
  const g = montarGrafo(); if (!g._porChave) return null;
  const pedido = semAcentoServidor(task.title + " " + task.text);
  const mentes = new Set([mentePorProjeto()[task.project] || "engenharia"]);
  for (const [id, rx] of Object.entries(pistasDaMente())) if (rx.test(pedido)) mentes.add(id);
  const pags = [];
  for (const [chave, end] of Object.entries(m.mapa)) {
    const p = g._porChave.get(chave); if (!p || end.mente === "triagem") continue;
    if (end.soNoProjeto && p.projeto !== task.project) continue;
    if (end.confianca === "media" || end.confianca === "baixa") continue; // proposta ainda não conferida pelo dono // regra de UM projeto (ex.: um "commit + push na main" de um projeto) não viaja
    if (ate && !(new Date(p.atualizada).getTime() < Date.parse(ate))) continue; // experimento: só o que já existia naquela data
    pags.push({ chave, mente: end.mente, tambem: end.tambem || [], p, tit: semAcentoServidor(p.titulo + " " + p.id), desc: semAcentoServidor(p.descricao),
      corpo: semAcentoServidor(p.titulo + " " + p.id + " " + p.descricao + " " + tiraCabecalhos(p.bruto).slice(0, 4000)) });
  }
  // IDF: palavra rara na memória pesa mais que palavra que aparece em tudo.
  const df = {}; for (const x of pags) for (const w of new Set(x.corpo.match(/[a-z0-9]{4,}/g) || [])) df[w] = (df[w] || 0) + 1;
  const termos = palavrasDe(task.title + " " + task.text).filter((w) => df[w]);
  // Onde a palavra aparece conta: no título vale 3, na descrição 2, só no corpo 1. Senão a página longa que cita tudo
  // passa na frente da página que é SOBRE o assunto (medido em 26/09: a página certa perdia para as longas).
  // E o tamanho da página conta (como no BM25): palavra achada SÓ no corpo vale menos numa página longa — senão a página de
  // 30 KB que cita tudo ganhava da regra curta que é exatamente sobre o assunto (medido em 26/09: "drawer lateral" ficava fora).
  // IDF do BM25: palavra presente em metade das páginas ou mais vale ~0 ("board", "projeto", "tarefa" somavam pontos em tudo).
  const idf = (w) => Math.max(0, Math.log((pags.length - df[w] + 0.5) / (df[w] + 0.5)));
  const mediaTam = pags.reduce((a, x) => a + x.corpo.length, 0) / (pags.length || 1);
  // O bônus do MESMO projeto só vale para quem já bateu em alguma palavra do pedido. Antes ele valia sozinho: num projeto
  // com 6+ memórias, as vagas do romaneio iam para páginas sem NADA a ver com o pedido (achado em 27/09, no teste do sentido).
  const nota = (x) => { const encurta = Math.min(1, Math.sqrt(mediaTam / Math.max(1, x.corpo.length)));
    const base = termos.reduce((a, w) => a + (x.corpo.includes(w) ? idf(w) * (x.tit.includes(w) ? 3 : x.desc.includes(w) ? 2 : 0.5 * encurta) : 0), 0);
    return base + (base > 0 && x.p.projeto === task.project ? 1.5 : 0); };
  for (const x of pags) x.nota = nota(x);
  // SENTIDO (27/09): a parecença do pedido com cada memória (bge-m3 local). Palavra e sentido viram dois rankings, juntados
  // pela posição (fusão de rankings: 1/(60+posição) em cada um) — as duas notas não estão na mesma escala, a posição está.
  // Entra quem acha pela palavra OU está perto do melhor achado pelo sentido (≥ 85% dele e ≥ 0,42): no gabarito de 27/09
  // a memória certa sempre ficou a ≥ 86% do melhor, e a mediana das outras, em ~0,40.
  const temSentido = !!(sentido && sentido.vetorPedido);
  if (temSentido) for (const x of pags) { const v = sentido.vetores[x.chave]; x.sim = v ? parecenca(sentido.vetorPedido, v) : null; }
  const posicoes = (lista, campo) => { const m = new Map(); lista.filter((x) => x[campo] != null && x[campo] > 0).sort((a, b) => b[campo] - a[campo]).forEach((x, i) => m.set(x, i + 1)); return m; };
  const fundir = (lista) => {
    const pl = posicoes(lista, "nota"), ps = temSentido ? posicoes(lista, "sim") : new Map();
    const melhor = temSentido ? Math.max(0, ...lista.map((x) => x.sim || 0)) : 0;
    const perto = (x) => temSentido && x.sim != null && x.sim >= Math.max(0.42, melhor * 0.85);
    for (const x of lista) x.peso = (pl.has(x) ? 1 / (60 + pl.get(x)) : 0) + (perto(x) ? 1 / (60 + ps.get(x)) : 0);
    return lista.filter((x) => x.nota > 0 || perto(x)).sort((a, b) => b.peso - a.peso || String(b.p.atualizada).localeCompare(String(a.p.atualizada)));
  };
  const porNota = (a, b) => b.nota - a.nota || String(b.p.atualizada).localeCompare(String(a.p.atualizada));
  // O Dono: o NÚCLEO fixo vai sempre, na ordem que o dono escolheu (data/mentes.json "nucleoDono"); depois, até 4 regras
  // dele que tenham a ver com o pedido. Antes era só por palavra, e às vezes ia "commit push test" no lugar de "veredito primeiro".
  const nucleo = (m.nucleoDono || []).map((k) => pags.find((x) => x.chave === k)).filter(Boolean);
  const doDono = pags.filter((x) => x.mente === "dono" && !nucleo.includes(x));
  const daMente = pags.filter((x) => x.mente !== "dono" && (todasMentes || mentes.has(x.mente) || x.tambem.some((t) => mentes.has(t))));
  const dono = [...nucleo, ...(temSentido ? fundir(doDono) : doDono.filter((x) => x.nota > 0).sort(porNota)).slice(0, nucleo.length ? 4 : 10)];
  const daTarefa = (temSentido ? fundir(daMente) : daMente.filter((x) => x.nota > 0).sort(porNota)).slice(0, todasMentes ? 10 : 6);
  if (!dono.length && !daTarefa.length) return null;
  const nomeM = Object.fromEntries(mentesDef().map((x) => [x.id, x.icone + " " + x.nome]));
  const texto = [
    "## Romaneio — memórias separadas pelo board para esta tarefa",
    "Use como contexto (vêm da memória compartilhada). Se precisar de mais, consulte o ai-memory. Se alguma estiver desatualizada, diga no resumo.",
    "", "### 🧭 O Dono (vale sempre)",
    ...dono.map((x) => `- **${x.p.titulo}**: ${cut(x.p.descricao || tiraCabecalhos(x.p.bruto), 220)}`),
    ...(daTarefa.length ? ["", `### Da tarefa — mentes: ${[...mentes].map((id) => nomeM[id]).join(", ")}`] : []),
    ...daTarefa.map((x) => `\n#### ${x.p.titulo} (${nomeM[x.mente]} · ${x.p.projeto})\n${x.p.descricao ? x.p.descricao + "\n" : ""}${cut(tiraCabecalhos(x.p.bruto).replace(/^#.*$/m, ""), 700)}`),
  ].join("\n");
  return {
    em: now(), mentes: [...mentes], termos: termos.length, tokensAprox: Math.round(texto.length / 4), texto,
    modo: temSentido ? "palavra+sentido" : "palavra", ...(sentido && sentido.erro ? { semSentido: sentido.erro } : {}),
    itens: [...dono, ...daTarefa].map((x) => ({ chave: x.chave, titulo: x.p.titulo, mente: x.mente, nota: Number(x.nota.toFixed(2)),
      ...(temSentido && x.sim != null ? { sentido: Number(x.sim.toFixed(3)) } : {}) })),
  };
}

// O índice de sentido fica pronto sem esperar a 1ª tarefa: ao subir e a cada 10 min (só o que mudou é recalculado).
if (COM_ROTINAS) {
  setTimeout(() => indexarMemoria(paginasParaSentido()), 20000);
  setInterval(() => indexarMemoria(paginasParaSentido()), 10 * 60000);
}
// ── Curva de giro (27/09): por onde cada memória passou ────────────────────────────────────────────────────
// Num armazém, perto da doca fica o que MAIS SAI, não o que chegou por último. Aqui "sair" = ir no romaneio de uma tarefa
// (task.romaneio.itens). Para cada memória: quantas tarefas a levaram, a última vez, e como essas tarefas foram na
// conferência — de primeira (revisor e QA aprovaram sem conserto), depois de conserto, reprovadas/erro, ou sem conferência
// (tarefa que não mexeu em arquivo). ⚠️ Mostra por onde a memória passou; NÃO prova que ela ajudou (a tela diz isso).
export function resultadoDaConferencia(t) {
  if (t.status === "erro") return "falhou";
  const v = [t.revisor, t.qa].filter(Boolean);
  if (!v.length) return ["executada", "concluida"].includes(t.status) ? "semConferencia" : null; // ainda na fila/rodando: não conta
  if (v.some((x) => x.veredito !== "APROVADO")) return "falhou";
  return v.some((x) => (x.rodadas || 0) > 0) ? "conserto" : "primeira";
}
export function giroDaMemoria() {
  const giro = {}; let desde = null;
  for (const t of state.tasks) {
    const itens = t.romaneio?.itens; if (!Array.isArray(itens) || !itens.length) continue;
    const quando = t.romaneio.em || t.startedAt || t.createdAt; if (!desde || quando < desde) desde = quando;
    const r = resultadoDaConferencia(t);
    for (const i of itens) {
      const g = giro[i.chave] ||= { saidas: 0, ultima: null, primeira: 0, conserto: 0, falhou: 0, semConferencia: 0, tarefas: [] };
      g.saidas++; if (!g.ultima || quando > g.ultima) g.ultima = quando;
      if (r) g[r]++;
      g.tarefas.push({ id: t.id, titulo: t.title, resultado: r || "andando", em: quando });
    }
  }
  for (const g of Object.values(giro)) g.tarefas = g.tarefas.sort((a, b) => String(b.em).localeCompare(String(a.em))).slice(0, 20);
  return { desde, giro };
}

/** O texto de cada memória para o índice de sentido (título + descrição + começo do corpo). */
export function paginasParaSentido() {
  const g = montarGrafo(); if (!g._porChave) return [];
  return [...g._porChave.values()].filter((p) => !p.sessao && !/^(log-\d{4}-\d{2}|index|MEMORY)$/.test(p.id))
    .map((p) => ({ chave: p.chave, texto: `${p.titulo}\n${p.descricao}\n${tiraCabecalhos(p.bruto).slice(0, 1500)}` }));
}
/**
 * O sentido do pedido para o romaneio: vetor do pedido + vetores das memórias. Nunca segura a tarefa: o índice das memórias
 * é posto em dia em segundo plano (a 1ª vez leva ~1 min) e, se o provedor não responder, o romaneio vai só por palavra
 * — e diz isso (`semSentido`).
 */
export async function sentidoDoPedido(task) {
  if (configBusca().provedor === "lexico") return { erro: "o board está configurado para buscar só por palavra (BOARD_BUSCA_PROVEDOR=lexico)" };
  try {
    const paginas = paginasParaSentido();
    indexarMemoria(paginas).then((r) => { if (r.erro) console.error("índice de sentido da memória:", r.erro); });
    const vetores = vetoresDaMemoria();
    // Índice pela metade compara o pedido com só uma parte da memória e ainda diz "palavra+sentido" — engana (visto no ar
    // em 27/09: com 32 de ~350 vetores, o romaneio trouxe memórias erradas). Abaixo de 95% pronto, vai só por palavra.
    const prontas = paginas.filter((p) => vetores[p.chave]).length;
    if (!paginas.length || prontas < paginas.length * 0.95) return { erro: `índice de sentido ainda sendo montado (${prontas} de ${paginas.length})` };
    return { vetorPedido: await vetorDoPedido(task.title + "\n" + task.text), vetores };
  } catch (e) { return { erro: e.message }; }
}

// ── Inventário da memória (o inventário do galpão) ─────────────────────────────────────────────────────
// Toda madrugada (02h), SEM IA e sem custo: acha memória NOVA sem mente, suspeitas de REPETIDAS e as VENCIDAS
// (sessões, notas de status com data, cópias grandes). Nada muda sozinho: o dono decide na tela. Só o "Juntar" chama IA,
// e só quando o dono clica (escreve a versão única para ele ver antes de aplicar). Estado em data/inventario.json.
export const INVENTARIO_FILE = join(DATA, "inventario.json");
export const lerInventario = () => { try { return JSON.parse(readFileSync(INVENTARIO_FILE, "utf8")); } catch { return null; } };
export const gravarInventario = (x) => { writeFileSync(INVENTARIO_FILE + ".tmp", JSON.stringify(x, null, 1)); renameSync(INVENTARIO_FILE + ".tmp", INVENTARIO_FILE); };
export const radical = (w) => w.slice(0, 5); // "trabalha", "trabalhar", "trabalhem" → "traba"
// o nome do dono aparece em muito título ("Como trabalhar com o <nome>") e não diz nada do assunto
export const NOME_DONO = semAcentoServidor(process.env.BOARD_DONO || "").split(/\s+/).filter(Boolean);
export function palavrasTitulo(t) { return new Set((semAcentoServidor(t).match(/[a-z0-9]{4,}/g) || []).filter((w) => !PARADAS.has(w) && w !== "dono" && !NOME_DONO.includes(w)).map(radical)); }
export function inventariar() {
  grafoCache.em = 0; const g = montarGrafo(); if (!g._porChave) return null;
  const m = lerMentes() || { mapa: {} }; const mapa = m.mapa || {};
  const pags = [...g._porChave.values()].filter((p) => !/^(log-\d{4}-\d{2}|index|MEMORY)$/.test(p.id));
  const agora = Date.now(), dias = (t) => (agora - t) / 86400000;
  // 1) novas: estão na memória e não têm endereço
  const novas = pags.filter((p) => !mapa[p.chave]).map((p) => ({ chave: p.chave, titulo: p.titulo, projeto: p.projeto, sessao: p.sessao }));
  // 2) vencidas: sessão com mais de 7 dias, nota de status com data (mais de 14 dias), cópia grande
  const vencidas = [];
  for (const p of pags) {
    const idade = dias(p.atualizada), tam = p.bruto.length;
    const motivo = p.sessao && idade > 7 ? `resumo de sessão de ${Math.round(idade)} dias (o que importava já virou memória)`
      : /onde paramos|onde estamos|estado em \d|status em \d/i.test(p.titulo) && idade > 14 ? `nota de status datada, de ${Math.round(idade)} dias`
      : tam > 30000 ? `página grande (${Math.round(tam / 1000)} KB): pesa no contexto; confira se é cópia de documento ou se dá para resumir`
      : /^(Revise a tarefa|Teste a entrega)/.test(p.titulo) ? "sessão do revisor/QA do board (não é memória de trabalho)" : null;
    if (motivo) vencidas.push({ chave: p.chave, titulo: p.titulo, projeto: p.projeto, motivo });
  }
  // 3) suspeitas de repetidas: texto parecido (cosseno TF-IDF ≥ 0,5) OU mesma mente + 2 palavras do título em comum
  const doc = pags.filter((p) => !p.sessao).map((p) => {
    const ws = (semAcentoServidor(p.titulo + " " + p.descricao + " " + tiraCabecalhos(p.bruto).slice(0, 6000)).match(/[a-z0-9]{4,}/g) || []).filter((w) => !PARADAS.has(w));
    return { p, tf: ws.reduce((a, w) => (a[w] = (a[w] || 0) + 1, a), {}), tit: palavrasTitulo(p.titulo), mente: (mapa[p.chave] || {}).mente };
  });
  const df = {}; for (const d of doc) for (const w in d.tf) df[w] = (df[w] || 0) + 1;
  for (const d of doc) { let s2 = 0; d.v = {}; for (const w in d.tf) { const x = d.tf[w] * Math.log(doc.length / df[w]); d.v[w] = x; s2 += x * x; } d.n = Math.sqrt(s2) || 1; }
  const cos = (a, b) => { let x = 0; for (const w in a.v) if (b.v[w]) x += a.v[w] * b.v[w]; return x / (a.n * b.n); };
  const pares = [];
  for (let i = 0; i < doc.length; i++) for (let j = i + 1; j < doc.length; j++) {
    const a = doc[i], b = doc[j]; const c = cos(a, b);
    const comum = [...a.tit].filter((w) => b.tit.has(w)).length, jac = comum / (Math.min(a.tit.size, b.tit.size) || 1);
    // título parecido só conta com um mínimo de texto em comum (≥ 0,15): senão "Saturno" no título juntava assuntos sem nada a ver
    const titulo = a.mente && a.mente === b.mente && comum >= 2 && jac >= 0.6 && c >= 0.15;
    if (c >= 0.5 || titulo) pares.push({ a: a.p.chave, b: b.p.chave, texto: Number(c.toFixed(2)), titulo });
  }
  // agrupa pares encadeados (A~B, B~C → um grupo) e fica com os 15 mais parecidos
  const grupo = new Map(); const achar = (k) => { while (grupo.get(k) && grupo.get(k) !== k) k = grupo.get(k); return k; };
  for (const x of pares) { grupo.set(x.a, achar(x.a) || x.a); grupo.set(x.b, achar(x.b) || x.b); const ra = achar(x.a), rb = achar(x.b); if (ra !== rb) grupo.set(rb, ra); }
  const grupos = {}; for (const k of grupo.keys()) (grupos[achar(k)] = grupos[achar(k)] || new Set()).add(k);
  const titulo = (k) => (g._porChave.get(k) || {}).titulo || k;
  const repetidas = Object.values(grupos).filter((set) => set.size >= 2 && set.size <= 5).map((set) => {
    const ks = [...set]; const ps = pares.filter((x) => set.has(x.a) && set.has(x.b));
    return { chaves: ks, titulos: ks.map(titulo), parecenca: Math.max(...ps.map((x) => x.texto)), porTitulo: ps.some((x) => x.titulo) };
  }).sort((a, b) => b.parecenca - a.parecenca).slice(0, 15);
  const antes = lerInventario() || {}; const ign = new Set(antes.ignoradas || []);
  const chaveGrupo = (ks) => [...ks].sort().join("|");
  const inv = { em: now(), total: pags.length, ignoradas: [...ign], juntar: antes.juntar || {}, feitos: antes.feitos || [],
    novas, vencidas: vencidas.filter((x) => !ign.has(x.chave)), repetidas: repetidas.filter((r) => !ign.has(chaveGrupo(r.chaves))) };
  gravarInventario(inv);
  logEvent("inventario", { t: "solto", texto: `inventário da memória: ${novas.length} novas sem mente · ${repetidas.length} grupos suspeitos de repetição · ${vencidas.length} vencidas` });
  return inv;
}
// Roda uma vez por madrugada (às 2h, depois dos backups). Conferido a cada 10 min.
export function inventarioDaMadrugada() {
  const h = new Date().getHours(), hoje = new Date().toLocaleDateString("sv-SE");
  const ult = (lerInventario() || {}).em; if (h !== 2 || (ult && new Date(ult).toLocaleDateString("sv-SE") === hoje)) return;
  try { inventariar(); } catch (e) { console.error("inventário falhou:", e.message); }
}
// Caminho da página DENTRO do projeto no ai-memory (o espelho usa o nome do projeto como pasta).
export const caminhoNoProjeto = (p) => relative(join(ESPELHO_MEMORIA, p.projeto), p.caminho);
export function apagarDaMemoria(chave) {
  const g = montarGrafo(); const p = g._porChave && g._porChave.get(chave); if (!p) throw new Error("memória não encontrada: " + chave);
  const guarda = join(DATA, "inventario-descartadas"); mkdirSync(guarda, { recursive: true });
  writeFileSync(join(guarda, chave.replace(/[^\w.-]+/g, "_") + ".md"), p.bruto); // cópia local para desfazer à mão, além do backup noturno
  execFileSync("ai-memory", ["delete-page", "--workspace", "default", "--project", p.projeto, "--path", caminhoNoProjeto(p)],
    { env: { ...process.env, ...envMemoria(), PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:${process.env.PATH || ""}` }, timeout: 30000, stdio: "pipe" });
  const m = lerMentes(); if (m && m.mapa[chave]) { delete m.mapa[chave]; gravarMentes(m); }
}

// O "tipo" de uma memória (vira o porta-palete na vista Galpão): pela pasta, ou pelo type do cabeçalho original
// da memória do Claude (project/feedback/reference/user), que veio junto quando ela foi importada.
export function tipoDaMemoria(caminho, bruto) {
  if (/[\/]decisions[\/]/.test(caminho)) return "decisao";
  if (/[\/]sessions[\/]/.test(caminho)) return "sessao";
  const t = (bruto.match(/^\s+type:\s*(project|feedback|reference|user)\s*$/m) || [])[1];
  if (/[\/](_rules|preferences|preferencias)[\/]/.test(caminho)) return t === "user" ? "dono" : "regra";
  return { project: "projeto", feedback: "regra", reference: "referencia", user: "dono" }[t] || "outro";
}

export function montarGrafo() {
  if (grafoCache.dado && Date.now() - grafoCache.em < 60000) return grafoCache.dado;
  if (!existsSync(ESPELHO_MEMORIA)) return { erro: "o espelho da memória ainda não existe (rode memoria-obsidian)", nos: [], ligacoes: [] };
  const paginas = [];
  const anda = (dir, projeto) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "_lint") anda(p, projeto); continue; }
      if (!e.name.endsWith(".md") || e.name === "_meta.md") continue;
      const bruto = readFileSync(p, "utf8");
      const id = e.name.slice(0, -3);
      const nome = (bruto.match(/^name:\s*(.+)$/m) || [])[1];
      const h1 = (tiraCabecalhos(bruto).match(/^#\s+(.+)$/m) || [])[1];
      const descricao = ((bruto.match(/^description:\s*(.+)$/m) || [])[1] || "").replace(/^["']|["']$/g, "");
      // Sem título escrito, o nome é um código (project_saas_multitenant): vira texto legível.
      const cru = (h1 || nome || id).trim();
      const titulo = /^[a-z0-9_-]+$/i.test(cru) ? cru.replace(/^(project|feedback|reference|user|notes?)[-_]+/i, "").replace(/[-_]+/g, " ").replace(/^./, (x) => x.toUpperCase()) : cru;
      paginas.push({ chave: projeto + "/" + id, id, projeto, titulo: titulo.slice(0, 120), descricao: descricao.slice(0, 240), caminho: p, bruto,
        atualizada: dataDaMemoria(bruto) || statSync(p).mtimeMs, sessao: /[\/]sessions[\/]/.test(p), tipo: tipoDaMemoria(p, bruto) });
    }
  };
  for (const e of readdirSync(ESPELHO_MEMORIA, { withFileTypes: true })) if (e.isDirectory()) anda(join(ESPELHO_MEMORIA, e.name), e.name);
  const porId = new Map();
  const norm = (x) => String(x).toLowerCase().trim().replace(/\.md$/, "").replace(/[\s_]+/g, "-");
  for (const pg of paginas) { const k = norm(pg.id); if (!porId.has(k)) porId.set(k, []); porId.get(k).push(pg); }
  const acha = (alvo, projeto) => { const l = porId.get(norm(alvo)); return l ? (l.find((x) => x.projeto === projeto) || l[0]) : null; };
  const ligacoes = new Set();
  for (const pg of paginas) {
    for (const m of pg.bruto.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
      const alvo = acha(m[1].split("/").pop(), pg.projeto);
      if (alvo && alvo.chave !== pg.chave) ligacoes.add(pg.chave + "\u0000" + alvo.chave);
    }
  }
  const grau = {}; const lig = [...ligacoes].map((l) => { const [a, b] = l.split("\u0000"); grau[a] = (grau[a] || 0) + 1; grau[b] = (grau[b] || 0) + 1; return { a, b }; });
  const dado = {
    geradoEm: new Date().toISOString(),
    nos: paginas.map((p) => ({ chave: p.chave, id: p.id, projeto: p.projeto, titulo: p.titulo, descricao: p.descricao, grau: grau[p.chave] || 0,
      atualizada: new Date(p.atualizada).toISOString(), sessao: p.sessao, tipo: p.tipo,
      temas: Object.entries(temasDaMemoria()).filter(([, rx]) => rx.test(p.id + " " + p.titulo + " " + p.descricao + " " + tiraCabecalhos(p.bruto))).map(([t]) => t) })),
    ligacoes: lig,
    _porChave: new Map(paginas.map((p) => [p.chave, p])),
  };
  grafoCache = { em: Date.now(), dado };
  return dado;
}
