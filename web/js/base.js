// Utilitários da tela: estado (S), formatação, markdown, api(), toast e o uso do plano.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const STATUS_LABEL = { pendente: "Pendente", fila: "Na fila", rodando: "Rodando", executada: "Executada", concluida: "Concluída", erro: "Erro" };
// `busy` sem `rodando` é a tarefa respondendo no chat: também está trabalhando, e a tela
// precisa dizer isso — senão o agente trabalha e o quadro continua escrito "Pendente".
const trabalhando = (t) => t.status === "rodando" || t.busy;
// Quando a tarefa em erro volta sozinha — ou por que não volta.
const retryTxt = (t) => {
  if (!t.retentativa) return "";
  const h = new Date(t.retentativa.em).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return t.retentativa.tipo === "cota" ? `⏸ espera a cota: volta às ${h}` : `↻ volta às ${h} (${t.retentativa.n}/${t.retentativa.max})`;
};
const ETAPA = { agente: "Rodando", portao: "Verificando", revisor: "Revisando", qa: "Testando (QA)", entrega: "Entregando", merge: "Mesclando", deploy: "Publicando" };
const ENTREGA_LABEL = { direto: "Direto na pasta (sem PR)", pr: "Abrir Pull Request (o dono revisa)", deploy: "PR, mesclar e publicar (o board faz tudo)" };
const estado = (t) => t.status === "rodando" ? { cls: "rodando", label: ETAPA[t.etapa] || "Rodando" }
  : t.busy ? { cls: "rodando", label: "Respondendo" }
  : t.status === "fila" && t.acao ? { cls: "fila", label: t.acao === "deploy" ? "Na fila · publicar" : "Na fila · PR" }
  : t.status === "erro" && t.retentativa ? { cls: "fila", label: t.retentativa.tipo === "cota" ? "Esperando cota" : "Vai tentar de novo" }
  : { cls: t.status, label: STATUS_LABEL[t.status] };
// Selos do que já foi conferido: o dono precisa ver "passou no portão" sem abrir a tarefa.
const selos = (t) => [
  t.gate ? `<span class="selo ${t.gate.ok ? "ok" : "nao"}" title="${esc(t.gate.comando)}">⛨ portão ${t.gate.ok ? "✓" : "✗"}</span>` : "",
  t.revisor ? `<span class="selo ${t.revisor.veredito === "APROVADO" ? "ok" : "nao"}">🔍 revisor ${t.revisor.veredito === "APROVADO" ? "✓" : "✗"}</span>` : "",
  t.qa ? `<span class="selo ${t.qa.veredito === "APROVADO" ? "ok" : "nao"}">🧪 QA ${t.qa.veredito === "APROVADO" ? "✓" : "✗"}</span>` : "",
  t.merged ? `<span class="selo ok">⇪ mesclado</span>` : "",
  t.deploy ? `<span class="selo ${t.deploy.ok ? "ok" : "nao"}" title="${esc(t.deploy.comando)}">⇪ publicado ${t.deploy.ok ? "✓" : "✗"}</span>` : "",
].join("");
const ORDER = { rodando: 0, fila: 1, pendente: 2, erro: 3, executada: 4, concluida: 5 };
const fmtCost = (v) => v ? "US$ " + Number(v).toFixed(2) : "";
const cutTxt = (s, n) => { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const fmtDur = (ms) => { if (!ms) return ""; const m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000); return m ? `${m}min ${s}s` : `${s}s`; };
const fmtAt = (iso) => iso ? new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "";
const fmtDay = (iso) => iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
// Há quanto tempo a tarefa está parada — o que faz a aba Pendentes valer como lembrete.
const haQuanto = (iso) => {
  if (!iso) return "";
  const dias = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return dias >= 1 ? `há ${dias} dia${dias > 1 ? "s" : ""}` : "";
};
// O que um porte faz neste motor: no Claude é esforço (o modelo não muda); nos outros, o modelo do porte.
const efeitoPorte = (motor, p) => {
  const c = CAT[motor || "claude"] || {};
  if (c.portes?.[p]) return c.portes[p];
  if (c.esforcos) return c.esforcos[p] ? "esforço " + c.esforcos[p] : "esforço padrão";
  return "";
};
// "claude-opus-5-5" → "Opus 5.5": o nome que o dono reconhece.
const nomeModelo = (m) => {
  const x = String(m || "");
  const r = x.match(/^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i);
  if (r) return r[1][0].toUpperCase() + r[1].slice(1) + " " + r[2] + (r[3] ? "." + r[3] : "");
  if (/^(opus|sonnet|haiku)$/i.test(x)) return x[0].toUpperCase() + x.slice(1);
  return x || "padrão";
};
const rotuloAgente = (t) => `#${t.agente} · ${nomeModelo(t.modeloUsado)}${t.esforcoUsado ? " · " + t.esforcoUsado : ""}`;
// O agente aparece enquanto trabalha; na tarefa ⚡ fica sempre (é a cópia dele).
const agenteSelo = (t) => t.agente && (trabalhando(t) || t.paralelo)
  ? `<span class="agente${trabalhando(t) ? " on" : ""}" title="agente, modelo e esforço desta tarefa${t.paralelo ? " — cópia isolada (⚡ paralelo)" : ""}">${t.paralelo ? "⚡ " : ""}${esc(rotuloAgente(t))}</span>` : "";
const juntarSelo = (t) => {
  const j = (t.worktree || {}).juntar;
  if (j === "ok") return `<span class="selo ok" title="o trabalho da cópia já está na pasta principal">⇲ juntou</span>`;
  if (j === "pendente") return `<span class="selo" title="junta quando a pasta principal estiver livre">⇲ esperando a pasta</span>`;
  if (j === "conflito") return `<span class="selo nao" title="conflito com a pasta principal: nada foi aplicado; o trabalho está em ${esc(t.worktree.dir)}">⚠ não juntou</span>`;
  return "";
};
const store = { get: (k, d) => { try { return JSON.parse(localStorage.getItem("board." + k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem("board." + k, JSON.stringify(v)); } catch {} } };

// Markdown da resposta do agente → HTML. Escapa ANTES de tudo: o texto vem de um modelo e não é confiável.
function mdInline(s) {
  return s.split(/(`[^`]+`)/g).map((p) => (p.length > 1 && p.startsWith("`") && p.endsWith("`"))
    ? `<code>${p.slice(1, -1)}</code>`
    : p.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*(?!\s)([^*]+?)\*(?!\w)/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
  ).join("");
}
function mdToHtml(txt) {
  if (!txt) return "";
  const L = esc(txt).replace(/\r/g, "").split("\n");
  const out = [];
  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l || "");
  const isSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l || "");
  const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => mdInline(c.trim()));
  const ITEM = /^\s*([-*+]|\d+[.)])\s+/;
  const HR = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
  let i = 0;
  while (i < L.length) {
    const l = L[i];
    let m;
    if (/^\s*```/.test(l)) {
      const buf = []; i++;
      while (i < L.length && !/^\s*```/.test(L[i])) buf.push(L[i++]);
      i++;
      out.push(`<pre class="md-code"><code>${buf.join("\n")}</code></pre>`);
    } else if (!l.trim()) {
      i++;
    } else if ((m = l.match(/^(#{1,4})\s+(.*)$/))) {
      const n = Math.min(m[1].length + 1, 4);
      out.push(`<h${n}>${mdInline(m[2])}</h${n}>`); i++;
    } else if (HR.test(l)) {
      out.push("<hr>"); i++;
    } else if (isRow(l) && isSep(L[i + 1])) {
      const head = cells(l); i += 2;
      const rows = [];
      while (i < L.length && isRow(L[i])) rows.push(cells(L[i++]));
      out.push(`<div class="md-tw"><table class="md-table"><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
    } else if (/^\s*&gt;\s?/.test(l)) {
      const buf = [];
      while (i < L.length && /^\s*&gt;\s?/.test(L[i])) buf.push(mdInline(L[i++].replace(/^\s*&gt;\s?/, "")));
      out.push(`<blockquote>${buf.join("<br>")}</blockquote>`);
    } else if (ITEM.test(l)) {
      const ordered = /^\s*\d+[.)]\s+/.test(l), inicio = parseInt(l, 10) || 1, items = [];
      while (i < L.length && ITEM.test(L[i])) {
        const sub = L[i].match(/^\s*/)[0].length >= 2;
        let corpo = mdInline(L[i].replace(ITEM, "")); i++;
        while (i < L.length && L[i].trim() && /^\s{2,}/.test(L[i]) && !ITEM.test(L[i])) corpo += "<br>" + mdInline(L[i++].trim());
        items.push(`<li${sub ? ' class="sub"' : ""}>${corpo}</li>`);
      }
      out.push(ordered ? `<ol${inicio > 1 ? ` start="${inicio}"` : ""}>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
    } else {
      const buf = [mdInline(L[i++])];
      while (i < L.length && L[i].trim() && !/^\s*(```|#{1,4}\s|&gt;)/.test(L[i]) && !ITEM.test(L[i]) && !HR.test(L[i]) && !(isRow(L[i]) && isSep(L[i + 1]))) buf.push(mdInline(L[i++]));
      out.push(`<p>${buf.join("<br>")}</p>`);
    }
  }
  return out.join("");
}


let S = { tasks: [], projects: [], config: {} };
let connected = false;
let view = { name: "list", id: null };
let logCache = {};    // id → eventos
let tarefaCheia = {}; // id → tarefa com texto e resumo (o estado da lista vem sem eles)
let lastLine = {}; // id → último evento textual (pra mostrar na lista)

async function api(path, opts = {}) {
  const r = await fetch("/api" + path, { headers: { "content-type": "application/json" }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ("erro " + r.status));
  return d;
}
function toast(msg, ms = 3500, tipo = "") { const t = document.createElement("div"); t.className = "toast" + (tipo ? " " + tipo : ""); t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), ms); }

// Plano do Claude: o servidor devolve a última leitura na hora e avisa ("uso") quando atualiza.
let USO = null;
let GASTO = null; // o que cada motor gastou nas tarefas do board (vem do /api/usage, por motor)
let CAT = {}; // catálogo de modelos por motor (vem do /api/modelos)
async function carregarModelos() { try { CAT = await api("/modelos"); render(); } catch { /* segue com o padrão */ } }
const nivel = (pct) => (pct >= 90 ? "limite" : pct >= 70 ? "atencao" : "ok");
const NIVEL_TXT = { ok: "", atencao: "⚠ atenção", limite: "⛔ quase no limite" };
async function carregarUso(fresco = false) {
  try { USO = await api("/claude-uso" + (fresco ? "?fresco=1" : "")); } catch { return; }
  renderHeader();
  if (view.name === "list" && store.get("tab", "ativas") === "consumo") renderPlano();
}
const emQuanto = (iso) => {
  const ms = new Date(iso).getTime() - Date.now(); if (!(ms > 0)) return "";
  const min = Math.round(ms / 60000), h = Math.floor(min / 60), d = Math.floor(h / 24);
  return d >= 1 ? `em ${d} dia${d > 1 ? "s" : ""} e ${h % 24}h` : h >= 1 ? `em ${h}h ${min % 60}min` : `em ${min} min`;
};
const quandoCurto = (iso) => new Date(iso).toLocaleString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

// Eventos chegam em rajada (uma tarefa rodando dispara vários seguidos). Redesenhar a lista a cada
// um deixava a tela pesada; aqui eles se juntam em uma atualização só.
let stateAgendado = null;
function agendarState() {
  if (stateAgendado) return;
  stateAgendado = setTimeout(() => { stateAgendado = null; loadState(); }, 250);
}
/** Assinatura do que a LISTA mostra: se não mudou, não redesenha. */
const assinaturaLista = () => JSON.stringify([
  S.tasks.map((t) => [t.id, t.status, t.etapa, t.busy, t.order, t.cost, t.entrega, t.prUrl, (t.gate || {}).ok,
    (t.revisor || {}).veredito, (t.qa || {}).veredito, (t.retentativa || {}).em, (t.anexos || []).length, t.acao, t.title, t.porte, t.classificando, t.agente, t.modeloUsado, t.esforcoUsado, t.paralelo, (t.worktree || {}).juntar]),
  S.config.filaPausada, S.config.reinicioPendente, USO && USO.ok && USO.limites.map((l) => l.pct)]);
let ultimaAssinatura = null;

async function loadState() { S = await api("/state"); render(); }

