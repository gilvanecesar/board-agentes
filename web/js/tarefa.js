// A ficha da tarefa: linha do tempo, chat, entrega (PR/publicar) e passagem de bastão.
// ── tela da tarefa ───────────────────────────────────────────────────────────
/** Ficha da tarefa "não juntada — conflito": por quê, quais arquivos, a saída do portão e o "tentar de novo". */
function avisoNaoJuntada(t) {
  if (!naoJuntada(t)) return "";
  const c = t.worktree.conflito || {};
  return `<div class="aviso-naojuntada" role="alert" onclick="event.stopPropagation()">
    <b>⚠ Não juntada — conflito.</b> <span>${esc(c.motivo || "a pasta principal mudou nos mesmos trechos")}. Nada entrou na pasta principal; o trabalho aprovado está só na cópia isolada da tarefa.</span>${pastaRecolhida(t.worktree.dir, "caminho da cópia")}
    ${(c.arquivos || []).length ? `<div class="nj-arquivos">Arquivos: ${c.arquivos.slice(0, 20).map((a) => `<code>${esc(a)}</code>`).join(" ")}${c.arquivos.length > 20 ? " …" : ""}</div>` : ""}
    ${c.portao ? `<details><summary>saída do portão (${esc(c.portao.comando)})</summary><pre class="md-code"><code>${esc(c.portao.saida || "")}</code></pre></details>` : ""}
    <div class="nj-acoes"><button class="btn primary" onclick="juntarDeNovo(${t.id})">⇲ Tentar juntar de novo</button><span class="pr-mudo">o agente já tentou resolver sozinho; se você aplicar o trabalho na pasta à mão, o board percebe e limpa o aviso — ou ▶ Rodar de novo para o agente refazer em cima da pasta atual</span></div>
  </div>`;
}
async function juntarDeNovo(id) {
  try { await api(`/tasks/${id}/juntar`, { method: "POST" }); toast("Junção na fila: o board tenta assim que a pasta estiver livre.", 4000, "info"); }
  catch (e) { toast(e.message, 5000, "erro"); }
}
/** Ficha da tarefa cujo PR a vigia não conseguiu atualizar (#279). Resolvido no GitHub ou pelo chat, o aviso some sozinho. */
function avisoPrVigia(t) {
  if (!prEsgotado(t)) return "";
  const v = t.prVigia;
  return `<div class="aviso-naojuntada" role="alert" onclick="event.stopPropagation()">
    <b>⚠ ${esc(vigiaTxt(v))}.</b> <span>${esc(v.porque || "")}</span>
    <div class="nj-acoes"><a class="prlink" href="${esc(v.url)}" target="_blank" rel="noopener">↗ ver o PR #${esc(String(v.numero))}</a><span class="pr-mudo">resolva no PR ou peça aqui no chat da tarefa; quando o GitHub mostrar o PR sem conflito e sem check falhando, este aviso some sozinho</span></div>
  </div>`;
}
/** Ficha da tarefa reprovada que o chat consertou: o conserto ainda não passou por ninguém (#288). */
function avisoConferir(t) {
  if (!faltaConferir(t)) return "";
  return `<div class="aviso-conferir" role="status"><b>⏳ Falta conferir.</b> <span>O chat mudou arquivo depois da reprovação. Portão, revisor e QA rodam assim que a fila chegar nesta tarefa; até lá, o conserto não foi conferido.</span></div>`;
}
const SOBRAS_ABERTAS = new Set(); // o redesenho da ficha não fecha o que o dono abriu
/** Os defeitos menores da conferência (#300): não reprovaram e nenhuma rodada automática mexe neles. Só aqui, recolhidos, sem cor de
 *  alerta e sem contador (#311, pedido do dono: "essas sobras são redundantes"). */
function avisoSobras(t) {
  if (!t.sobras?.length) return "";
  return `<details class="sobras"${SOBRAS_ABERTAS.has(t.id) ? " open" : ""} ontoggle="SOBRAS_ABERTAS[this.open ? 'add' : 'delete'](${Number(t.id)})"><summary>Observações menores do revisor e do QA</summary>
    <div>Não reprovaram e nenhuma rodada automática mexe nelas. Para consertar, peça no chat da tarefa.</div>
    <ul>${t.sobras.map((s) => `<li><span class="pr-mudo">${s.quem === "qa" ? "QA" : "revisor"}</span> ${esc(s.texto)}</li>`).join("")}</ul></details>`;
}
function detailHead(t) {
  const canRun = !trabalhando(t) && ["pendente", "executada", "erro", "concluida"].includes(t.status);
  const e = estado(t);
  const motor = (S.motores || []).find((m) => m.id === (t.motor || "claude"))?.rotulo || t.motor || "Claude";
  const quem = [t.agente ? "#" + t.agente : "", t.modeloUsado ? nomeModelo(t.modeloUsado) : t.modelo || motor, t.porte || ""].filter(Boolean).join(" · ");
  // Cockpit (#364): o cabeçalho é UMA linha, como na proposta — estado, "#id título", projeto, quem trabalha, entrega e os botões à direita.
  // O resto (esteira, metadados, entrega, o pedido inteiro) mora na coluna da esquerda (fichaLado).
  return `<div class="dhead fhead">
      <span class="pill ${e.cls}">${e.label}</span>
      <h2 class="t" title="${esc(t.title)}">#${t.id} ${esc(t.title)}</h2>
      <span class="chip" style="color:var(--violet)">${esc(nomeProj(t.project))}</span>
      <span class="chip" title="qual CLI e qual modelo rodam esta tarefa">${esc(quem)}</span>
      <span class="chip">entrega: ${t.entrega === "pr" ? "PR" : t.entrega === "deploy" ? "PR + publicar" : "direto"}</span>
      <div class="acts">
        ${t.status === "rodando" ? `<button class="btn danger" onclick="stopTask(${t.id})">⏹ Parar</button>` : ""}
        ${t.status === "fila" ? `<button class="btn" onclick="setStatus(${t.id},'pendente')">⏸ Tirar da fila</button>` : ""}
        ${canRun ? `<button class="btn primary" onclick="setStatus(${t.id},'fila')">▶ ${t.sessionId ? "Rodar de novo" : "Rodar"}</button>` : ""}
        ${canRun && t.sessionId ? `<button class="btn" title="Confere e abre o PR do trabalho que já está feito, sem refazer a tarefa" onclick="virarPR(${t.id})">↗ Virar PR</button>` : ""}
        ${canRun && t.sessionId ? (podePublicar(t)
          ? `<button class="btn" title="Confere, abre o PR, mescla e roda o comando de publicação do projeto" onclick="publicar(${t.id})">⇪ Mesclar e publicar</button>`
          : `<button class="btn" style="opacity:.5" title="Desligado: declare o comando de publicação de ${esc(nomeProj(t.project))} em data/deploy.json" onclick="semDeploy('${esc(t.project)}')">⇪ Mesclar e publicar</button>${pastaRecolhida(`{"${t.project}": "./deploy.sh"}`, "como ligar")}`) : ""}
        ${t.status !== "concluida" && t.status !== "rodando" ? `<button class="btn" onclick="setStatus(${t.id},'concluida')">✓ Concluir</button>` : ""}
        ${t.status === "concluida" ? `<button class="btn" onclick="setStatus(${t.id},'${t.result ? "executada" : "pendente"}')">Reabrir</button>` : ""}
        ${!trabalhando(t) && (S.motores || []).length > 1 ? `<span class="passar">⇄ passar para
          ${S.motores.filter((m) => m.id !== (t.motor || "claude")).map((m) => `<button class="btn sm" title="${esc(m.rotulo)} assume e termina: a sessão não atravessa, vai o resumo, os últimos passos e o estado da pasta${cotaTxt(m.id)}" onclick="passarBastao(${t.id},'${m.id}')">${esc(m.rotulo)}${cotaSelo(m.id)}</button>`).join("")}
        </span>` : ""}
        ${trabalhando(t) && t.agente ? `<button class="btn" onclick="abrirTmux()" title="A sessão tmux com uma aba por agente, ao vivo">🖥 tmux</button>` : ""}
        <button class="btn danger" onclick="delTask(${t.id})">Excluir</button>
      </div>
    </div>`;
}
const FICHA_DET = { aberto: null }; // o "detalhes" da coluna: aberto no computador, fechado no celular, e o clique do dono manda
/** A coluna da esquerda da ficha (Cockpit): a esteira em 5 passos, os avisos, os metadados, a entrega e o PEDIDO inteiro embaixo. */
function fichaLado(t) {
  const aberto = FICHA_DET.aberto ?? innerWidth > 760;
  const nRom = t.romaneio?.itens?.length || 0;
  return `<div class="rot">Esteira</div>
    ${esteiraFicha(t)}
    ${avisoProjeto(t)}
    ${avisoNaoJuntada(t)}
    ${avisoPrVigia(t)}
    ${avisoConferir(t)}
    ${avisoSobras(t)}
    <details class="ficha-det"${aberto ? " open" : ""} ontoggle="FICHA_DET.aberto = this.open"><summary>Detalhes da tarefa</summary>
      <div class="m">
        ${retryTxt(t) ? `<span style="color:var(--amber)">${esc(retryTxt(t))}</span>` : ""}
        <span title="qual CLI e qual modelo rodam esta tarefa">${esc((S.motores || []).find((m) => m.id === (t.motor || "claude"))?.rotulo || t.motor || "Claude")}${t.modelo ? " · " + esc(t.modelo) : t.classificando ? " · classificando o porte…" : t.porte ? " · porte " + esc(t.porte) + (t.porteAuto ? " (auto" + (efeitoPorte(t.motor, t.porte) ? ", " + esc(efeitoPorte(t.motor, t.porte)) : "") + ")" : efeitoPorte(t.motor, t.porte) ? " (" + esc(efeitoPorte(t.motor, t.porte)) + ")" : "") : ""}</span>${agenteSelo(t)}${juntarSelo(t)}${prVigiaSelo(t)}
        ${t.tokens ? `<span title="tokens que o motor informou">${t.tokens.toLocaleString("pt-BR")} tokens</span>` : ""}
        <span>criada ${fmtDay(t.createdAt)}</span>
        ${t.cost ? `<span>${fmtCost(t.cost)}</span>` : ""}${t.turns ? `<span>${t.turns} turno(s)</span>` : ""}${t.durationMs ? `<span>${fmtDur(t.durationMs)}</span>` : ""}
        ${t.sessionId ? `<span title="${esc(t.sessionId)}">sessão ${esc(t.sessionId.slice(0, 8))}</span>` : ""}
        ${selos(t)}
        ${t.prUrl ? `<a class="prlink" href="${esc(t.prUrl)}" target="_blank" rel="noopener">↗ ver o PR</a>` : ""}
        ${t.publicado ? `<span class="pr-ok" title="${esc(t.publicado.quem || "")}">🚀 publicado ${esc(fmtDay(t.publicado.em))}${t.publicado.conferido === false ? (garantirPublicar(), `<span data-pubaviso="${esc(t.publicado.slug || t.project)}" data-pubsha="${esc(t.publicado.mainSha || "")}" data-pubem="${esc(t.publicado.em || "")}">${esc(avisoPublicadoHtml(t.publicado.slug || t.project, t.publicado.mainSha, t.publicado.em))}</span>`) : ""}</span>` : ""}
        ${t.merged && (S.publicaveis || []).includes(t.project) ? (garantirPublicar(), `<span class="pub-acao" data-pubacao="${esc(t.project)}" data-rotulo="🚀 Publicar ${esc(nomeProj(t.project))}" data-sm="1">${acaoPublicarHtml(t.project, { rotulo: `🚀 Publicar ${nomeProj(t.project)}`, sm: true })}</span>`) : ""}
      </div>
      <div class="m entrega-linha">
        <span>Entrega:</span>
        <select id="entregaTask" ${t.status === "rodando" || t.busy ? "disabled" : ""}>
          <option value="direto" ${!["pr", "deploy"].includes(t.entrega) ? "selected" : ""}>${ENTREGA_LABEL.direto}</option>
          <option value="pr" ${t.entrega === "pr" ? "selected" : ""}>${ENTREGA_LABEL.pr}</option>
          ${podePublicar(t) ? `<option value="deploy" ${t.entrega === "deploy" ? "selected" : ""}>${ENTREGA_LABEL.deploy}</option>` : ""}
        </select>
      </div>
    </details>
    <div class="pedido"><div class="rot">Pedido</div>
      <div class="t pedido-txt" title="clique para abrir/fechar o texto todo" onclick="this.classList.toggle('aberto')">${esc(t.text || t.title)}</div>
      ${fotosHtml(t.anexos)}
      <div class="pedido-m">${t.anexos?.length ? `🖼 ${t.anexos.length} anexo${t.anexos.length > 1 ? "s" : ""}` : ""}${t.anexos?.length && nRom ? " · " : ""}${nRom ? `📦 romaneio ${nRom} memórias` : ""}</div>
    </div>`;
}
async function renderDetail() {
  const app = $("#app");
  const base = S.tasks.find((x) => x.id === view.id);
  const cheia = tarefaCheia[view.id];
  const t = base && cheia ? { ...cheia, ...base, text: cheia.text, result: cheia.result, anexos: cheia.anexos } : base || cheia;
  if (!t) { app.innerHTML = headerHtml(`<button class="back" onclick="location.hash=''">← voltar</button>`) + `<div class="empty">Tarefa não existe (mais).</div>`; return; }
  const locked = t.status === "rodando" || t.busy;
  // Já estou nesta tarefa: só atualizo cabeçalho e o estado do chat — sem apagar o que o dono digita.
  if (app.dataset.task === String(t.id) && $("#timeline")) {
    renderHeader();
    $(".dhead").outerHTML = detailHead(t);
    if ($("#fichaLado")) $("#fichaLado").innerHTML = fichaLado(t);
    bindEntrega(t.id);
    const ta = $("#chatIn"), btn = $("#chatBtn");
    ta.disabled = locked; btn.disabled = locked;
    ta.placeholder = locked ? "A tarefa está rodando — espere terminar pra discutir" : "Discutir a tarefa com o agente… (Enter envia)";
    if (locked) showThinking(); else { const th = $("#timeline .thinking"); if (th) th.remove(); }
    pintarPermissoes();
    return;
  }
  app.dataset.task = String(t.id); delete app.dataset.conversa; delete app.dataset.busca;
  app.className = "wrap detail ficha";
  app.innerHTML = `
    <div class="dtop">
      ${headerHtml(`<button class="back" onclick="location.hash=''">← voltar</button>`)}
      ${detailHead(t)}
    </div>
    <aside class="ficha-lado" id="fichaLado" aria-label="Esteira, detalhes e o pedido">${fichaLado(t)}</aside>
    <div class="timeline" id="timeline"><div class="empty">carregando…</div></div>
    <div class="chatbox">
      <div style="flex:1;display:flex;flex-direction:column;gap:8px">
        <div class="anexos" id="anexosChat" hidden></div>
        <textarea id="chatIn" class="cresce" rows="1" placeholder="${locked ? "A tarefa está rodando — espere terminar pra discutir" : "Discutir a tarefa com o agente… (Enter envia)"}" ${locked ? "disabled" : ""}></textarea>
      </div>
      ${micHtml("chatIn", locked)}
      <button class="ib clipe" id="clipeChat" title="Anexar imagem (ou cole com Ctrl+V, ou arraste aqui)" ${locked ? "disabled" : ""}>📎</button>
      <input type="file" id="arqChat" accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,.pdf" multiple hidden>
      <button class="btn primary" id="chatBtn" ${locked ? "disabled" : ""}>Enviar</button>
    </div>
  `;
  const ta = $("#chatIn");
  ligarRascunho(ta, "chat." + t.id);
  ligarAltura(ta);
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(t.id); } });
  $("#chatBtn").onclick = () => sendChat(t.id);
  $("#clipeChat").onclick = () => $("#arqChat").click();
  ligarMic(app);
  $("#arqChat").onchange = (e) => { subirImagens("chat", e.target.files); e.target.value = ""; };
  ligarImagens("chat", ta, app.querySelector(".chatbox"));
  pintarAnexos("chat");
  bindEntrega(t.id);
  pintarPermissoes();
  medirTopo();

  try {
    const d = await api(`/tasks/${t.id}/log`);
    if (view.id !== t.id) return;
    logCache[t.id] = d.events; tarefaCheia[t.id] = d.task; lastText = null;
    const tl = $("#timeline"); tl.innerHTML = d.events.length ? "" : `<div class="empty">Nada aconteceu ainda. Clique em ▶ Rodar, ou discuta a tarefa embaixo.</div>`;
    d.events.forEach((ev) => appendEvent(ev, false));
    if (t.busy || t.status === "rodando") showThinking();
    rolarProFim(true);
  } catch (e) { toast(e.message); }
}

const motorSelo = (t) => {
  const padrao = (S.config || {}).motor || "claude";
  const partes = [t.motor && t.motor !== padrao ? (S.motores || []).find((m) => m.id === t.motor)?.rotulo || t.motor : "", t.modelo || (t.porte ? "porte " + t.porte + (t.porteAuto ? " · auto" : "") : "")].filter(Boolean);
  return partes.length ? `<span class="selo" title="motor e modelo desta tarefa">${esc(partes.join(" · "))}</span>` : "";
};
const fotosHtml = (anexos) => !anexos?.length ? "" :
  `<div class="fotos">${anexos.map((a) => `<a href="/api/anexos/${esc(a.id)}" target="_blank" rel="noopener" title="${esc(a.nome || "")}">${ehPdf(a.id) ? pdfHtml(a.nome) : `<img src="/api/anexos/${esc(a.id)}" alt="${esc(a.nome || "imagem")}">`}</a>`).join("")}</div>`;

const ICONE_MENTE = { dono: "🧭", marketplace: "🚚", fiscal: "🧾", financeiro: "💰", whatsapp: "💬", comercial: "📣", design: "🎨", engenharia: "🛠️", seguranca: "🛡️", triagem: "📥" };
// A tela Memória (o grafo) saiu do menu em 04/11: a página clicada no 📦, na Busca ou no Controle abre aqui, numa janela
// por cima da tela, lida da mesma rota (`/api/memoria/pagina`, só chave que o grafo conhece).
async function irParaMemoria(chave) {
  let dlg = $("#memDialogo");
  if (!dlg) { dlg = document.createElement("dialog"); dlg.id = "memDialogo"; dlg.className = "mem-dialogo"; document.body.appendChild(dlg); dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); }); }
  dlg.innerHTML = `<div class="mem-dialogo-corpo"><button class="ib mem-fechar" onclick="this.closest('dialog').close()" aria-label="Fechar">✕</button><div class="docker-vazio">carregando…</div></div>`;
  if (!dlg.open) dlg.showModal();
  const corpo = dlg.querySelector(".mem-dialogo-corpo");
  try {
    const p = await api("/memoria/pagina?chave=" + encodeURIComponent(chave));
    corpo.innerHTML = `<button class="ib mem-fechar" onclick="this.closest('dialog').close()" aria-label="Fechar">✕</button><span class="eyebrow">MEMÓRIA · ${esc(nomeProj(p.projeto))}</span><h3>${esc(p.titulo)}</h3>`
      + (p.descricao ? `<p class="hint">${esc(p.descricao)}</p>` : "") + `<div class="md">${mdToHtml(p.texto || "")}</div>`
      + (p.liga?.length || p.citadaPor?.length ? `<div class="mem-ligas">${[["Liga para", p.liga || []], ["Citada por", p.citadaPor || []]].filter(([, l]) => l.length).map(([t, l]) => `<b>${t}</b>${l.map((i) => `<button onclick="irParaMemoria(${esc(JSON.stringify(i.chave))})">${esc(i.titulo)}</button>`).join("")}`).join("")}</div>` : "");
  } catch (e) { corpo.querySelector(".docker-vazio").textContent = e.message; }
}
function eventHtml(ev) {
  const at = `<div class="at">${fmtAt(ev.at)}</div>`;
  switch (ev.t) {
    case "dono": return `<div class="ev dono com-rot${ev.naVez ? " navez" : ""}"><span class="ev-rot">você</span>${at}${ev.voz ? `<div class="k"><span class="selo voz-selo" title="Transcrita do modo voz. Não vale como SIM: aprovação é no botão ✓ Aprovar">🎙 falada</span></div>` : ""}${ev.naVez ? `<div class="k"><span title="Mandada com a resposta anterior no meio: o agente recebe quando ela terminar">✎ enviada durante a resposta</span></div>` : ""}${citacaoHtml(ev.cita)}<div class="ev-txt">${esc(ev.texto)}</div>${fotosHtml(ev.anexos)}${ev.aprovacao ? `<div class="k"><span class="selo aprovacao" title="Digitada por você na tela da Central: as outras sessões conferem este número com board aprovacao">✓ aprovação #${esc(ev.aprovacao)}</span></div>` : ""}</div>`;
    // Central: o que outra sessão do Claude mandou (não é o dono; quem decide é ele).
    // Pedido de permissão (#232): o cartão com os botões mora em #permCartoes; aqui fica a marca na linha do tempo.
    case "permissao": return `<div class="ev mark perm-marca">🔐 ${fmtAt(ev.at)} · ${ev.tipo === "barrado" ? `o classificador barrou${ev.motivo ? ` (${esc(ev.motivo)})` : ""}` : "pediu permissão"}: <b>${esc(ev.ferramenta)}</b> <code>${esc(cutTxt(ev.acao, 140))}</code></div>`;
    case "permissao-resposta": return `<div class="ev mark ${/permitida/.test(ev.decisao) ? "ok" : "nao"}">🔐 ${fmtAt(ev.at)} · ${esc(ev.decisao)} — ${esc(ev.quem)}${ev.regra ? ` · regra <code>${esc(ev.regra)}</code>` : ""}</div>`;
    case "sessao": return `<div class="ev sessao com-rot"><span class="ev-rot" title="mensagem de outra sessão">✉</span>${at}<div class="k"><span>✉ mensagem de <b>${esc(ev.de)}</b></span></div><div class="md">${mdToHtml(ev.texto)}</div></div>`;
    case "texto": return `<div class="ev texto com-rot${ev.quem === "revisor" || ev.quem === "qa" ? " rot-conf" : ""}"><span class="ev-rot">${ev.quem === "revisor" ? "rev." : ev.quem === "qa" ? "QA" : "agente"}</span>${at}${ev.quem === "revisor" ? `<span class="tag-pr" style="margin-right:6px">REVISOR</span>` : ev.quem === "qa" ? `<span class="tag-pr" style="margin-right:6px;color:var(--c-qa);border-color:var(--c-qa)">QA</span>` : ""}<div class="md">${mdToHtml(ev.texto)}</div></div>`;
    case "ferramenta": return `<div class="ev ferramenta ${ev.quem === "revisor" ? "rev" : ""}" title="${esc(ev.alvo)}">${ev.quem === "revisor" ? "🔍" : ev.quem === "qa" ? "🧪" : "▸"} <b>${esc(ev.nome)}</b> ${esc(ev.alvo)}</div>`;
    case "resultado": {
      // Conversa e Central: o número (R12) vem do servidor, que conta pelo log; e dá para responder a ela.
      const n = Number.isInteger(ev.n) ? ev.n : null;
      const rot = n ? `<span class="ev-rot rnum" title="Número desta resposta, contado pelo board: clique para responder citando">R${n}</span>` : `<span class="ev-rot">fim</span>`;
      const k = `<div class="k"><span>resultado</span>${ev.importado ? `<span title="Resposta dada no terminal, antes de a sessão vir para a Conversa">🖥 do terminal</span>` : ""}${ev.custo ? `<span>${fmtCost(ev.custo)}</span>` : ""}${ev.turnos ? `<span>${ev.turnos} turno(s)</span>` : ""}${ev.dur ? `<span>${fmtDur(ev.dur)}</span>` : ""}${n ? `<button class="responder" type="button" title="Responder citando R${n}" onclick="responderA(${n})">↩ responder</button>` : ""}</div>`;
      const ancora = n ? ` id="r-${n}"` : "";
      // O resultado repete a última fala do agente: então só o rodapé com custo/tempo.
      // Central (#213): a resposta que pede o SIM ganha o botão Aprovar — manda "SIM" citando ela, com o id de aprovação.
      const sim = ev.pedidoSim && n && view.central ? `<div class="pedido-sim"><span><b>Pedido de SIM:</b> ${esc(ev.pedidoSim)}</span>
        <button class="btn primary" type="button" title="Envia SIM citando R${n}; o board grava a aprovação que as outras sessões conferem" onclick="aprovarPedido(${n})">✓ Aprovar</button><button class="btn" type="button" title="Responder citando R${n}, sem aprovar" onclick="responderA(${n})">↩ responder</button></div>` : "";
      if (ev.dup) return `<div class="ev resultado slim com-rot"${ancora}>${rot}${k}${sim}</div>`;
      return `<div class="ev resultado com-rot"${ancora}>${rot}${k}<div class="md">${mdToHtml(ev.texto || "(sem texto)")}</div>${sim}</div>`;
    }
    case "portao": {
      if (ev.estado === "rodando") return `<div class="ev mark">⛨ ${fmtAt(ev.at)} · portão rodando <code>${esc(ev.comando)}</code></div>`;
      const ok = ev.estado === "passou";
      return `<div class="ev portao ${ok ? "ok" : "nao"}"><div class="k"><span>⛨ portão ${ok ? "passou" : "falhou"}</span><span>${esc(ev.comando)}</span>${ok ? "" : `<span>código ${ev.code}</span>`}</div>${ok ? "" : `<pre>${esc(ev.saida || "")}</pre>`}</div>`;
    }
    case "retentativa": {
      if (ev.estado === "passagem") return `<div class="ev mark" style="color:var(--amber)">${esc(ev.texto || "")}</div>`;
      const cor = ev.estado === "esgotada" || ev.estado === "manual" ? "err" : "";
      return `<div class="ev mark ${cor}">↻ ${fmtAt(ev.at)} · ${esc(ev.texto || "")}</div>`;
    }
    case "passo": {
      const nome = ev.nome === "merge" ? "mesclar o PR" : "publicar";
      if (ev.estado === "rodando") return `<div class="ev mark">⇪ ${fmtAt(ev.at)} · ${nome} <code>${esc(cutTxt(ev.comando, 90))}</code></div>`;
      const ok = ev.estado === "passou";
      return `<div class="ev portao ${ok ? "ok" : "nao"}"><div class="k"><span>⇪ ${nome} ${ok ? "ok" : "falhou"}</span><span>${esc(cutTxt(ev.comando, 70))}</span>${ok ? "" : `<span>código ${ev.code}</span>`}</div>${ok ? "" : `<pre>${esc(ev.saida || "")}</pre>`}</div>`;
    }
    case "revisor":
    case "qa": {
      const ok = ev.veredito === "APROVADO";
      return `<div class="ev revisor com-rot rot-conf ${ok ? "ok" : "nao"}"><span class="ev-rot">${ev.t === "qa" ? "QA" : "rev."}</span><div class="k"><span>${ev.t === "qa" ? "🧪 QA" : "🔍 revisor"}: ${esc(ev.veredito)}</span>${ev.menores ? `<span>${ev.menores} ${ev.menores === 1 ? "menor" : "menores"} para o dono</span>` : ""}${ev.custo ? `<span>${fmtCost(ev.custo)}</span>` : ""}</div><div class="txt">${esc(ev.texto || "")}</div></div>`;
    }
    case "romaneio": {
      const itens = ev.itens || [];
      return `<details class="ev romaneio"><summary>📦 romaneio · ${itens.length} memórias · ~${Number(ev.tokens || 0).toLocaleString("pt-BR")} tokens · mentes: ${(ev.mentes || []).map((m) => ICONE_MENTE[m] || "").join(" ")} ${esc((ev.mentes || []).join(", "))}${ev.modo === "palavra+sentido" ? " · por palavra e sentido" : ev.modo === "palavra" ? " · só por palavra" : ""}</summary>`
        + (ev.semSentido ? `<div class="rom-aviso">sem o sentido nesta tarefa: ${esc(ev.semSentido)}</div>` : "")
        + `<div class="rom-lista">${itens.map((i) => `<button onclick="irParaMemoria(${esc(JSON.stringify(i.chave))})" title="ler a página da memória${i.sentido != null ? ` · parecença de sentido ${Math.round(i.sentido * 100)}%` : ""}">${ICONE_MENTE[i.mente] || ""} ${esc(i.titulo)}${i.nota ? `<small>${i.nota}</small>` : ""}${i.sentido != null && !i.nota ? `<small>sentido ${Math.round(i.sentido * 100)}%</small>` : ""}</button>`).join("")}</div></details>`;
    }
    case "inicio": return `<div class="ev mark">▶ ${fmtDay(ev.at)} · começou em ${esc(nomeProj(ev.projeto))}</div>`;
    case "fim": return `<div class="ev mark ${ev.status === "erro" ? "err" : ""}">${ev.status === "erro" ? "✗" : "■"} ${fmtAt(ev.at)} · ${esc(ev.status)}${ev.motivo ? " — " + esc(ev.motivo) : ""}</div>`;
    default: return `<div class="ev solto">${esc(ev.texto)}</div>`;
  }
}
let lastText = null; // última fala do agente na tela — pra não repetir no resultado
function appendEvent(ev, scroll = true) {
  const tl = $("#timeline"); if (!tl) return;
  if (ev.t === "texto") lastText = (ev.texto || "").trim();
  if (ev.t === "resultado") { ev = { ...ev, dup: (ev.texto || "").trim() === lastText }; lastText = null; }
  const vivo = tl.querySelector(".ao-vivo"); if (vivo) vivo.remove();
  const empty = tl.querySelector(".empty"); if (empty) empty.remove();
  const th = tl.querySelector(".thinking"); if (th) th.remove();
  // a mesma "resultado" já chegou no evento texto anterior? mantém os dois: o resultado tem custo.
  tl.insertAdjacentHTML("beforeend", eventHtml(ev));
  if (ev.t !== "fim" && ev.t !== "resultado") showThinking();
  if (scroll) rolarProFim();
}
// ── Rolagem automática (conversa e tarefa) ──────────────────────────────────
// Acompanha o fim enquanto o dono estiver lá; puxar a tela de quem subiu para ler é pior que não
// rolar. "Está no fim?" vem do último scroll DELE: medir depois de inserir falhava com resposta
// longa (o bloco novo já empurrava o fim para longe e a tela parava de acompanhar).
let seguirFim = true;
const pertoDoFim = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
window.addEventListener("scroll", () => { seguirFim = pertoDoFim(); if (seguirFim) avisoDescer(false); }, { passive: true });
function rolarProFim(forcar = false) {
  if (!$("#timeline")) return;
  if (forcar) seguirFim = true;
  if (seguirFim) { window.scrollTo({ top: document.documentElement.scrollHeight }); avisoDescer(false); }
  else avisoDescer(true);
}
// "↓ novas mensagens": chegou coisa enquanto o dono lia lá em cima. Mora na caixa de escrever
// (sticky), então some sozinho quando a tela troca.
function avisoDescer(mostrar) {
  const box = $(".chatbox"); if (!box) return;
  let b = box.querySelector(".descer");
  if (!mostrar) { if (b) b.remove(); return; }
  if (b) return;
  b = document.createElement("button");
  b.className = "descer"; b.type = "button"; b.textContent = "↓ novas mensagens";
  b.onclick = () => rolarProFim(true);
  box.appendChild(b);
}
// Imagem do histórico termina de carregar depois do primeiro scroll e empurra o fim para baixo.
document.addEventListener("load", (e) => { if (e.target.tagName === "IMG" && e.target.closest("#timeline") && seguirFim) rolarProFim(); }, true);
function showThinking() {
  const tl = $("#timeline"); if (!tl || tl.querySelector(".thinking")) return;
  const ocupado = view.name === "conversa"
    ? !!((S.conversas || {})[view.slug] || {}).busy
    : (() => { const t = S.tasks.find((x) => x.id === view.id); return !!(t && (t.busy || t.status === "rodando")); })();
  if (ocupado) tl.insertAdjacentHTML("beforeend", `<div class="thinking">trabalhando</div>`);
}
// Publicar só existe onde o dono declarou o comando (data/deploy.json) — sem isso, nem aparece.
const podePublicar = (t) => !!(S.deploys || {})[t.project];

// 🖥 ver no tmux: no Mac abre o Ghostty (sem ele, o Terminal); no board sem tela (Atena) leva ao board do Mac, que abre o
// Ghostty em ssh -t atena tmux attach (#352); sem o Mac configurado, a sessão aparece aqui, em #/agentes (#248).
async function abrirTmux() {
  // Aba aberta AINDA no gesto do clique (senão o bloqueador de pop-up barra): o endereço vem depois do POST.
  const aba = GH.modo === "mac" ? window.open("", "_blank") : null;
  try {
    const r = await api("/agentes/tmux", { method: "POST" });
    if (r.modo === "mac" && r.ghostty?.url) {
      if (aba) { aba.opener = null; aba.location.href = r.ghostty.url; } else window.open(r.ghostty.url, "_blank", "noopener");
      const copiou = await copiarComando(r.ghostty.comando);
      toast(`Abri o board do Mac numa aba: clique em "🖥 Abrir no Ghostty" lá.${copiou ? " O comando também foi copiado." : ""} ${GH_DICA}`, 9000);
      return;
    }
    aba?.close();
    if (r.modo === "navegador") {
      // #352: sem o board do Mac pronto, a vista fica aqui e o comando vai copiado, com o motivo dito (nunca calado).
      if (r.ghostty?.aviso) { const copiou = await copiarComando(r.ghostty.comando); toast(`Não abri no Ghostty: ${r.ghostty.aviso}. ${copiou ? `Copiei o comando (${r.ghostty.comando}) para colar num terminal do Mac.` : `O comando: ${r.ghostty.comando}`}`, 14000, "erro"); }
      location.hash = "#/agentes"; return;
    }
    toast(r.modo === "ghostty" ? `Abrindo o Ghostty na sessão tmux board-agentes. ${GH_DICA}` : "Abrindo o Terminal na sessão tmux board-agentes: uma aba por agente.", 6000, "info");
  } catch (e) { aba?.close(); toast("Não abri o tmux dos agentes: " + e.message, 8000, "erro"); }
}
async function filaPausar(pausar) {
  try { await api(pausar ? "/fila/pausar" : "/fila/retomar", { method: "POST" }); toast(pausar ? "Fila pausada: o que está rodando termina, nada novo começa." : "Fila retomada.", 4000); } catch (e) { toast(e.message); }
}
async function reiniciar() {
  try { const r = await api("/reiniciar", { method: "POST" }); toast(r.aviso, 5000); } catch (e) { toast(e.message); }
}
function semDeploy(proj) {
  // O arquivo é lido a cada pedido: basta salvar e recarregar a página, sem reiniciar o board.
  // #249: o toast diz o RÓTULO (nunca o slug da pasta); o exemplo de JSON, que precisa da chave técnica, fica recolhido ao lado do botão.
  toast(`Publicação desligada para ${nomeProj(proj)}. Para ligar, escreva o comando em board/data/deploy.json (o exemplo está em "como ligar", ao lado do botão) e recarregue a página.`, 9000);
}
// Quanto do plano de cada motor já foi usado — ajuda a escolher pra quem passar.
const cotaDoMotor = (id) => pctUso((USO && USO.motores || {})[id]);
const cotaSelo = (id) => { const p = cotaDoMotor(id); return p == null ? "" : ` <b style="font-weight:600;color:var(--${p >= ((USO && USO.teto) || 98) ? "red" : p >= 70 ? "amber" : "dim"})">${p}%</b>`; };
const cotaTxt = (id) => { const p = cotaDoMotor(id); return p == null ? "" : ` · plano em ${p}% de uso`; };

async function passarBastao(id, motor) {
  try { await api(`/tasks/${id}/passar`, { method: "POST", body: { motor } }); toast("Bastão passado: a tarefa voltou pra fila no outro motor.", 5000); }
  catch (e) { toast(e.message); }
}
async function virarPR(id) {
  try { await api(`/tasks/${id}/pr`, { method: "POST" }); } catch (e) { toast(e.message); }
}
async function publicar(id) {
  const t = S.tasks.find((x) => x.id === id);
  const cmd = (S.deploys || {})[t.project];
  if (!confirm(`Isto vai MESCLAR o PR e PUBLICAR o projeto ${nomeProj(t.project)}:\n\n$ ${cmd}\n\nSó acontece se o portão passar e o revisor aprovar. Confirma?`)) return;
  try { await api(`/tasks/${id}/publicar`, { method: "POST" }); } catch (e) { toast(e.message); }
}

function bindEntrega(id) {
  const sel = $("#entregaTask"); if (!sel) return;
  sel.onchange = async (e) => { try { await api(`/tasks/${id}`, { method: "PATCH", body: { entrega: e.target.value } }); } catch (err) { toast(err.message); } };
}
async function sendChat(id) {
  const ta = $("#chatIn"); const text = ta.value.trim(); if (!text && !idsAnexos("chat").length) return;
  rolarProFim(true);
  try {
    await api(`/tasks/${id}/chat`, { method: "POST", body: { text, anexos: idsAnexos("chat") } });
    somEnvio.tocar();
    ta.value = ""; autoAltura(ta); rascunho.gravar("chat." + id, ""); pendentes.chat = []; pintarAnexos("chat");
  } catch (e) { toast(e.message); }
}
// A esteira da tarefa em 4 passos (#364, Cockpit): agente → portão → revisor → QA, cada um com o estado escrito (nunca só cor).
function esteiraFicha(t) {
  const ps = esteiraPassos(t);
  const ic = { ok: "✓", nao: "✗", run: "…", "": "" };
  const desc = {
    agente: (p) => p.st === "run" ? "rodando agora" + (t.startedAt ? " · há " + emMin(t.startedAt) : "") : p.st === "ok" ? [fmtDur(t.durationMs), t.cost ? fmtCost(t.cost) : "", t.turns ? t.turns + " turno(s)" : ""].filter(Boolean).join(" · ") || "terminou" : "ainda não rodou",
    portao: (p) => p.st === "run" ? "rodando agora" : t.gate ? `${cutTxt(t.gate.comando || "", 40)} · ${t.gate.ok ? "verde" : "vermelho"}` : "depois do agente",
    revisor: (p) => p.st === "run" ? "rodando agora" : t.revisor ? t.revisor.veredito : S.config.revisorLigado === false ? "desligado" : "depois do portão",
    qa: (p) => p.st === "run" ? "rodando agora" : t.qa ? t.qa.veredito : S.config.qaLigado === false ? "desligado" : "depois do revisor",
  };
  const comPr = t.entrega === "pr" || t.entrega === "deploy" || t.prUrl;
  const pr = { nome: "pr", rot: "PR", st: t.prUrl ? "ok" : t.status === "rodando" && t.etapa === "entrega" ? "run" : "",
    d: t.prUrl ? `<a href="${esc(t.prUrl)}" target="_blank" rel="noopener">PR${prNumero(t.prUrl)}</a>${t.merged ? " · mesclado" : " · aberto"}` : comPr ? "depois do QA" : "sem PR (direto na pasta)" };
  return `<ol class="esteira" aria-label="Esteira da tarefa">${ps.map((p, i) => `<li class="passo ${p.st}"><i aria-hidden="true">${ic[p.st] || i + 1}</i><span><b>${p.rot}</b><small>${PASSO_TXT[p.st]}</small><em>${esc(desc[p.nome](p))}</em></span></li>`).join("")}<li class="passo ${pr.st}"><i aria-hidden="true">${ic[pr.st] || 5}</i><span><b>PR</b><small>${t.prUrl ? "aberto" : "ainda não"}</small><em>${pr.d}</em></span></li></ol>`;
}
// A coluna da esteira (ficha) fica presa logo abaixo do cabeçalho, que muda de altura (botões quebram linha): mede e guarda em --dtop-h.
const OBS_TOPO = typeof ResizeObserver === "function" ? new ResizeObserver(() => { const d = $(".dtop"); if (d) document.documentElement.style.setProperty("--dtop-h", d.offsetHeight + "px"); }) : null;
function medirTopo() { const d = $(".dtop"); if (!d) return; document.documentElement.style.setProperty("--dtop-h", d.offsetHeight + "px"); OBS_TOPO?.disconnect(); OBS_TOPO?.observe(d); }
