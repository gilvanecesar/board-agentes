// A tela principal: incluir tarefa, abas, filtros, lista, arrastar, anexos da caixa.
// ── tela principal ───────────────────────────────────────────────────────────
function renderList() {
  if (view.name === 'list' && store.get('tab','ativas') === 'monitoring' && $('#monitoring .network-panel')) { renderHeader(); return; }
  clearTimeout(monitorTimer);
  const app = $("#app");
  delete app.dataset.task; delete app.dataset.conversa; delete app.dataset.busca;
  // ⚠️ A lista inteira é redesenhada a cada evento do board (tarefa rodando = eventos o tempo todo).
  // Sem guardar, o texto que o dono está digitando na caixa de incluir some no meio da frase.
  const antigo = $("#newTask");
  const rascunho = antigo ? { valor: antigo.value, ini: antigo.selectionStart, fim: antigo.selectionEnd, foco: document.activeElement === antigo }
    : { valor: store.get("rascunho", ""), ini: null, fim: null, foco: true };
  const proj = store.get("project", "DEV");
  const autoQueue = store.get("autoQueue", false);
  const paralelo = store.get("paralelo", false);
  const entrega = store.get("entrega", "direto");
  const motores = S.motores || [];
  let motor = store.get("motor", (S.config || {}).motor || "claude");
  if (!motores.some((m) => m.id === motor)) motor = (motores[0] || {}).id || "claude";
  const escolha = store.get("modelo", ""); // "" | "porte:leve" | "modelo:opus"
  const tab = store.get("tab", "ativas");
  // Quem está trabalhando vai pro alto, mesmo respondendo no chat de uma tarefa pendente:
  // o que está acontecendo agora é o que o dono precisa ver sem procurar.
  const peso = (t) => (trabalhando(t) ? -1 : ORDER[t.status]);
  // Quatro abas, sem tarefa repetida: ATIVAS (o que anda: fila, rodando, erro — e a pendente que
  // está respondendo no chat agora), PENDENTES (o que ficou pra depois, de TODOS os projetos),
  // EXECUTADAS (o agente terminou; falta o dono conferir) e CONCLUÍDAS. Pendente também em Ativas
  // (até 24/09) misturava o que está andando com o que está parado.
  const active = S.tasks.filter((t) => ["fila", "rodando", "erro"].includes(t.status) || (t.status === "pendente" && trabalhando(t))).sort((a, b) => (peso(a) - peso(b)) || (a.order - b.order));
  const exec = S.tasks.filter((t) => t.status === "executada").sort((a, b) => (peso(a) - peso(b)) || (b.finishedAt || "").localeCompare(a.finishedAt || ""));
  const done = S.tasks.filter((t) => t.status === "concluida").sort((a, b) => (b.finishedAt || "").localeCompare(a.finishedAt || ""));
  // Pendente = fora da fila, esperando decisão do dono. Mais antiga primeiro: é a que está
  // esquecida há mais tempo.
  const pend = S.tasks.filter((t) => t.status === "pendente")
    .sort((a, b) => a.project.localeCompare(b.project) || (a.createdAt || "").localeCompare(b.createdAt || "") || (a.id - b.id));
  const base = tab === "concluidas" ? done : tab === "executadas" ? exec : tab === "pendentes" ? pend : active;
  // Vários projetos no mesmo quadro: o filtro é o que mantém a leitura possível.
  const counts = {}; for (const t of base) counts[t.project] = (counts[t.project] || 0) + 1;
  const running = new Set(S.tasks.filter(trabalhando).map((t) => t.project));
  let filtro = store.get("filtro", "todos");
  if (filtro !== "todos" && !counts[filtro]) filtro = "todos"; // projeto sem tarefa nesta aba
  // A aba Pendentes é o apanhado de TODOS os projetos (já agrupado): o filtro não vale nela.
  const shown = filtro === "todos" || tab === "pendentes" ? base : base.filter((t) => t.project === filtro);
  const emptyMsg = tab === "concluidas" ? "Nenhuma tarefa concluída ainda."
    : tab === "executadas" ? "Nenhuma tarefa executada esperando conferência."
    : tab === "pendentes" ? "Nada pendente: tudo que está no quadro já entrou na fila ou terminou."
    : "Nada por aqui. Escreva a primeira tarefa acima.";
  const chips = Object.keys(counts).sort();

  app.className = "wrap"; delete app.dataset.task; delete app.dataset.conversa;
  app.innerHTML = `
    ${headerHtml()}
    ${workspaceIntro(tab)}
    ${!['consumo','monitoring','memoria','controle'].includes(tab) ? `<section class="overview" aria-label="Resumo das tarefas">
      <button onclick="navigateBoard('ativas')"><span><i></i>Em andamento</span><strong>${S.tasks.filter(trabalhando).length} <small>agentes trabalhando</small></strong></button>
      <button onclick="navigateBoard('pendentes')"><span><i></i>Pendentes</span><strong>${pend.length} <small>ideias para depois</small></strong></button>
      <button onclick="navigateBoard('executadas')"><span><i></i>Para conferir</span><strong>${exec.length} <small>entregas prontas</small></strong></button>
      <button onclick="navigateBoard('concluidas')"><span><i></i>Concluídas</span><strong>${done.length} <small>trabalho entregue</small></strong></button>
    </section>` : ''}
    <div class="composer" ${['consumo','monitoring','memoria','controle'].includes(tab) ? 'hidden' : ''}>
      <label class="composer-label" for="newTask"><span aria-hidden="true">＋</span> NOVA TAREFA</label>
      <textarea id="newTask" rows="1" placeholder="O que vamos fazer agora?" aria-label="Descrição da nova tarefa" title="Enter inclui · Shift+Enter quebra linha · linhas com - criam várias tarefas"></textarea>
      <div class="row">
        <select id="proj" aria-label="Projeto da nova tarefa">${S.projects.map((p) => `<option value="${esc(p.slug)}" ${p.slug === proj ? "selected" : ""}>${esc(p.label)}</option>`).join("")}</select>
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
        <input type="file" id="arqBtn" accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,.pdf" multiple hidden>
        <button class="btn primary" id="addBtn">Criar tarefa <span aria-hidden="true" style="margin-left:12px">↗</span></button>
      </div>
      <div class="anexos" id="anexosIncluir" hidden></div>
      <div class="hint" id="dicaPortao">a fila roda na pasta de cada projeto, um agente por projeto</div>
    </div>
    <div class="tabs" aria-label="Filtrar tarefas" ${["consumo","monitoring","memoria","controle"].includes(tab) ? "hidden" : ""}>
      <button class="tab ${tab === "ativas" ? "on" : ""}" data-tab="ativas">Ativas<b>${active.length}</b></button>
      <button class="tab ${tab === "pendentes" ? "on" : ""}" data-tab="pendentes" title="O que ficou combinado pra depois, de todos os projetos">Pendentes<b>${pend.length}</b></button>
      <button class="tab ${tab === "executadas" ? "on" : ""}" data-tab="executadas">Executadas<b>${exec.length}</b></button>
      <button class="tab ${tab === "concluidas" ? "on" : ""}" data-tab="concluidas">Concluídas<b>${done.length}</b></button>
      <button class="tab" id="abrirBusca" style="margin-left:auto" title="Procurar tarefa pelo sentido: descreva com as suas palavras, mesmo sem lembrar o título">🔎 Buscar</button>
      <button class="tab" id="abrirConversa" title="Conversar com o agente na pasta deste projeto, sem abrir tarefa">💬 Conversa</button>
      <button class="tab ${tab === "monitoring" ? "on" : ""}" data-tab="monitoring" title="Visualizar status em tempo real de ai-memory, mac, saturno e google drive">🖧 Status</button>
      <button class="tab ${tab === "consumo" ? "on" : ""}" data-tab="consumo">Consumo</button>
    </div>
    ${tab === "monitoring" ? `<div class="monitoring" id="monitoring"><div class="empty">carregando…</div></div>` : ""}
    ${tab === "memoria" ? `<div class="memoria" id="memoria"><div class="empty">carregando…</div></div>` : ""}
    ${tab === "controle" ? `<div class="controle" id="controle"><div class="empty">carregando…</div></div>` : ""}
    ${tab === "consumo" ? `<div class="cons" id="consumo"><div class="empty">carregando…</div></div>` : ""}
    ${tab !== "consumo" && tab !== "monitoring" && tab !== "memoria" && tab !== "controle" && tab !== "pendentes" && chips.length > 1 ? `<div class="chips">
      <button class="chip ${filtro === "todos" ? "on" : ""}" data-proj="todos">Todos<b>${base.length}</b></button>
      ${chips.map((p) => `<button class="chip ${filtro === p ? "on" : ""}" data-proj="${esc(p)}">${running.has(p) ? "<i></i>" : ""}${esc(p)}<b>${counts[p]}</b></button>`).join("")}
    </div>` : ""}
    ${["consumo","monitoring","memoria","controle"].includes(tab) ? "" : `<div class="cols"><span></span><span>Descrição da atividade</span><span>${tab === "concluidas" ? "Concluída em" : tab === "executadas" ? "Executada em" : tab === "pendentes" ? "Criada em" : "Status"}</span></div>
    ${tab === "ativas" && S.tasks.some((t) => trabalhando(t) && t.agente) ? `<div class="agentes" title="quem está trabalhando agora">${S.tasks.filter((t) => trabalhando(t) && t.agente).sort((a, b) => a.project.localeCompare(b.project) || a.agente.localeCompare(b.agente)).map((t) => `<a class="agente-chip" href="#/t/${t.id}"><i></i><b>${t.paralelo ? "⚡" : ""}#${esc(t.agente)}</b>${esc(t.project)} · ${esc(nomeModelo(t.modeloUsado))}${t.esforcoUsado ? " · " + esc(t.esforcoUsado) : ""}<span>#${t.id} ${esc(cutTxt(t.title, 42))}</span></a>`).join("")}<button class="agente-chip" onclick="abrirTmux()" title="Abre o Terminal numa sessão tmux com uma aba por agente, ao vivo">🖥 ver no tmux</button></div>` : ""}
    <div class="list${tab === "pendentes" ? " pendentes" : ""}" id="list">${!shown.length ? `<div class="empty"><span class="empty-icon" aria-hidden="true">✓</span><strong>${tab === "ativas" ? "Tudo em dia por aqui" : "Seu quadro está em ordem"}</strong>${emptyMsg}</div>`
      : tab === "pendentes" ? gruposPendentes(shown) : shown.map((t) => taskRow(t)).join("")}</div>`}
  `;

  const ta = $("#newTask");
  const grow = () => { ta.style.height = "auto"; ta.style.height = Math.min(240, ta.scrollHeight) + "px"; };
  ta.value = rascunho.valor || "";
  if (ta.value) grow();
  ta.addEventListener("input", () => { grow(); store.set("rascunho", ta.value); });
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addTask(); } });
  $("#addBtn").onclick = addTask;
  $("#clipeBtn").onclick = () => $("#arqBtn").click();
  $("#arqBtn").onchange = (e) => { subirImagens("incluir", e.target.files); e.target.value = ""; };
  ligarImagens("incluir", ta, app.querySelector(".composer"));
  pintarAnexos("incluir");
  $("#proj").onchange = (e) => store.set("project", e.target.value);
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
  app.querySelectorAll(".tab[data-tab]").forEach((b) => { b.onclick = () => { store.set("tab", b.dataset.tab); ultimaAssinatura = null; renderList(); }; });
  if ($("#abrirBusca")) $("#abrirBusca").onclick = () => {
    // O filtro de projeto viaja junto: quem está olhando um projeto quer buscar dentro dele.
    if (filtro !== "todos") store.set("buscaProjeto", filtro);
    location.hash = "#/busca";
  };
  // A conversa é do projeto em que o dono está: o filtro manda; sem filtro, o do seletor.
  if ($("#abrirConversa")) $("#abrirConversa").onclick = () => {
    location.hash = "#/c/" + (filtro !== "todos" ? filtro : $("#proj").value);
  };
  app.querySelectorAll(".chip").forEach((b) => { b.onclick = () => {
    const p = b.dataset.proj;
    store.set("filtro", p);
    // Filtrou por um projeto? A tarefa nova nasce nele — é onde você está trabalhando.
    if (p !== "todos" && S.projects.some((x) => x.slug === p)) store.set("project", p);
    renderList();
  }; });
  // Só devolve o foco se ele estava na caixa (senão roubaria o clique num filtro ou seletor).
  if (rascunho.foco && !["consumo","monitoring","memoria","controle"].includes(tab)) { ta.focus({preventScroll:true}); if (rascunho.ini != null) ta.setSelectionRange(rascunho.ini, rascunho.fim); }
  if (tab === "ativas") bindDrag();
  if (tab === "monitoring") renderMonitoring();
  if (tab === "memoria") renderMemoria();
  if (tab === "controle") renderControle();
  if (tab === "consumo") renderConsumo();
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
      <div class="meta"><span>#${t.id}</span><span class="proj">${esc(t.project)}</span>${agenteSelo(t)}${juntarSelo(t)}${idade ? `<span class="idade" title="parada desde ${esc(fmtDay(t.createdAt))}">${esc(idade)}</span>` : ""}${t.entrega === "pr" || t.entrega === "deploy" ? `<span class="tag-pr">PR</span>` : ""}${t.anexos?.length ? `<span title="${t.anexos.length} anexo(s): imagem ou PDF">🖼 ${t.anexos.length}</span>` : ""}${motorSelo(t)}${selos(t)}${t.prUrl ? `<a class="prlink" href="${esc(t.prUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">↗ PR</a>` : ""}${t.cost ? `<span>${fmtCost(t.cost)}</span>` : ""}${lastTxt ? `<span class="last">${esc(lastTxt)}</span>` : ""}</div>
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
        : t.status === "executada" && !t.busy ? `<span class="pill executada">${fmtDay(t.finishedAt) || "Executada"}</span>`
        : `<span class="pill ${e.cls}">${e.label}</span>${trabalhando(t) ? "" : `<span class="grip" title="Arraste pra reordenar">⋮⋮</span>`}`}
    </div>
  </div>`;
}
/** Aba Pendentes: as tarefas fora da fila, agrupadas por projeto (já chegam ordenadas). */
function gruposPendentes(tarefas) {
  const grupos = new Map();
  for (const t of tarefas) (grupos.get(t.project) || grupos.set(t.project, []).get(t.project)).push(t);
  return [...grupos].map(([proj, ts]) => `
    <div class="grupo"><span class="proj">${esc(proj)}</span><b>${ts.length}</b></div>
    ${ts.map((t) => taskRow(t, { criada: true })).join("")}`).join("");
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
    pendentes.incluir = []; pintarAnexos("incluir");
    ta.value = ""; ta.style.height = "auto"; store.set("rascunho", "");
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

