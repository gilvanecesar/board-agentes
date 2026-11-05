// 🖥 ver no tmux → Ghostty (#352): a sessão do tmux numa janela do Ghostty do Mac. O modo vem do servidor (`ghostty` em cada
// sessão viva): "abrir" (este board é o do Mac: ele abre), "mac" (este board é o do Atena: abre o board do Mac em
// #/ghostty/<sessão>, onde o dono clica e o Mac abre o ssh) ou "copiar" (copia o comando pronto). Nenhuma tecla vai
// para a sessão: o Ghostty só se anexa. Sair sem fechar: Ctrl+B, depois D.
const GH_DICA = "Para sair do Ghostty sem fechar a sessão: Ctrl+B, depois D.";
let GH = { dados: null, erro: null, abrindo: null, modo: null };
// O modo vale para o 🖥 da faixa de agentes, que precisa abrir a aba ainda no gesto do clique (sem ssh: só o modo).
api("/ghostty?so-modo").then((d) => { GH.modo = d.modo; }).catch(() => {});

/** O botão de uma sessão viva no tmux. `g` = o `ghostty` que o servidor mandou; `ref` = {pid} ou {servidor}. */
function ghosttyBotao(g, ref = {}, classe = "btn") {
  if (!g) return "";
  const titulo = g.modo === "copiar" ? `Copia o comando para colar no Ghostty: ${g.comando}` : g.modo === "mac" ? `Abre o board do Mac para ele abrir o Ghostty em: ${g.comando}` : `Abre o Ghostty em: ${g.comando}`;
  return `<button class="${classe}" data-ghostty data-gh-modo="${esc(g.modo)}" data-gh-cmd="${esc(g.comando)}" ${g.url ? `data-gh-url="${esc(g.url)}"` : ""} ${g.aviso ? `data-gh-aviso="${esc(g.aviso)}"` : ""}
    ${ref.pid ? `data-gh-pid="${esc(ref.pid)}"` : ""} ${ref.servidor ? `data-gh-servidor="${esc(ref.servidor)}"` : ""} title="${esc(titulo + " · " + GH_DICA)}">${/cl-gh/.test(classe) ? "🖥 tmux" : ref.servidor ? "🖥 Abrir no Ghostty" : "🖥 ver no tmux"}</button>`;
}

async function copiarComando(cmd) {
  try { await navigator.clipboard.writeText(cmd); return true; } catch { return false; }
}

async function cliqueGhostty(b) {
  const modo = b.dataset.ghModo, cmd = b.dataset.ghCmd;
  if (modo === "mac") {
    // Ainda no gesto do clique: a aba nova não é barrada pelo bloqueador de pop-up.
    window.open(b.dataset.ghUrl, "_blank", "noopener"); // com noopener o retorno é sempre null: não dá para saber se abriu
    const copiou = await copiarComando(cmd);
    toast(`Abri o board do Mac numa aba: clique em "🖥 Abrir no Ghostty" lá.${copiou ? " O comando também foi copiado." : ""} ${GH_DICA}`, 9000);
    return;
  }
  if (modo === "copiar") {
    const aviso = b.dataset.ghAviso ? `Não abri pelo Mac: ${b.dataset.ghAviso}. ` : "";
    toast(aviso + ((await copiarComando(cmd)) ? `Comando copiado: cole no Ghostty. ${GH_DICA}` : `Não consegui copiar. O comando: ${cmd}`), 12000, aviso ? "erro" : "");
    return;
  }
  if (GH.abrindo) return;
  GH.abrindo = cmd; b.disabled = true;
  try {
    const corpo = b.dataset.ghServidor ? { servidor: b.dataset.ghServidor } : { pid: Number(b.dataset.ghPid) };
    const r = await api("/ghostty/abrir", { method: "POST", body: corpo });
    toast(`Abri ${r.nome || r.sessao} no Ghostty. ${GH_DICA}`, 7000);
  } catch (e) { toast(e.message, 8000, "erro"); }
  finally { GH.abrindo = null; b.disabled = false; }
}
document.addEventListener("click", (e) => { const b = e.target.closest("[data-ghostty]"); if (b) { e.preventDefault(); cliqueGhostty(b); } });

// #/ghostty/<sessão>: no board do Mac, as sessões do tmux do servidor, cada uma com o botão. A do endereço vem primeiro.
async function carregarGhostty() {
  try { GH.dados = await api("/ghostty"); GH.erro = null; } catch (e) { GH.erro = e.message; }
  pintarGhostty();
}
function ghosttyHtml() {
  const pedida = decodeURIComponent((location.hash.match(/^#\/ghostty\/([^/?]+)/) || [])[1] || "");
  if (GH.erro && !GH.dados) return `<div class="empty">Não consegui ler: ${esc(GH.erro)}</div>`;
  const d = GH.dados; if (!d) return `<div class="empty">lendo…</div>`;
  if (d.modo !== "abrir") return `<div class="empty">Este board não abre o Ghostty${d.ghostty ? "" : " (não achei o Ghostty.app nesta máquina)"}. Abra esta página no board do Mac.</div>`;
  if (!d.servidor) return `<div class="empty">Este board roda no próprio servidor: use o menu Sessões.</div>`;
  const l = [...(d.sessoes || [])].sort((a, b) => (b.nome === pedida) - (a.nome === pedida));
  const linhas = l.map((s) => `<div class="gh-linha ${s.nome === pedida ? "on" : ""}"><b>${esc(s.nome)}</b>
      <span class="pr-mudo">${s.janelas} janela${s.janelas === 1 ? "" : "s"}${s.presos ? ` · ${s.presos} terminal já anexado` : ""}</span>
      <code class="gh-cmd">${esc(s.comando)}</code>${ghosttyBotao({ modo: "abrir", comando: s.comando }, { servidor: s.nome }, s.nome === pedida ? "btn primary" : "btn")}</div>`).join("");
  return `${pedida && !l.some((s) => s.nome === pedida) ? `<p class="ses-erro">Não há sessão "${esc(pedida)}" no tmux de ${esc(d.servidor)} agora.</p>` : ""}
    ${d.erro ? `<p class="ses-erro">${esc(d.erro)}</p>` : ""}
    <div class="gh-lista">${linhas || `<div class="empty">Nenhuma sessão no tmux de ${esc(d.servidor)}.</div>`}</div>
    <p class="pr-mudo ses-dica">Abre uma janela nova do Ghostty com <code>ssh -t ${esc(d.servidor)} tmux attach</code>. ${GH_DICA} A sessão continua viva no ${esc(d.servidor)}.</p>`;
}
function pintarGhostty() { const el = $("#ghLista"); if (el) el.innerHTML = ghosttyHtml(); }
function renderGhostty() {
  const app = $("#app");
  if (app.dataset.ghostty === location.hash && $("#ghLista")) { renderHeader(); return; }
  for (const k of Object.keys(app.dataset)) delete app.dataset[k];
  app.dataset.ghostty = location.hash;
  app.className = "wrap";
  app.innerHTML = headerHtml(`<button class="back" onclick="location.hash='#/sessoes'">← voltar</button>`) + workspaceIntro("ghostty") + `<div id="ghLista"></div>`;
  pintarGhostty();
  carregarGhostty();
}
