// O canal ao vivo com o servidor (SSE): estado, log das tarefas, texto chegando aos pedaços.
// ── SSE ──────────────────────────────────────────────────────────────────────
function connect() {
  const es = new EventSource("/api/events");
  es.addEventListener("hello", () => { connected = true; loadState(); });
  es.addEventListener("state", () => agendarState());
  es.addEventListener("uso", () => carregarUso());
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
    const noFim = window.innerHeight + window.scrollY >= document.body.scrollHeight - 160;
    let b = tl.querySelector(".ao-vivo");
    if (!b) {
      const vazio = tl.querySelector(".empty"); if (vazio) vazio.remove();
      b = document.createElement("div"); b.className = "ev texto ao-vivo";
      tl.insertBefore(b, tl.querySelector(".thinking"));
    }
    b.innerHTML = `<div class="md">${mdToHtml(texto)}</div>`;
    if (noFim) window.scrollTo({ top: document.body.scrollHeight });
  });
  es.addEventListener("log", (e) => {
    const { id, ev } = JSON.parse(e.data);
    (logCache[id] ||= []).push(ev);
    if (ev.t === "texto" || ev.t === "ferramenta") { lastLine[id] = ev; if (view.name === "list") renderLastLine(id); }
    if ((view.name === "detail" || view.name === "conversa") && view.id === id) appendEvent(ev);
  });
  es.onerror = () => { connected = false; renderHeader(); };
}

