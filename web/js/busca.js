// A busca: tarefas pelo sentido e "Já tratei disso?" na memória.
// ── Busca semântica (a aba 🔎 Buscar) ────────────────────────────────────────
// O quadro tem tarefa de todo projeto e o dono não lembra número nem título exato. Aqui ele
// descreve com as palavras dele e o servidor compara o SENTIDO (embeddings) — ou, quando não há
// provedor de embeddings no ar, procura por palavra e DIZ que foi assim (a tela não finge IA).
let BUSCA = { q: "", projeto: "todos", res: null, buscando: false, info: null, hist: [] };

function buscaHead() {
  const projetos = [{ slug: "todos", label: "todos os projetos" }, ...(S.projects || [])];
  return `<div class="bhead">
    <div class="brow1">
      <div class="search-box">
        <input id="buscaIn" aria-label="Buscar tarefas" type="text" placeholder="Descreva a tarefa com as suas palavras… (Enter busca)" value="${esc(BUSCA.q)}">
        <button type="button" class="clear-btn" id="clearBtn" title="Limpar busca" aria-label="Limpar busca">✕</button>
      </div>
      <select id="buscaProj" title="Buscar em qual projeto">
        ${projetos.map((p) => `<option value="${esc(p.slug)}" ${p.slug === BUSCA.projeto ? "selected" : ""}>${esc(p.label)}</option>`).join("")}
      </select>
      <button class="btn primary" id="buscaBtn">Buscar</button>
    </div>
    <div class="hint" id="buscaEstado">conferindo o provedor de busca…</div>
  </div>`;
}

const MODO_TXT = { semantica: "por sentido", lexico: "por palavra" };
function buscaResultadosHtml() {
  const r = BUSCA.res;
  if (BUSCA.buscando) return `<div class="empty">buscando…</div>`;
  if (!r) return `<div class="empty">Escreva o que você procura — vale descrever de memória: <i>"aquela do rate limit que ficou no nginx"</i>.</div>`;
  if (!r.resultados.length) return `<div class="empty">Nada parecido com <b>${esc(r.consulta)}</b>${r.projeto && r.projeto !== "todos" ? ` em ${esc(r.projeto)}` : ""}.</div>`;
  return `<div class="bcount">${r.resultados.length} tarefa(s) · busca ${MODO_TXT[r.modo] || r.modo}${r.modo === "semantica" ? ` (${esc(r.provedor)})` : ""} · ${r.ms} ms${r.aviso ? ` · ${esc(r.aviso)}` : ""}</div>`
    + r.resultados.map((t) => {
      const pct = Math.round(t.score * 100);
      return `<div class="bres" onclick="location.hash='#/t/${t.id}'">
        <div class="bscore" title="parecença com o que você escreveu"><div class="bbar"><i style="width:${pct}%"></i></div><span>${pct}%</span></div>
        <div class="bmain">
          <div class="title">${esc(t.title)}</div>
          <div class="meta"><span>#${t.id}</span><span class="proj">${esc(t.project)}</span><span class="pill ${esc(t.status)}" style="min-width:0">${esc(STATUS_LABEL[t.status] || t.status)}</span>${t.entrega === "pr" || t.entrega === "deploy" ? `<span class="tag-pr">PR</span>` : ""}<span>${esc(fmtDay(t.finishedAt || t.createdAt))}</span></div>
          <div class="btrecho">${esc(t.trecho)}</div>
        </div>
      </div>`;
    }).join("");
}

function buscaHistoricoHtml() {
  if (!BUSCA.hist.length) return "";
  // O texto da consulta vai pelo ÍNDICE, não interpolado no onclick: consulta com aspas ou < >
  // viraria HTML quebrado (ou pior) no meio do atributo.
  return `<div class="bhist"><h3>Buscas recentes</h3>${BUSCA.hist.map((h, i) => `
    <div class="bh" onclick="refazerBusca(${i})">
      <span class="q">${esc(h.consulta)}</span>
      <span class="s">${esc(fmtDay(h.at))} · ${esc(h.projeto || "todos")} · ${MODO_TXT[h.modo] || esc(h.modo)} · ${(h.achados || []).length ? (h.achados || []).map((a) => "#" + a.id).join(" ") : "nada"}</span>
    </div>`).join("")}</div>`;
}

function refazerBusca(i) {
  const h = BUSCA.hist[i]; if (!h) return;
  const c = $("#buscaIn"); if (c) c.value = h.consulta;
  fazerBusca();
}

async function renderBusca() {
  const app = $("#app");
  const voltar = `<button class="back" onclick="location.hash=''">← voltar</button>`;
  // Já estou na busca: o board manda evento o tempo todo — redesenhar apagaria o que ele digita.
  if (app.dataset.busca === "1" && $("#buscaIn")) { renderHeader(); return; }
  app.dataset.busca = "1"; delete app.dataset.task; delete app.dataset.conversa;
  app.className = "wrap";
  BUSCA.projeto = store.get("buscaProjeto", "todos");
  if (!(S.projects || []).some((p) => p.slug === BUSCA.projeto)) BUSCA.projeto = "todos";
  app.innerHTML = headerHtml(voltar) + workspaceIntro('busca') + buscaHead()
    + `<div id="buscaRes">${buscaResultadosHtml()}</div><div id="buscaHist">${buscaHistoricoHtml()}</div>`;
  const campo = $("#buscaIn");
  let timeoDebounce;
  campo.addEventListener("input", () => {
    clearTimeout(timeoDebounce);
    if (campo.value.trim().length < 2) { BUSCA.res = null; pintarBusca(); return; }
    timeoDebounce = setTimeout(() => fazerBusca(), 300);
  });
  campo.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); clearTimeout(timeoDebounce); fazerBusca(); } });
  $("#clearBtn").onclick = () => { campo.value = ""; BUSCA.res = null; BUSCA.q = ""; pintarBusca(); campo.focus(); };
  $("#buscaBtn").onclick = () => fazerBusca();
  $("#buscaProj").onchange = (e) => { BUSCA.projeto = e.target.value; store.set("buscaProjeto", e.target.value); if (BUSCA.q && BUSCA.q.length >= 2) fazerBusca(); };
  campo.focus(); campo.setSelectionRange(campo.value.length, campo.value.length);
  carregarEstadoBusca();
  carregarHistoricoBusca();
}

async function fazerBusca() {
  const campo = $("#buscaIn"); if (!campo) return;
  const q = campo.value.trim();
  if (!q) return;
  BUSCA.q = q; BUSCA.buscando = true; pintarBusca();
  try {
    const [tarefas, mem] = await Promise.all([
      api(`/busca?q=${encodeURIComponent(q)}&projeto=${encodeURIComponent(BUSCA.projeto)}`),
      api(`/romaneio/previa?todas=1&texto=${encodeURIComponent(q)}&projeto=${encodeURIComponent(BUSCA.projeto === "todos" ? "DEV" : BUSCA.projeto)}`).catch(() => null),
    ]);
    BUSCA.res = { ...tarefas, projeto: BUSCA.projeto };
    BUSCA.mem = mem;
  } catch (e) { toast(e.message); BUSCA.res = null; BUSCA.mem = null; }
  BUSCA.buscando = false;
  pintarBusca();
  carregarHistoricoBusca();
  carregarEstadoBusca(); // a busca pode ter caído no socorro: o rodapé conta a verdade
}

function pintarBusca() { const el = $("#buscaRes"); if (el) el.innerHTML = buscaMemoriaHtml() + buscaResultadosHtml(); } // a memória primeiro: é ela que responde "já tratei disso?"
// "Já tratei disso?": o mesmo picking do romaneio, mostrando o que a memória compartilhada tem sobre a busca.
function buscaMemoriaHtml() {
  if (!BUSCA.res || !BUSCA.q) return "";
  const m = BUSCA.mem;
  const itens = m && m.itens ? m.itens.filter((i) => i.nota > 0).sort((a, b) => b.nota - a.nota) : [];
  const corpo = !m ? `<div class="docker-vazio">não consegui consultar a memória</div>`
    : m.vazio ? `<div class="docker-vazio">${esc(m.motivo === "endereçamento não aprovado" ? "a memória ainda não tem o endereçamento aprovado" : "nada na memória sobre isso")}</div>`
    : !itens.length ? `<div class="docker-vazio">nada na memória sobre isso</div>`
    : itens.map((i) => `<button class="mem-hit" onclick="irParaMemoria(${esc(JSON.stringify(i.chave))})"><span>${ICONE_MENTE[i.mente] || ""} ${esc(i.titulo)}</span><small>${esc(i.chave.split("/")[0])} · relevância ${i.nota}</small></button>`).join("");
  return `<section class="busca-mem"><div class="busca-mem-cab"><b>Na memória</b><span>o que os agentes já guardaram sobre isso · abre no menu Memória</span></div>${corpo}</section>`;
}

async function carregarEstadoBusca() {
  try { BUSCA.info = await api("/busca/estado"); } catch { return; }
  const el = $("#buscaEstado"); if (!el) return;
  const i = BUSCA.info;
  const onde = i.local ? "na sua máquina" : "em serviço externo — o texto das tarefas sai daqui";
  el.innerHTML = i.pronto && i.modo === "semantica"
    ? `busca por sentido · ${esc(i.provedor)}${i.modelo ? " · " + esc(i.modelo) : ""} (${esc(onde)}) · ${i.indexados}/${i.total} tarefas no índice <button class="linkish" onclick="reindexarBusca()">↻ reindexar</button>`
    : `⚠ ${esc(i.motivo || "sem provedor de embeddings")} · para ligar a busca por sentido: instale o ollama (<code>ollama pull nomic-embed-text</code>) ou escolha outro provedor em BOARD_BUSCA_PROVEDOR`;
}

async function carregarHistoricoBusca() {
  try { BUSCA.hist = (await api("/busca/historico?n=20")).buscas || []; } catch { return; }
  const el = $("#buscaHist"); if (el) el.innerHTML = buscaHistoricoHtml();
}

async function reindexarBusca() {
  toast("recalculando o índice…");
  try { const r = await api("/busca/reindexar", { method: "POST" }); toast(`índice refeito: ${r.total} tarefa(s)`); }
  catch (e) { toast(e.message); }
  carregarEstadoBusca();
}

// Mostra o motor quando não é o padrão do board, e o modelo quando o dono escolheu um.
