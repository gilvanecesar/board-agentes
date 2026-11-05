// A tela principal: incluir tarefa, abas, filtros, lista, arrastar, anexos da caixa.
// ── tela principal ───────────────────────────────────────────────────────────
function renderList() {
  const app = $("#app");
  const colunaAntes = colunaNaTela(); // celular: o redesenho (a cada evento) não tira o dono da coluna em que ele está
  delete app.dataset.task; delete app.dataset.conversa; delete app.dataset.busca;
  // ⚠️ A lista inteira é redesenhada a cada evento do board (tarefa rodando = eventos o tempo todo).
  // Sem guardar, o texto que o dono está digitando na caixa de incluir some no meio da frase.
  const antigo = $("#newTask");
  const rascunho = antigo ? { valor: antigo.value, ini: antigo.selectionStart, fim: antigo.selectionEnd, foco: document.activeElement === antigo }
    : { valor: store.get("rascunho", ""), ini: null, fim: null, foco: false }; // Cockpit: a caixa mora no topo e abre ao focar; abrir sozinha cobriria o quadro
  // O projeto guardado pode ter saído da seleção (data/projetos.json): cai no primeiro da lista.
  const guardado = store.get("project", "DEV");
  const proj = S.projects.some((p) => p.slug === guardado) ? guardado : (S.projects[0]?.slug || "DEV");
  const autoQueue = store.get("autoQueue", false);
  const paralelo = store.get("paralelo", false);
  const entrega = store.get("entrega", "direto");
  const motores = S.motores || [];
  let motor = store.get("motor", (S.config || {}).motor || "claude");
  if (!motores.some((m) => m.id === motor)) motor = (motores[0] || {}).id || "claude";
  const escolha = store.get("modelo", ""); // "" | "porte:leve" | "modelo:opus"
  if (TELAS_REMOVIDAS.includes(store.get("tab", "ativas"))) store.set("tab", "ativas"); // aba guardada de uma tela que saiu (04/11)
  const tab = store.get("tab", "ativas");
  // #364 (Cockpit): o quadro abre em KANBAN por estado; a lista (com as abas, a paginação e o arrastar) continua a um clique.
  const kanban = tab !== "controle" && store.get("visao", "kanban") === "kanban";
  // Quem está trabalhando vai pro alto, mesmo respondendo no chat de uma tarefa pendente:
  // o que está acontecendo agora é o que o dono precisa ver sem procurar.
  // Quatro abas, sem tarefa repetida: ATIVAS (o que anda: fila, rodando, erro — e a pendente que
  // está respondendo no chat agora), PENDENTES (o que ficou pra depois, de TODOS os projetos),
  // EXECUTADAS (o agente terminou; falta o dono conferir) e CONCLUÍDAS. Pendente também em Ativas
  // (até 24/09) misturava o que está andando com o que está parado.
  // "Não juntada — conflito" pede o dono: fica em Ativas (no alto), não em Executadas como se estivesse entregue.
  const presa = (t) => naoJuntada(t) && t.status === "executada";
  const peso = (t) => (trabalhando(t) ? -1 : presa(t) ? -0.5 : ORDER[t.status]);
  const active = S.tasks.filter((t) => ["fila", "rodando", "erro"].includes(t.status) || (t.status === "pendente" && trabalhando(t)) || presa(t)).sort((a, b) => (peso(a) - peso(b)) || (a.order - b.order));
  const exec = S.tasks.filter((t) => t.status === "executada" && !presa(t)).sort((a, b) => (peso(a) - peso(b)) || (b.finishedAt || "").localeCompare(a.finishedAt || ""));
  const done = S.tasks.filter((t) => t.status === "concluida").sort((a, b) => (b.finishedAt || "").localeCompare(a.finishedAt || ""));
  // Pendente = fora da fila, esperando decisão do dono. Mais antiga primeiro: é a que está
  // esquecida há mais tempo.
  const pend = S.tasks.filter((t) => t.status === "pendente")
    .sort((a, b) => a.project.localeCompare(b.project) || (a.createdAt || "").localeCompare(b.createdAt || "") || (a.id - b.id));
  const base = kanban ? S.tasks : tab === "concluidas" ? done : tab === "executadas" ? exec : tab === "pendentes" ? pend : active;
  // Vários projetos no mesmo quadro: o filtro é o que mantém a leitura possível.
  const counts = {}; for (const t of base) counts[t.project] = (counts[t.project] || 0) + 1;
  const running = new Set(S.tasks.filter(trabalhando).map((t) => t.project));
  let filtro = store.get("filtro", "todos");
  if (filtro !== "todos" && !counts[filtro]) filtro = "todos"; // projeto sem tarefa nesta aba
  // A aba Pendentes é o apanhado de TODOS os projetos (já agrupado): o filtro não vale nela.
  const shown = filtro === "todos" || (tab === "pendentes" && !kanban) ? base : base.filter((t) => t.project === filtro);
  const emptyMsg = tab === "concluidas" ? "Nenhuma tarefa concluída ainda."
    : tab === "executadas" ? "Nenhuma tarefa executada esperando conferência."
    : tab === "pendentes" ? "Nada pendente: tudo que está no quadro já entrou na fila ou terminou."
    : "Nada por aqui. Escreva a primeira tarefa acima.";
  const chips = Object.keys(counts).sort((a, b) => nomeProj(a).localeCompare(nomeProj(b)));
  // Paginação (só tela): com centenas de tarefas concluídas a lista inteira ficava longa demais.
  // A página é guardada por aba; o arrastar em Ativas só reordena as visíveis (ver bindDrag).
  const pag = paginar(shown, tab);

  app.className = "wrap"; delete app.dataset.task; delete app.dataset.conversa;
  app.innerHTML = `
    ${headerHtml()}
    ${workspaceIntro(tab)}
    ${tab !== 'controle' ? faixaNaoJuntadas() : ''}
    ${tab !== 'controle' && !kanban ? `<section class="overview" aria-label="Resumo das tarefas">
      <button onclick="navigateBoard('ativas')"><span><i></i>Em andamento</span><strong>${S.tasks.filter(trabalhando).length} <small>agentes trabalhando</small></strong></button>
      <button onclick="navigateBoard('pendentes')"><span><i></i>Pendentes</span><strong>${pend.length} <small>ideias para depois</small></strong></button>
      <button onclick="navigateBoard('executadas')"><span><i></i>Para conferir</span><strong>${exec.length} <small>entregas prontas</small></strong></button>
      <button onclick="navigateBoard('concluidas')"><span><i></i>Concluídas</span><strong>${done.length} <small>trabalho entregue</small></strong></button>
    </section>` : ''}
    <div class="composer" ${tab === 'controle' ? 'hidden' : ''}>
      <label class="composer-label" for="newTask"><span aria-hidden="true">＋</span> NOVA TAREFA</label>
      <textarea id="newTask" class="cresce" rows="1" placeholder="Nova tarefa: descreva e Enter (Shift+Enter quebra linha)" aria-label="Descrição da nova tarefa" title="Enter inclui · Shift+Enter quebra linha · linhas com - criam várias tarefas"></textarea>
      <div class="row">
        <select id="proj" aria-label="Projeto da nova tarefa">${S.projects.map((p) => `<option value="${esc(p.slug)}" ${p.slug === proj ? "selected" : ""}>${esc(p.label)}</option>`).join("")}<option value="__novo__">＋ Novo projeto…</option></select>
        <select id="entrega" title="Como esta tarefa é entregue">
          <option value="direto" ${entrega === "direto" ? "selected" : ""}>Direto na pasta</option>
          <option value="pr" ${entrega === "pr" ? "selected" : ""}>Abrir PR</option>
          ${(S.deploys || {})[proj] ? `<option value="deploy" ${entrega === "deploy" ? "selected" : ""}>PR, mesclar e publicar</option>` : ""}
        </select>
        ${(S.motores || []).length > 1 ? `<select id="motor" title="Qual CLI roda esta tarefa">
          ${S.motores.map((m) => `<option value="${esc(m.id)}" ${m.id === motor ? "selected" : ""}>${esc(m.rotulo)}</option>`).join("")}
        </select>` : ""}
        <select id="modelo" title="Modelo desta tarefa. Por porte, o board escolhe; ou fixe um modelo.">
          <option value="" ${escolha === "" ? "selected" : ""}>${(CAT[motor] || {}).esforcos ? "automático" : "modelo: padrão"}</option>
          <optgroup label="pelo porte da tarefa">
            ${["leve", "normal", "pesado"].map((p) => { const m = efeitoPorte(motor, p); return `<option value="porte:${p}" ${escolha === "porte:" + p ? "selected" : ""}>${p}${m ? " · " + esc(m) : ""}</option>`; }).join("")}
          </optgroup>
          ${(CAT[motor] || {}).lista?.length ? `<optgroup label="modelo fixo">
            ${CAT[motor].lista.map((m) => `<option value="modelo:${esc(m)}" ${escolha === "modelo:" + m ? "selected" : ""}>${esc(m)}</option>`).join("")}
          </optgroup>` : ""}
        </select>
        <label class="tog"><input type="checkbox" id="autoQueue" ${autoQueue ? "checked" : ""}> já colocar na fila</label>
        <label class="tog" title="Cada tarefa ganha o próprio agente (#eng01, #eng02…) numa cópia isolada do projeto e roda ao mesmo tempo que as outras (até 3 por projeto). Quando a conferência aprova, o board junta na pasta. Em produção (BOARD_PRODUCAO) cada um entrega por PR."><input type="checkbox" id="paralelo" ${paralelo ? "checked" : ""}> ⚡ em paralelo</label>
        <button class="ib clipe" id="clipeBtn" title="Anexar imagem (ou cole com Ctrl+V, ou arraste aqui)">📎</button>
        ${micHtml("newTask")}
        <input type="file" id="arqBtn" accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,.pdf" multiple hidden>
        <button class="btn primary" id="addBtn">Criar tarefa <span aria-hidden="true" style="margin-left:12px">↗</span></button>
      </div>
      <div class="anexos" id="anexosIncluir" hidden></div>
      <div class="hint" id="dicaPortao">a fila roda na pasta de cada projeto, um agente por projeto</div>
    </div>
    ${tab !== "controle" ? `<div class="qhead"><h2>Quadro</h2>${kanban ? `${chips.length > 1 ? `<div class="chips">
      <button class="chip ${filtro === "todos" ? "on" : ""}" data-proj="todos">Todos<b>${base.length}</b></button>
      ${chips.map((p) => `<button class="chip ${filtro === p ? "on" : ""}" data-proj="${esc(p)}">${running.has(p) ? "<i></i>" : ""}${esc(nomeProj(p))}<b>${counts[p]}</b></button>`).join("")}
    </div>` : ""}` : ""}<span class="qhead-dir">${kanban ? agentesResumo() : ""}<span class="visao" role="group" aria-label="Como ver o quadro"><button class="visao-btn ${kanban ? "on" : ""}" data-visao="kanban" ${kanban ? 'aria-pressed="true"' : 'aria-pressed="false"'} title="As tarefas em colunas por estado">▦ Kanban</button><button class="visao-btn ${kanban ? "" : "on"}" data-visao="lista" ${kanban ? 'aria-pressed="false"' : 'aria-pressed="true"'} title="A lista por abas, com paginação e arrastar para reordenar a fila">☰ Lista</button></span></span></div>` : ""}
    <div class="tabs" aria-label="Filtrar tarefas" ${tab === "controle" || kanban ? "hidden" : ""}>
      <button class="tab ${!kanban && tab === "ativas" ? "on" : ""}" data-tab="ativas">Ativas<b>${active.length}</b></button>
      <button class="tab ${!kanban && tab === "pendentes" ? "on" : ""}" data-tab="pendentes" title="O que ficou combinado pra depois, de todos os projetos">Pendentes<b>${pend.length}</b></button>
      <button class="tab ${!kanban && tab === "executadas" ? "on" : ""}" data-tab="executadas">Executadas<b>${exec.length}</b></button>
      <button class="tab ${!kanban && tab === "concluidas" ? "on" : ""}" data-tab="concluidas">Concluídas<b>${done.length}</b></button>
      <button class="tab" id="abrirBusca" style="margin-left:auto" title="Procurar tarefa pelo sentido: descreva com as suas palavras, mesmo sem lembrar o título">🔎 Buscar</button>
      <button class="tab" id="abrirConversa" title="Conversar com o agente na pasta deste projeto, sem abrir tarefa">💬 Conversa</button>
    </div>
    ${tab === "controle" ? mheadHtml("Controle", `<span class="chip">backups, memória e cópias fora das máquinas</span>`) + `<div class="controle" id="controle"><div class="empty">carregando…</div></div>` : ""}
    ${tab !== "controle" && !kanban && tab !== "pendentes" && chips.length > 1 ? `<div class="chips">
      <button class="chip ${filtro === "todos" ? "on" : ""}" data-proj="todos">Todos<b>${base.length}</b></button>
      ${chips.map((p) => `<button class="chip ${filtro === p ? "on" : ""}" data-proj="${esc(p)}">${running.has(p) ? "<i></i>" : ""}${esc(nomeProj(p))}<b>${counts[p]}</b></button>`).join("")}
    </div>` : ""}
    ${tab === "controle" ? "" : kanban ? kanbanHtml(shown) : `<div class="cols"><span></span><span>Descrição da atividade</span><span>${tab === "concluidas" ? "Concluída em" : tab === "executadas" ? "Executada em" : tab === "pendentes" ? "Criada em" : "Status"}</span></div>
    ${tab === "ativas" ? agentesFaixa() : ""}
    <div class="list${tab === "pendentes" ? " pendentes" : ""}" id="list">${!shown.length ? `<div class="empty"><span class="empty-icon" aria-hidden="true">✓</span><strong>${tab === "ativas" ? "Tudo em dia por aqui" : "Seu quadro está em ordem"}</strong>${emptyMsg}</div>`
      : tab === "pendentes" ? gruposPendentes(pag.itens, shown) : pag.itens.map((t) => taskRow(t)).join("")}</div>
    ${paginacaoHtml(pag)}`}
  `;

  const ta = $("#newTask");
  ta.value = rascunho.valor || "";
  ligarAltura(ta);
  ta.dataset.rascunho = "nova";
  ta.addEventListener("input", () => store.set("rascunho", ta.value));
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addTask(); } });
  $("#addBtn").onclick = addTask;
  $("#clipeBtn").onclick = () => $("#arqBtn").click();
  ligarMic(app);
  $("#arqBtn").onchange = (e) => { subirImagens("incluir", e.target.files); e.target.value = ""; };
  ligarImagens("incluir", ta, app.querySelector(".composer"));
  pintarAnexos("incluir");
  $("#proj").onchange = async (e) => {
    if (e.target.value !== "__novo__") return store.set("project", e.target.value);
    e.target.value = proj; // até o projeto existir, a seleção continua onde estava
    const nome = prompt("Nome do novo projeto (vira uma pasta em DEV):");
    if (!nome || !nome.trim()) return;
    const descricao = prompt("Em uma frase, o que é este projeto? (opcional — vai para o CLAUDE.md)") || "";
    try {
      const r = await api("/projetos", { method: "POST", body: { nome, descricao } });
      store.set("project", r.projeto.slug);
      toast(r.aviso ? `Projeto "${r.projeto.label}" criado — ${r.aviso}` : `Projeto "${r.projeto.label}" criado`, r.aviso ? 8000 : 4000, r.aviso ? "erro" : "");
      await loadState();
    } catch (err) { toast("Não deu para criar o projeto: " + err.message, 6000, "erro"); }
  };
  $("#autoQueue").onchange = (e) => { store.set("autoQueue", e.target.checked); renderList(); };
  $("#paralelo").onchange = (e) => { store.set("paralelo", e.target.checked); };
  $("#entrega").onchange = (e) => { store.set("entrega", e.target.value); renderList(); };
  if ($("#motor")) $("#motor").onchange = (e) => { store.set("motor", e.target.value); store.set("modelo", ""); renderList(); };
  if ($("#modelo")) $("#modelo").onchange = (e) => { store.set("modelo", e.target.value); renderList(); };
  // A dica conta o que vai acontecer DEPOIS do agente, no projeto escolhido.
  const dica = $("#dicaPortao"), cmd = (S.portoes || {})[proj];
  if (dica) dica.textContent = [S.config.filaPausada && autoQueue ? "⏸ fila pausada: a tarefa incluída espera você retomar ·" : "",
    cmd ? `depois roda o portão: ${cmd}` : "este projeto não tem portão (sem script de check/test)",
    [S.config.revisorLigado !== false ? "revisor" : "", S.config.qaLigado !== false ? "QA" : ""].filter(Boolean).length ? `→ ${[S.config.revisorLigado !== false ? "revisor" : "", S.config.qaLigado !== false ? "QA" : ""].filter(Boolean).join(" → ")}` : ""].filter(Boolean).join(" ");
  $("#proj").addEventListener("change", () => renderList());
  app.querySelectorAll(".tab[data-tab]").forEach((b) => { b.onclick = () => { store.set("tab", b.dataset.tab); store.set("visao", "lista"); ultimaAssinatura = null; renderList(); }; });
  app.querySelectorAll(".visao-btn").forEach((b) => { b.onclick = () => { store.set("visao", b.dataset.visao); ultimaAssinatura = null; renderList(); }; });
  if ($("#abrirBusca")) $("#abrirBusca").onclick = () => {
    // O filtro de projeto viaja junto: quem está olhando um projeto quer buscar dentro dele.
    if (filtro !== "todos") store.set("buscaProjeto", filtro);
    location.hash = "#/busca";
  };
  // A conversa é do projeto em que o dono está: o filtro manda; sem filtro, o do seletor.
  if ($("#abrirConversa")) $("#abrirConversa").onclick = () => {
    location.hash = "#/c/" + projetoDaConversa(filtro !== "todos" ? filtro : $("#proj").value);
  };
  app.querySelectorAll(".chip[data-proj]").forEach((b) => { b.onclick = () => {
    const p = b.dataset.proj;
    store.set("filtro", p);
    store.set("pagina." + tab, 1); // outro recorte: volta para a primeira página
    // Filtrou por um projeto? A tarefa nova nasce nele — é onde você está trabalhando.
    if (p !== "todos" && S.projects.some((x) => x.slug === p)) store.set("project", p);
    renderList();
  }; });
  // Só devolve o foco se ele estava na caixa (senão roubaria o clique num filtro ou seletor).
  if (rascunho.foco && tab !== "controle") { ta.focus({preventScroll:true}); if (rascunho.ini != null) ta.setSelectionRange(rascunho.ini, rascunho.fim); }
  app.querySelectorAll(".paginacao [data-pagina]").forEach((b) => { b.onclick = () => {
    store.set("pagina." + tab, Number(b.dataset.pagina));
    renderList();
    $("#list")?.scrollIntoView({ block: "start", behavior: "smooth" });
  }; });
  if ($("#porPagina")) $("#porPagina").onchange = (e) => { store.set("porPagina", Number(e.target.value)); store.set("pagina." + tab, 1); renderList(); };
  if (tab === "ativas" && !kanban) bindDrag();
  if (kanban && innerWidth <= 760) { const k = $("#kanban"), c = k && k.querySelector(`.kcol[data-col="${colunaAntes || colunaInicial()}"]`); if (c) { k.scrollLeft = c.offsetLeft - k.offsetLeft; document.querySelectorAll(".kchips .chip").forEach((b) => b.classList.toggle("on", b.dataset.kcol === c.dataset.col)); } }
  if (tab === "controle") renderControle();
}

function taskRow(t, { criada = false } = {}) {
  const last = lastLine[t.id];
  const e = estado(t);
  const lastTxt = trabalhando(t) && last ? (last.t === "ferramenta" ? `▸ ${last.nome}: ${last.alvo}` : last.texto)
    : (t.status === "erro" ? (retryTxt(t) ? retryTxt(t) + " · " : "") + (t.error || "") : "");
  const canRun = !trabalhando(t) && ["pendente", "executada", "erro", "concluida"].includes(t.status);
  const idade = criada ? haQuanto(t.createdAt) : "";
  return `<div class="task ${e.cls}" data-id="${t.id}" draggable="${!criada && t.status !== "concluida"}">
    <button class="chk ${t.status === "concluida" ? "on" : ""}" title="${t.status === "concluida" ? "Reabrir" : "Marcar como concluída"}" onclick="toggleDone(${t.id})">${t.status === "concluida" ? "✓" : ""}</button>
    <div class="main" role="link" tabindex="0" onkeydown="if(event.key==='Enter')location.hash='#/t/${t.id}'" onclick="location.hash='#/t/${t.id}'">
      <div class="title">${esc(t.title)}</div>
      ${avisoProjeto(t)}
      <div class="meta"><span>#${t.id}</span><span class="proj">${esc(nomeProj(t.project))}</span>${agenteSelo(t)}${juntarSelo(t)}${prVigiaSelo(t)}${conferirSelo(t)}${idade ? `<span class="idade" title="parada desde ${esc(fmtDay(t.createdAt))}">${esc(idade)}</span>` : ""}${t.entrega === "pr" || t.entrega === "deploy" ? `<span class="tag-pr">PR</span>` : ""}${t.anexos?.length ? `<span title="${t.anexos.length} anexo(s): imagem ou PDF">🖼 ${t.anexos.length}</span>` : ""}${motorSelo(t)}${selos(t)}${t.prUrl ? `<a class="prlink" href="${esc(t.prUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">↗ PR</a>` : ""}${t.cost ? `<span>${fmtCost(t.cost)}</span>` : ""}${lastTxt ? `<span class="last">${esc(lastTxt)}</span>` : ""}</div>
    </div>
    <div class="right">
      <div class="acts">
        ${t.status === "rodando" ? `<button class="ib" title="Parar" onclick="stopTask(${t.id})">⏹</button>` : ""}
        ${t.busy && t.status !== "rodando" ? `<span class="ib" title="Respondendo no chat">💬</span>` : ""}
        ${t.status === "fila" ? `<button class="ib" title="Tirar da fila" onclick="setStatus(${t.id},'pendente')">⏸</button>` : ""}
        ${canRun ? `<button class="ib" title="${t.sessionId ? "Rodar de novo (continua a sessão)" : "Colocar na fila"}" onclick="setStatus(${t.id},'fila')">▶</button>` : ""}
        <button class="ib" title="Abrir a tarefa" onclick="location.hash='#/t/${t.id}'">↗</button>
        <button class="ib del" title="Excluir" onclick="delTask(${t.id})">🗑</button>
      </div>
      ${criada && !trabalhando(t) ? `<span class="pill pendente" title="incluída no quadro em ${esc(fmtDay(t.createdAt))}">${fmtDay(t.createdAt) || "Pendente"}</span>`
        : t.status === "concluida" && !t.busy ? `<span class="pill concluida">${fmtDay(t.finishedAt) || "Concluída"}</span>`
        : t.status === "executada" && !t.busy && !naoJuntada(t) ? `<span class="pill executada">${fmtDay(t.finishedAt) || "Executada"}</span>`
        : `<span class="pill ${e.cls}">${e.label}</span>${trabalhando(t) ? "" : `<span class="grip" title="Arraste pra reordenar">⋮⋮</span>`}`}
    </div>
  </div>`;
}
// ── Kanban por estado (#364, Proposta A "Cockpit") ───────────────────────────────
// Cinco colunas, cada tarefa numa só: PENDENTES (parada, fora da fila), FILA, RODANDO (trabalhando agora, inclusive
// respondendo no chat), PARA CONFERIR (executada, erro e "não juntada": o que pede o dono) e CONCLUÍDAS (as mais recentes).
const KANBAN_MAX = 30;
function colunasKanban(tarefas) {
  const presa = (t) => naoJuntada(t) && t.status === "executada";
  const cols = [
    { id: "pendentes", rotulo: "Pendentes", cor: "var(--dim)", tarefas: tarefas.filter((t) => t.status === "pendente" && !trabalhando(t)).sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || "")) },
    { id: "fila", rotulo: "Fila", cor: "var(--violet)", tarefas: tarefas.filter((t) => t.status === "fila").sort((a, b) => a.order - b.order) },
    { id: "rodando", rotulo: "Rodando", cor: "var(--run)", tarefas: tarefas.filter(trabalhando).sort((a, b) => a.order - b.order) },
    { id: "conferir", rotulo: "Para conferir", cor: "var(--amber)", tarefas: tarefas.filter((t) => !trabalhando(t) && (t.status === "erro" || t.status === "executada" || presa(t)))
      .sort((a, b) => ((a.status === "erro" || presa(a) ? 0 : 1) - (b.status === "erro" || presa(b) ? 0 : 1)) || (b.finishedAt || "").localeCompare(a.finishedAt || "")) },
    { id: "concluidas", rotulo: "Concluídas", cor: "var(--green)", tarefas: tarefas.filter((t) => t.status === "concluida" && !trabalhando(t)).sort((a, b) => (b.finishedAt || "").localeCompare(a.finishedAt || "")) },
  ];
  return cols;
}
/** A faixa "quem trabalha agora" com o 🖥 ver no tmux (na lista Ativas e no kanban). */
function agentesFaixa() {
  return S.tasks.some((t) => trabalhando(t) && t.agente) ? `<div class="agentes" title="quem está trabalhando agora">${S.tasks.filter((t) => trabalhando(t) && t.agente).sort((a, b) => a.project.localeCompare(b.project) || a.agente.localeCompare(b.agente)).map((t) => `<a class="agente-chip" href="#/t/${t.id}"><i></i><b>${t.paralelo ? "⚡" : ""}#${esc(t.agente)}</b>${esc(nomeProj(t.project))} · ${esc(nomeModelo(t.modeloUsado))}${t.esforcoUsado ? " · " + esc(t.esforcoUsado) : ""}<span>#${t.id} ${esc(cutTxt(t.title, 42))}</span></a>`).join("")}<button class="agente-chip" onclick="abrirTmux()" title="A sessão tmux com o painel e uma aba por agente, ao vivo: no Terminal (Mac) ou aqui na tela (board sem tela, ex.: Atena)">🖥 ver no tmux</button></div>` : "";
}
/** Kanban (Cockpit): "⚡ eng01 · eng02 trabalhando" no cabeçalho do quadro, com o 🖥 ver no tmux. */
function agentesResumo() {
  const ag = S.tasks.filter((t) => trabalhando(t) && t.agente).sort((a, b) => a.agente.localeCompare(b.agente));
  if (!ag.length) return "";
  return `<span class="chip agentes-resumo" title="${esc(ag.map((t) => `#${t.agente} · ${nomeProj(t.project)} · ${nomeModelo(t.modeloUsado)}${t.esforcoUsado ? " · " + t.esforcoUsado : ""} — #${t.id} ${t.title}`).join("\n"))}">⚡ ${ag.map((t) => esc(t.agente)).join(" · ")} trabalhando</span><button class="chip agente-chip" onclick="abrirTmux()" title="A sessão tmux com o painel e uma aba por agente, ao vivo">🖥 ver no tmux</button>`;
}
/** A esteira em 4 risquinhos: agente → portão → revisor → QA. ok / nao / run / vazio — sempre com o texto no title. */
function esteiraPassos(t) {
  const rodandoEm = (et) => t.status === "rodando" && t.etapa === et;
  const ver = (v) => v ? (v.veredito ? (v.veredito === "APROVADO" ? "ok" : "nao") : (v.ok ? "ok" : "nao")) : "";
  return [
    { nome: "agente", rot: "Agente", st: rodandoEm("agente") ? "run" : (t.sessionId || t.result || t.cost || t.gate || t.revisor || t.qa || ["executada", "concluida"].includes(t.status)) ? "ok" : "" },
    { nome: "portao", rot: "Portão", st: rodandoEm("portao") ? "run" : ver(t.gate) },
    { nome: "revisor", rot: "Revisor", st: rodandoEm("revisor") ? "run" : ver(t.revisor) },
    { nome: "qa", rot: "QA", st: rodandoEm("qa") ? "run" : ver(t.qa) },
  ];
}
const PASSO_TXT = { ok: "passou", nao: "reprovou", run: "rodando agora", "": "ainda não" };
function esteiraMini(t) {
  const ps = esteiraPassos(t);
  return `<span class="est" title="${esc(ps.map((p) => p.rot + ": " + PASSO_TXT[p.st]).join(" · "))}">${ps.map((p) => `<i class="${p.st}"></i>`).join("")}</span>`;
}
function kanbanCard(t, col, pos) {
  const e = estado(t);
  const alerta = t.status === "erro" || (naoJuntada(t) && t.status !== "concluida") || prEsgotado(t) ? " alerta" : "";
  const quando = col === "pendentes" ? haQuanto(t.createdAt) || "hoje" : col === "concluidas" ? fmtDay(t.finishedAt) : "";
  const tempo = trabalhando(t) && t.startedAt ? emMin(t.startedAt) : "";
  // A linha de baixo, como na proposta: projeto · agente · modelo/porte · estado/tempo.
  const meta = [esc(nomeProj(t.project)), t.agente ? "#" + esc(t.agente) : "",
    col === "fila" ? esc(t.porte || (t.modelo ? nomeModelo(t.modelo) : "")) : trabalhando(t) ? esc(nomeModelo(t.modeloUsado) || "") : "",
    trabalhando(t) ? esc(e.label.toLowerCase()) : col === "conferir" ? esc(e.label.toLowerCase()) : "",
    col === "fila" ? pos + "º" : "", tempo, t.prUrl ? `<a href="${esc(t.prUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">PR${prNumero(t.prUrl)}</a>` : t.entrega === "pr" || t.entrega === "deploy" ? "PR" : "",
    t.merged ? "mesclado" : "", t.anexos?.length ? "🖼 " + t.anexos.length : "", quando ? esc(quando) : "", t.cost && col !== "rodando" ? fmtCost(t.cost) : ""].filter(Boolean);
  const acao = t.status === "rodando" ? `<button class="ib" title="Parar a tarefa #${t.id}" onclick="stopTask(${t.id})">⏹</button>`
    : col === "pendentes" ? `<button class="ib" title="Pôr a #${t.id} na fila" onclick="setStatus(${t.id},'fila')">▶</button>`
    : col === "fila" ? `<button class="ib" title="Tirar a #${t.id} da fila" onclick="setStatus(${t.id},'pendente')">⏸</button>`
    : col === "conferir" && t.status === "executada" && !naoJuntada(t) ? `<button class="ib" title="Marcar a #${t.id} como concluída" onclick="toggleDone(${t.id})">✓</button>` : "";
  const ps = esteiraPassos(t);
  const mostraEst = col === "rodando" || col === "conferir";
  return `<article class="kcard${alerta}${col === "concluidas" ? " feita" : ""}" data-id="${t.id}">
    <a class="kt" href="#/t/${t.id}">#${t.id} ${esc(t.title)}</a>
    ${avisoProjeto(t)}
    <div class="km">${meta.map((m) => `<span>${m}</span>`).join("")}${juntarSelo(t)}${prVigiaSelo(t)}${conferirSelo(t)}${acao ? `<span class="ka">${acao}</span>` : ""}</div>
    ${mostraEst ? esteiraMini(t) : ""}
    ${col === "rodando" ? `<div class="km est-txt">${ps.map((p) => p.st === "run" ? `<b>${p.nome === "qa" ? "QA" : p.nome === "portao" ? "portão" : p.nome}…</b>` : `${p.nome === "qa" ? "QA" : p.nome === "portao" ? "portão" : p.nome}${p.st === "ok" ? " ✓" : p.st === "nao" ? " ✗" : ""}`).join(" ")}</div>` : ""}
  </article>`;
}
const prNumero = (url) => { const m = String(url || "").match(/\/pull\/(\d+)/); return m ? " #" + m[1] : ""; };
const emMin = (iso) => { const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000)); return m < 60 ? m + " min" : Math.floor(m / 60) + " h " + (m % 60) + " min"; };
const KCURTO = { pendentes: "Pend.", fila: "Fila", rodando: "Rodando", conferir: "Conferir", concluidas: "Concl." };
function kanbanHtml(tarefas) {
  const cols = colunasKanban(tarefas);
  const ativa = store.get("kcol", "rodando");  // o celular acerta a marca depois de desenhar (colunaInicial)
  return `<div class="kchips" role="tablist" aria-label="Estado">${cols.map((c) => `<button class="chip ${c.id === ativa ? "on" : ""}" data-kcol="${c.id}" onclick="irColuna('${c.id}')">${KCURTO[c.id]} ${c.tarefas.length}</button>`).join("")}</div>
  <div class="kanban" id="kanban" aria-label="Tarefas por estado" onscroll="colunaVisivel()">${cols.map((c) => `
    <section class="kcol" data-col="${c.id}" style="--c:${c.cor}" aria-label="${c.rotulo}: ${c.tarefas.length}">
      <h3><span>${c.rotulo}</span><b>${c.tarefas.length}</b></h3>
      <div class="kcards">${c.tarefas.length ? c.tarefas.slice(0, KANBAN_MAX).map((t, i) => kanbanCard(t, c.id, i + 1)).join("")
        : `<p class="kvazio">nada aqui</p>`}
      ${c.tarefas.length > KANBAN_MAX ? `<button class="kmais" onclick="store.set('visao','lista');store.set('tab','${c.id === "conferir" ? "executadas" : c.id === "concluidas" ? "concluidas" : c.id === "pendentes" ? "pendentes" : "ativas"}');ultimaAssinatura=null;renderList()">+ ${c.tarefas.length - KANBAN_MAX} na lista</button>` : ""}
      ${c.id !== "concluidas" ? `<p class="kdica">← arraste para ver ${cols[cols.indexOf(c) + 1].rotulo}</p>` : ""}</div>
    </section>`).join("")}</div>`;
}
/** A coluna à vista no kanban do celular agora (null fora do kanban ou no computador). */
function colunaNaTela() {
  const k = $("#kanban"); if (!k || k.scrollWidth <= k.clientWidth + 4 || !k.querySelector(".kcard")) return null; // quadro vazio (o estado ainda chegando) não conta
  const cols = [...k.querySelectorAll(".kcol")];
  return cols.reduce((m, x) => Math.abs(x.offsetLeft - k.offsetLeft - k.scrollLeft) < Math.abs(m.offsetLeft - k.offsetLeft - k.scrollLeft) ? x : m, cols[0])?.dataset.col || null;
}
/** A coluna que o celular mostra ao abrir: a última escolhida; sem escolha, a primeira com tarefa (Rodando, Para conferir, Fila, Pendentes). */
function colunaInicial() {
  const g = store.get("kcol", null); if (g) return g;
  const k = $("#kanban"); const tem = (id) => k && k.querySelector(`.kcol[data-col="${id}"] .kcard`);
  return ["rodando", "conferir", "fila", "pendentes"].find(tem) || "rodando";
}
/** Celular: uma coluna por vez; a aba de estado leva à coluna e acompanha quem arrasta de lado. */
function irColuna(id) {
  store.set("kcol", id);
  const k = $("#kanban"), c = k && k.querySelector(`.kcol[data-col="${id}"]`);
  if (c) k.scrollTo({ left: c.offsetLeft - k.offsetLeft, behavior: "smooth" });
  document.querySelectorAll(".kchips .chip").forEach((b) => b.classList.toggle("on", b.dataset.kcol === id));
}
function colunaVisivel() {
  const k = $("#kanban"); if (!k || k.scrollWidth <= k.clientWidth + 4) return;
  const cols = [...k.querySelectorAll(".kcol")];
  const c = cols.reduce((m, x) => Math.abs(x.offsetLeft - k.offsetLeft - k.scrollLeft) < Math.abs(m.offsetLeft - k.offsetLeft - k.scrollLeft) ? x : m, cols[0]);
  if (!c) return;
  document.querySelectorAll(".kchips .chip").forEach((b) => b.classList.toggle("on", b.dataset.kcol === c.dataset.col));
}
/** Aba Pendentes: as tarefas fora da fila, agrupadas por projeto (já chegam ordenadas).
 *  `todas` = a lista inteira, para o número do grupo contar o projeto todo, não só a página. */
function gruposPendentes(tarefas, todas = tarefas) {
  const total = {}; for (const t of todas) total[t.project] = (total[t.project] || 0) + 1;
  const grupos = new Map();
  for (const t of tarefas) (grupos.get(t.project) || grupos.set(t.project, []).get(t.project)).push(t);
  return [...grupos].map(([proj, ts]) => `
    <div class="grupo"><span class="proj">${esc(nomeProj(proj))}</span><b>${total[proj]}</b></div>
    ${ts.map((t) => taskRow(t, { criada: true })).join("")}`).join("");
}
// ── paginação das listas (Ativas, Pendentes, Executadas, Concluídas) ────────────
const POR_PAGINA = [10, 20, 50, 100];
/** Recorta a lista na página guardada da aba. Página fora do alcance (tarefa saiu da aba) cai na última. */
function paginar(lista, tab) {
  let por = Number(store.get("porPagina", 20));
  if (!POR_PAGINA.includes(por)) por = 20;
  const paginas = Math.max(1, Math.ceil(lista.length / por));
  const pagina = Math.min(paginas, Math.max(1, Math.floor(Number(store.get("pagina." + tab, 1))) || 1));
  const ini = (pagina - 1) * por;
  return { itens: lista.slice(ini, ini + por), pagina, paginas, por, total: lista.length, ini };
}
/** Os números que aparecem: primeira, última e a vizinhança da atual; o resto vira "…". */
function numerosDaPaginacao(pagina, paginas) {
  const quer = new Set([1, paginas, pagina - 1, pagina, pagina + 1].filter((n) => n >= 1 && n <= paginas));
  const ns = [...quer].sort((a, b) => a - b), saida = [];
  ns.forEach((n, i) => { if (i && n - ns[i - 1] > 1) saida.push(n - ns[i - 1] === 2 ? n - 1 : "…"); saida.push(n); });
  return saida;
}
function paginacaoHtml(p) {
  // Lista que cabe na menor página não precisa de paginação (nem do seletor).
  if (p.total <= POR_PAGINA[0]) return "";
  const botao = (n, rotulo, titulo, off) => `<button class="pag" data-pagina="${n}" ${off ? "disabled" : ""} title="${titulo}">${rotulo}</button>`;
  return `<nav class="paginacao" aria-label="Páginas da lista">
    <span class="pag-info">${p.ini + 1}–${p.ini + p.itens.length} de ${p.total}</span>
    <div class="pag-nums">
      ${botao(p.pagina - 1, "‹", "Página anterior", p.pagina <= 1)}
      ${numerosDaPaginacao(p.pagina, p.paginas).map((n) => n === "…" ? `<span class="pag-gap">…</span>`
        : `<button class="pag ${n === p.pagina ? "on" : ""}" data-pagina="${n}" ${n === p.pagina ? 'aria-current="page"' : ""} title="Página ${n}">${n}</button>`).join("")}
      ${botao(p.pagina + 1, "›", "Próxima página", p.pagina >= p.paginas)}
    </div>
    <label class="pag-por">por página <select id="porPagina" aria-label="Tarefas por página">${POR_PAGINA.map((n) => `<option value="${n}" ${n === p.por ? "selected" : ""}>${n}</option>`).join("")}</select></label>
  </nav>`;
}
function renderLastLine(id) {
  const row = document.querySelector(`.task[data-id="${id}"] .meta .last`);
  const ev = lastLine[id]; if (!ev) return;
  const txt = ev.t === "ferramenta" ? `▸ ${ev.nome}: ${ev.alvo}` : ev.texto;
  if (row) row.textContent = txt;
  else { const meta = document.querySelector(`.task[data-id="${id}"] .meta`); if (meta) meta.insertAdjacentHTML("beforeend", `<span class="last">${esc(txt)}</span>`); }
}

// Imagens que o dono colou/arrastou e ainda não foram enviadas (caixa de incluir e chat).
const pendentes = { incluir: [], chat: [], conversa: [] };
// O que o servidor aceita (ele confere pelos bytes; aqui é só pra avisar na hora).
const ANEXO_TIPOS = /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/;
const ANEXO_EXTS = /\.(png|jpe?g|gif|webp|pdf)$/i;
const ehPdf = (nome) => /\.pdf$/i.test(nome || "");
const pdfHtml = (nome) => `<span class="pdf"><b>📄 PDF</b><span>${esc(nome || "documento.pdf")}</span></span>`;
async function subirImagens(onde, arquivos) {
  const todos = [...arquivos].filter(Boolean);
  const aceita = (f) => f.type ? ANEXO_TIPOS.test(f.type) : ANEXO_EXTS.test(f.name || "");
  const fotos = todos.filter(aceita), fora = todos.filter((f) => !aceita(f));
  // Nunca recusar em silêncio: o dono achou que o 📎 estava quebrado (24/09).
  if (fora.length) toast(`não aceito ${fora.map((f) => f.name || f.type || "esse arquivo").join(", ")} — só imagem (png, jpg, gif, webp) ou PDF`);
  if (!fotos.length) return;
  if (pendentes[onde].length + fotos.length > 6) return toast("no máximo 6 anexos por vez");
  for (const f of fotos) {
    const pdf = f.type === "application/pdf" || ehPdf(f.name);
    const marca = { id: null, nome: f.name || (pdf ? "documento.pdf" : "print.png"), pdf, subindo: true, previa: pdf ? null : URL.createObjectURL(f) };
    pendentes[onde].push(marca); pintarAnexos(onde);
    try {
      const r = await fetch(`/api/anexos?nome=${encodeURIComponent(marca.nome)}`, { method: "POST", headers: { "content-type": f.type }, body: f });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "não consegui subir o anexo");
      marca.id = d.anexo.id; marca.subindo = false;
    } catch (e) { toast(e.message); pendentes[onde] = pendentes[onde].filter((x) => x !== marca); }
    pintarAnexos(onde);
  }
}
function tirarAnexo(onde, i) { pendentes[onde].splice(i, 1); pintarAnexos(onde); }
function pintarAnexos(onde) {
  const el = $(onde === "incluir" ? "#anexosIncluir" : onde === "conversa" ? "#anexosConversa" : "#anexosChat"); if (!el) return;
  el.innerHTML = pendentes[onde].map((a, i) => a.subindo
    ? `<div class="anexo subindo">subindo…</div>`
    : `<div class="anexo" title="${esc(a.nome)}">${a.pdf ? pdfHtml(a.nome) : `<img src="${esc(a.previa || "/api/anexos/" + a.id)}" alt="${esc(a.nome)}">`}<span class="x" onclick="tirarAnexo('${onde}',${i})">×</span></div>`).join("");
  el.hidden = !pendentes[onde].length;
}
/** Colar, arrastar e escolher arquivo — os três caminhos que o dono usa pra mandar print. */
function ligarImagens(onde, campo, caixa) {
  if (!campo) return;
  campo.addEventListener("paste", (e) => { const f = e.clipboardData?.files; if (f && f.length) { e.preventDefault(); subirImagens(onde, f); } });
  if (!caixa) return;
  caixa.addEventListener("dragover", (e) => { e.preventDefault(); caixa.classList.add("arrastando"); });
  caixa.addEventListener("dragleave", () => caixa.classList.remove("arrastando"));
  caixa.addEventListener("drop", (e) => { e.preventDefault(); caixa.classList.remove("arrastando"); subirImagens(onde, e.dataTransfer.files); });
}
const idsAnexos = (onde) => pendentes[onde].filter((a) => a.id).map((a) => ({ id: a.id, nome: a.nome }));

// O seletor guarda "porte:leve" ou "modelo:opus"; o board recebe os dois campos separados.
function escolhido() {
  const v = ($("#modelo") || {}).value || "";
  return { modelo: v.startsWith("modelo:") ? v.slice(7) : "", porte: v.startsWith("porte:") ? v.slice(6) : null };
}
async function addTask() {
  const ta = $("#newTask"); const text = ta.value.trim(); if (!text) return;
  try {
    const fila = $("#autoQueue").checked;
    const r = await api("/tasks", { method: "POST", body: { text, project: $("#proj").value, queue: $("#autoQueue").checked, paralelo: $("#paralelo").checked, entrega: $("#entrega").value, anexos: idsAnexos("incluir"),
      motor: $("#motor") ? $("#motor").value : undefined,
      modelo: escolhido().modelo, porte: escolhido().porte } });
    somEnvio.tocar();
    pendentes.incluir = []; pintarAnexos("incluir");
    ta.value = ""; autoAltura(ta); store.set("rascunho", "");
    // Pendente não aparece em Ativas: sem este aviso a tarefa parecia sumir ao incluir.
    const n = (r.tasks || []).length;
    if (n && !fila && store.get("tab", "ativas") !== "pendentes") toast(`${n > 1 ? n + " tarefas foram" : "Tarefa #" + r.tasks[0].id + " foi"} para Pendentes. Use ▶ para pôr na fila.`, 4500, "info");
  } catch (e) { toast(e.message); }
}
async function setStatus(id, status) { try { await api(`/tasks/${id}`, { method: "PATCH", body: { status } }); } catch (e) { toast(e.message); } }
async function toggleDone(id) { const t = S.tasks.find((x) => x.id === id); setStatus(id, t.status === "concluida" ? (t.result ? "executada" : "pendente") : "concluida"); }
async function stopTask(id) { try { await api(`/tasks/${id}/stop`, { method: "POST" }); } catch (e) { toast(e.message); } }
async function delTask(id) {
  const t = S.tasks.find((x) => x.id === id);
  if (t.status === "rodando" || t.sessionId) { if (!confirm(`Excluir a tarefa #${id} e o histórico dela?`)) return; }
  try { await api(`/tasks/${id}`, { method: "DELETE" }); if (view.name === "detail") location.hash = ""; } catch (e) { toast(e.message); }
}

// arrastar pra reordenar (a ordem manda em quem roda primeiro na fila)
function bindDrag() {
  const list = $("#list"); if (!list) return;
  let dragging = null;
  list.querySelectorAll(".task").forEach((el) => {
    el.addEventListener("dragstart", () => { dragging = el; el.classList.add("dragging"); });
    el.addEventListener("dragend", () => { el.classList.remove("dragging"); list.querySelectorAll(".over").forEach((x) => x.classList.remove("over")); });
    el.addEventListener("dragover", (e) => { e.preventDefault(); if (el !== dragging) el.classList.add("over"); });
    el.addEventListener("dragleave", () => el.classList.remove("over"));
    el.addEventListener("drop", async (e) => {
      e.preventDefault(); el.classList.remove("over");
      if (!dragging || dragging === el) return;
      const r = el.getBoundingClientRect();
      (e.clientY < r.top + r.height / 2) ? el.before(dragging) : el.after(dragging);
      // Só as tarefas VISÍVEIS mudam de lugar: as escondidas pelo filtro ficam nas suas
      // posições globais. Sem isto, arrastar com filtro ligado jogava os outros projetos
      // para o fim da fila — e a ordem da fila é quem roda primeiro.
      const visible = [...list.querySelectorAll(".task")].map((x) => Number(x.dataset.id));
      const global = S.tasks.slice().sort((a, b) => a.order - b.order).map((t) => t.id);
      const slots = global.map((id, i) => (visible.includes(id) ? i : -1)).filter((i) => i >= 0);
      const ids = global.slice();
      slots.forEach((slot, k) => { ids[slot] = visible[k]; });
      try { await api("/tasks/reorder", { method: "POST", body: { ids } }); } catch (err) { toast(err.message); }
    });
  });
}

