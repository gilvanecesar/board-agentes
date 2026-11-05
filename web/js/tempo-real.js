// O canal ao vivo com o servidor (SSE): estado, log das tarefas, texto chegando aos pedaços.
// ── SSE ──────────────────────────────────────────────────────────────────────
function connect() {
  const es = new EventSource("/api/events?tela=" + TELA.id);
  es.addEventListener("hello", () => { connected = true; loadState(); carregarPermissoes(); telaAoConectar(); });
  // `board tela <destino>` (#293): só a aba em uso recebe; `tela-atual` diz a todas qual é ela.
  es.addEventListener("tela-destino", (e) => aoPedidoDeTela(JSON.parse(e.data)));
  es.addEventListener("tela-atual", (e) => { TELA.sou = JSON.parse(e.data).tela === TELA.id; });
  // Pedido de permissão de uma sessão (#232): cartão, sininho e aviso.
  es.addEventListener("permissao", (e) => aoEventoPermissao(JSON.parse(e.data)));
  es.addEventListener("state", () => agendarState());
  es.addEventListener("voz-impressao", () => { if (VOZ.servidor) vozRecarregarEstado(); }); // cadastrou ou apagou em outro aparelho
  es.addEventListener("uso", () => carregarUso());
  es.addEventListener("prs", () => { if (view.name === "prs") carregarPrs(true); });
  // Começou ou terminou uma publicação (nesta aba ou em outra): o 🚀 muda em toda tela que já mostra o botão.
  es.addEventListener("publicar", () => { if (view.name === "prs" || PUB.dados) carregarPublicar(); });
  es.addEventListener("conversa-limpa", (e) => {
    const { slug } = JSON.parse(e.data);
    logCache["conversa-" + slug] = [];
    if (view.name === "conversa" && view.slug === slug) { delete $("#app").dataset.conversa; renderConversa(); }
  });
  // Texto da conversa chegando aos pedaços (processo vivo): um balão que o bloco final substitui.
  es.addEventListener("parcial", (e) => {
    const { id, texto } = JSON.parse(e.data);
    if (!((view.name === "conversa" || view.name === "detail") && view.id === id)) return;
    const tl = $("#timeline"); if (!tl) return;
    let b = tl.querySelector(".ao-vivo");
    if (!b) {
      const vazio = tl.querySelector(".empty"); if (vazio) vazio.remove();
      b = document.createElement("div"); b.className = "ev texto ao-vivo";
      tl.insertBefore(b, tl.querySelector(".thinking"));
    }
    b.innerHTML = `<div class="md">${mdToHtml(texto)}</div>`;
    rolarProFim();
  });
  es.addEventListener("log", (e) => {
    const { id, ev } = JSON.parse(e.data);
    if (String(id).startsWith("publicar-")) return aoLogDePublicar(String(id).slice(9), ev);
    if (id === "navegador") return; // a tela do Navegador saiu em 04/11; o registro segue em data/logs/navegador.jsonl
    const anteriores = (logCache[id] ||= []);
    if (deveTocarRecebida(id, ev, anteriores)) somEnvio.receber();
    anteriores.push(ev);
    if (ev.t === "texto" || ev.t === "ferramenta") { lastLine[id] = ev; if (view.name === "list") renderLastLine(id); }
    if ((view.name === "detail" || view.name === "conversa") && view.id === id) appendEvent(ev);
    if (id === "conversa-central") aoRespostaDaCentral(ev); // 🎙 modo voz: a resposta terminou, o board fala
  });
  es.onerror = () => { connected = false; TELA.sou = false; renderHeader(); };
}

