// Roteamento (#/t, #/c, #/busca), o menu lateral e o cabeçalho.
// ── roteamento ───────────────────────────────────────────────────────────────
function route() {
  const t = location.hash.match(/^#\/t\/(\d+)/);
  const c = location.hash.match(/^#\/c\/([\w.-]+)/);
  const b = /^#\/busca/.test(location.hash);
  view = t ? { name: "detail", id: Number(t[1]) }
    : c ? { name: "conversa", id: "conversa-" + c[1], slug: c[1] }
      : b ? { name: "busca", id: "busca" }
        : { name: "list", id: null };
  render();
}
window.addEventListener("hashchange", route);

function render() {
  if (view.name === "detail") return renderDetail();
  if (view.name === "conversa") return renderConversa();
  if (view.name === "busca") return renderBusca();
  const a = assinaturaLista();
  if (a === ultimaAssinatura && $("#list")) return; // nada mudou na lista: não mexe na tela
  ultimaAssinatura = a;
  renderList();
}


const NAV_ICONS = {
  board: '<rect x="3" y="3" width="7" height="18" rx="1.5"/><rect x="14" y="3" width="7" height="11" rx="1.5"/>',
  busca: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  conversa: '<path d="M21 11a8 8 0 0 1-8 8H7l-5 3 2-6a8 8 0 1 1 17-5Z"/>',
  consumo: '<path d="M4 20V12m8 8V4m8 16V8"/>',
  monitoring: '<path d="M2 12h4l3-8 6 16 3-8h4"/>',
  controle: '<path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6l-8-3Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  memoria: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="11" cy="18" r="2.5"/><path d="M8.4 6.6 15.6 7.6M7.2 8.2l2.8 7.6M16.6 10.2l-4.3 6"/>'
};
function navigateBoard(destination) {
  if (destination === 'busca') { const p = store.get('filtro','todos'); if (p !== 'todos') store.set('buscaProjeto',p); location.hash = '#/busca'; return; }
  if (destination === 'conversa') { const p = store.get('filtro','todos'); location.hash = '#/c/' + encodeURIComponent(p !== 'todos' ? p : store.get('project',S.projects[0]?.slug || 'DEV')); return; }
  store.set('tab', destination === 'board' ? 'ativas' : destination);
  ultimaAssinatura = null;
  if (location.hash) location.hash = ''; else { view = {name:'list',id:null}; renderList(); }
}
function renderNavigation() {
  const selected = view.name === 'list' ? (['consumo','monitoring','memoria','controle'].includes(store.get('tab','ativas')) ? store.get('tab','ativas') : 'board') : view.name === 'detail' ? 'board' : view.name;
  $('#navigation').innerHTML = `<a class="brand" href="#" aria-label="Board início"><span class="brand-mark" aria-hidden="true"><i></i><i></i></span>board<span style="color:var(--cyan)">.</span></a>
    <div class="nav-label">Workspace</div><nav>${[['board','Meu quadro'],['conversa','Conversas'],['busca','Buscar'],['memoria','Memória'],['controle','Controle'],['consumo','Consumo'],['monitoring','Monitoramento']].map(([key,label]) => `<button class="nav-item ${selected === key ? 'active' : ''}" ${selected === key ? 'aria-current="page"' : ''} onclick="navigateBoard('${key}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${NAV_ICONS[key]}</svg>${label}</button>`).join('')}</nav>
    <div class="sidebar-bottom"><div class="workspace-badge"><span class="workspace-avatar">B</span><div><b>Seu workspace</b><small>${S.projects.length} projetos conectados</small></div></div></div>`;
}
function workspaceIntro(tab) {
  const titles = {memoria:['Memória compartilhada','Tudo o que os agentes lembram.','O mesmo conhecimento para Claude, Codex, Gemini e opencode, ligado por assunto.'],busca:['Encontre no board','Uma ideia, qualquer palavra.','Encontre tarefas pelo que você lembra, em todos os seus projetos.'],conversa:['Converse com seus agentes','O próximo passo começa aqui.','Explore ideias e trabalhe com o contexto de cada projeto.'],controle:['Continuidade','Nada se perde.','Backups, memória compartilhada e as cópias fora das máquinas, num lugar só.'],consumo:['Recursos','Consumo dos agentes','Acompanhe os limites dos motores e o uso do seu board.'],monitoring:['Infraestrutura','Sua infraestrutura, em foco.','Acompanhe os serviços que mantêm seu workspace funcionando.']};
  const [label,title,subtitle] = titles[tab] || ['Visão geral','Seu trabalho, em movimento.','Organize as ideias. Delegue aos agentes. Acompanhe cada entrega.'];
  return `<section class="page-intro"><div><span class="eyebrow">${label}</span><h2>${title}</h2><p>${subtitle}</p></div><span class="page-date">${new Date().toLocaleDateString('pt-BR',{day:'numeric',month:'long'})}</span></section>`;
}

function headerHtml(extra = "") {
  renderNavigation();
  const n = (s) => S.tasks.filter((t) => t.status === s).length;
  const nTrab = S.tasks.filter(trabalhando).length;
  return `<header>
    ${extra}
    <h1>Workspace <span style="color:var(--line2);padding:0 8px">/</span> ${view.name === "conversa" ? "Conversas" : view.name === "busca" ? "Busca" : view.name === "detail" ? "Detalhes da tarefa" : store.get("tab", "ativas") === "consumo" ? "Consumo" : store.get("tab", "ativas") === "monitoring" ? "Monitoramento" : store.get("tab", "ativas") === "memoria" ? "Memória" : store.get("tab", "ativas") === "controle" ? "Controle" : "Meu quadro"}</h1>
    ${S.config.pausaAte ? `<span class="selo nao" style="height:22px" title="a cota do Claude acabou; nada novo começa até ela voltar">⏸ fila pausada até ${new Date(S.config.pausaAte).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</span>` : ""}
    <span class="stats"><b>${nTrab}</b> trabalhando${nTrab === 1 ? ` (${(ETAPA[(S.tasks.find(trabalhando) || {}).etapa] || "Rodando").toLowerCase()})` : ""} · <b>${n("fila")}</b> na fila · <b>${n("pendente")}</b> pendente${n("executada") ? ` · <b>${n("executada")}</b> executada` : ""}</span>
    ${usoCabecalho()}
    <span class="cfg"><span class="dot ${connected ? "on" : ""}"></span>${connected ? "ao vivo" : "sem conexão"} · ${S.config.perProject || 1} por projeto · teto ${S.config.parallel || 1}
      ${S.config.filaPausada
        ? `· <button class="selo nao" style="height:20px;cursor:pointer" title="A fila está pausada: nada novo começa. Clique para retomar." onclick="filaPausar(false)">⏸ fila pausada · ▶ retomar</button>`
        : `<button class="ib" style="display:inline-grid;width:22px;height:22px;vertical-align:middle" title="Pausar a fila: o que está rodando termina, nada novo começa" onclick="filaPausar(true)">⏸</button>`}
      ${S.config.reinicioPendente ? `<span style="color:var(--amber)" title="sai sozinho quando nada estiver rodando">· ↻ reinício pendente</span>` : `<button class="ib" style="display:inline-grid;width:22px;height:22px;vertical-align:middle" title="Reiniciar o board (carrega código novo) assim que nada estiver rodando" onclick="reiniciar()">↻</button>`}</span>
  </header>`;
}
function usoCabecalho() {
  const ms = USO && USO.motores ? Object.entries(USO.motores).filter(([, u]) => u.ok) : [];
  if (ms.length) {
    const partes = ms.map(([, u]) => {
      const semana = u.limites.filter((l) => /semana|week/i.test(l.nome)).sort((a, b) => b.pct - a.pct)[0] || u.limites[0];
      return `${esc(u.rotulo)} ${semana ? semana.pct + "%" : "?"}`;
    });
    const pior = Math.max(...ms.flatMap(([, u]) => u.limites.map((l) => l.pct)));
    return `<span class="uso-cab" style="margin-left:auto" title="Uso do plano de cada motor (semana) — clique para ver" onclick="store.set('tab','consumo');location.hash='';ultimaAssinatura=null;renderList()"><i class="${nivel(pior)}"></i>${partes.join(" · ")}</span>`;
  }
  if (!USO || !USO.ok) return "";
  const ses = USO.limites.find((l) => /sessão/i.test(l.nome));
  const sem = USO.limites.filter((l) => /semana/i.test(l.nome)).sort((a, b) => b.pct - a.pct)[0];
  const pior = Math.max(...USO.limites.map((l) => l.pct));
  const partes = [ses ? `sessão ${ses.pct}%` : "", sem ? `semana ${sem.pct}%` : ""].filter(Boolean).join(" · ");
  return `<span class="uso-cab" style="margin-left:auto" title="Uso do seu plano do Claude — clique para ver" onclick="store.set('tab','consumo');location.hash='';renderList()"><i class="${nivel(pior)}"></i>Claude: ${partes}</span>`;
}
function renderHeader() { const h = $("header"); if (h) h.outerHTML = headerHtml(view.name !== "list" ? `<button class="back" onclick="location.hash=''">← voltar</button>` : ""); }

