// A conversa por projeto (um fio por projeto).
// ── Conversa por projeto ─────────────────────────────────────────────────────
// O dono tinha que abrir uma aba de terminal por projeto e repetir o contexto em cada uma.
// Aqui é um fio por projeto, na pasta dele, que continua de onde parou. Não cria tarefa.
function conversaHead(slug, c) {
  const motor = c.motor || (S.config || {}).motor || "claude";
  const escolha = c.modelo ? "modelo:" + c.modelo : "";
  return `<div class="chead dhead">
    <div class="dh1">
      <b class="central-nome">Conversa</b>
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
      ${c.busy ? `<button class="btn" title="Corta a resposta atual; o que estiver na vez segue logo depois" onclick="pararConversa('${esc(slug)}')">⏹ parar</button>`
    : `<button class="btn" title="Começa um fio novo: o agente esquece esta conversa" onclick="limparConversa('${esc(slug)}')">🧹 novo fio</button>`}
      ${naVezHtml(c)}
      ${c.custo ? `<span class="selo" title="custo desta conversa">${fmtCost(c.custo)}</span>` : ""}
    </div>
    <div class="hint">roda na pasta de ${esc(nomeProj(slug))} · lê código, pesquisa e consulta a memória · só muda arquivo se você pedir · peça "vira tarefa" para ir pra fila</div>
  </div>`;
}

/** O inspetor da Conversa (Cockpit): as conversas de cada projeto (com quem está respondendo agora) e as tarefas deste projeto. */
function pintarLadoConversa(slug) {
  const el = $("#convLado"); if (!el) return;
  const conv = S.conversas || {};
  const projs = (S.projects || []).filter((p) => p.slug !== "DEV");
  const minhas = (S.tasks || []).filter((t) => t.project === slug && t.status !== "concluida")
    .sort((a, b) => (ORDER[a.status] - ORDER[b.status]) || (a.order - b.order)).slice(0, 12);
  el.innerHTML = `<section><h3>Conversas <span>${projs.length}</span></h3>${projs.map((p) => `<a class="cl-item ${p.slug === slug ? "on" : ""}" href="#/c/${esc(p.slug)}"><span class="cl-bola ${(conv[p.slug] || {}).busy ? "run" : ""}"></span>${esc(p.label)}<span class="cl-m">${(conv[p.slug] || {}).busy ? "respondendo" : p.slug === slug ? "aberta" : ""}</span></a>`).join("")}</section>
    <section><h3>Tarefas de ${esc(nomeProj(slug))} <span>${minhas.length}</span></h3>${minhas.length ? minhas.map((t) => `<a class="cl-item" href="#/t/${t.id}"><span class="cl-bola ${trabalhando(t) ? "run" : t.status === "erro" ? "err" : ""}"></span>#${t.id} ${esc(cutTxt(t.title || "", 50))}<span class="cl-m">${esc(estado(t).label)}</span></a>`).join("") : `<div class="cl-vazio">nenhuma em aberto</div>`}</section>
    <section><h3>Atalhos</h3><a class="cl-item" href="#/busca">⌕ Buscar no projeto</a><a class="cl-item" href="#/sessoes">⌨ Sessões do terminal</a></section>`;
}
const naVezHtml = (c) => c.naVez ? `<span class="selo conv-navez" title="Mensagens que você mandou com a resposta no meio: seguem juntas, na ordem, assim que ela terminar">✎ ${c.naVez} na vez</span>` : "";

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
  const central = !!view.central;
  const voltar = `<button class="back" onclick="location.hash=''">← voltar</button>`;
  if (!central && !(S.projects || []).some((p) => p.slug === slug)) {
    // Projeto que saiu da seleção (ou link velho): diz isso e oferece os fios que existem — sem beco sem saída.
    delete app.dataset.conversa;
    app.innerHTML = headerHtml(voltar) + `<div class="empty">"${esc(nomeProj(slug))}" não está na seleção de projetos. Abrir a conversa de:
      <div class="conv-outros">${(S.projects || []).map((p) => `<a class="btn" href="#/c/${encodeURIComponent(p.slug)}">${esc(p.label)}</a>`).join(" ")}</div></div>`;
    return;
  }
  const c = (S.conversas || {})[slug] || {};
  const busy = !!c.busy;
  // Central: o dono pode escrever enquanto ela lê o que outra sessão mandou (o servidor põe a mensagem dele na vez).
  const pensando = busy || (central && !!c.ouvindo);
  const dica = central ? "Peça qualquer coisa — ela responde, cria a tarefa ou leva à sessão certa… (Enter envia)" : `Conversar sobre ${nomeProj(slug)}… (Enter envia)`;
  // A caixa nunca trava (26/10, "eu penso rápido"): com resposta no meio, o que ele manda espera a vez no servidor.
  const ocupado = "respondendo… pode continuar escrevendo: entra na vez (Enter envia)";
  const cabeca = () => central ? centralHead(c) : conversaHead(slug, c);
  // Já estou nesta conversa: só atualizo cabeçalho e caixa — sem apagar o que o dono digita.
  if (app.dataset.conversa === slug && $("#timeline")) {
    renderHeader();
    $(".chead").outerHTML = cabeca();
    if (!central) bindConversaHead(slug);
    $("#convIn").placeholder = busy ? ocupado : dica;
    if (pensando) showThinking(); else { const th = $("#timeline .thinking"); if (th) th.remove(); }
    if (central) { pintarLadoCentral(); pintarVoz(); } else pintarLadoConversa(slug);
    pintarPermissoes();
    return;
  }
  app.dataset.conversa = slug; delete app.dataset.task; delete app.dataset.busca;
  app.className = "wrap detail" + (central ? " central" : " conversa com-inspetor");
  app.innerHTML = `
    <div class="dtop">
      ${headerHtml(voltar)}
      ${workspaceIntro(central ? 'central' : 'conversa')}
      ${cabeca()}
    </div>
    ${central ? `<aside class="central-lado" id="centralLado" aria-label="Sessões, tarefas e PRs"></aside>` : `<aside class="inspetor" id="convLado" aria-label="Conversas e tarefas do projeto"></aside>`}
    <div class="timeline" id="timeline"><div class="empty">carregando…</div></div>
    <div class="chatbox">
      <div style="flex:1;display:flex;flex-direction:column;gap:8px">
        <div class="responder-a" id="responderA" hidden></div>
        <div class="anexos" id="anexosConversa" hidden></div>
        <textarea id="convIn" class="cresce" rows="1" placeholder="${esc(busy ? ocupado : dica)}"></textarea>
      </div>
      ${micHtml("convIn")}
      <button class="ib clipe" id="clipeConv" title="Anexar imagem (ou cole com Ctrl+V, ou arraste aqui)">📎</button>
      <input type="file" id="arqConv" accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,.pdf" multiple hidden>
      <button class="btn primary" id="convBtn">Enviar</button>
    </div>
  `;
  const ta = $("#convIn");
  ligarRascunho(ta, "conversa." + slug);
  ligarAltura(ta);
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviarConversa(slug); } });
  $("#convBtn").onclick = () => enviarConversa(slug);
  $("#clipeConv").onclick = () => $("#arqConv").click();
  ligarMic(app);
  $("#arqConv").onchange = (e) => { subirImagens("conversa", e.target.files); e.target.value = ""; };
  ligarImagens("conversa", ta, app.querySelector(".chatbox"));
  pintarAnexos("conversa");
  pintarRespondendo();
  ta.addEventListener("keydown", (e) => { if (e.key === "Escape" && respondendo) { respondendo = null; pintarRespondendo(); } });
  if (!central) bindConversaHead(slug);
  if (central) { pintarLadoCentral(); carregarLadoCentral(); vozAoDesenharCentral(); } else pintarLadoConversa(slug);
  pintarPermissoes();

  try {
    const d = await api(`/conversa/${slug}`);
    if (view.slug !== slug) return;
    logCache[view.id] = d.events; lastText = null;
    const tl = $("#timeline");
    tl.innerHTML = d.events.length ? "" : central
      ? `<div class="empty">Fale aqui o que precisa. A Central responde o que for simples, cria a tarefa no projeto certo ou leva o assunto à sessão do Claude que já está nele — e o que as sessões responderem aparece aqui.</div>`
      : `<div class="empty">Fio novo. Pergunte qualquer coisa sobre <b>${esc(nomeProj(slug))}</b> — ele lê o código e a memória do projeto antes de responder.</div>`;
    d.events.forEach((ev) => appendEvent(ev, false));
    if (d.busy || (central && (S.conversas?.central || {}).ouvindo)) showThinking();
    ta.focus();
    rolarProFim(true);
  } catch (e) { toast(e.message); }
}

// ── Responder a uma resposta (26/10, "como resposta de WhatsApp") ─────────────
// O número (R12) é do servidor; aqui só se escolhe qual citar. A citação aparece acima da caixa até enviar ou ✕.
let respondendo = null; // { slug, n, trecho }
const trechoDe = (texto, max) => cutTxt(String(texto || "").replace(/\s+/g, " ").trim(), max);
function citacaoHtml(cita) {
  if (!cita || !Number.isInteger(cita.n)) return "";
  return `<a class="citacao" href="#r-${cita.n}" onclick="event.preventDefault();irParaResposta(${cita.n})" title="Ir para R${cita.n}"><b>↩ R${cita.n}</b> ${esc(trechoDe(cita.trecho, 140))}</a>`;
}
function irParaResposta(n) {
  const el = document.getElementById("r-" + n); if (!el) return toast(`R${n} não está mais nesta conversa`);
  el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  el.classList.add("destaque"); setTimeout(() => el.classList.remove("destaque"), 1600);
}
function responderA(n) {
  const ev = (logCache[view.id] || []).find((e) => e.t === "resultado" && e.n === n);
  if (!ev || view.name !== "conversa") return;
  respondendo = { slug: view.slug, n, trecho: ev.texto };
  pintarRespondendo();
  const ta = $("#convIn"); if (ta) ta.focus();
}
function pintarRespondendo() {
  const el = $("#responderA"); if (!el) return;
  // 🧹 novo fio recomeça a contagem: a citação de um número que sumiu do fio cai sozinha.
  if (respondendo && respondendo.slug === view.slug && logCache[view.id] && !logCache[view.id].some((e) => e.t === "resultado" && e.n === respondendo.n)) respondendo = null;
  const r = respondendo && respondendo.slug === view.slug ? respondendo : null;
  el.hidden = !r;
  el.innerHTML = r ? `<span class="citacao"><b>↩ respondendo a R${r.n}</b> ${esc(trechoDe(r.trecho, 140))}</span>
    <button class="ib" type="button" title="Não responder a R${r.n}" onclick="respondendo=null;pintarRespondendo()">✕</button>` : "";
}

async function enviarConversa(slug, texto) {
  const ta = $("#convIn");
  const t = texto !== undefined ? texto : ta.value.trim();
  if (!t && !idsAnexos("conversa").length) return;
  rolarProFim(true); // quem acabou de perguntar quer ver a resposta chegando
  const modelo = (($("#convModelo") || {}).value || "").replace(/^modelo:/, "");
  // Limpa ANTES de esperar o servidor: quem pensa rápido já está escrevendo a próxima; se falhar, o texto volta.
  const anexos = idsAnexos("conversa"), guardados = pendentes.conversa;
  const cita = respondendo && respondendo.slug === slug ? respondendo : null;
  if (texto === undefined) { ta.value = ""; autoAltura(ta); rascunho.gravar("conversa." + slug, ""); }
  pendentes.conversa = []; pintarAnexos("conversa");
  respondendo = null; pintarRespondendo();
  try {
    await api(`/conversa/${slug}`, { method: "POST", body: { texto: t || "(imagem)", anexos,
      motor: ($("#convMotor") || {}).value, modelo, ...(cita ? { cita: cita.n } : {}) } });
    somEnvio.tocar();
  } catch (e) {
    toast(e.message);
    if (texto === undefined) {
      // Falhou: o texto volta para a caixa (se ela ainda estiver na tela) e para o rascunho.
      const caixa = view.slug === slug ? $("#convIn") : null;
      const depois = caixa ? caixa.value : rascunho.ler("conversa." + slug);
      const volta = t + (depois ? "\n" + depois : "");
      if (caixa) { caixa.value = volta; autoAltura(caixa); }
      rascunho.gravar("conversa." + slug, volta);
    }
    pendentes.conversa = guardados.concat(pendentes.conversa || []); pintarAnexos("conversa");
    if (cita && !respondendo) { respondendo = cita; pintarRespondendo(); }
  }
}
// Aprovar um pedido de SIM da Central (#213): é o dono escrevendo "SIM" citando a resposta — o servidor grava a aprovação.
async function aprovarPedido(n) {
  const ev = (logCache[view.id] || []).find((e) => e.t === "resultado" && e.n === n);
  if (!ev || !view.central) return;
  if (!confirm(`Aprovar?\n\n${ev.pedidoSim}\n\nA Central leva este SIM, com o número da aprovação, à sessão que vai fazer.`)) return;
  const antes = respondendo;
  respondendo = { slug: "central", n, trecho: ev.texto };
  await enviarConversa("central", "SIM");
  if (antes && antes.n !== n) { respondendo = antes; pintarRespondendo(); }
}
async function limparConversa(slug) {
  if (!confirm("Começar um fio novo? O agente esquece esta conversa e o histórico some da tela.")) return;
  try { await api(`/conversa/${slug}/limpar`, { method: "POST" }); } catch (e) { toast(e.message); }
}
async function pararConversa(slug) { try { await api(`/conversa/${slug}/parar`, { method: "POST" }); } catch (e) { toast(e.message); } }


// ── A Central (26/10): o fio onde o dono fala e o agente distribui para as sessões e para a fila ─────────────
function centralHead(c) {
  const voz = typeof VOZ !== "undefined" && VOZ.ligado();
  // Cockpit (#364): uma linha só, como na proposta: Central, o modo voz, ✉ lendo, e o 🧹/⏹ à direita. A explicação vai no title.
  return `<div class="chead dhead">
    <div class="dh1">
      <b class="central-nome" title="roda na pasta DEV · não edita arquivo de projeto · cria tarefa e leva assunto às sessões abertas · mensagem de outra sessão ela só te relata — quem decide é você · produção só com o seu sim">Central</b>
      <span class="chip ${voz ? "on" : ""}" id="chipVoz">${voz ? `● ouvindo — diga “${esc(VOZ.nome())}”` : "🎙 voz desligada"}</span>
      ${c.ouvindo ? `<span class="selo central-ouvindo" title="Outra sessão escreveu: a Central está lendo para te contar">✉ lendo mensagem de outra sessão</span>` : ""}
      ${naVezHtml(c)}
      ${c.custo ? `<span class="chip" title="custo desta conversa">${fmtCost(c.custo)}</span>` : ""}
      <span class="dh-dir">${c.busy || c.ouvindo ? `<button class="btn" onclick="pararConversa('central')">⏹ parar</button>`
    : `<button class="btn" title="Começa um fio novo: a Central esquece esta conversa" onclick="limparConversa('central')">🧹 novo fio</button>`}</span>
    </div>
    <div class="ctabs" role="tablist" aria-label="Central no celular"><button class="chip ${document.body.classList.contains("ver-inspetor") ? "" : "on"}" onclick="verInspetor(false)">Conversa</button><button class="chip ${document.body.classList.contains("ver-inspetor") ? "on" : ""}" onclick="verInspetor(true)">Inspetor${precisaDeVoce() ? ` · ${precisaDeVoce()} ⚠` : ""}</button>${(S.publicaveis || []).length ? `<button class="chip" onclick="verInspetor(true, '.cl-publicar')">🚀 Publicar</button>` : ""}</div>
    <div class="hint chint">roda na pasta DEV · não edita arquivo de projeto · cria tarefa e leva assunto às sessões abertas · mensagem de outra sessão ela só te relata — quem decide é você · produção só com o seu sim</div>
  </div>`;
}
/** Celular: o inspetor (sessões, rodando, PRs, 🚀) vira uma aba ao lado da conversa, como na proposta. */
function verInspetor(on, ir) {
  document.body.classList.toggle("ver-inspetor", on);
  document.querySelectorAll(".ctabs .chip").forEach((b, i) => b.classList.toggle("on", on ? i === 1 : i === 0));
  if (ir) $(ir)?.scrollIntoView({ block: "start" });
}
const precisaDeVoce = () => (PERM?.pendentes?.length || 0) + (S.tasks || []).filter((t) => (naoJuntada(t) && t.status !== "concluida") || prEsgotado(t) || faltaConferir(t)).length;

let LADO_CENTRAL = { sessoes: null, prs: null, erro: null };
async function carregarLadoCentral() {
  try { LADO_CENTRAL.sessoes = await api("/central/sessoes"); LADO_CENTRAL.erro = null; } catch (e) { LADO_CENTRAL.erro = e.message; }
  try { LADO_CENTRAL.prs = await api("/prs"); } catch { /* sem gh: a coluna diz que não leu */ }
  if ((S.publicaveis || []).length) garantirPublicar(); // o 🚀 de cada projeto, no mesmo estado do menu PRs
  pintarLadoCentral();
}
// A coluna se atualiza sozinha enquanto a Central está aberta (as sessões mudam de "ocupada" para "parada").
setInterval(() => { if (view.central && document.visibilityState === "visible") carregarLadoCentral(); }, 10000);

function pintarLadoCentral() {
  const el = $("#centralLado"); if (!el) return;
  const d = LADO_CENTRAL.sessoes;
  const estadoSessao = (s) => s.status === "busy" ? "ocupada" : s.status === "idle" ? "parada" : "";
  const sess = !d ? `<div class="pr-mudo cl-vazio">${LADO_CENTRAL.erro ? "não li as sessões: " + esc(LADO_CENTRAL.erro) : "lendo…"}</div>`
    : d.sessoes.length ? d.sessoes.map((s) => `<div class="cl-sessao ${estadoSessao(s)}" title="pasta ${esc(s.pasta)}">
        <span class="cl-bola"></span><b>${esc(s.nome)}</b>${s.central ? ` <span class="pr-mudo">(esta)</span>` : ""}
        <span class="cl-estado ${estadoSessao(s)}">${estadoSessao(s) || esc(s.status || "?")}</span>${s.ghostty && !s.central ? ghosttyBotao(s.ghostty, { pid: s.pid }, "btn cl-gh") : ""}</div>`).join("")
      : `<div class="pr-mudo cl-vazio">nenhuma sessão do Claude aberta</div>`;
  const rodando = (S.tasks || []).filter((t) => t.status === "rodando" || t.busy);
  const fila = (S.tasks || []).filter((t) => t.status === "fila").length;
  const tarefas = rodando.length ? rodando.map((t) => `<a class="cl-item" href="#/t/${t.id}"><span class="cl-bola run"></span>#${t.id} <span class="pr-mudo">${esc(nomeProj(t.project))}</span> ${esc(cutTxt(t.title || t.text || "", 60))}<span class="cl-m">${esc(estado(t).label)}</span></a>`).join("")
    : `<div class="pr-mudo cl-vazio">nada rodando</div>`;
  const prs = LADO_CENTRAL.prs ? LADO_CENTRAL.prs.projetos.flatMap((p) => p.abertos.map((pr) => ({ ...pr, label: p.label }))) : null;
  const presas = (S.tasks || []).filter((t) => naoJuntada(t) && t.status !== "concluida");
  const prPresos = (S.tasks || []).filter(prEsgotado);
  const aConferir = (S.tasks || []).filter(faltaConferir);
  el.innerHTML = `${permissoesLadoHtml()}${aConferir.length ? `<section class="cl-conferir"><h3>⏳ Falta conferir</h3>${aConferir.map((t) => `<a class="cl-item" href="#/t/${t.id}">#${t.id} <span class="pr-mudo">${esc(nomeProj(t.project))}</span> ${esc(cutTxt(t.title || "", 60))}</a>`).join("")}<div class="pr-mudo">consertada no chat; portão, revisor e QA na fila</div></section>` : ""}${prPresos.length ? `<section class="cl-naojuntada" role="alert"><h3>⚠ PR em conflito — precisa de você</h3>${prPresos.map((t) => `<a class="cl-item" href="#/t/${t.id}">#${t.id} <span class="pr-mudo">${esc(nomeProj(t.project))} · PR #${t.prVigia.numero}</span> ${esc(cutTxt(t.title || "", 60))}</a>`).join("")}<div class="pr-mudo">o board tentou atualizar e não conseguiu; o motivo está na tarefa</div></section>` : ""}${presas.length ? `<section class="cl-naojuntada" role="alert"><h3>⚠ Não juntadas — conflito</h3>${presas.map((t) => `<a class="cl-item" href="#/t/${t.id}">#${t.id} <span class="pr-mudo">${esc(nomeProj(t.project))}</span> ${esc(cutTxt(t.title || "", 60))}</a>`).join("")}<div class="pr-mudo">aprovadas, mas o trabalho está só na cópia</div></section>` : ""}
    <section><h3>Sessões abertas <span>${d ? d.sessoes.length : ""}</span></h3>${sess}</section>
    <section><h3>Rodando <span>${rodando.length}${fila ? ` · ${fila} na fila` : ""}</span></h3>${tarefas}</section>
    <section><h3>PRs abertos <span>${prs ? prs.length : ""}</span></h3>${prs === null ? `<div class="pr-mudo">lendo…</div>` : prs.length
      ? prs.slice(0, 8).map((pr) => `<a class="cl-item" href="#/prs">${esc(pr.label)} #${pr.numero} ${esc(cutTxt(pr.titulo, 50))}${vigiaDoPr(pr) ? ` <span class="${vigiaDoPr(pr).estado === "esgotado" ? "pr-alerta" : "pr-atualizando"}">${esc(vigiaTxt(vigiaDoPr(pr)))}</span>` : pr.conflito ? ` <span class="pr-alerta">conflito</span>` : ""}</a>`).join("") + (prs.length > 8 ? `<a class="cl-item pr-mudo" href="#/prs">+ ${prs.length - 8}</a>` : "")
      : `<div class="pr-mudo cl-vazio">nenhum</div>`}</section>
    ${(S.publicaveis || []).length ? `<section class="cl-publicar"><h3>🚀 Publicar</h3>${S.publicaveis.map((slug) => `<div class="cl-pub"><b>${esc(nomeProj(slug))}</b>
      <span class="pub-acao" data-pubacao="${esc(slug)}" data-sm="1">${PUB.dados ? acaoPublicarHtml(slug, { sm: true }) : `<span class="pr-mudo">lendo…</span>`}</span></div>`).join("")}</section>` : ""}`;
}

// Clicar no NÚMERO da resposta (o selo R9) faz o mesmo que o ↩ responder da #200: cita R9 acima da caixa
// e põe o cursor nela (#202). Escuta delegada: o selo é redesenhado a cada evento da conversa.
document.addEventListener("click", (e) => {
  const selo = e.target.closest && e.target.closest(".ev.resultado .rnum");
  if (!selo || typeof responderA !== "function") return;
  const n = Number((selo.closest(".ev.resultado").id || "").replace(/^r-/, "")) || Number(selo.textContent.replace(/^R/, ""));
  if (Number.isInteger(n) && n > 0) responderA(n);
});
