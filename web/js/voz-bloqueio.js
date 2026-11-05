// 🎙 Modo voz (#303): a tela do aparelho bloqueou? Com o modo ligado o microfone segue com a aba escondida ou o navegador atrás de
// outra janela, e fecha com a tela bloqueada. `visibilityState` não separa os dois: no Mac, aba trocada, janela coberta e tela
// bloqueada dão o mesmo "hidden". Quem sabe é o IdleDetector (`screenState`), que precisa de uma permissão e só existe no Chrome.
// Sem ele, ninguém garante que a tela não bloqueou: fora de vista o microfone fecha, como na #296, e a tela diz por quê.
const BLOQUEIO = { controle: null, abrindo: false, pedido: false, permissao: null };

function vozPararVigia() {
  BLOQUEIO.controle?.abort();
  BLOQUEIO.controle = null;
  Object.assign(VOZ, { sabeBloqueio: false, bloqueada: false });
}
/** O vigia acompanha o modo ligado nesta aba. Com a permissão já dada, liga sem pedir nada (recarregar, comando falado). */
async function vozVigiarBloqueio() {
  if (!VOZ.ligado() || !VOZ.dona()) return vozPararVigia();
  if (BLOQUEIO.controle || BLOQUEIO.abrindo || !window.IdleDetector) return;
  BLOQUEIO.abrindo = true;
  const controle = new AbortController();
  try {
    BLOQUEIO.permissao ||= await navigator.permissions.query({ name: "idle-detection" });
    BLOQUEIO.permissao.onchange = () => { if (BLOQUEIO.permissao.state !== "granted") vozPararVigia(); vozAplicar(); };
    if (BLOQUEIO.permissao.state !== "granted") return;
    const d = new IdleDetector();
    d.addEventListener("change", () => { if (BLOQUEIO.controle === controle) vozTelaDoAparelho(d.screenState); });
    await d.start({ threshold: 60000, signal: controle.signal }); // 60 s é o mínimo da API; o `screenState` não depende dele
    if (!VOZ.ligado() || !VOZ.dona()) return controle.abort();
    BLOQUEIO.controle = controle;
    Object.assign(VOZ, { sabeBloqueio: true, bloqueada: d.screenState === "locked" });
  } catch { return; } finally { BLOQUEIO.abrindo = false; } // sem o vigia, fora de vista fecha
  vozAplicar();
}
function vozTelaDoAparelho(estado) {
  const bloqueada = estado === "locked";
  if (bloqueada === VOZ.bloqueada) return;
  VOZ.bloqueada = bloqueada;
  vozAplicar();
}
/** O navegador só pergunta depois de um gesto: é chamado no clique de ligar ou, se ligou falando, no próximo clique dele. */
async function vozPedirBloqueio() {
  if (!window.IdleDetector) return;
  BLOQUEIO.pedido = true;
  try { if (await IdleDetector.requestPermission() === "granted") await vozVigiarBloqueio(); } catch { /* sem gesto: o próximo clique pede */ }
  pintarVoz();
}
document.addEventListener("click", () => { if (VOZ.ligado() && !VOZ.sabeBloqueio && !BLOQUEIO.pedido) vozPedirBloqueio(); }, { capture: true, passive: true });
