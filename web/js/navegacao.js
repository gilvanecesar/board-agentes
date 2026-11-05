// Roteamento (#/t, #/c, #/busca), o menu lateral e o cabeçalho.
// ── roteamento ───────────────────────────────────────────────────────────────
function route() {
  const t = location.hash.match(/^#\/t\/(\d+)/);
  const c = location.hash.match(/^#\/c\/([\w.-]+)/);
  const b = /^#\/busca/.test(location.hash);
  const prs = /^#\/prs/.test(location.hash);
  const central = /^#\/central/.test(location.hash);
  // #/navegador era a tela do Navegador dos agentes, removida em 04/11: endereço guardado cai no quadro.
  if (/^#\/navegador/.test(location.hash)) { history.replaceState(null, "", location.pathname + location.search); }
  const ses = /^#\/sessoes/.test(location.hash);
  const agt = /^#\/agentes/.test(location.hash);
  const voz = /^#\/voz/.test(location.hash);
  const gh = /^#\/ghostty/.test(location.hash);
  view = gh ? { name: "ghostty", id: "ghostty" } : voz ? { name: "voz", id: "voz" } : agt ? { name: "agentes", id: "agentes" } : ses ? { name: "sessoes", id: "sessoes" } : central ? { name: "conversa", id: "conversa-central", slug: "central", central: true }
    : t ? { name: "detail", id: Number(t[1]) }
    : c ? { name: "conversa", id: "conversa-" + c[1], slug: c[1] }
      : b ? { name: "busca", id: "busca" }
        : prs ? { name: "prs", id: "prs" }
        : { name: "list", id: null };
  render();
}
window.addEventListener("hashchange", route);

function render() {
  if (view.name === "detail") return renderDetail();
  if (view.name === "conversa") return renderConversa();
  if (view.name === "busca") return renderBusca();
  if (view.name === "prs") return renderPrs();
  if (view.name === "sessoes") return renderSessoes();
  if (view.name === "agentes") return renderAgentesTmux();
  if (view.name === "voz") return renderVozCadastro();
  if (view.name === "ghostty") return renderGhostty();
  const a = assinaturaLista();
  if (a === ultimaAssinatura && ($("#list") || $("#kanban"))) return; // nada mudou na lista: não mexe na tela
  ultimaAssinatura = a;
  renderList();
}


const NAV_ICONS = {
  board: '<rect x="3" y="3" width="7" height="18" rx="1.5"/><rect x="14" y="3" width="7" height="11" rx="1.5"/>',
  prs: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/><path d="M6 7v10"/><path d="M18 17V9a3 3 0 0 0-3-3h-4"/><path d="m13 3-2 3 2 3"/>',
  busca: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  conversa: '<path d="M21 11a8 8 0 0 1-8 8H7l-5 3 2-6a8 8 0 1 1 17-5Z"/>',
  central: '<circle cx="12" cy="12" r="2.5"/><circle cx="4.5" cy="5" r="2"/><circle cx="19.5" cy="5" r="2"/><circle cx="4.5" cy="19" r="2"/><circle cx="19.5" cy="19" r="2"/><path d="m6 6.5 4.2 4M18 6.5l-4.2 4M6 17.5l4.2-4M18 17.5l-4.2-4"/>',
  controle: '<path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6l-8-3Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  sessoes: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M12 15h5"/>'
};
// O fio que o 💬 abre: o projeto filtrado, senão o último escolhido, senão o 1º da seleção. Só vale projeto que ESTÁ
// na seleção: o guardado no navegador pode ter saído dela (26/10: um projeto saiu e o menu ficou preso no #/c/ dele).
function projetoDaConversa(preferido) {
  const ok = (p) => p && (S.projects || []).some((x) => x.slug === p);
  return [preferido, store.get('project', null)].find(ok) || S.projects?.[0]?.slug || 'DEV';
}
function navigateBoard(destination) {
  if (destination === 'central') { location.hash = '#/central'; return; }
  if (destination === 'prs') { location.hash = '#/prs'; return; }
  if (TELAS_REMOVIDAS.includes(destination)) destination = 'board'; // tela removida em 04/11
  if (destination === 'sessoes') { location.hash = '#/sessoes'; return; }
  if (destination === 'busca') { const p = store.get('filtro','todos'); if (p !== 'todos') store.set('buscaProjeto',p); location.hash = '#/busca'; return; }
  if (destination === 'conversa') { location.hash = '#/c/' + encodeURIComponent(projetoDaConversa(store.get('filtro','todos'))); return; }
  store.set('tab', destination === 'board' ? 'ativas' : destination);
  ultimaAssinatura = null;
  if (location.hash) location.hash = ''; else { view = {name:'list',id:null}; renderList(); }
}
function renderNavigation() {
  const selected = view.name === 'list' ? (store.get('tab','ativas') === 'controle' ? 'controle' : 'board') : view.name === 'detail' || view.name === 'agentes' ? 'board' : view.name === 'ghostty' ? 'sessoes' : view.central || view.name === 'voz' ? 'central' : view.name;
  // O painel do modo voz (#307) mora no menu e NÃO se redesenha com ele: o menu volta a cada evento, e redesenhar o painel
  // arrancaria o deslizante da mão do dono e fecharia os ajustes abertos. Por isso o menu escreve só nos dois pedaços dele.
  const aside = $('#navigation');
  if (!$('#navMenu')) {
    aside.innerHTML = `<div id="navMenu" class="nav-pedaco"></div><section class="voz-painel" id="vozPainel" aria-label="Modo voz"><div id="vozBarra"></div><button class="voz-abrir" type="button" aria-expanded="false" title="Abrir o painel do modo voz: ajustes, cadastro da voz e limites" onclick="alternarMais()">⚙</button><div class="voz-faixa" id="vozFaixa" role="status" aria-live="polite"></div></section><div id="navBase" class="nav-pedaco"></div>`;
    if (typeof pintarVoz === 'function') queueMicrotask(pintarVoz);
  }
  // Cockpit (#364, Proposta A): o menu é um TRILHO de ícones com o rótulo curto embaixo e um selo de contagem; no celular vira a
  // barra de baixo (Central, Quadro, Conv., Sessões, PRs e ⋯ Mais, onde ficam Buscar, Controle e o painel do modo voz).
  const precisa = (S.tasks || []).filter((t) => t.status === "erro" || (naoJuntada(t) && t.status !== "concluida") || prEsgotado(t) || faltaConferir(t)).length;
  const nPrs = typeof LADO_CENTRAL !== "undefined" && LADO_CENTRAL.prs ? LADO_CENTRAL.prs.projetos.reduce((n, p) => n + p.abertos.length, 0) : 0;
  const selo = { board: precisa, prs: nPrs };
  $('#navMenu').innerHTML = `<nav class="trilho">${NAV_ITENS.map(([key, curto, label]) => `<button class="nav-item ${selected === key ? 'active' : ''}" data-k="${key}" ${selected === key ? 'aria-current="page"' : ''} title="${label}" aria-label="${label}" onclick="navigateBoard('${key}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${NAV_ICONS[key]}</svg><span class="nav-rot">${curto}</span>${selo[key] ? `<span class="nav-selo" title="${key === 'board' ? 'tarefas que precisam de você' : 'PRs abertos'}">${selo[key]}</span>` : ''}</button>`).join('')}<button class="nav-mais" type="button" aria-expanded="${document.body.classList.contains('mais-aberto')}" onclick="alternarMais()" title="Mais: Buscar, Controle e o modo voz"><span aria-hidden="true">⋯</span><span class="nav-rot">Mais</span></button></nav>`;
  $('#navBase').innerHTML = `<div class="mais-folha" aria-label="Mais"><button class="btn" onclick="alternarMais(false);navigateBoard('busca')">⌕ Buscar</button><button class="btn" onclick="alternarMais(false);navigateBoard('controle')">🛡 Controle</button></div>`;
}
const NAV_ITENS = [['central', 'Central', 'Central'], ['board', 'Quadro', 'Meu quadro'], ['conversa', 'Conv.', 'Conversas'], ['sessoes', 'Sessões', 'Sessões'], ['busca', 'Buscar', 'Buscar'], ['prs', 'PRs', 'Pull Requests'], ['controle', 'Contr.', 'Controle']];
/** O "⋯ Mais" (celular) e o ⚙ do módulo de voz (computador) abrem a mesma folha: Buscar, Controle e o painel do modo voz. */
function alternarMais(abrir) {
  const on = document.body.classList.toggle('mais-aberto', abrir);
  document.querySelectorAll('.nav-mais, .voz-abrir').forEach((b) => b.setAttribute('aria-expanded', String(on)));
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('mais-aberto')) alternarMais(false); });
document.addEventListener('click', (e) => {
  if (!document.body.classList.contains('mais-aberto')) return;
  if (e.target.closest && (e.target.closest('#vozPainel') || e.target.closest('.nav-mais') || e.target.closest('.mais-folha') || e.target.closest('.voz-abrir'))) return;
  alternarMais(false);
});
/** O cabeçalho de painel do Cockpit (#364): título, o meio (chips, seletores) e as ações à direita. */
const mheadHtml = (titulo, meio = "", dir = "") => `<div class="mhead"><h2>${titulo}</h2>${meio}${dir ? `<span class="mhead-dir">${dir}</span>` : ""}</div>`;
function workspaceIntro(tab) {
  const titles = {ghostty:['Abrir no Ghostty','Suas sessões, no seu terminal.','As sessões do tmux do servidor, cada uma numa janela do Ghostty deste Mac. Para sair sem fechar a sessão: Ctrl+B, depois D.'],agentes:['Agentes no tmux','Quem está trabalhando, ao vivo.','A sessão tmux board-agentes: o painel e uma aba por agente, como no Terminal — aqui porque o board roda numa máquina sem tela. Só leitura.'],sessoes:['Sessões do terminal','Suas sessões, sem sair daqui.','O terminal de cada sessão do Claude que roda no tmux, ao vivo. Responda daqui: texto, Enter, setas, Esc e o 1/2/3 dos pedidos de permissão.'],central:['Central','Fale uma vez, o trabalho anda.','Você pede aqui; a Central responde, cria a tarefa ou leva às sessões do Claude abertas na máquina — e mostra o que elas responderem.'],prs:['Pull Requests','O que está esperando você.','Os PRs abertos de cada projeto, com os checks e a conferência do board. Mesclar daqui só mescla; publicar é o 🚀 de cada projeto, sempre pelo seu clique.'],busca:['Encontre no board','Uma ideia, qualquer palavra.','Encontre tarefas pelo que você lembra, em todos os seus projetos.'],conversa:['Converse com seus agentes','O próximo passo começa aqui.','Explore ideias e trabalhe com o contexto de cada projeto.'],controle:['Continuidade','Nada se perde.','Backups, memória compartilhada e as cópias fora das máquinas, num lugar só.']};
  const [label,title,subtitle] = titles[tab] || ['Visão geral','Seu trabalho, em movimento.','Organize as ideias. Delegue aos agentes. Acompanhe cada entrega.'];
  return `<section class="page-intro"><div><span class="eyebrow">${label}</span><h2>${title}</h2><p>${subtitle}</p></div><span class="page-date">${new Date().toLocaleDateString('pt-BR',{day:'numeric',month:'long'})}</span></section>`;
}

function headerHtml(extra = "") {
  renderNavigation();
  const n = (s) => S.tasks.filter((t) => t.status === s).length;
  const nTrab = S.tasks.filter(trabalhando).length;
  const tela = view.central ? "Central" : view.name === "conversa" ? "Conversas" : view.name === "busca" ? "Busca" : view.name === "prs" ? "Pull Requests" : view.name === "sessoes" ? "Sessões" : view.name === "agentes" ? "Agentes no tmux" : view.name === "ghostty" ? "Ghostty" : view.name === "voz" ? "Voz do dono" : view.name === "detail" ? "Meu quadro" : store.get("tab", "ativas") === "controle" ? "Controle" : "Meu quadro";
  // A caixa de comando do topo (Cockpit): no quadro, a própria caixa de nova tarefa se põe aqui por cima; nas outras telas, diz onde ele está e leva à caixa certa.
  const t = view.name === "detail" ? S.tasks.find((x) => x.id === view.id) : null;
  const resto = view.central ? "pergunte à Central ou mande trabalho…" : view.name === "conversa" ? (view.slug ? nomeProj(view.slug) + " · converse com o agente…" : "")
    : t ? `${nomeProj(t.project)} / #${t.id}` : view.name === "detail" ? "tarefa" : view.name === "list" && store.get("tab", "ativas") !== "controle" ? "nova tarefa: descreva e Enter" : view.name === "list" ? "backups, memória e Drive" : view.name === "busca" ? "tarefas e memória" : view.name === "prs" ? "abertos e mesclados" : view.name === "sessoes" ? "o terminal de cada sessão" : "nova tarefa…";
  return `<header class="topo">
    <a class="brand-logo top-logo" href="#" aria-label="Board início" title="Board">B</a>
    ${extra}
    <h1 class="cmd" title="${view.name === "list" ? "" : "Ir para a caixa de escrever"}" onclick="cmdTopo()"><span class="cmd-ico" aria-hidden="true">⌕</span><span class="cmd-tela">${tela}</span>${resto ? `<span class="cmd-resto"><span class="cmd-sep" aria-hidden="true">${t ? "/" : "·"}</span> ${esc(resto)}</span>` : ""}<kbd>${view.name === "list" && store.get("tab", "ativas") !== "controle" ? "N" : "⌘K"}</kbd></h1>
    ${S.config.pausaAte ? `<span class="selo nao" style="height:22px" title="a cota do Claude acabou; nada novo começa até ela voltar">⏸ fila pausada até ${new Date(S.config.pausaAte).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</span>` : ""}
    <span class="stats" title="${nTrab} trabalhando · ${n("fila")} na fila · ${n("pendente")} pendente(s)${n("executada") ? ` · ${n("executada")} executada(s)` : ""}"><span class="dot ${nTrab ? "on" : ""}"></span>${nTrab} rodando · ${n("fila")} na fila${S.tasks.some((t) => naoJuntada(t) && t.status !== "concluida") ? ` · <b class="naojuntada-cab">${S.tasks.filter((t) => naoJuntada(t) && t.status !== "concluida").length} não juntada</b>` : ""}</span>
    ${usoCabecalho()}
    ${PERM.pendentes.length ? `<a class="perm-cab" href="#/central" title="Sessões esperando a sua permissão: responda na Central (ou na conversa/tarefa de cada uma)">🔐 ${PERM.pendentes.length} pedido${PERM.pendentes.length > 1 ? "s" : ""} de permissão</a>` : ""}
    <span class="cfg"><span class="dot ${connected ? "on" : ""}" title="${connected ? "ao vivo" : "sem conexão"}"></span><span class="cfg-txt">${connected ? "ao vivo" : "sem conexão"} · ${S.config.perProject || 1} por projeto · teto ${S.config.parallel || 1}</span>
      <span class="fonte-ctl" role="group" aria-label="Tamanho da letra"><button class="ib" type="button" title="Letra menor" aria-label="Letra menor" onclick="mudarFonte(-1)">A−</button><button class="ib" type="button" title="Letra maior" aria-label="Letra maior" onclick="mudarFonte(1)">A+</button></span>
      ${somBotao()}
      ${S.config.filaPausada
        ? `<button class="selo nao" style="height:20px;cursor:pointer" title="A fila está pausada: nada novo começa. Clique para retomar." onclick="filaPausar(false)">⏸ fila pausada · ▶ retomar</button>`
        : `<button class="ib" style="display:inline-grid;width:22px;height:22px;vertical-align:middle" title="Pausar a fila: o que está rodando termina, nada novo começa" onclick="filaPausar(true)">⏸</button>`}
      ${S.config.reinicioPendente ? `<span style="color:var(--amber)" title="sai sozinho quando nada estiver rodando">· ↻ reinício pendente</span>` : `<button class="ib" style="display:inline-grid;width:22px;height:22px;vertical-align:middle" title="Reiniciar o board (carrega código novo) assim que nada estiver rodando" onclick="reiniciar()">↻</button>`}</span>
  </header>`;
}
/** A caixa do topo: leva à caixa de escrever da tela (Central, conversa, ficha) ou à nova tarefa do quadro. */
function cmdTopo() {
  const caixa = $("#convIn") || $("#chatIn") || $("#newTask");
  if (caixa && !caixa.disabled) return caixa.focus();
  if (view.name !== "list") { store.set("tab", "ativas"); location.hash = ""; setTimeout(() => $("#newTask")?.focus(), 200); }
}
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); cmdTopo(); }
});
// O plano do Claude num número compacto no topo, como na barra do tmux (`board barra`). Era o atalho para a tela
// Consumo, que saiu do menu em 04/11 (pedido do dono): sem clique, os detalhes de cada janela ficam no `title`.
function usoCabecalho() {
  const c = USO && USO.motores ? USO.motores.claude : USO;
  if (!c || !c.ok || !c.limites?.length) return "";
  const ses = c.limites.find((l) => /sess/i.test(l.nome));
  const sem = c.limites.filter((l) => /seman|week/i.test(l.nome)).sort((a, b) => b.pct - a.pct)[0];
  const pior = Math.max(...[ses, sem].filter(Boolean).map((l) => l.pct), 0);
  // #364 (Cockpit): cada número ganha uma barrinha ao lado (vazia de texto: o que se lê continua "sessão X% · semana Y%").
  const barra = (l) => `<span class="ubar ${nivel(l.pct)}" aria-hidden="true"><s style="width:${Math.max(0, Math.min(100, l.pct))}%"></s></span>`;
  const partes = [ses ? `sessão ${ses.pct}%${barra(ses)}` : "", sem ? `semana ${sem.pct}%${barra(sem)}` : ""].filter(Boolean).join(" · ");
  if (!partes) return "";
  const dica = c.limites.map((l) => `${l.nome}: ${l.pct}%${l.renovaEm ? ` (renova ${emQuanto(l.renovaEm) || "agora"})` : l.renovaTexto ? ` (${l.renovaTexto})` : ""}`).join("\n");
  return `<span class="uso-cab" title="Uso do seu plano do Claude\n${esc(dica)}"><i class="${nivel(pior)}"></i>Claude ${partes}</span>`;
}
function renderHeader() { const h = $("header"); if (document.activeElement && document.activeElement.classList.contains("som-volume")) return; /* não arrancar o volume da mão do dono */ if (h) h.outerHTML = headerHtml(view.name !== "list" ? `<button class="back" onclick="location.hash=''">← voltar</button>` : ""); }
/** A−/A+ (#364): a letra do board inteiro, por aparelho (`board.fonte`, 13 a 22 px; padrão 16). O CSS do Cockpit é em rem. */
const FONTES = [13, 14, 15, 16, 17, 18, 20, 22];
function mudarFonte(passo) {
  const atual = Number(store.get("fonte", 16)) || 16;
  const i = Math.max(0, Math.min(FONTES.length - 1, FONTES.findIndex((f) => f >= atual) + passo));
  const nova = FONTES[i];
  store.set("fonte", nova);
  document.documentElement.style.fontSize = nova + "px";
  toast(`Letra em ${nova} px (neste aparelho)`, 1800, "info");
  if (typeof medirTopo === "function") medirTopo();
}
