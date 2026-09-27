// A conversa por projeto (um fio por projeto).
// ── Conversa por projeto ─────────────────────────────────────────────────────
// O dono tinha que abrir uma aba de terminal por projeto e repetir o contexto em cada uma.
// Aqui é um fio por projeto, na pasta dele, que continua de onde parou. Não cria tarefa.
function conversaHead(slug, c) {
  const motor = c.motor || (S.config || {}).motor || "claude";
  const escolha = c.modelo ? "modelo:" + c.modelo : "";
  return `<div class="chead dhead">
    <div class="dh1">
      <select id="convProj" title="De qual projeto é esta conversa">
        ${(S.projects || []).map((p) => `<option value="${esc(p.slug)}" ${p.slug === slug ? "selected" : ""}>${esc(p.label)}</option>`).join("")}
      </select>
      ${(S.motores || []).length > 1 ? `<select id="convMotor" title="Qual CLI responde nesta conversa">
        ${S.motores.map((m) => `<option value="${esc(m.id)}" ${m.id === motor ? "selected" : ""}>${esc(m.rotulo)}</option>`).join("")}
      </select>` : ""}
      <select id="convModelo" title="Modelo desta conversa">
        <option value="" ${escolha === "" ? "selected" : ""}>modelo: padrão</option>
        ${(CAT[motor] || {}).lista?.length ? CAT[motor].lista.map((m) => `<option value="modelo:${esc(m)}" ${escolha === "modelo:" + m ? "selected" : ""}>${esc(m)}</option>`).join("") : ""}
      </select>
      ${c.busy ? `<button class="btn" onclick="pararConversa('${esc(slug)}')">⏹ parar</button>`
    : `<button class="btn" title="Começa um fio novo: o agente esquece esta conversa" onclick="limparConversa('${esc(slug)}')">🧹 novo fio</button>`}
      ${c.custo ? `<span class="selo" title="custo desta conversa">${fmtCost(c.custo)}</span>` : ""}
    </div>
    <div class="hint">roda na pasta de ${esc(slug)} · lê código, pesquisa e consulta a memória · só muda arquivo se você pedir · peça "vira tarefa" para ir pra fila</div>
  </div>`;
}

function bindConversaHead(slug) {
  if ($("#convProj")) $("#convProj").onchange = (e) => { location.hash = "#/c/" + e.target.value; };
  // A lista de modelos é POR MOTOR: trocar o motor tem que redesenhar o seletor de modelo,
  // senão sobra um modelo de outra família e o CLI devolve 400 (foi o que matou a #127).
  if ($("#convMotor")) $("#convMotor").onchange = (e) => {
    const c = (S.conversas || {})[slug] || {};
    $(".chead").outerHTML = conversaHead(slug, { ...c, motor: e.target.value, modelo: null });
    bindConversaHead(slug);
  };
}

async function renderConversa() {
  const app = $("#app");
  const slug = view.slug;
  const voltar = `<button class="back" onclick="location.hash=''">← voltar</button>`;
  if (!(S.projects || []).some((p) => p.slug === slug)) {
    app.innerHTML = headerHtml(voltar) + `<div class="empty">Não conheço o projeto "${esc(slug)}".</div>`;
    return;
  }
  const c = (S.conversas || {})[slug] || {};
  const busy = !!c.busy;
  // Já estou nesta conversa: só atualizo cabeçalho e caixa — sem apagar o que o dono digita.
  if (app.dataset.conversa === slug && $("#timeline")) {
    renderHeader();
    $(".chead").outerHTML = conversaHead(slug, c);
    bindConversaHead(slug);
    const ta = $("#convIn"), btn = $("#convBtn");
    ta.disabled = busy; btn.disabled = busy;
    ta.placeholder = busy ? "respondendo…" : `Conversar sobre ${slug}… (Enter envia)`;
    if (busy) showThinking(); else { const th = $("#timeline .thinking"); if (th) th.remove(); }
    return;
  }
  app.dataset.conversa = slug; delete app.dataset.task; delete app.dataset.busca;
  app.className = "wrap detail";
  app.innerHTML = `
    <div class="dtop">
      ${headerHtml(voltar)}
      ${workspaceIntro('conversa')}
      ${conversaHead(slug, c)}
    </div>
    <div class="timeline" id="timeline"><div class="empty">carregando…</div></div>
    <div class="chatbox">
      <div style="flex:1;display:flex;flex-direction:column;gap:8px">
        <div class="anexos" id="anexosConversa" hidden></div>
        <textarea id="convIn" rows="1" placeholder="${busy ? "respondendo…" : `Conversar sobre ${esc(slug)}… (Enter envia)`}" ${busy ? "disabled" : ""}></textarea>
      </div>
      <button class="ib clipe" id="clipeConv" title="Anexar imagem (ou cole com Ctrl+V, ou arraste aqui)" ${busy ? "disabled" : ""}>📎</button>
      <input type="file" id="arqConv" accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,.pdf" multiple hidden>
      <button class="btn primary" id="convBtn" ${busy ? "disabled" : ""}>Enviar</button>
    </div>
  `;
  const ta = $("#convIn");
  ta.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = Math.min(200, ta.scrollHeight) + "px"; });
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviarConversa(slug); } });
  $("#convBtn").onclick = () => enviarConversa(slug);
  $("#clipeConv").onclick = () => $("#arqConv").click();
  $("#arqConv").onchange = (e) => { subirImagens("conversa", e.target.files); e.target.value = ""; };
  ligarImagens("conversa", ta, app.querySelector(".chatbox"));
  pintarAnexos("conversa");
  bindConversaHead(slug);

  try {
    const d = await api(`/conversa/${slug}`);
    if (view.slug !== slug) return;
    logCache[view.id] = d.events; lastText = null;
    const tl = $("#timeline");
    tl.innerHTML = d.events.length ? "" : `<div class="empty">Fio novo. Pergunte qualquer coisa sobre <b>${esc(slug)}</b> — ele lê o código e a memória do projeto antes de responder.</div>`;
    d.events.forEach((ev) => appendEvent(ev, false));
    if (d.busy) showThinking();
    ta.focus();
    window.scrollTo(0, document.body.scrollHeight);
  } catch (e) { toast(e.message); }
}

async function enviarConversa(slug, texto) {
  const ta = $("#convIn");
  const t = texto !== undefined ? texto : ta.value.trim();
  if (!t && !idsAnexos("conversa").length) return;
  const modelo = (($("#convModelo") || {}).value || "").replace(/^modelo:/, "");
  try {
    await api(`/conversa/${slug}`, { method: "POST", body: { texto: t || "(imagem)", anexos: idsAnexos("conversa"),
      motor: ($("#convMotor") || {}).value, modelo } });
    if (texto === undefined) { ta.value = ""; ta.style.height = "auto"; }
    pendentes.conversa = []; pintarAnexos("conversa");
  } catch (e) { toast(e.message); }
}
async function limparConversa(slug) {
  if (!confirm("Começar um fio novo? O agente esquece esta conversa e o histórico some da tela.")) return;
  try { await api(`/conversa/${slug}/limpar`, { method: "POST" }); } catch (e) { toast(e.message); }
}
async function pararConversa(slug) { try { await api(`/conversa/${slug}/parar`, { method: "POST" }); } catch (e) { toast(e.message); } }

