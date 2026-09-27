#!/usr/bin/env node
/**
 * BUSCA — procurar tarefa pelo SENTIDO, não pela palavra exata.
 *
 * O quadro passa de 130 tarefas em 6 projetos e o dono não lembra o número nem o título exato
 * ("aquela do rate limit do nginx" estava escrita como "balde por IP"). Aqui a consulta e cada
 * tarefa (título + descrição) viram vetor (embedding) e a comparação é por cosseno.
 *
 * ⚠️ PROVEDOR — o padrão é LOCAL de propósito:
 *   - `ollama`  (padrão): roda na máquina, não custa e NÃO manda o quadro pra fora.
 *   - `openai` / `cohere`: melhores em português, mas MANDAM o texto das tarefas (que falam de
 *     produção) para um serviço externo, e precisam de chave.
 *   - `lexico`: sem IA nenhuma, só palavras — é também o SOCORRO automático quando o provedor
 *     escolhido não responde, pra busca nunca ficar morta.
 * Qual usar de verdade é decisão do dono (BOARD_BUSCA_PROVEDOR); o board funciona nos quatro.
 *
 * Variáveis:
 *   BOARD_BUSCA_PROVEDOR=ollama|openai|cohere|lexico   BOARD_BUSCA_MODELO=<modelo do provedor>
 *   BOARD_OLLAMA_URL=http://127.0.0.1:11434            OPENAI_API_KEY / COHERE_API_KEY
 *
 * Sem dependência npm: fetch e fs do próprio Node. Índice em data/embeddings.json (só o que
 * mudou é recalculado — a chave é o hash do texto da tarefa).
 */
import { createHash } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const DATA = join(ROOT, "data");
const INDEX_FILE = join(DATA, "embeddings.json");

const PROVEDOR = (process.env.BOARD_BUSCA_PROVEDOR || "ollama").toLowerCase();
const OLLAMA_URL = (process.env.BOARD_OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
const TIMEOUT_MS = Number(process.env.BOARD_BUSCA_TIMEOUT_S || 25) * 1000;
const PERTO = Math.min(0.99, Math.max(0.1, Number(process.env.BOARD_BUSCA_PERTO || 0.75))); // quão perto do melhor achado ainda conta
const LOTE = 32; // textos por requisição

// ollama: bge-m3 (multilíngue). Medido em 27/09/2026 na memória real (330 páginas), com 10 pedidos escritos com OUTRAS
// palavras: nomic-embed-text acertou entre os 5 primeiros 3/10 (pior que a busca por palavra, 4/10); bge-m3, 8/10.
// O nomic é treinado quase só em inglês — em português ele não separa o que tem a ver do que não tem.
const MODELO_PADRAO = {
  ollama: "bge-m3",
  openai: "text-embedding-3-small",
  cohere: "embed-multilingual-v3.0",
  lexico: "",
};
const MODELO = process.env.BOARD_BUSCA_MODELO || MODELO_PADRAO[PROVEDOR] || "";

export const configBusca = () => ({
  provedor: PROVEDOR,
  modelo: MODELO,
  local: PROVEDOR === "ollama" || PROVEDOR === "lexico",
  url: PROVEDOR === "ollama" ? OLLAMA_URL : null,
  temChave: PROVEDOR === "openai" ? !!process.env.OPENAI_API_KEY : PROVEDOR === "cohere" ? !!process.env.COHERE_API_KEY : true,
});

// ── o texto que representa a tarefa ───────────────────────────────────────────
/** Título pesa mais: repetir é o jeito barato de dar peso sem inventar um segundo vetor. */
const textoDaTarefa = (t) =>
  [t.title || "", t.title || "", String(t.text || "").slice(0, 4000), `projeto ${t.project || ""}`].join("\n").trim();
const hashDe = (s) => createHash("sha1").update(s).digest("hex").slice(0, 16);

// ── provedores de embedding ───────────────────────────────────────────────────
async function pede(url, opts) {
  let r;
  // "fetch failed" não diz nada a quem lê na tela: o que importa é QUEM não respondeu.
  try { r = await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) }); }
  catch (e) { throw new Error(e.name === "TimeoutError" ? `${new URL(url).origin} demorou mais de ${TIMEOUT_MS / 1000}s` : `não consegui falar com ${new URL(url).origin}`); }
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(corpo.error?.message || corpo.error || corpo.message || `${url.replace(/\?.*/, "")} devolveu ${r.status}`);
  return corpo;
}

async function embedOllama(textos) {
  // A API nova (/api/embed) aceita lista; a antiga (/api/embeddings) é um texto por vez.
  try {
    const d = await pede(`${OLLAMA_URL}/api/embed`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: MODELO, input: textos }),
    });
    if (Array.isArray(d.embeddings) && d.embeddings.length === textos.length) return d.embeddings;
    throw new Error("resposta sem embeddings");
  } catch (e) {
    if (!/404|resposta sem embeddings/.test(e.message)) throw e;
    const out = [];
    for (const t of textos) {
      const d = await pede(`${OLLAMA_URL}/api/embeddings`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: MODELO, prompt: t }),
      });
      out.push(d.embedding);
    }
    return out;
  }
}

async function embedOpenAI(textos) {
  const chave = process.env.OPENAI_API_KEY;
  if (!chave) throw new Error("falta OPENAI_API_KEY no ambiente");
  const d = await pede("https://api.openai.com/v1/embeddings", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${chave}` },
    body: JSON.stringify({ model: MODELO, input: textos }),
  });
  return [...(d.data || [])].sort((a, b) => a.index - b.index).map((x) => x.embedding);
}

async function embedCohere(textos, tipo) {
  const chave = process.env.COHERE_API_KEY;
  if (!chave) throw new Error("falta COHERE_API_KEY no ambiente");
  const d = await pede("https://api.cohere.com/v2/embed", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${chave}` },
    body: JSON.stringify({ model: MODELO, texts: textos, input_type: tipo === "consulta" ? "search_query" : "search_document", embedding_types: ["float"] }),
  });
  const v = d.embeddings?.float || d.embeddings;
  if (!Array.isArray(v)) throw new Error("resposta sem embeddings");
  return v;
}

/** Vetores de uma lista de textos, em lotes. `tipo` = "documento" | "consulta" (o Cohere separa). */
async function embed(textos, tipo = "documento") {
  if (PROVEDOR === "lexico") throw new Error("provedor léxico não tem embeddings");
  const out = [];
  for (let i = 0; i < textos.length; i += LOTE) {
    const parte = textos.slice(i, i + LOTE);
    const vetores = PROVEDOR === "openai" ? await embedOpenAI(parte)
      : PROVEDOR === "cohere" ? await embedCohere(parte, tipo)
        : await embedOllama(parte);
    if (vetores.length !== parte.length) throw new Error("o provedor devolveu menos vetores do que pedi");
    out.push(...vetores.map(normalizar));
  }
  return out;
}

/** Guardo normalizado: com norma 1, cosseno vira produto escalar (e o índice fica menor). */
function normalizar(v) {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => Number((x / n).toFixed(5)));
}
const escalar = (a, b) => { let s = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) s += a[i] * b[i]; return s; };

// ── índice em disco ───────────────────────────────────────────────────────────
function lerIndice() {
  try {
    const d = JSON.parse(readFileSync(INDEX_FILE, "utf8"));
    // Trocar de provedor ou de modelo muda o espaço vetorial: comparar vetor velho com novo é
    // comparar régua com balança. Índice de outra origem é descartado inteiro.
    if (d.provedor !== PROVEDOR || d.modelo !== MODELO) return vazio();
    return { ...vazio(), ...d, itens: d.itens || {} };
  } catch { return vazio(); }
}
const vazio = () => ({ provedor: PROVEDOR, modelo: MODELO, atualizadoEm: null, itens: {} });

function gravarIndice(idx) {
  if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });
  const tmp = INDEX_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(idx));
  renameSync(tmp, INDEX_FILE);
}

/**
 * Põe o índice em dia: calcula só as tarefas novas ou editadas e esquece as que sumiram do quadro.
 * Devolve o que fez (e o erro, quando o provedor não respondeu — quem chama decide o socorro).
 */
export async function indexar(tarefas, { forcar = false } = {}) {
  const idx = forcar ? vazio() : lerIndice();
  const vivos = new Set(tarefas.map((t) => String(t.id)));
  for (const id of Object.keys(idx.itens)) if (!vivos.has(id)) delete idx.itens[id];

  const faltam = tarefas.filter((t) => {
    const item = idx.itens[String(t.id)];
    return !item || item.hash !== hashDe(textoDaTarefa(t));
  });
  if (!faltam.length) { gravarIndice(idx); return { novos: 0, total: Object.keys(idx.itens).length, erro: null }; }
  try {
    const vetores = await embed(faltam.map(textoDaTarefa));
    faltam.forEach((t, i) => { idx.itens[String(t.id)] = { hash: hashDe(textoDaTarefa(t)), v: vetores[i] }; });
    idx.atualizadoEm = new Date().toISOString();
    gravarIndice(idx);
    return { novos: faltam.length, total: Object.keys(idx.itens).length, erro: null };
  } catch (e) {
    return { novos: 0, total: Object.keys(idx.itens).length, erro: e.message };
  }
}

// ── socorro sem IA: busca por palavra ─────────────────────────────────────────
const SEM_SENTIDO = new Set(["para", "pelo", "pela", "com", "sem", "que", "uma", "dos", "das", "nos", "nas",
  "por", "the", "and", "and", "mas", "como", "onde", "quando", "tarefa", "fazer", "isso", "essa", "esse", "aquela", "aquele", "está", "esta"]);
const palavras = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .split(/[^a-z0-9#]+/).filter((p) => p.length >= 3 && !SEM_SENTIDO.has(p));

/**
 * Cada palavra da consulta vale o seu IDF (palavra rara pesa mais); casar só o começo da palavra
 * ("nginx" ↔ "nginxconf", "pedido" ↔ "pedidos") vale 60%. O resultado é normalizado pelo total
 * possível, pra virar um 0–1 que a tela mostra do mesmo jeito que o do cosseno.
 */
function buscaLexica(consulta, tarefas) {
  const termos = [...new Set(palavras(consulta))];
  if (!termos.length) return [];
  const docs = tarefas.map((t) => ({ t, p: new Set(palavras(textoDaTarefa(t))) }));
  const idf = new Map(termos.map((termo) => {
    const n = docs.filter((d) => d.p.has(termo)).length;
    return [termo, Math.log((docs.length + 1) / (n + 1)) + 1];
  }));
  const teto = termos.reduce((s, termo) => s + idf.get(termo), 0) || 1;
  return docs.map(({ t, p }) => {
    let pontos = 0;
    for (const termo of termos) {
      if (p.has(termo)) pontos += idf.get(termo);
      else if (termo.length >= 4 && [...p].some((x) => x.startsWith(termo) || termo.startsWith(x) && x.length >= 4)) pontos += idf.get(termo) * 0.6;
    }
    return { t, score: pontos / teto };
  }).filter((r) => r.score > 0);
}

// ── a busca ───────────────────────────────────────────────────────────────────
/**
 * Procura no quadro inteiro (ou num projeto só) e devolve os mais parecidos.
 * `modo` conta a verdade pra tela: "semantica" (embeddings) ou "lexico" (o socorro), com o
 * `aviso` explicando por que caiu no socorro — a tela nunca finge que houve IA quando não houve.
 */
// ── o SENTIDO das memórias (o romaneio) ──────────────────────────────────────
// Mesmo provedor e modelo da busca; índice próprio em data/embeddings-memoria.json, chaveado pela chave da página e pelo
// hash do texto — só o que mudou é recalculado. A 1ª vez leva ~1 min para 300 páginas; depois, segundos.
const INDEX_MEMORIA = join(DATA, "embeddings-memoria.json");
function lerIndiceMemoria() {
  try {
    const d = JSON.parse(readFileSync(INDEX_MEMORIA, "utf8"));
    if (d.provedor !== PROVEDOR || d.modelo !== MODELO) return vazio();
    return { ...vazio(), ...d, itens: d.itens || {} };
  } catch { return vazio(); }
}
let indexandoMemoria = null;
/** Põe o índice das memórias em dia. `paginas` = [{ chave, texto }]. Uma indexação por vez. */
export function indexarMemoria(paginas) {
  if (indexandoMemoria) return indexandoMemoria;
  const esta = (async () => {
    const idx = lerIndiceMemoria();
    const vivas = new Set(paginas.map((p) => p.chave));
    for (const k of Object.keys(idx.itens)) if (!vivas.has(k)) delete idx.itens[k];
    const faltam = paginas.filter((p) => idx.itens[p.chave]?.hash !== hashDe(p.texto));
    try {
      for (let i = 0; i < faltam.length; i += LOTE) {
        const parte = faltam.slice(i, i + LOTE);
        const v = await embed(parte.map((p) => p.texto));
        parte.forEach((p, j) => { idx.itens[p.chave] = { hash: hashDe(p.texto), v: v[j] }; });
        idx.atualizadoEm = new Date().toISOString();
        if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });
        writeFileSync(INDEX_MEMORIA + ".tmp", JSON.stringify(idx)); renameSync(INDEX_MEMORIA + ".tmp", INDEX_MEMORIA);
      }
      return { novos: faltam.length, total: Object.keys(idx.itens).length, erro: null };
    } catch (e) { return { novos: 0, total: Object.keys(idx.itens).length, erro: e.message }; }
  })();
  // A trava solta DEPOIS de gravada: com nada a indexar a função termina na hora, e um `finally` lá dentro rodava antes
  // da atribuição — a trava ficava presa para sempre e nenhuma memória nova era indexada até reiniciar (achado em 27/09).
  indexandoMemoria = esta;
  esta.finally(() => { if (indexandoMemoria === esta) indexandoMemoria = null; });
  return esta;
}
/** Os vetores já calculados das memórias: { chave: vetor }. */
export function vetoresDaMemoria() { return Object.fromEntries(Object.entries(lerIndiceMemoria().itens).map(([k, x]) => [k, x.v])); }
/** O vetor de um pedido, com prazo curto (o romaneio não pode segurar a tarefa esperando o provedor). */
export async function vetorDoPedido(texto, prazoMs = 8000) {
  if (PROVEDOR === "lexico") throw new Error("busca configurada só por palavra (BOARD_BUSCA_PROVEDOR=lexico)");
  let t; const limite = new Promise((_, bad) => { t = setTimeout(() => bad(new Error(`${PROVEDOR} demorou mais de ${prazoMs / 1000}s`)), prazoMs); });
  try { return (await Promise.race([embed([String(texto).slice(0, 4000)], "consulta"), limite]))[0]; } finally { clearTimeout(t); }
}
export { escalar as parecenca };

export async function buscar(consulta, tarefas, { limite = 20, projeto = null, minimo = 0.15 } = {}) {
  const t0 = Date.now();
  const q = String(consulta || "").trim();
  if (!q) return { consulta: "", modo: "vazio", provedor: PROVEDOR, resultados: [], ms: 0, aviso: null };
  const alvo = projeto && projeto !== "todos" ? tarefas.filter((t) => t.project === projeto) : tarefas;

  let aviso = null;
  if (PROVEDOR !== "lexico") {
    const st = await indexar(tarefas); // o índice é sempre do quadro TODO; o filtro de projeto é só na hora de comparar
    if (st.erro) aviso = `sem embeddings (${st.erro}) — busquei por palavra`;
    else {
      try {
        const [qv] = await embed([q], "consulta");
        const idx = lerIndice();
        const todos = alvo
          .map((t) => ({ t, score: idx.itens[String(t.id)] ? escalar(qv, idx.itens[String(t.id)].v) : -1 }))
          .sort((a, b) => b.score - a.score);
        // Em embedding TUDO tem alguma parecença (dois textos quaisquer ficam na casa de 0,4): um
        // corte fixo devolveria o quadro inteiro. O corte é relativo ao melhor achado — é ele que
        // diz o que é "parecido" nesta consulta.
        const corte = Math.max(minimo, (todos[0]?.score || 0) * PERTO);
        const resultados = todos.filter((r) => r.score >= corte).slice(0, limite);
        return { consulta: q, modo: "semantica", provedor: PROVEDOR, modelo: MODELO, aviso: null,
          resultados: resultados.map(formatar), ms: Date.now() - t0 };
      } catch (e) { aviso = `sem embeddings (${e.message}) — busquei por palavra`; }
    }
  }
  const resultados = buscaLexica(q, alvo).sort((a, b) => b.score - a.score).slice(0, limite);
  return { consulta: q, modo: "lexico", provedor: PROVEDOR, modelo: MODELO,
    aviso: aviso || (PROVEDOR === "lexico" ? null : "busquei por palavra"),
    resultados: resultados.map(formatar), ms: Date.now() - t0 };
}

const formatar = ({ t, score }) => ({
  id: t.id, title: t.title, project: t.project, status: t.status, entrega: t.entrega, prUrl: t.prUrl || null,
  createdAt: t.createdAt, finishedAt: t.finishedAt || null,
  trecho: String(t.text || "").replace(/\s+/g, " ").trim().slice(0, 220),
  score: Number(Math.max(0, Math.min(1, score)).toFixed(3)),
});

/** O que a tela mostra no rodapé do painel: qual provedor está valendo e se ele responde. */
export async function estadoBusca(tarefas = []) {
  const cfg = configBusca();
  const idx = lerIndice();
  const base = { ...cfg, indexados: Object.keys(idx.itens).length, total: tarefas.length, atualizadoEm: idx.atualizadoEm };
  if (PROVEDOR === "lexico") return { ...base, pronto: true, modo: "lexico", motivo: "busca por palavra (sem IA), como o dono configurou" };
  if (!cfg.temChave) return { ...base, pronto: false, modo: "lexico", motivo: `falta a chave do ${PROVEDOR} no ambiente — a busca cai na procura por palavra` };
  try {
    await embed(["ping"], "consulta");
    return { ...base, pronto: true, modo: "semantica", motivo: null };
  } catch (e) {
    return { ...base, pronto: false, modo: "lexico", motivo: `${PROVEDOR} não respondeu (${e.message}) — a busca cai na procura por palavra` };
  }
}
