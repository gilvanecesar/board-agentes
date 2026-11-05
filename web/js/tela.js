// `board tela <destino>` (#293): a Central muda ESTA tela, se ela for a que o dono está usando. Só navegação; link abre aba nova (#302).
// 🔴 Este arquivo não clica em nada e só fala com /api/tela/*: Aprovar, Mesclar, Publicar, permissões e teclas de sessão ficam
// com o dono. O servidor manda um destino da lista fechada; aqui ele é conferido de novo, e nunca vira endereço cru.
const TELA_ABAS = ["central", "board", "conversa", "sessoes", "busca", "prs", "controle"];
const TELA_DIGITANDO_MS = 8000, TELA_LEMBRETE_MS = 60000;
const TELA = {
  id: Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 16), // um por carga de página, logo um por aba
  usadaEm: document.hasFocus() ? Date.now() : 0, avisadoEm: 0, sou: false, digitouEm: 0, guardado: null,
};

// ── Quem está usando: toda interação marca; quem já é a tela atual só relembra de vez em quando ──
function telaAvisar() {
  if (!connected || !TELA.usadaEm || (TELA.sou && Date.now() - TELA.avisadoEm < TELA_LEMBRETE_MS)) return;
  TELA.avisadoEm = Date.now();
  fetch("/api/tela/ativa", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tela: TELA.id, haMs: Date.now() - TELA.usadaEm }) }).catch(() => {});
}
function telaUsada() { TELA.usadaEm = Date.now(); telaAvisar(); }
function telaAoConectar() { TELA.sou = false; telaAvisar(); } // canal novo (o board reiniciou): o servidor esqueceu, e fica sabendo há quanto tempo foi
["pointerdown", "keydown", "wheel"].forEach((ev) => document.addEventListener(ev, telaUsada, { capture: true, passive: true }));
window.addEventListener("focus", telaUsada);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") telaUsada(); });

const ehCampo = (el) => !!el && (el.id === "sesTerm" || el.isContentEditable || el.matches?.("textarea, input:not([type=checkbox], [type=radio], [type=range], [type=file], [type=button], [type=submit])"));
["keydown", "input"].forEach((ev) => document.addEventListener(ev, (e) => { if (ehCampo(e.target)) TELA.digitouEm = Date.now(); }, { capture: true, passive: true }));

/**
 * Mudar agora perderia o que ele escreve? As caixas de escrever guardam rascunho a cada tecla: paradas, podem sair. O que NÃO
 * pode sair: alguém digitando agora (a próxima tecla iria para lugar nenhum), o ditado no meio e os dois campos sem rascunho —
 * o da sessão não pode ter (pode ser senha) e o da busca só guarda ao buscar.
 */
function telaOcupada() {
  if (ditado !== "parado" || $("#sesTexto")?.value) return true;
  const busca = $("#buscaIn");
  if (busca && busca.value.trim() !== BUSCA.q.trim()) return true;
  return telaDigitando();
}
function telaDigitando() {
  const a = document.activeElement;
  return ehCampo(a) && (a.id === "sesTerm" || !!a.value || !!a.textContent) && Date.now() - TELA.digitouEm < TELA_DIGITANDO_MS;
}

// O host, e não o href: Node e Chrome escrevem `|` e `^` do caminho de jeitos diferentes (QA da #302), e o que importa é abrir o site que o servidor conferiu.
const linkValido = (d) => { try { const x = new URL(d.url); return /^https?:$/.test(x.protocol) && !x.username && !x.password && x.host === d.host; } catch { return false; } };
function destinoValido(d) {
  if (d.tipo === "link") return linkValido(d);
  if (d.tipo === "aba") return TELA_ABAS.includes(d.aba);
  if (d.tipo === "tarefa" || d.tipo === "sessao") return Number.isSafeInteger(d.tipo === "tarefa" ? d.id : d.pid);
  return d.tipo === "conversa" && /^[\w.-]+$/.test(d.slug || "");
}

async function telaResponde(pedido, resultado) {
  try { return (await fetch("/api/tela/resposta", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tela: TELA.id, pedido, resultado }) })).ok; }
  catch { return false; } // sem resposta, não muda
}

/** Responde ANTES de mudar: pedido que chega atrasado (tela presa num confirm, celular dormindo) o servidor recusa, e nada muda. */
async function aoPedidoDeTela(d) {
  if (d.tipo === "link") return aoPedidoDeLink(d);
  const resultado = !destinoValido(d) ? "recusou" : telaOcupada() ? "segurou" : "mudou";
  if (!await telaResponde(d.pedido, resultado)) return;
  if (resultado === "mudou") irParaDestino(d);
  else if (resultado === "segurou") guardarPedido(d);
}

// ── #302: link em aba nova. Aba nova não tira nada da tela, então só segura com ele escrevendo (o foco iria embora). ──
async function aoPedidoDeLink(d) {
  const resultado = !destinoValido(d) ? "recusou" : ditado !== "parado" || telaDigitando() ? "segurou" : "abrindo";
  if (!await telaResponde(d.pedido, resultado)) return;
  if (resultado === "segurou") avisoDeLink(d, "Você estava digitando: nada abriu.");
  if (resultado !== "abrindo") return;
  const abriu = abrirAba(d.url);
  if (!abriu) avisoDeLink(d, "O navegador bloqueou a aba nova.", true);
  await telaResponde(d.pedido, abriu ? "abriu" : "bloqueou");
}
/** `noopener` faria o window.open devolver null sempre, e bloqueado ficaria igual a aberto: o site perde o `opener` aqui. */
function abrirAba(url) {
  let w = null;
  try {
    w = window.open("about:blank", "_blank");
    if (!w || w.closed) return false;
    w.opener = null;
    w.location.replace(url);
    return true;
  } catch { try { w?.close(); } catch { /* sem aba para fechar */ } return false; }
}
/** O link fica na tela, clicável: o clique é dele, e clique de verdade o bloqueador deixa passar. */
function avisoDeLink(d, motivo, bloqueado = false) {
  let caixa = $("#telaLink");
  if (!caixa) { caixa = document.createElement("div"); caixa.id = "telaLink"; caixa.className = "tela-guardada tela-link"; caixa.setAttribute("role", "status"); document.body.append(caixa); }
  const item = document.createElement("div");
  item.className = "tela-link-item";
  item.innerHTML = `<span>A Central pediu para abrir este link. ${esc(motivo)}</span><a target="_blank" rel="noopener noreferrer" onclick="tirarAvisoDeLink(this)"></a>
    ${bloqueado ? `<small>Para abrir direto da próxima vez, libere pop-ups para <b>${esc(location.host)}</b>. Chrome: ícone de pop-up bloqueado na barra de endereço → Sempre permitir. Safari: Ajustes → Sites → Janelas Pop-up → ${esc(location.host)} → Permitir.</small>` : ""}
    <button class="btn" type="button" onclick="tirarAvisoDeLink(this)">Agora não</button>`;
  const a = item.querySelector("a"); a.href = d.url; a.textContent = d.url; // pelo DOM: o endereço nunca passa por HTML
  caixa.append(item);
}
function tirarAvisoDeLink(el) { el.closest(".tela-link-item")?.remove(); if (!$("#telaLink .tela-link-item")) $("#telaLink")?.remove(); }

function irParaDestino(d) {
  esquecerPedido();
  document.activeElement?.blur?.(); // com o foco no terminal de uma sessão, a próxima tecla iria para a sessão nova
  if (d.tipo === "aba") navigateBoard(d.aba);
  else if (d.tipo === "tarefa") location.hash = "#/t/" + d.id;
  else if (d.tipo === "conversa") location.hash = "#/c/" + encodeURIComponent(d.slug);
  else { pararDeAssistirSessao(); location.hash = "#/sessoes/" + d.pid; }
}

// ── Ele estava digitando: a tela fica onde está e o pedido espera o clique DELE ──
function guardarPedido(d) {
  esquecerPedido();
  TELA.guardado = d;
  const el = document.createElement("div");
  el.id = "telaGuardada"; el.className = "tela-guardada"; el.setAttribute("role", "status");
  el.innerHTML = `<span>A Central pediu para abrir <b>${esc(d.rotulo)}</b>. Você estava digitando: nada mudou.</span>
    <button class="btn primary" type="button" onclick="abrirPedidoGuardado()">Abrir</button><button class="btn" type="button" onclick="esquecerPedido()">Agora não</button>`;
  document.body.append(el);
}
function abrirPedidoGuardado() { if (TELA.guardado) irParaDestino(TELA.guardado); }
function esquecerPedido() { TELA.guardado = null; $("#telaGuardada")?.remove(); }
