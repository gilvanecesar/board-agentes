// 🖥 Os agentes no tmux, na tela (#/agentes, #248): o board sem tela (Atena) não tem Terminal para abrir, então o
// "ver no tmux" mostra aqui a sessão board-agentes — uma aba por janela (o painel e cada agente), a tela crua ao vivo
// pelo mesmo desenho do menu Sessões (#233). Só leitura: o painel e o `board seguir` não leem teclado.
let AGT = { dados: null, erro: null, janela: null, fonte: null, timer: null, abrindo: false };

async function carregarAgentesTmux() {
  try { AGT.dados = await api("/agentes/tmux"); AGT.erro = null; }
  catch (e) { AGT.erro = e.message; }
  pintarAgentesTmux();
}

function janelaEscolhida() {
  const l = AGT.dados?.janelas || [];
  return l.find((j) => j.janela === AGT.janela) || l.find((j) => j.ativa) || l[0] || null;
}

function agentesTmuxHtml() {
  if (AGT.erro && !AGT.dados) return `<div class="empty">Não consegui ler a sessão dos agentes: ${esc(AGT.erro)}</div>`;
  const d = AGT.dados; if (!d) return `<div class="empty">lendo…</div>`;
  if (!d.existe) return `<div class="empty">A sessão tmux <b>${esc(d.sessao)}</b> não está aberta.
    <p><button class="btn primary" data-agt-abrir ${AGT.abrindo ? "disabled" : ""}>${AGT.abrindo ? "⏳ abrindo…" : "🖥 Abrir a sessão dos agentes"}</button></p></div>`;
  const j = janelaEscolhida();
  const abas = d.janelas.map((x) => `<button class="ses-aba ${x.janela === j.janela ? "on" : ""}" data-agt-janela="${x.janela}" title="tmux ${esc(d.sessao)}:${x.janela}${x.tarefa ? ` · tarefa #${x.tarefa}` : ""}">
      <i class="ses-dot ${x.terminou ? "" : "on"}"></i><b>${esc(x.nome)}</b>${x.tarefa ? `<small>#${x.tarefa}</small>` : ""}${x.terminou ? `<small class="ses-fora">terminou</small>` : ""}</button>`).join("");
  return `<div class="ses-abas" role="tablist">${abas}</div>
    <div class="ses-cab"><b>${esc(j.nome)}</b> <span class="pr-mudo">tmux ${esc(d.sessao)}:${j.janela} · só leitura${j.tarefa ? ` · <a href="#/t/${j.tarefa}">abrir a tarefa #${j.tarefa}</a>` : ""}</span></div>
    <pre class="ses-term" id="agtTerm" tabindex="0" aria-label="tela da aba ${esc(j.nome)} da sessão ${esc(d.sessao)}"><span class="pr-mudo">conectando…</span></pre>
    <p class="pr-mudo ses-dica">Agente que começa ganha aba sozinho (quem abre é o painel). A aba some quando a tarefa é concluída.</p>`;
}

function pintarAgentesTmux() {
  const el = $("#agtLista"); if (!el) return;
  const antes = AGT.janela;
  const term = $("#agtTerm"), html = term && term.dataset.pronto ? term.innerHTML : null, topo = term?.scrollTop;
  el.innerHTML = agentesTmuxHtml();
  const j = AGT.dados?.existe ? janelaEscolhida() : null;
  AGT.janela = j ? j.janela : null;
  const t = $("#agtTerm");
  if (html != null && t && antes === AGT.janela) { t.innerHTML = html; t.dataset.pronto = "1"; t.scrollTop = topo; }
  if (!j) pararDeAssistirAgentes();
  else if (antes !== j.janela || !AGT.fonte) assistirAgentes(j.janela);
}

function assistirAgentes(n) {
  pararDeAssistirAgentes();
  const es = new EventSource(`/api/agentes/tmux/${n}/ao-vivo`);
  es.addEventListener("tela", (e) => {
    const t = $("#agtTerm"); if (!t || AGT.janela !== n) return;
    const seguir = !t.dataset.pronto || t.scrollHeight - t.scrollTop - t.clientHeight < 40;
    t.innerHTML = JSON.parse(e.data).html; t.dataset.pronto = "1";
    if (seguir) t.scrollTop = t.scrollHeight;
  });
  es.addEventListener("erro", (e) => {
    const t = $("#agtTerm"); if (t) { t.innerHTML = `<span class="ses-erro">${esc(JSON.parse(e.data).error)}</span>`; delete t.dataset.pronto; }
    carregarAgentesTmux();
  });
  AGT.fonte = es;
}
function pararDeAssistirAgentes() { if (AGT.fonte) { AGT.fonte.close(); AGT.fonte = null; } }

function renderAgentesTmux() {
  const app = $("#app");
  const n = (location.hash.match(/^#\/agentes\/(\d+)/) || [])[1];
  if (n != null) AGT.janela = Number(n);
  if (app.dataset.agentes === "1" && $("#agtLista")) { renderHeader(); pintarAgentesTmux(); return; }
  app.dataset.agentes = "1"; delete app.dataset.task; delete app.dataset.conversa; delete app.dataset.busca; delete app.dataset.prs; delete app.dataset.navegador; delete app.dataset.sessoes;
  app.className = "wrap";
  app.innerHTML = headerHtml(`<button class="back" onclick="location.hash=''">← voltar</button>`) + workspaceIntro("agentes") + `<div id="agtLista"></div>`;
  pintarAgentesTmux();
  carregarAgentesTmux();
  clearInterval(AGT.timer);
  AGT.timer = setInterval(() => { if (view.name === "agentes") carregarAgentesTmux(); }, 3000); // agente novo, aba que fechou
}
window.addEventListener("hashchange", () => {
  if (/^#\/agentes/.test(location.hash)) return;
  pararDeAssistirAgentes(); clearInterval(AGT.timer); AGT.timer = null; delete $("#app").dataset.agentes;
});

document.addEventListener("click", async (e) => {
  if (!$("#agtLista")?.contains(e.target)) return;
  const aba = e.target.closest("[data-agt-janela]");
  if (aba) { const n = Number(aba.dataset.agtJanela); history.replaceState(null, "", "#/agentes/" + n); if (n !== AGT.janela) { AGT.janela = n; pararDeAssistirAgentes(); pintarAgentesTmux(); } return; }
  if (e.target.closest("[data-agt-abrir]") && !AGT.abrindo) {
    AGT.abrindo = true; pintarAgentesTmux();
    try { await abrirTmux(); } // o mesmo 🖥 da faixa de agentes (#352: Ghostty, direto ou pelo board do Mac)
    finally { AGT.abrindo = false; await carregarAgentesTmux(); }
  }
});
