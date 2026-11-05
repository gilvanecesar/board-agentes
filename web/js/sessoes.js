// 🖥 Sessões (#/sessoes, #233): o terminal CRU de cada sessão do Claude aberta na máquina, ao vivo, e a caixa para
// responder — texto, Enter, setas, Esc, o 1/2/3 dos pedidos de permissão, Ctrl+C. Uma aba por sessão. Quem roda fora do
// tmux, depois que sai (/exit), volta por um de dois caminhos (#234): 💬 vira o fio da Conversa do projeto (sem terminal
// nenhum) ou ⇱ reabre no tmux, sem janela. E ＋ Nova sessão abre um claude novo por projeto, no tmux.
// (O pedido de permissão como cartão é a #232.)
let SES = { dados: null, erro: null, fonte: null, pid: null, timer: null, projetos: null, abrindo: false, anterioresAberto: false, limpando: false };

async function carregarSessoes() {
  try { SES.dados = await api("/sessoes"); SES.erro = null; }
  catch (e) { SES.erro = e.message; }
  if (!SES.projetos) { try { SES.projetos = (await api("/sessoes/projetos")).projetos; } catch { SES.projetos = []; } }
  pintarSessoes();
}

function novaSessaoHtml() {
  const ps = SES.projetos || [];
  if (!ps.length) return "";
  const esc_ = store.get("sesProjeto", ps[0].slug);
  return `<form class="ses-nova" id="sesNova"><label class="pr-mudo" for="sesNovaProj">Nova sessão do Claude em</label>
    <select id="sesNovaProj">${ps.map((p) => `<option value="${esc(p.slug)}" ${p.slug === esc_ ? "selected" : ""}>${esc(p.label)}</option>`).join("")}</select>
    <button class="btn" ${SES.abrindo ? "disabled" : ""}>${SES.abrindo ? "⏳ abrindo…" : "＋ Nova sessão"}</button>
    <span class="pr-mudo">abre no tmux, sem janela; fica viva com tudo fechado</span></form>`;
}

const SES_TECLAS = [["Enter", "⏎ Enter"], ["Escape", "Esc"], ["Up", "↑"], ["Down", "↓"], ["Left", "←"], ["Right", "→"], ["Tab", "Tab"], ["BTab", "⇧Tab"], ["BSpace", "⌫"], ["C-c", "Ctrl+C"]];

// As abas: as sessões abertas e, depois delas, as que saíram do terminal (a memória do board), com os caminhos de volta.
// #345: a que tem o mesmo nome e pasta de uma viva (ou de outra que saiu depois) não vira aba: fica em "anteriores".
const comoEncerrada = (e) => ({ ...e, encerrada: true, tmux: null, status: "saiu do terminal" });
function sessoesDaTela() {
  const d = SES.dados || {};
  return [...(d.sessoes || []), ...(d.encerradas || []).map(comoEncerrada)];
}
const anterioresDaTela = () => (SES.dados?.anteriores || []).map(comoEncerrada);
// A chave da escolha é o sessionId: o pid se repete entre reinícios da máquina (duas "robo" com o pid 1769).
const chaveSes = (s) => s.sessionId || String(s.pid);
function sessaoEscolhida() {
  const l = sessoesDaTela(), todas = [...l, ...anterioresDaTela()];
  return todas.find((s) => chaveSes(s) === SES.escolha) || l.find((s) => s.pid === SES.pid && !s.encerrada) || todas.find((s) => s.pid === SES.pid)
    || l.find((s) => s.tmux) || l[0] || null;
}
/** "saiu há 5 min", "há 3 h", "há 2 dias". */
function saiuHa(iso) {
  const t = Date.parse(iso || ""); if (!t) return "saiu";
  const min = Math.max(0, Math.round((Date.now() - t) / 60000));
  return "saiu há " + (min < 1 ? "menos de 1 min" : min < 60 ? `${min} min` : min < 1440 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} dia${Math.round(min / 1440) > 1 ? "s" : ""}`);
}
const quandoSaiu = (iso) => iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";

function anterioresHtml(s) {
  const l = anterioresDaTela();
  const total = l.length + (SES.dados?.encerradas || []).length;
  const limpar = total ? `<button class="btn" id="sesLimpar" ${SES.limpando ? "disabled" : ""} title="Esquece as sessões que saíram do terminal. Sessão aberta, a trazida para a Conversa e o histórico do Claude ficam.">${SES.limpando ? "⏳ limpando…" : `🧹 Limpar encerradas (${total})`}</button>` : "";
  if (!l.length) return limpar ? `<div class="ses-anteriores">${limpar}</div>` : "";
  return `<div class="ses-anteriores"><details id="sesAnteriores" ${SES.anterioresAberto ? "open" : ""}><summary>anteriores (${l.length})</summary>
    <p class="pr-mudo">Sessões que saíram com o mesmo nome e pasta de uma aba acima (ex.: a robo, que sobe um claude novo a cada reinício).</p>
    <div class="ses-ant-lista">${l.map((x) => `<button class="ses-aba ses-ant ${s && chaveSes(x) === chaveSes(s) ? "on" : ""}" data-ses-ant="${esc(chaveSes(x))}" title="${esc(x.pasta)} · saiu por volta de ${esc(quandoSaiu(x.saiu))}"><b>${esc(x.nome)}</b>${x.pasta && x.pasta !== x.nome ? `<small>${esc(x.pasta)}</small>` : ""}<small class="ses-fora">${esc(saiuHa(x.saiu))}</small></button>`).join("")}</div>
  </details>${limpar}</div>`;
}

function trazidasHtml() {
  const t = SES.dados?.trazidas || [], reab = new Set(SES.dados?.reaberta || []);
  const avisos = (SES.dados?.sessoes || []).filter((s) => reab.has(s.sessionId));
  if (!t.length && !avisos.length) return "";
  return `<div class="ses-trazidas"><span class="pr-mudo">Trazidas para a Conversa:</span>
    ${t.map((x) => `<a class="btn" href="#/c/${esc(x.slug)}">💬 ${esc(x.nome)} → ${esc(x.label)}</a>`).join("")}
    ${avisos.map((s) => `<span class="ses-erro">⚠ ${esc(s.nome)} foi trazida para a Conversa e está aberta de novo no terminal — duas cópias da mesma conversa se atropelam: feche uma.</span>`).join("")}</div>`;
}

function sessoesHtml() {
  if (SES.erro && !SES.dados) return `<div class="empty">Não consegui ler as sessões: ${esc(SES.erro)}</div>`;
  const d = SES.dados; if (!d) return `<div class="empty">lendo…</div>`;
  // Cockpit (#364): o terminal no meio e, à direita, o inspetor com a lista das sessões, a nova sessão e as trazidas.
  if (!sessoesDaTela().length) return `<div class="ses-grade"><div class="ses-main"><div class="empty">Nenhuma sessão do Claude aberta agora. Abra uma com <b>＋ Nova sessão</b> — ela roda no tmux, sem janela, e aparece aqui.</div></div><aside class="inspetor ses-lado">${novaSessaoHtml()}${trazidasHtml()}</aside></div>`;
  const s = sessaoEscolhida();
  const abas = sessoesDaTela().map((x) => `<button class="ses-aba ${chaveSes(x) === chaveSes(s) ? "on" : ""}" data-ses="${x.pid}" data-ses-chave="${esc(chaveSes(x))}" title="${esc(x.pasta)} · ${esc(x.status)}${x.tmux ? ` · tmux ${esc(x.tmux.sessao)}:${x.tmux.janela}` : x.encerrada ? ` · saiu por volta de ${esc(quandoSaiu(x.saiu))}` : " · fora do tmux"}">
      <i class="ses-dot ${x.tmux ? "on" : ""}"></i><b>${esc(x.nome)}</b>${x.pasta && x.pasta !== x.nome ? `<small>${esc(x.pasta)}</small>` : ""}${x.tmux ? "" : `<small class="ses-fora">${x.encerrada ? esc(saiuHa(x.saiu)) : "fora do tmux"}</small>`}</button>`).join("");
  return `<div class="ses-grade"><div class="ses-main">${s.tmux ? terminalHtml(s) : reabrirHtml(s)}</div><aside class="inspetor ses-lado"><h3>Sessões abertas <span>${sessoesDaTela().length}</span></h3><div class="ses-abas" role="tablist">${abas}</div>${anterioresHtml(s)}${novaSessaoHtml()}${trazidasHtml()}</aside></div>`;
}

function terminalHtml(s) {
  return `<div class="ses-cab"><b>${esc(s.nome)}</b> <span class="pr-mudo">${esc(s.pasta)} · tmux ${esc(s.tmux.sessao)}:${esc(s.tmux.janela)} · ${esc(s.status)}</span>${pastaRecolhida(s.cwd, "caminho")}${s.ghostty ? `<span class="ses-gh">${ghosttyBotao(s.ghostty, { pid: s.pid }, "btn primary")}<span class="pr-mudo">no seu terminal · sair sem fechar: <kbd>Ctrl</kbd>+<kbd>B</kbd>, depois <kbd>D</kbd></span></span>` : ""}</div>
    <pre class="ses-term" id="sesTerm" tabindex="0" aria-label="terminal da sessão ${esc(s.nome)} — com o foco aqui, as teclas vão para a sessão"><span class="pr-mudo">conectando…</span></pre>
    <div class="ses-teclas">${SES_TECLAS.map(([k, r]) => `<button class="btn" data-tecla="${k}">${r}</button>`).join("")}
      <span class="ses-sep"></span>${["1", "2", "3"].map((n) => `<button class="btn" data-texto="${n}" title="a opção ${n} de um pedido de permissão">${n}</button>`).join("")}</div>
    <form class="ses-enviar" id="sesForm"><input id="sesTexto" autocomplete="off" placeholder="Escreva para a sessão ${esc(s.nome)}…">
      <label class="ses-enter"><input type="checkbox" id="sesComEnter" checked> Enter no fim</label><button class="btn primary">Enviar</button></form>
    <p class="pr-mudo ses-dica">Clique no terminal para digitar direto nele (Enter, setas, Esc, Ctrl+C também). Cada envio fica no registro do board, sem o texto.</p>`;
}

function reabrirHtml(s) {
  const proj = s.projeto, ocupado = SES.abrindo ? "disabled" : "";
  const conversa = proj ? `<button class="btn primary" data-trazer ${ocupado}>💬 Trazer para a Conversa de ${esc(proj.label)}</button>` : "";
  const tmux = `<button class="btn" data-tmux ${ocupado}>⇱ Abrir no tmux, sem janela</button>`;
  const texto = s.encerrada
    ? `<b>${esc(s.nome)} saiu do terminal</b> <span class="pr-mudo">(${esc(s.pasta)} · <span class="ses-saiu" title="por volta de ${esc(quandoSaiu(s.saiu))}">${esc(saiuHa(s.saiu))}</span>)</span>${pastaRecolhida(s.cwd, "caminho")}
    <p>Volte a falar com ela sem terminal nenhum: <b>Trazer para a Conversa</b> faz dela o fio da Conversa do projeto, com o histórico.
    Ou <b>Abrir no tmux</b>: reabre a mesma conversa dentro do tmux, sem abrir janela, e ela responde aqui nesta tela.</p>
    ${!proj ? `<p class="pr-mudo">A pasta dela não é um projeto do board: só dá para abrir no tmux.</p>` : s.historico === false ? `<p class="pr-mudo">Não achei o histórico desta sessão: a Conversa começaria do zero.</p>` : ""}`
    : `<b>${esc(s.nome)} roda fora do tmux</b> <span class="pr-mudo">(${esc(s.pasta)} · pid ${esc(s.pid)})</span>${pastaRecolhida(s.cwd, "caminho")}
    <p>O board só enxerga e responde sessões que rodam dentro do tmux. Para trazer esta com a mesma conversa, dê <code>/exit</code> nela onde ela está — duas cópias da mesma sessão se atropelam, e o board nunca fecha a de fora — e escolha para onde ela vem.</p>`;
  return `<div class="ses-reabrir">${texto}<div class="ses-botoes">${conversa}${tmux}</div>
    <details class="ses-manual"><summary class="pr-mudo">ou pelo terminal</summary><pre class="ses-cmd">${esc(s.reabrir)}</pre><button class="btn" data-copiar>Copiar o comando</button></details></div>`;
}

// 💬 para a Conversa: o servidor pergunta o que só o dono decide (qual fio fica, pôr o projeto na seleção) e a tela pergunta.
async function trazerParaConversa(s, extra = {}) {
  if (SES.abrindo) return;
  SES.abrindo = true; pintarSessoes();
  try {
    const r = await fetch("/api/sessoes/trazer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: s.sessionId, ...extra }) });
    const d = await r.json().catch(() => ({}));
    if (r.status === 409 && d.conflito) {
      const c = d.conflito;
      const ok = confirm(`A Conversa de ${c.label} já tem um fio (${c.mensagens} mensage${c.mensagens === 1 ? "m" : "ns"}${c.trecho ? `, a última sua: "${c.trecho}"` : ""}). Qual fica?\n\nOK = a sessão ${c.nova} do terminal (o fio de agora vai para o arquivo, não é apagado)\nCancelar = manter o fio de agora`);
      SES.abrindo = false;
      return ok ? trazerParaConversa(s, { ...extra, substituir: true }) : pintarSessoes();
    }
    if (r.status === 409 && d.precisaVisivel) {
      const ok = confirm(`${d.precisaVisivel.label} não está na seleção de projetos da tela. Pôr na seleção e trazer a sessão para a Conversa dele?`);
      SES.abrindo = false;
      return ok ? trazerParaConversa(s, { ...extra, porVisivel: true }) : pintarSessoes();
    }
    if (!r.ok) throw new Error(d.error || "erro " + r.status);
    toast(d.jaEstava ? "Esta sessão já é o fio da Conversa." : `Sessão ${s.nome} trazida para a Conversa de ${d.label || d.slug}.`, 5000);
    SES.abrindo = false;
    location.hash = d.url;
  } catch (e) { toast(e.message, 8000, "erro"); }
  finally { if (SES.abrindo) { SES.abrindo = false; await carregarSessoes(); } }
}

// 🧹 Esquecer as que saíram (#345): só a lembrança do board; sessão viva, trazida e transcrito ficam.
async function limparEncerradas() {
  if (SES.limpando) return;
  const n = (SES.dados?.encerradas || []).length + (SES.dados?.anteriores || []).length;
  if (!confirm(`Esquecer as ${n} sessões que saíram do terminal?\n\nAs sessões abertas, as trazidas para a Conversa e o histórico do Claude ficam. As que saíram não aparecem mais aqui (nem para trazer de volta).`)) return;
  SES.limpando = true; pintarSessoes();
  try { const r = await api("/sessoes/limpar-encerradas", { method: "POST", body: {} }); toast(`${r.esquecidas} sessão(ões) esquecida(s).`, 4000); }
  catch (e) { toast(e.message, 8000, "erro"); }
  finally { SES.limpando = false; await carregarSessoes(); }
}

// Trazer / Nova: o servidor abre no tmux e espera o claude se registrar; a tela passa para a aba da sessão nova.
async function abrirSessao(rota, corpo) {
  if (SES.abrindo) return;
  SES.abrindo = true; pintarSessoes();
  try {
    const r = await api(rota, { method: "POST", body: corpo || {} });
    toast(r.aviso || `Sessão ${r.nome} aberta no tmux (${r.tmux}), sem janela. Para vê-la no seu terminal: 🖥 ver no tmux, no alto dela (abre no Ghostty).`, 7000);
    if (r.pid) { SES.pid = r.pid; SES.escolha = null; pararDeAssistirSessao(); history.replaceState(null, "", "#/sessoes/" + r.pid); }
  } catch (e) { toast(e.message, 8000, "erro"); }
  finally { SES.abrindo = false; await carregarSessoes(); }
}

function pintarSessoes() {
  const el = $("#sesLista"); if (!el) return;
  const antes = sessaoEscolhida();
  const term = $("#sesTerm"), html = term && term.dataset.pronto ? term.innerHTML : null, foco = document.activeElement?.id;
  const texto = $("#sesTexto")?.value;
  el.innerHTML = sessoesHtml();
  const s = sessaoEscolhida();
  SES.pid = s?.pid ?? null; SES.escolha = s ? chaveSes(s) : null;
  if (html != null && $("#sesTerm")) { $("#sesTerm").innerHTML = html; $("#sesTerm").dataset.pronto = "1"; rolarTerminal(true); }
  if (texto != null && $("#sesTexto")) $("#sesTexto").value = texto;
  if (foco && $("#" + foco)) $("#" + foco).focus();
  if (!s?.tmux) pararDeAssistirSessao();
  else if (!antes || antes.pid !== s.pid || !SES.fonte) assistirSessao(s.pid);
}

function rolarTerminal(forcar) {
  const t = $("#sesTerm"); if (!t) return;
  if (forcar || t.scrollHeight - t.scrollTop - t.clientHeight < 40) t.scrollTop = t.scrollHeight;
}

function assistirSessao(pid) {
  pararDeAssistirSessao();
  const es = new EventSource(`/api/sessoes/${pid}/ao-vivo`);
  es.addEventListener("tela", (e) => {
    const t = $("#sesTerm"); if (!t || SES.pid !== pid) return;
    const seguir = !t.dataset.pronto || t.scrollHeight - t.scrollTop - t.clientHeight < 40;
    t.innerHTML = JSON.parse(e.data).html; t.dataset.pronto = "1";
    if (seguir) t.scrollTop = t.scrollHeight;
  });
  es.addEventListener("erro", (e) => {
    const t = $("#sesTerm"); if (t) t.innerHTML = `<span class="ses-erro">${esc(JSON.parse(e.data).error)}</span>`;
    carregarSessoes();
  });
  SES.fonte = es;
}
function pararDeAssistirSessao() { if (SES.fonte) { SES.fonte.close(); SES.fonte = null; } }

// Um envio de cada vez, na ordem: "2" e Enter clicados (ou digitados) em seguida não podem chegar trocados.
let sesFila = Promise.resolve();
function mandarSessao(corpo) {
  const pid = SES.pid; if (!pid) return Promise.resolve(false);
  const vez = sesFila.then(async () => {
    try { await api(`/sessoes/${pid}/teclas`, { method: "POST", body: corpo }); return true; }
    catch (e) { toast("Não deu: " + e.message, 5000, "erro"); return false; }
  });
  sesFila = vez;
  return vez;
}

// Com o foco no terminal, a tecla vai para a sessão (o que o terminal do Mac faria).
const SES_MAPA = { Enter: "Enter", Escape: "Escape", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Tab: "Tab", Backspace: "BSpace", PageUp: "PPage", PageDown: "NPage", Home: "Home", End: "End" };
function teclaNoTerminal(e) {
  if (e.metaKey || e.altKey) return; // ⌘C/⌘V e afins ficam com o navegador
  let corpo = null;
  if (e.ctrlKey) { if (e.key.toLowerCase() === "c") corpo = { teclas: ["C-c"] }; }
  else if (e.key === "Tab" && e.shiftKey) corpo = { teclas: ["BTab"] };
  else if (SES_MAPA[e.key]) corpo = { teclas: [SES_MAPA[e.key]] };
  else if (e.key.length === 1) corpo = { texto: e.key };
  if (!corpo) return;
  e.preventDefault();
  mandarSessao(corpo);
}

function renderSessoes() {
  const app = $("#app");
  const pidHash = Number((location.hash.match(/^#\/sessoes\/(\d+)/) || [])[1]) || null;
  if (pidHash && pidHash !== SES.pid) { SES.pid = pidHash; SES.escolha = null; }
  if (app.dataset.sessoes === "1" && $("#sesLista")) { renderHeader(); pintarSessoes(); return; }
  app.dataset.sessoes = "1"; delete app.dataset.task; delete app.dataset.conversa; delete app.dataset.busca; delete app.dataset.prs; delete app.dataset.navegador;
  app.className = "wrap sessoes com-inspetor";
  app.innerHTML = headerHtml(`<button class="back" onclick="location.hash=''">← voltar</button>`) + workspaceIntro("sessoes") + mheadHtml("Sessões", `<span class="chip">o terminal de cada sessão do Claude no tmux, ao vivo</span>`) + `<div id="sesLista"></div>`;
  pintarSessoes();
  carregarSessoes();
  clearInterval(SES.timer);
  SES.timer = setInterval(() => { if (view.name === "sessoes") carregarSessoes(); }, 5000); // sessão que abriu, fechou ou entrou no tmux
}
window.addEventListener("hashchange", () => {
  if (/^#\/sessoes/.test(location.hash)) return;
  pararDeAssistirSessao(); clearInterval(SES.timer); SES.timer = null;
});

document.addEventListener("click", async (e) => {
  if (!$("#sesLista")?.contains(e.target)) return;
  const aba = e.target.closest("[data-ses]");
  if (aba) { const pid = Number(aba.dataset.ses), ch = aba.dataset.sesChave; if (ch !== SES.escolha) { SES.pid = pid; SES.escolha = ch; pararDeAssistirSessao(); history.replaceState(null, "", "#/sessoes/" + pid); pintarSessoes(); } return; }
  const ant = e.target.closest("[data-ses-ant]");
  if (ant) { const x = anterioresDaTela().find((y) => chaveSes(y) === ant.dataset.sesAnt); if (x) { SES.pid = x.pid; SES.escolha = chaveSes(x); pararDeAssistirSessao(); history.replaceState(null, "", "#/sessoes/" + x.pid); pintarSessoes(); } return; }
  if (e.target.closest("#sesLimpar")) { limparEncerradas(); return; }
  const t = e.target.closest("[data-tecla]");
  if (t) { await mandarSessao({ teclas: [t.dataset.tecla] }); $("#sesTerm")?.focus(); return; }
  const n = e.target.closest("[data-texto]");
  if (n) { await mandarSessao({ texto: n.dataset.texto }); $("#sesTerm")?.focus(); return; }
  if (e.target.closest("[data-trazer]")) { const s = sessaoEscolhida(); if (s) trazerParaConversa(s); return; }
  if (e.target.closest("[data-tmux]")) { const s = sessaoEscolhida(); if (s) abrirSessao("/sessoes/tmux", { sessionId: s.sessionId }); return; }
  if (e.target.closest("[data-copiar]")) {
    const cmd = sessaoEscolhida()?.reabrir || "";
    try { await navigator.clipboard.writeText(cmd); toast("Comando copiado."); } catch { toast("Não consegui copiar: selecione o comando e copie à mão.", 5000, "erro"); }
  }
});
document.addEventListener("change", (e) => { if (e.target.id === "sesNovaProj") store.set("sesProjeto", e.target.value); });
document.addEventListener("toggle", (e) => { if (e.target.id === "sesAnteriores") SES.anterioresAberto = e.target.open; }, true);
document.addEventListener("submit", async (e) => {
  if (e.target.id === "sesNova") { e.preventDefault(); abrirSessao("/sessoes/nova", { projeto: $("#sesNovaProj").value }); return; }
  if (e.target.id !== "sesForm") return;
  e.preventDefault();
  const inp = $("#sesTexto"), texto = inp.value, enter = $("#sesComEnter").checked;
  if (!texto && !enter) return;
  if (await mandarSessao({ texto, enter })) { inp.value = ""; somEnvio.tocar(); }
});
document.addEventListener("keydown", (e) => { if (e.target.id === "sesTerm") teclaNoTerminal(e); });
