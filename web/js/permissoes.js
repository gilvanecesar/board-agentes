// Pedidos de permissão das sessões (#232, 28/10: "não dá pra trazer elas pra cá? senão vou ter que ficar com o terminal
// aberto também"). O cartão aparece acima da caixa de escrever: na conversa do projeto (os dela), na ficha da tarefa (os
// dela) e na Central (TODOS). Chegou um pedido: sininho + aviso, em qualquer tela. A resposta vai pela rota com o
// Origin da tela — agente nenhum se autoaprova.
const PERM = { pendentes: [], carregado: false };

async function carregarPermissoes() {
  try { const d = await api("/permissoes?n=1"); PERM.pendentes = d.pendentes || []; PERM.carregado = true; } catch { /* sem leitura: fica o que tinha */ }
  pintarPermissoes();
  if (PERM.pendentes.length) renderHeader();
}

function aoEventoPermissao(d) {
  if (d.novo) {
    if (!PERM.pendentes.some((c) => c.id === d.novo.id)) PERM.pendentes.push(d.novo);
    somEnvio.receber();
    toast(`🔐 ${rotuloOrigem(d.novo.de)} pede permissão: ${d.novo.ferramenta} ${cutTxt(d.novo.acao, 80)}`, 6000);
  }
  if (d.fechado) PERM.pendentes = PERM.pendentes.filter((c) => c.id !== d.fechado);
  pintarPermissoes();
  renderHeader();
  if (view.central) pintarLadoCentral();
}

const rotuloProjeto = (slug) => slug === "central" ? "Central" : nomeProj(slug);
const rotuloOrigem = (de = {}) => de.tarefa ? `tarefa #${de.tarefa} (${rotuloProjeto(de.slug)})` : `conversa ${rotuloProjeto(de.slug)}`;
const linkOrigem = (de = {}) => de.tarefa ? `#/t/${encodeURIComponent(de.tarefa)}` : de.slug === "central" ? "#/central" : `#/c/${encodeURIComponent(de.slug)}`;

/** Os pedidos que ESTA tela mostra. */
function permissoesDaTela() {
  if (view.central) return PERM.pendentes;
  if (view.name === "conversa") return PERM.pendentes.filter((c) => !c.de.tarefa && c.de.slug === view.slug);
  if (view.name === "detail") return PERM.pendentes.filter((c) => String(c.de.tarefa) === String(view.id));
  return [];
}

function cartaoPermissaoHtml(c) {
  const barrado = c.tipo === "barrado";
  const vence = c.expira ? ` · nega sozinho às ${new Date(c.expira).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}` : "";
  return `<div class="perm-cartao ${barrado ? "barrado" : ""}" data-perm="${esc(c.id)}" role="alert">
    <div class="perm-topo"><b>🔐 ${barrado ? "Barrado pelo classificador" : "Pede permissão"}</b>
      <a href="${linkOrigem(c.de)}">${esc(rotuloOrigem(c.de))}</a>
      <span class="pr-mudo">${esc(c.de.papel || "")} · ${fmtAt(c.em)}${vence}</span></div>
    ${barrado ? `<div class="pr-mudo">O agente já ouviu "não"${c.motivo ? ` (${esc(c.motivo)})` : ""}. Permitir libera esta ação no próximo turno e pede para ele rodar de novo.</div>` : `<div class="pr-mudo">O agente está ESPERANDO a sua resposta.</div>`}
    <div class="perm-acao"><b>${esc(c.ferramenta)}</b><pre>${esc(c.acao)}</pre></div>
    <div class="perm-botoes">
      ${barrado && !c.regraUmaVez ? `<span class="pr-mudo" title="A ação tem ( ) , * ou quebra de linha: no --allowedTools isso viraria OUTRA regra">não dá para liberar só esta ação pelo board — responda na conversa</span>`
        : `<button class="btn primary"${barrado ? ` title="Libera no próximo turno a regra exata ${esc(c.regraUmaVez)}"` : ""} onclick="responderPermissao('${esc(c.id)}','uma')">✓ Permitir uma vez${barrado ? ` <code>${esc(c.regraUmaVez)}</code>` : ""}</button>`}
      ${c.regraSempre ? `<button class="btn" title="Grava a regra ${esc(c.regraSempre)} para ${esc(rotuloProjeto(c.de.slug))}: da próxima vez passa sem perguntar" onclick="responderPermissao('${esc(c.id)}','sempre')">✓ Sempre permitir este tipo <code>${esc(c.regraSempre)}</code></button>`
        : `<span class="pr-mudo" title="Comando composto (&, ;, |…) ou caractere que viraria outra regra ( ( ) , * ) não vira regra de tipo">sem "sempre" para esta ação</span>`}
      <button class="btn perigo" onclick="responderPermissao('${esc(c.id)}','negar')">✗ Negar</button>
    </div>
  </div>`;
}

/** Desenha os cartões acima da caixa de escrever (cria o lugar se a tela ainda não tem). */
function pintarPermissoes() {
  const lista = permissoesDaTela();
  let el = $("#permCartoes");
  if (!lista.length) { if (el) el.remove(); return; }
  if (!el) {
    const box = $(".chatbox"); if (!box) return;
    el = document.createElement("div"); el.id = "permCartoes"; el.className = "perm-cartoes";
    box.parentNode.insertBefore(el, box);
  }
  el.innerHTML = lista.map(cartaoPermissaoHtml).join("");
}

async function responderPermissao(id, acao) {
  const c = PERM.pendentes.find((x) => x.id === id);
  if (acao === "sempre" && c && !confirm(`Liberar SEMPRE, em ${rotuloProjeto(c.de.slug)}, a regra:\n\n${c.regraSempre}\n\nDa próxima vez passa sem perguntar. (Tira em data/permissoes.json ou na Central.)`)) return;
  try {
    await api(`/permissoes/${id}`, { method: "POST", body: { acao } });
    PERM.pendentes = PERM.pendentes.filter((x) => x.id !== id);
    toast(acao === "negar" ? "🔐 negado" : "🔐 permitido" + (acao === "sempre" ? " (sempre este tipo)" : " (uma vez)"));
  } catch (e) { toast(e.message); carregarPermissoes(); }
  pintarPermissoes();
  if (view.central) pintarLadoCentral();
}

/** A seção da coluna da Central: quantos esperam e onde (o aviso que fica, além do toast). */
function permissoesLadoHtml() {
  if (!PERM.pendentes.length) return "";
  return `<section class="cl-permissao" role="alert"><h3>🔐 Pedidos de permissão (${PERM.pendentes.length})</h3>${PERM.pendentes.map((c) =>
    `<a class="cl-item" href="${linkOrigem(c.de)}">${esc(rotuloOrigem(c.de))} <span class="pr-mudo">${esc(c.ferramenta)}</span> ${esc(cutTxt(c.acao, 50))}</a>`).join("")}
    <div class="pr-mudo">responda nos cartões acima da caixa de escrever</div></section>`;
}
