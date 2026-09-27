// A ficha da tarefa: linha do tempo, chat, entrega (PR/publicar) e passagem de bastão.
// ── tela da tarefa ───────────────────────────────────────────────────────────
function detailHead(t) {
  const canRun = !trabalhando(t) && ["pendente", "executada", "erro", "concluida"].includes(t.status);
  const e = estado(t);
  return `<div class="dhead">
      <div class="t" title="clique para abrir/fechar o texto todo" onclick="this.classList.toggle('aberto')">${esc(t.text || t.title)}</div>
      ${fotosHtml(t.anexos)}
      <div class="m">
        <span class="pill ${e.cls}">${e.label}</span>
        <span>#${t.id}</span><span style="color:var(--violet)">${esc(t.project)}</span>
        ${retryTxt(t) ? `<span style="color:var(--amber)">${esc(retryTxt(t))}</span>` : ""}
        <span title="qual CLI e qual modelo rodam esta tarefa">${esc((S.motores || []).find((m) => m.id === (t.motor || "claude"))?.rotulo || t.motor || "Claude")}${t.modelo ? " · " + esc(t.modelo) : t.classificando ? " · classificando o porte…" : t.porte ? " · porte " + esc(t.porte) + (t.porteAuto ? " (auto" + (efeitoPorte(t.motor, t.porte) ? ", " + esc(efeitoPorte(t.motor, t.porte)) : "") + ")" : efeitoPorte(t.motor, t.porte) ? " (" + esc(efeitoPorte(t.motor, t.porte)) + ")" : "") : ""}</span>${agenteSelo(t)}${juntarSelo(t)}
        ${t.tokens ? `<span title="tokens que o motor informou">${t.tokens.toLocaleString("pt-BR")} tokens</span>` : ""}
        <span>criada ${fmtDay(t.createdAt)}</span>
        ${t.cost ? `<span>${fmtCost(t.cost)}</span>` : ""}${t.turns ? `<span>${t.turns} turno(s)</span>` : ""}${t.durationMs ? `<span>${fmtDur(t.durationMs)}</span>` : ""}
        ${t.sessionId ? `<span title="${esc(t.sessionId)}">sessão ${esc(t.sessionId.slice(0, 8))}</span>` : ""}
        ${selos(t)}
        ${t.prUrl ? `<a class="prlink" href="${esc(t.prUrl)}" target="_blank" rel="noopener">↗ ver o PR</a>` : ""}
      </div>
      <div class="m">
        <span>Entrega:</span>
        <select id="entregaTask" ${t.status === "rodando" || t.busy ? "disabled" : ""}>
          <option value="direto" ${!["pr", "deploy"].includes(t.entrega) ? "selected" : ""}>${ENTREGA_LABEL.direto}</option>
          <option value="pr" ${t.entrega === "pr" ? "selected" : ""}>${ENTREGA_LABEL.pr}</option>
          ${podePublicar(t) ? `<option value="deploy" ${t.entrega === "deploy" ? "selected" : ""}>${ENTREGA_LABEL.deploy}</option>` : ""}
        </select>
      </div>
      <div class="acts">
        ${t.status === "rodando" ? `<button class="btn danger" onclick="stopTask(${t.id})">⏹ Parar</button>` : ""}
        ${t.status === "fila" ? `<button class="btn" onclick="setStatus(${t.id},'pendente')">⏸ Tirar da fila</button>` : ""}
        ${canRun ? `<button class="btn primary" onclick="setStatus(${t.id},'fila')">▶ ${t.sessionId ? "Rodar de novo" : "Rodar"}</button>` : ""}
        ${canRun && t.sessionId ? `<button class="btn" title="Confere e abre o PR do trabalho que já está feito, sem refazer a tarefa" onclick="virarPR(${t.id})">↗ Virar PR</button>` : ""}
        ${canRun && t.sessionId ? (podePublicar(t)
          ? `<button class="btn" title="Confere, abre o PR, mescla e roda o comando de publicação do projeto" onclick="publicar(${t.id})">⇪ Mesclar e publicar</button>`
          : `<button class="btn" style="opacity:.5" title="Desligado: declare o comando de publicação de ${esc(t.project)} em data/deploy.json" onclick="semDeploy('${esc(t.project)}')">⇪ Mesclar e publicar</button>`) : ""}
        ${t.status !== "concluida" && t.status !== "rodando" ? `<button class="btn" onclick="setStatus(${t.id},'concluida')">✓ Concluir</button>` : ""}
        ${t.status === "concluida" ? `<button class="btn" onclick="setStatus(${t.id},'${t.result ? "executada" : "pendente"}')">Reabrir</button>` : ""}
        ${!trabalhando(t) && (S.motores || []).length > 1 ? `<span class="passar">⇄ passar para
          ${S.motores.filter((m) => m.id !== (t.motor || "claude")).map((m) => `<button class="btn sm" title="${esc(m.rotulo)} assume e termina: a sessão não atravessa, vai o resumo, os últimos passos e o estado da pasta${cotaTxt(m.id)}" onclick="passarBastao(${t.id},'${m.id}')">${esc(m.rotulo)}${cotaSelo(m.id)}</button>`).join("")}
        </span>` : ""}
        <button class="btn danger" onclick="delTask(${t.id})">Excluir</button>
      </div>
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
    bindEntrega(t.id);
    const ta = $("#chatIn"), btn = $("#chatBtn");
    ta.disabled = locked; btn.disabled = locked;
    ta.placeholder = locked ? "A tarefa está rodando — espere terminar pra discutir" : "Discutir a tarefa com o agente… (Enter envia)";
    if (locked) showThinking(); else { const th = $("#timeline .thinking"); if (th) th.remove(); }
    return;
  }
  app.dataset.task = String(t.id); delete app.dataset.conversa; delete app.dataset.busca;
  app.className = "wrap detail";
  app.innerHTML = `
    <div class="dtop">
      ${headerHtml(`<button class="back" onclick="location.hash=''">← voltar</button>`)}
      ${detailHead(t)}
    </div>
    <div class="timeline" id="timeline"><div class="empty">carregando…</div></div>
    <div class="chatbox">
      <div style="flex:1;display:flex;flex-direction:column;gap:8px">
        <div class="anexos" id="anexosChat" hidden></div>
        <textarea id="chatIn" rows="1" placeholder="${locked ? "A tarefa está rodando — espere terminar pra discutir" : "Discutir a tarefa com o agente… (Enter envia)"}" ${locked ? "disabled" : ""}></textarea>
      </div>
      <button class="ib clipe" id="clipeChat" title="Anexar imagem (ou cole com Ctrl+V, ou arraste aqui)" ${locked ? "disabled" : ""}>📎</button>
      <input type="file" id="arqChat" accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,.pdf" multiple hidden>
      <button class="btn primary" id="chatBtn" ${locked ? "disabled" : ""}>Enviar</button>
    </div>
  `;
  const ta = $("#chatIn");
  ta.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = Math.min(200, ta.scrollHeight) + "px"; });
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(t.id); } });
  $("#chatBtn").onclick = () => sendChat(t.id);
  $("#clipeChat").onclick = () => $("#arqChat").click();
  $("#arqChat").onchange = (e) => { subirImagens("chat", e.target.files); e.target.value = ""; };
  ligarImagens("chat", ta, app.querySelector(".chatbox"));
  pintarAnexos("chat");
  bindEntrega(t.id);

  try {
    const d = await api(`/tasks/${t.id}/log`);
    if (view.id !== t.id) return;
    logCache[t.id] = d.events; tarefaCheia[t.id] = d.task; lastText = null;
    const tl = $("#timeline"); tl.innerHTML = d.events.length ? "" : `<div class="empty">Nada aconteceu ainda. Clique em ▶ Rodar, ou discuta a tarefa embaixo.</div>`;
    d.events.forEach((ev) => appendEvent(ev, false));
    if (t.busy || t.status === "rodando") showThinking();
    window.scrollTo(0, document.body.scrollHeight);
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
function irParaMemoria(chave) { GE.sel = chave; navigateBoard("memoria"); }
function eventHtml(ev) {
  const at = `<div class="at">${fmtAt(ev.at)}</div>`;
  switch (ev.t) {
    case "dono": return `<div class="ev dono">${at}${esc(ev.texto)}${fotosHtml(ev.anexos)}</div>`;
    case "texto": return `<div class="ev texto">${at}${ev.quem === "revisor" ? `<span class="tag-pr" style="margin-right:6px">REVISOR</span>` : ev.quem === "qa" ? `<span class="tag-pr" style="margin-right:6px;color:var(--c-qa);border-color:var(--c-qa)">QA</span>` : ""}<div class="md">${mdToHtml(ev.texto)}</div></div>`;
    case "ferramenta": return `<div class="ev ferramenta ${ev.quem === "revisor" ? "rev" : ""}" title="${esc(ev.alvo)}">${ev.quem === "revisor" ? "🔍" : ev.quem === "qa" ? "🧪" : "▸"} <b>${esc(ev.nome)}</b> ${esc(ev.alvo)}</div>`;
    case "resultado": {
      const k = `<div class="k"><span>resultado</span>${ev.custo ? `<span>${fmtCost(ev.custo)}</span>` : ""}${ev.turnos ? `<span>${ev.turnos} turno(s)</span>` : ""}${ev.dur ? `<span>${fmtDur(ev.dur)}</span>` : ""}</div>`;
      // O resultado repete a última fala do agente: então só o rodapé com custo/tempo.
      if (ev.dup) return `<div class="ev resultado slim">${k}</div>`;
      return `<div class="ev resultado">${k}<div class="md">${mdToHtml(ev.texto || "(sem texto)")}</div></div>`;
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
      return `<div class="ev revisor ${ok ? "ok" : "nao"}"><div class="k"><span>${ev.t === "qa" ? "🧪 QA" : "🔍 revisor"}: ${esc(ev.veredito)}</span>${ev.custo ? `<span>${fmtCost(ev.custo)}</span>` : ""}</div><div class="txt">${esc(ev.texto || "")}</div></div>`;
    }
    case "romaneio": {
      const itens = ev.itens || [];
      return `<details class="ev romaneio"><summary>📦 romaneio · ${itens.length} memórias · ~${Number(ev.tokens || 0).toLocaleString("pt-BR")} tokens · mentes: ${(ev.mentes || []).map((m) => ICONE_MENTE[m] || "").join(" ")} ${esc((ev.mentes || []).join(", "))}${ev.modo === "palavra+sentido" ? " · por palavra e sentido" : ev.modo === "palavra" ? " · só por palavra" : ""}</summary>`
        + (ev.semSentido ? `<div class="rom-aviso">sem o sentido nesta tarefa: ${esc(ev.semSentido)}</div>` : "")
        + `<div class="rom-lista">${itens.map((i) => `<button onclick="irParaMemoria(${esc(JSON.stringify(i.chave))})" title="abrir na Memória${i.sentido != null ? ` · parecença de sentido ${Math.round(i.sentido * 100)}%` : ""}">${ICONE_MENTE[i.mente] || ""} ${esc(i.titulo)}${i.nota ? `<small>${i.nota}</small>` : ""}${i.sentido != null && !i.nota ? `<small>sentido ${Math.round(i.sentido * 100)}%</small>` : ""}</button>`).join("")}</div></details>`;
    }
    case "inicio": return `<div class="ev mark">▶ ${fmtDay(ev.at)} · começou em ${esc(ev.projeto)}</div>`;
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
  // Só acompanha quem já está no fim: puxar a tela de quem subiu para ler é pior que não rolar.
  const noFim = window.innerHeight + window.scrollY >= document.body.scrollHeight - 160;
  if (scroll && noFim) window.scrollTo({ top: document.body.scrollHeight });
}
function showThinking() {
  const tl = $("#timeline"); if (!tl || tl.querySelector(".thinking")) return;
  const ocupado = view.name === "conversa"
    ? !!((S.conversas || {})[view.slug] || {}).busy
    : (() => { const t = S.tasks.find((x) => x.id === view.id); return !!(t && (t.busy || t.status === "rodando")); })();
  if (ocupado) tl.insertAdjacentHTML("beforeend", `<div class="thinking">trabalhando</div>`);
}
// Publicar só existe onde o dono declarou o comando (data/deploy.json) — sem isso, nem aparece.
const podePublicar = (t) => !!(S.deploys || {})[t.project];

async function abrirTmux() {
  try { await api("/agentes/tmux", { method: "POST" }); toast("Abrindo o Terminal na sessão tmux board-agentes: uma aba por agente.", 4000, "info"); } catch (e) { toast(e.message); }
}
async function filaPausar(pausar) {
  try { await api(pausar ? "/fila/pausar" : "/fila/retomar", { method: "POST" }); toast(pausar ? "Fila pausada: o que está rodando termina, nada novo começa." : "Fila retomada.", 4000); } catch (e) { toast(e.message); }
}
async function reiniciar() {
  try { const r = await api("/reiniciar", { method: "POST" }); toast(r.aviso, 5000); } catch (e) { toast(e.message); }
}
function semDeploy(proj) {
  // O arquivo é lido a cada pedido: basta salvar e recarregar a página, sem reiniciar o board.
  toast(`Publicação desligada para ${proj}. Para ligar, escreva o comando em board/data/deploy.json, ex.: {"${proj}": "./deploy.sh"} e recarregue a página.`, 9000);
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
  if (!confirm(`Isto vai MESCLAR o PR e PUBLICAR o projeto ${t.project}:\n\n$ ${cmd}\n\nSó acontece se o portão passar e o revisor aprovar. Confirma?`)) return;
  try { await api(`/tasks/${id}/publicar`, { method: "POST" }); } catch (e) { toast(e.message); }
}

function bindEntrega(id) {
  const sel = $("#entregaTask"); if (!sel) return;
  sel.onchange = async (e) => { try { await api(`/tasks/${id}`, { method: "PATCH", body: { entrega: e.target.value } }); } catch (err) { toast(err.message); } };
}
async function sendChat(id) {
  const ta = $("#chatIn"); const text = ta.value.trim(); if (!text && !idsAnexos("chat").length) return;
  try {
    await api(`/tasks/${id}/chat`, { method: "POST", body: { text, anexos: idsAnexos("chat") } });
    ta.value = ""; ta.style.height = "auto"; pendentes.chat = []; pintarAnexos("chat");
  } catch (e) { toast(e.message); }
}

