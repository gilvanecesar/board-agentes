// Memória: o grafo, o galpão (mentes e endereços) e o inventário.
// ── Grafo da memória (menu "Memória") ─────────────────────────────────────────────────────────
// Posições por simulação de forças, feita à mão (o board não tem dependência). O estado fica guardado
// aqui fora para o grafo não se refazer quando o board redesenha a lista por causa de outro evento.
const CORES_GRAFO = ['#7cc4f7', '#f2a65a', '#c792ea', '#f07178', '#82d9c5', '#ffcb6b', '#a3b1ff', '#e8a0bf', '#89ddff', '#d4a373', '#9aa7b0'];
const GE = { tema: null, dados: null, nos: [], lig: [], cor: {}, s: 1, tx: 0, ty: 0, sel: null, hover: null, busca: '', fora: new Set(), vizinhos: new Map() };
const semAcento = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
function montarSimulacao(d) {
  const contagem = {}; for (const n of d.nos) contagem[n.projeto] = (contagem[n.projeto] || 0) + 1;
  const projetos = Object.keys(contagem).sort((a, b) => (a === '_global' ? -1 : b === '_global' ? 1 : contagem[b] - contagem[a]));
  GE.cor = {}; projetos.forEach((p, i) => { GE.cor[p] = p === '_global' ? '#b9ed80' : CORES_GRAFO[(i - 1 + CORES_GRAFO.length) % CORES_GRAFO.length]; });
  const centro = {}; projetos.forEach((p, i) => { const ang = (i / projetos.length) * Math.PI * 2; centro[p] = p === '_global' ? [0, 0] : [Math.cos(ang) * 330, Math.sin(ang) * 330]; });
  const idx = new Map();
  GE.nos = d.nos.map((n, i) => { idx.set(n.chave, i); const [cx, cy] = centro[n.projeto]; return { ...n, x: cx + (Math.random() - .5) * 120, y: cy + (Math.random() - .5) * 120, vx: 0, vy: 0, r: 3 + Math.sqrt(n.grau) * 1.6, cx, cy }; });
  GE.lig = d.ligacoes.map((l) => [idx.get(l.a), idx.get(l.b)]).filter(([a, b]) => a != null && b != null);
  GE.vizinhos = new Map(GE.nos.map((n) => [n.chave, new Set()]));
  for (const [a, b] of GE.lig) { GE.vizinhos.get(GE.nos[a].chave).add(GE.nos[b].chave); GE.vizinhos.get(GE.nos[b].chave).add(GE.nos[a].chave); }
  const N = GE.nos, n = N.length;
  for (let t = 0; t < 320; t++) {
    const alfa = 1 - t / 320;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const A = N[i], B = N[j]; let dx = A.x - B.x, dy = A.y - B.y; const d2 = Math.max(dx * dx + dy * dy, 30);
      if (d2 > 90000) continue;
      const f = (1400 / d2) * alfa; dx *= f / Math.sqrt(d2); dy *= f / Math.sqrt(d2);
      A.vx += dx; A.vy += dy; B.vx -= dx; B.vy -= dy;
    }
    for (const [a, b] of GE.lig) {
      const A = N[a], B = N[b]; const dx = B.x - A.x, dy = B.y - A.y; const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = ((d - 60) / d) * 0.06 * alfa; A.vx += dx * f; A.vy += dy * f; B.vx -= dx * f; B.vy -= dy * f;
    }
    for (const A of N) { A.vx += (A.cx - A.x) * 0.006 * alfa - A.x * 0.002 * alfa; A.vy += (A.cy - A.y) * 0.006 * alfa - A.y * 0.002 * alfa; A.vx *= .82; A.vy *= .82; A.x += A.vx; A.y += A.vy; }
  }
}
function encaixarGrafo(cv) {
  const xs = GE.nos.map((n) => n.x), ys = GE.nos.map((n) => n.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  GE.s = Math.min(cv.clientWidth / (x1 - x0 + 80), cv.clientHeight / (y1 - y0 + 80));
  GE.tx = cv.clientWidth / 2 - ((x0 + x1) / 2) * GE.s; GE.ty = cv.clientHeight / 2 - ((y0 + y1) / 2) * GE.s;
}
function visivelNoGrafo(n) {
  if (GE.fora.has(n.projeto)) return false;
  if (GE.tema && !(n.temas || []).includes(GE.tema)) return false;
  if (!GE.busca) return true;
  return semAcento(n.titulo + ' ' + n.id + ' ' + n.descricao).includes(GE.busca);
}
function desenharGrafo() {
  const cv = $('#grafoCanvas'); if (!cv) return;
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
  const foco = GE.hover || GE.sel, viz = foco ? GE.vizinhos.get(foco) : null;
  const P = (n) => [n.x * GE.s + GE.tx, n.y * GE.s + GE.ty];
  c.lineWidth = 1;
  for (const [a, b] of GE.lig) {
    const A = GE.nos[a], B = GE.nos[b]; const vis = visivelNoGrafo(A) && visivelNoGrafo(B);
    const aceso = foco && (A.chave === foco || B.chave === foco);
    c.strokeStyle = aceso ? GE.cor[(A.chave === foco ? A : B).projeto] : vis ? 'rgba(210,230,215,.10)' : 'rgba(210,230,215,.025)';
    c.globalAlpha = aceso ? .85 : 1;
    const [x1, y1] = P(A), [x2, y2] = P(B); c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
  }
  c.globalAlpha = 1;
  for (const n of GE.nos) {
    const [x, y] = P(n), vis = visivelNoGrafo(n), perto = foco && (n.chave === foco || (viz && viz.has(n.chave)));
    c.globalAlpha = !vis ? .12 : foco && !perto ? .35 : 1;
    c.fillStyle = GE.cor[n.projeto]; c.beginPath(); c.arc(x, y, n.r * Math.min(1.6, Math.max(.7, GE.s)), 0, Math.PI * 2); c.fill();
    if (n.chave === GE.sel) { c.globalAlpha = 1; c.strokeStyle = '#edf1e9'; c.lineWidth = 2; c.stroke(); c.lineWidth = 1; }
  }
  c.globalAlpha = 1; c.font = '11px ' + getComputedStyle(document.body).fontFamily; c.textAlign = 'center';
  // Rótulos por prioridade (o foco, os vizinhos, a busca, os mais ligados) e SEM sobreposição: o que não cabe fica
  // para o passar do mouse. Empilhar 19 títulos em volta de uma página tornava todos ilegíveis.
  const candidatos = GE.nos.map((n) => {
    const perto = foco && (n.chave === foco || (viz && viz.has(n.chave)));
    const prio = n.chave === foco ? 1e6 : perto ? 1e5 + n.grau : (GE.busca && visivelNoGrafo(n)) ? 1e4 + n.grau : ((GE.s > 1.3 && n.grau >= 4) || (n.grau >= 10 && !foco)) && visivelNoGrafo(n) ? n.grau : -1;
    return { n, prio };
  }).filter((x) => x.prio >= 0).sort((a, b) => b.prio - a.prio);
  const ocupado = [];
  for (const { n } of candidatos) {
    const [x, y] = P(n); const t = n.titulo.length > 34 ? n.titulo.slice(0, 33) + '…' : n.titulo;
    const tw = c.measureText(t).width, r = { x: x - tw / 2 - 3, y: y + n.r + 3, w: tw + 6, h: 15 };
    if (ocupado.some((o) => r.x < o.x + o.w && r.x + r.w > o.x && r.y < o.y + o.h && r.y + r.h > o.y)) continue;
    ocupado.push(r);
    c.fillStyle = 'rgba(17,20,19,.82)'; c.fillRect(r.x, r.y, r.w, r.h);
    c.fillStyle = n.chave === foco ? '#edf1e9' : '#a8b3aa'; c.fillText(t, x, y + n.r + 14);
  }
}
function noNoPonto(mx, my) {
  let melhor = null, dist = 1e9;
  for (const n of GE.nos) { const x = n.x * GE.s + GE.tx, y = n.y * GE.s + GE.ty; const d = Math.hypot(mx - x, my - y); if (d < n.r * Math.max(1, GE.s) + 5 && d < dist) { dist = d; melhor = n; } }
  return melhor;
}
const normMem = (x) => String(x).toLowerCase().trim().replace(/\.md$/, '').replace(/[\s_]+/g, '-');
function achaNoDaMemoria(alvo, projeto) {
  const l = GE.nos.filter((n) => normMem(n.id) === normMem(String(alvo).split('/').pop()));
  return (l.find((n) => n.projeto === projeto) || l[0] || {}).chave || null;
}
// [[alvo|texto]] vira um link que abre a página citada; o resto passa pelo mesmo mdToHtml das conversas.
function comLinksDaMemoria(texto) {
  const alvos = [];
  const marcado = String(texto || '').replace(/\[\[([^\]|#]+)(?:[|#]([^\]]*))?\]\]/g, (_, a, rot) => { alvos.push([a.trim(), (rot || a).trim()]); return '\u2063' + (alvos.length - 1) + '\u2063'; });
  return mdToHtml(marcado).replace(/\u2063(\d+)\u2063/g, (_, i) => { const [a, rot] = alvos[+i]; return '<button class="grafo-wiki" data-alvo="' + esc(a) + '">' + esc(rot) + '</button>'; });
}
async function abrirPaginaDaMemoria(chave, centralizar) {
  GE.sel = chave; desenharGrafo();
  const n = GE.nos.find((x) => x.chave === chave); const cv = $('#grafoCanvas');
  if (n && centralizar && cv) { GE.tx = cv.clientWidth / 2 - n.x * GE.s; GE.ty = cv.clientHeight / 2 - n.y * GE.s; desenharGrafo(); }
  const box = $('#grafoPagina'); if (!box) return;
  box.innerHTML = '<div class="docker-vazio">carregando…</div>';
  try {
    const p = await api('/memoria/pagina?chave=' + encodeURIComponent(chave));
    const lista = (titulo, itens) => itens.length ? '<div class="grafo-lig"><b>' + titulo + ' (' + itens.length + ')</b>' + itens.map((i) => '<button data-chave="' + esc(i.chave) + '">' + esc(i.titulo) + '</button>').join('') + '</div>' : '';
    box.innerHTML = '<span class="grafo-chip"><i style="background:' + GE.cor[p.projeto] + '"></i>' + esc(p.projeto) + '</span><h3>' + esc(p.titulo) + '</h3>'
      + (p.descricao ? '<p class="grafo-desc">' + esc(p.descricao) + '</p>' : '') + '<div class="md">' + comLinksDaMemoria(p.texto) + '</div>'
      + lista('Liga para', p.liga) + lista('Citada por', p.citadaPor) + giroHtml((GE.dados.nos || []).find((x) => x.chave === chave));
    box.querySelectorAll('[data-chave]').forEach((b) => { b.onclick = () => abrirPaginaDaMemoria(b.dataset.chave, true); });
    box.querySelectorAll('[data-alvo]').forEach((b) => { b.onclick = () => { const k = achaNoDaMemoria(b.dataset.alvo, p.projeto); if (k) abrirPaginaDaMemoria(k, true); }; });
  } catch (e) { box.innerHTML = '<div class="docker-vazio">' + esc(e.message) + '</div>'; }
}
async function renderMemoria() {
  const el = $('#memoria'); if (!el) return;
  el.innerHTML = '<section class="network-panel"><div class="network-heading"><div><span class="eyebrow">GRAFO DA MEMÓRIA</span><h2>Cada ponto é uma página. Cada linha, uma ligação.</h2></div><span class="network-health" id="grafoInfo" role="status">Carregando</span></div>'
    + '<div class="grafo-barra"><div class="gp-modo" role="tablist" aria-label="Como ver a memória"><button data-modo="grafo">Grafo</button><button data-modo="galpao">Galpão</button></div><input id="grafoBusca" type="search" placeholder="Procurar na memória: título ou assunto…" aria-label="Procurar na memória"><div class="grafo-projetos" id="grafoTemas"></div><div class="grafo-projetos" id="grafoProjetos"></div></div>'
    + '<div class="grafo-corpo"><div class="grafo-canvas" id="grafoArea"><canvas id="grafoCanvas" aria-label="Grafo das páginas da memória"></canvas></div><div class="galpao" id="galpao" hidden></div>'
    + '<aside class="grafo-pagina" id="grafoPagina"><div class="docker-vazio">Clique num ponto para ler a página. Arraste para mover; a roda do mouse aproxima.</div></aside></div>'
    + '<div class="network-footer"><span id="grafoFonte">fonte: ai-memory no Saturno</span><span>só para ver · para mudar a memória, peça a um agente</span></div></section>';
  let d; try { d = await api('/memoria/grafo'); } catch (e) { if (el.isConnected) $('#grafoInfo').textContent = 'Não consegui ler a memória'; return; }
  if (!el.isConnected) return; // o dono já foi para outra tela enquanto o grafo carregava
  if (d.erro) { $('#grafoInfo').textContent = d.erro; return; }
  const cv = $('#grafoCanvas'); if (!cv) return;
  const novo = !GE.dados || GE.dados.geradoEm !== d.geradoEm;
  if (novo) { const antes = GE.dados; GE.dados = d; montarSimulacao(d); if (!antes) encaixarGrafo(cv); }
  $('#grafoInfo').dataset.state = 'online';
  $('#grafoInfo').textContent = d.nos.length + ' páginas · ' + d.ligacoes.length + ' ligações';
  $('#grafoFonte').textContent = 'fonte: ai-memory no Saturno · espelho de ' + new Date(d.geradoEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const contagem = {}; for (const n of d.nos) contagem[n.projeto] = (contagem[n.projeto] || 0) + 1;
  const pj = $('#grafoProjetos');
  pj.innerHTML = Object.keys(GE.cor).map((p) => '<button class="grafo-chip ' + (GE.fora.has(p) ? 'off' : '') + '" data-proj="' + esc(p) + '" title="Mostrar ou esconder ' + esc(p) + '"><i style="background:' + GE.cor[p] + '"></i>' + esc(p) + ' ' + contagem[p] + '</button>').join('');
  pj.querySelectorAll('[data-proj]').forEach((b) => { b.onclick = () => { const p = b.dataset.proj; GE.fora.has(p) ? GE.fora.delete(p) : GE.fora.add(p); b.classList.toggle('off'); redesenharMemoria(); }; });
  const temas = {}; for (const n of d.nos) for (const t of n.temas || []) temas[t] = (temas[t] || 0) + 1;
  const tm = $('#grafoTemas');
  tm.innerHTML = '<span class="grafo-rotulo">Temas</span>' + Object.entries(temas).sort((a, b) => b[1] - a[1]).map(([t, q]) => '<button class="grafo-chip grafo-tema ' + (GE.tema === t ? 'on' : '') + '" data-tema="' + esc(t) + '" title="Acender só as páginas que falam de ' + esc(t) + '">' + esc(t) + ' ' + q + '</button>').join('');
  tm.querySelectorAll('[data-tema]').forEach((bt) => { bt.onclick = () => { GE.tema = GE.tema === bt.dataset.tema ? null : bt.dataset.tema; tm.querySelectorAll('[data-tema]').forEach((x) => x.classList.toggle('on', x.dataset.tema === GE.tema)); redesenharMemoria(); }; });
  pj.insertAdjacentHTML('afterbegin', '<span class="grafo-rotulo">Guardada em</span>');
  const bx = $('#grafoBusca'); bx.value = GE.busca;
  bx.oninput = () => { GE.busca = semAcento(bx.value.trim()); redesenharMemoria(); };
  bx.onkeydown = (e) => { if (e.key === 'Enter') { const n = GE.nos.find(visivelNoGrafo); if (n) abrirPaginaDaMemoria(n.chave, true); } };
  let arrasto = null;
  cv.onpointerdown = (e) => { arrasto = { x: e.offsetX, y: e.offsetY, tx: GE.tx, ty: GE.ty, moveu: false }; cv.setPointerCapture(e.pointerId); cv.classList.add('arrastando'); };
  cv.onpointermove = (e) => {
    if (arrasto) { const dx = e.offsetX - arrasto.x, dy = e.offsetY - arrasto.y; if (Math.abs(dx) + Math.abs(dy) > 3) arrasto.moveu = true; GE.tx = arrasto.tx + dx; GE.ty = arrasto.ty + dy; desenharGrafo(); return; }
    const n = noNoPonto(e.offsetX, e.offsetY); const h = n ? n.chave : null;
    if (h !== GE.hover) { GE.hover = h; cv.title = n ? n.titulo + ' · ' + n.projeto + (n.grau ? ' · ' + n.grau + ' ligações' : '') : ''; desenharGrafo(); }
  };
  cv.onpointerup = (e) => { cv.classList.remove('arrastando'); const a = arrasto; arrasto = null; if (a && !a.moveu) { const n = noNoPonto(e.offsetX, e.offsetY); if (n) abrirPaginaDaMemoria(n.chave, false); } };
  cv.onpointerleave = () => { if (!arrasto && GE.hover) { GE.hover = null; desenharGrafo(); } };
  cv.onwheel = (e) => { e.preventDefault(); const f = Math.exp(-e.deltaY * 0.0015); const s2 = Math.min(6, Math.max(.2, GE.s * f)); GE.tx = e.offsetX - (e.offsetX - GE.tx) * (s2 / GE.s); GE.ty = e.offsetY - (e.offsetY - GE.ty) * (s2 / GE.s); GE.s = s2; desenharGrafo(); };
  cv.ondblclick = () => { encaixarGrafo(cv); desenharGrafo(); };
  if (!GE.observador) { GE.observador = new ResizeObserver(() => desenharGrafo()); }
  GE.observador.disconnect(); GE.observador.observe($('#grafoArea'));
  desenharGrafo();
  document.querySelectorAll('.gp-modo [data-modo]').forEach((b) => { b.onclick = () => { GE.modo = b.dataset.modo; store.set('memoriaModo', GE.modo); mostrarModoMemoria(); }; });
  mostrarModoMemoria();
  if (GE.sel) abrirPaginaDaMemoria(GE.sel, false);
}
function redesenharMemoria() { desenharGrafo(); if (GE.modo === 'galpao') desenharGalpao(); }
function mostrarModoMemoria() {
  GE.modo = GE.modo || store.get('memoriaModo', 'grafo');
  const g = GE.modo === 'galpao';
  document.querySelectorAll('.gp-modo [data-modo]').forEach((b) => b.classList.toggle('on', b.dataset.modo === GE.modo));
  const a = $('#grafoArea'), gp = $('#galpao'); if (!a || !gp) return;
  a.hidden = g; gp.hidden = !g;
  const cab = document.querySelector('#memoria .network-heading');
  if (cab) { cab.querySelector('.eyebrow').textContent = g ? 'GALPÃO DA MEMÓRIA' : 'GRAFO DA MEMÓRIA'; cab.querySelector('h2').textContent = g ? 'Cada rua é um projeto. Cada posição, uma memória.' : 'Cada ponto é uma página. Cada linha, uma ligação.'; }
  if (g) desenharGalpao(); else desenharGrafo();
}
// ── Galpão: a memória como um armazém (pedido do dono, 26/09) ──────────────────────────────────────
// Rua = projeto (a 1ª é a área comum, _global) · porta-palete = TIPO da memória · posição = uma página.
// Mais recente no nível 1 (perto do chão/da doca), como a curva A de um WMS. Cor = idade da última gravação.
// Tudo vem do grafo que já existe: nenhum número aqui é inventado.
const TIPOS_GALPAO = [['projeto','Fatos do projeto'],['regra','Regras e lições'],['decisao','Decisões'],['dono','Sobre o dono'],['referencia','Referências'],['sessao','Sessões'],['outro','Sem tipo']];
function idadeGalpao(iso) { const d = (Date.now() - Date.parse(iso)) / 86400000; return d < 1 ? 'g0' : d < 7 ? 'g1' : d < 30 ? 'g2' : d < 90 ? 'g3' : 'g4'; }
// Curva de giro: a cor diz quantas tarefas levaram a memória (mesma paleta da idade: claro = mais perto da doca).
function giroGalpao(n) { const s = (n.giro || {}).saidas || 0; return s >= 10 ? 'g0' : s >= 3 ? 'g1' : s >= 1 ? 'g2' : 'g4'; }
const RESULTADO_GIRO = { primeira: 'passou de primeira', conserto: 'passou depois de conserto', falhou: 'reprovada ou com erro', semConferencia: 'sem conferência', andando: 'ainda andando' };
/** Por onde a memória passou: as tarefas que a levaram e como cada uma foi. Mostra o caminho, não prova que ajudou. */
function giroHtml(n) {
  const desde = GE.dados && GE.dados.giroDesde; if (!desde || !n) return '';
  const g = n.giro, dia = (iso) => new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  if (!g) return `<div class="grafo-lig giro"><b>📦 Giro</b><small class="giro-nota">não foi a nenhuma tarefa desde ${dia(desde)}, quando o romaneio começou</small></div>`;
  const PLURAL = { primeira: 'passaram de primeira', conserto: 'passaram depois de conserto', falhou: 'reprovadas ou com erro', semConferencia: 'sem conferência' };
  const partes = [['primeira', g.primeira], ['conserto', g.conserto], ['falhou', g.falhou], ['semConferencia', g.semConferencia]].filter(([, x]) => x).map(([k, x]) => `${x} ${x > 1 ? PLURAL[k] : RESULTADO_GIRO[k]}`).join(' · ');
  return `<div class="grafo-lig giro"><b>📦 Saiu em ${g.saidas} tarefa${g.saidas > 1 ? 's' : ''} · última em ${dia(g.ultima)}</b>`
    + `<small class="giro-nota">${esc(partes)}${partes ? '. ' : ''}Mostra por onde a memória passou — não prova que ela ajudou.</small>`
    + g.tarefas.map((t) => `<button onclick="location.hash='#/t/${t.id}'">#${t.id} ${esc(cutTxt(t.titulo, 60))} · ${esc(RESULTADO_GIRO[t.resultado] || '')}</button>`).join('') + '</div>';
}
// Revisão do endereçamento: as memórias com confiança média/baixa, a mente proposta e o motivo. O dono confere (✓)
// ou move para outra mente; só depois de todas conferidas o botão Aprovar aparece. Tudo grava em data/mentes.json.
function revisaoDasMentes() {
  const M = GE.dados.mentes; const def = Object.fromEntries(M.mentes.map((m) => [m.id, m]));
  const pend = GE.dados.nos.filter((n) => n.menteConfianca === 'media' || n.menteConfianca === 'baixa').sort((a, b) => (a.menteConfianca === 'baixa' ? -1 : 1) - (b.menteConfianca === 'baixa' ? -1 : 1));
  const cont = M.mentes.map((m) => `<span class="gp-mchip" title="${esc(m.desc)}">${m.icone} ${esc(m.nome)} <b>${M.porMente[m.id] || 0}</b></span>`).join('');
  if (!pend.length) return `<div class="gp-rev"><div class="gp-mchips">${cont}</div>${M.status === 'aprovada' ? '' : '<div class="gp-rev-ok">Todas conferidas. <button class="gp-aprovar" data-aprovar>Aprovar endereçamento</button></div>'}</div>`;
  const opc = (atual) => M.mentes.map((m) => `<option value="${m.id}" ${m.id === atual ? 'selected' : ''}>${m.icone} ${esc(m.nome)}</option>`).join('');
  return `<div class="gp-rev"><div class="gp-mchips">${cont}</div>
    <div class="gp-rev-cab"><b>Para conferir: ${pend.length}</b><span>as de confiança baixa primeiro · ✓ confirma a mente proposta · trocar no seletor já grava</span></div>
    <div class="gp-rev-lista">${pend.map((n) => `<div class="gp-rev-item" data-conf="${n.menteConfianca}">
      <button class="gp-rev-tit" data-abrir="${esc(n.chave)}">${esc(n.titulo)}<small>${esc(n.projeto)} · ${esc(n.menteMotivo || '')}</small></button>
      <select data-mover="${esc(n.chave)}" aria-label="Mente de ${esc(n.titulo)}">${opc(n.mente)}</select>
      <button class="gp-rev-ok-b" data-conferir="${esc(n.chave)}" title="Está certo">✓</button></div>`).join('')}</div></div>`;
}
function ligarRevisaoDasMentes(el) {
  const atualiza = async (url, corpo) => {
    try { await api(url, { method: 'POST', body: corpo }); }
    catch (e) { toast(e.message); return; }
    const d = await api('/memoria/grafo'); GE.dados = { ...GE.dados, nos: GE.dados.nos.map((n) => d.nos.find((x) => x.chave === n.chave) || n), mentes: d.mentes };
    desenharGalpao();
  };
  el.querySelectorAll('[data-conferir]').forEach((b) => { b.onclick = () => atualiza('/memoria/mentes/conferir', { chave: b.dataset.conferir }); });
  el.querySelectorAll('[data-mover]').forEach((sel) => { sel.onchange = () => atualiza('/memoria/mentes/mover', { chave: sel.dataset.mover, mente: sel.value }); });
  el.querySelectorAll('[data-abrir]').forEach((b) => { b.onclick = () => abrirPaginaDaMemoria(b.dataset.abrir, false); });
  const ap = el.querySelector('[data-aprovar]'); if (ap) ap.onclick = () => atualiza('/memoria/mentes/aprovar', {});
}
// ── Inventário (dentro do Galpão): novas sem mente, suspeitas de repetidas e vencidas. O servidor acha; o dono decide.
const INV = { dados: null, carregando: false, prop: {}, confirma: null };
async function carregarInventario(forcar) {
  if (INV.carregando) return; INV.carregando = true;
  try { INV.dados = await api('/memoria/inventario' + (forcar ? '/rodar' : ''), forcar ? { method: 'POST' } : {}); } catch (e) { toast(e.message); }
  INV.carregando = false; desenharGalpao();
}
function inventarioHtml() {
  const d = INV.dados;
  if (!d) { if (!INV.carregando) carregarInventario(false); return '<div class="inv"><div class="docker-vazio">carregando o inventário…</div></div>'; }
  if (!d.em) return `<div class="inv"><div class="inv-cab"><b>Inventário</b><span>ainda não rodou</span><button class="inv-bt" data-inv-rodar>Contar agora</button></div></div>`;
  const tit = (k) => esc((GE.dados.nos.find((n) => n.chave === k) || {}).titulo || k);
  const abre = (k) => `<button class="inv-link" data-abrir="${esc(k)}">${tit(k)}</button>`;
  const rep = d.repetidas.map((r) => {
    const id = r.chaves.slice().sort().join('|'); const p = INV.prop[id];
    const corpo = !p ? '' : p.carregando ? '<div class="inv-prev">a IA está lendo as páginas e escrevendo a versão única…</div>'
      : p.naoJuntar ? `<div class="inv-prev">🤔 <b>A IA acha que não são repetidas:</b> ${esc(p.naoJuntar)}</div>`
      : `<div class="inv-prev"><div class="md">${mdToHtml(p.texto)}</div><div class="inv-acoes"><button class="inv-bt forte" data-inv-aplicar="${esc(p.id)}">Aplicar: fica só esta${r.chaves.length > 2 ? ` (apaga as outras ${r.chaves.length - 1})` : ' (apaga a outra)'}</button><small>US$ ${(p.custo || 0).toFixed(3)} · a 1ª página recebe o texto</small></div></div>`;
    return `<div class="inv-item"><div class="inv-lin"><span class="inv-pct">${Math.round(r.parecenca * 100)}%</span><div class="inv-tits">${r.chaves.map(abre).join('<i>⟷</i>')}</div>
      <div class="inv-acoes"><button class="inv-bt" data-inv-juntar="${esc(r.chaves.join(','))}" ${p && p.carregando ? 'disabled' : ''}>Juntar</button><button class="inv-bt" data-inv-ignorar-grupo="${esc(r.chaves.join(','))}" title="Não são repetidas: não mostrar de novo">Não são</button></div></div>${corpo}</div>`;
  }).join('') || '<div class="docker-vazio">nenhuma suspeita de repetição</div>';
  const venc = d.vencidas.map((v) => `<div class="inv-item"><div class="inv-lin"><div class="inv-tits">${abre(v.chave)}<small>${esc(v.projeto)} · ${esc(v.motivo)}</small></div>
    <div class="inv-acoes">${INV.confirma === v.chave ? `<button class="inv-bt perigo" data-inv-descartar="${esc(v.chave)}">Confirmar: apagar da memória</button>` : `<button class="inv-bt" data-inv-quase="${esc(v.chave)}">Descartar</button>`}<button class="inv-bt" data-inv-ignorar="${esc(v.chave)}">Manter</button></div></div></div>`).join('') || '<div class="docker-vazio">nada vencido</div>';
  const novas = d.novas.length ? `<div class="inv-lin"><span>${d.novas.length} memória(s) nova(s) sem mente: ${d.novas.slice(0, 4).map((x) => abre(x.chave)).join(', ')}${d.novas.length > 4 ? '…' : ''}</span><button class="inv-bt" data-inv-enderecar>Propor mentes</button></div>` : '<div class="docker-vazio">toda memória tem endereço</div>';
  const feitos = (d.feitos || []).slice(-3).reverse().map((f) => `${new Date(f.em).toLocaleDateString('pt-BR')} · ${f.acao}: ${f.chaves.length}`).join(' · ');
  return `<details class="inv" ${store.get('invAberto', true) ? 'open' : ''}><summary class="inv-cab"><b>🌙 Inventário</b><span>contado ${new Date(d.em).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · toda madrugada às 2h · ${d.novas.length} novas · ${d.repetidas.length} suspeitas de repetição · ${d.vencidas.length} vencidas</span><button class="inv-bt" data-inv-rodar>${INV.carregando ? 'contando…' : 'Contar agora'}</button></summary>
    <div class="inv-sec"><h4>Novas sem mente</h4>${novas}</div>
    <div class="inv-sec"><h4>Suspeitas de repetição</h4><p class="inv-dica">Parecença pelo texto e pelo título. "Juntar" pede a uma IA a versão única (só com o seu clique); você vê antes de aplicar.</p>${rep}</div>
    <div class="inv-sec"><h4>Vencidas</h4><p class="inv-dica">Descartar apaga da memória compartilhada. Fica uma cópia em data/inventario-descartadas e no backup da madrugada.</p>${venc}</div>
    ${feitos ? `<div class="inv-dica">feito: ${esc(feitos)}</div>` : ''}</details>`;
}
function ligarInventario(el) {
  const det = el.querySelector('details.inv'); if (det) det.ontoggle = () => store.set('invAberto', det.open);
  const post = async (acao, corpo) => { try { return await api('/memoria/inventario/' + acao, { method: 'POST', body: corpo }); } catch (e) { toast(e.message); return null; } };
  const recarrega = async () => { const g = await api('/memoria/grafo'); GE.dados = { ...GE.dados, ...g }; await carregarInventario(false); };
  el.querySelectorAll('[data-inv-rodar]').forEach((b) => { b.onclick = (e) => { e.preventDefault(); carregarInventario(true); }; });
  el.querySelectorAll('.inv [data-abrir]').forEach((b) => { b.onclick = () => abrirPaginaDaMemoria(b.dataset.abrir, false); });
  const ench = el.querySelector('[data-inv-enderecar]'); if (ench) ench.onclick = async () => { const r = await post('enderecar-novas', {}); if (r) { toast(`${r.enderecadas} proposta(s) de mente: confira na lista (Porta-palete por Mente)`); recarrega(); } };
  el.querySelectorAll('[data-inv-quase]').forEach((b) => { b.onclick = () => { INV.confirma = b.dataset.invQuase; desenharGalpao(); }; });
  el.querySelectorAll('[data-inv-descartar]').forEach((b) => { b.onclick = async () => { INV.confirma = null; if (await post('descartar', { chave: b.dataset.invDescartar })) { toast('descartada'); recarrega(); } }; });
  el.querySelectorAll('[data-inv-ignorar]').forEach((b) => { b.onclick = async () => { if (await post('ignorar', { chave: b.dataset.invIgnorar })) carregarInventario(false); }; });
  el.querySelectorAll('[data-inv-ignorar-grupo]').forEach((b) => { b.onclick = async () => { if (await post('ignorar', { chaves: b.dataset.invIgnorarGrupo.split(',') })) carregarInventario(false); }; });
  el.querySelectorAll('[data-inv-juntar]').forEach((b) => { b.onclick = async () => {
    const chaves = b.dataset.invJuntar.split(','); const id = chaves.slice().sort().join('|');
    INV.prop[id] = { carregando: true }; desenharGalpao();
    const r = await post('juntar', { chaves }); INV.prop[id] = r || undefined; desenharGalpao();
  }; });
  el.querySelectorAll('[data-inv-aplicar]').forEach((b) => { b.onclick = async () => { if (await post('aplicar', { id: b.dataset.invAplicar })) { toast('juntadas: ficou uma página só'); INV.prop = {}; recarrega(); } }; });
}
function desenharGalpao() {
  const el = $('#galpao'); if (!el || !GE.dados) return;
  GE.pp = GE.pp || store.get('galpaoPP', 'tipo');
  GE.nivel = GE.nivel || store.get('galpaoNivel', 'idade');
  const porGiro = GE.nivel === 'giro' && !!GE.dados.giroDesde;
  const todos = GE.dados.nos.filter((n) => !GE.fora.has(n.projeto));
  const ruas = {}; for (const n of todos) (ruas[n.projeto] = ruas[n.projeto] || []).push(n);
  const ordem = Object.keys(ruas).sort((a, b) => (a === '_global' ? -1 : b === '_global' ? 1 : ruas[b].length - ruas[a].length));
  const acesa = (n) => (!GE.busca || semAcento(n.titulo + ' ' + n.descricao + ' ' + n.projeto).includes(GE.busca)) && (!GE.tema || (n.temas || []).includes(GE.tema));
  const semana = todos.filter((n) => Date.now() - Date.parse(n.atualizada) < 7 * 86400000).length;
  const achadas = GE.busca || GE.tema ? todos.filter(acesa).length : null;
  const M = GE.dados.mentes || {}; const porM = GE.pp === 'mente' && M.existe;
  let html = `<div class="gp-pp"><span>Porta-palete por</span><div class="gp-modo"><button data-pp="tipo" class="${porM ? '' : 'on'}">Tipo</button><button data-pp="mente" class="${porM ? 'on' : ''}" ${M.existe ? '' : 'disabled title="ainda não há endereçamento"'}>Mente</button></div>${M.existe ? `<span class="gp-status" data-st="${M.status}">${M.status === 'aprovada' ? '✓ endereçamento aprovado' : 'endereçamento PROPOSTO · ' + M.aRevisar + ' para conferir'}</span>` : ''}</div>`
    + inventarioHtml()
    + (porM ? revisaoDasMentes() : '')
    + (GE.dados.giroDesde ? `<div class="gp-pp"><span>Nível por</span><div class="gp-modo"><button data-nivel="idade" class="${porGiro ? '' : 'on'}">Idade</button><button data-nivel="giro" class="${porGiro ? 'on' : ''}" title="o que mais sai nas tarefas fica perto da doca">Giro</button></div></div>` : '')
    + `<div class="gp-kpis"><div><b>${ordem.length}</b><span>ruas (projetos)</span></div><div><b>${todos.length}</b><span>posições ocupadas</span></div><div><b>${semana}</b><span>mexidas nos últimos 7 dias</span></div>${GE.dados.giroDesde ? `<div><b>${todos.filter((n) => !n.giro && !n.sessao).length}</b><span>nunca foram a uma tarefa (desde ${new Date(GE.dados.giroDesde).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })})</span></div>` : ''}${achadas != null ? `<div><b>${achadas}</b><span>localizadas na busca</span></div>` : ''}</div>
    <div class="gp-legenda">${porGiro
      ? '<span><i class="gp-p g0"></i>10+ tarefas</span><span><i class="gp-p g1"></i>3 a 9</span><span><i class="gp-p g2"></i>1 ou 2</span><span><i class="gp-p g4"></i>nunca saiu</span>'
      : '<span><i class="gp-p g0"></i>hoje</span><span><i class="gp-p g1"></i>7 dias</span><span><i class="gp-p g2"></i>30 dias</span><span><i class="gp-p g3"></i>90 dias</span><span><i class="gp-p g4"></i>mais antiga</span>'}<span class="gp-nota">${porM ? 'porta-palete = MENTE' : 'porta-palete = TIPO da memória'} · ${porGiro ? 'cor = em quantas tarefas ela saiu · nível 1 = a que MAIS sai, perto da doca' : 'cor = última edição (ou a entrada na memória) · nível 1 = a mais recente, perto da doca'} · endereço R-P-N-P</span></div>`;
  ordem.forEach((proj, ri) => {
    const lista = ruas[proj];
    html += `<section class="gp-rua${proj === '_global' ? ' gp-comum' : ''}"><div class="gp-rua-cab"><span class="gp-rua-n">RUA ${String(ri + 1).padStart(2, '0')}</span><b>${esc(proj === '_global' ? 'Área comum' : proj)}</b><small>${proj === '_global' ? '_global · vale para todos os projetos · ' : ''}${lista.length} posições</small></div><div class="gp-predios">`;
    let pi = 0;
    const porMente = GE.pp === 'mente' && GE.dados.mentes && GE.dados.mentes.existe;
    const grupos = porMente ? GE.dados.mentes.mentes.map((m) => [m.id, m.icone + ' ' + m.nome]) : TIPOS_GALPAO;
    for (const [tipo, nome] of grupos) {
      const itens = lista.filter((n) => (porMente ? (n.mente || 'triagem') : (n.tipo || 'outro')) === tipo)
        .sort((a, b) => (porGiro ? ((b.giro || {}).saidas || 0) - ((a.giro || {}).saidas || 0) : 0) || b.atualizada.localeCompare(a.atualizada));
      if (!itens.length) continue;
      pi++;
      const cols = Math.max(4, Math.min(22, Math.ceil(Math.sqrt(itens.length * 2.2))));
      const niveis = Math.ceil(itens.length / cols);
      let linhas = '';
      for (let nv = niveis; nv >= 1; nv--) {
        let cel = '';
        for (let c = 1; c <= cols; c++) {
          const n = itens[(nv - 1) * cols + (c - 1)];
          if (!n) { cel += '<i class="gp-p gp-vazia"></i>'; continue; }
          const end = `R${String(ri + 1).padStart(2, '0')}-P${String(pi).padStart(2, '0')}-N${nv}-${String(c).padStart(2, '0')}`;
          cel += `<button class="gp-p ${porGiro ? giroGalpao(n) : idadeGalpao(n.atualizada)}${acesa(n) ? '' : ' gp-apagada'}${GE.sel === n.chave ? ' gp-sel' : ''}" data-chave="${esc(n.chave)}" data-end="${end}" title="${esc(end + ' · ' + n.titulo + (porGiro ? ' · ' + (n.giro ? `saiu em ${n.giro.saidas} tarefa(s)` : 'nunca saiu') : ''))}"></button>`;
        }
        linhas += `<div class="gp-nivel"><span class="gp-nv">N${nv}</span><div class="gp-pos">${cel}</div></div>`;
      }
      html += `<div class="gp-predio"><div class="gp-predio-cab"><span>P${String(pi).padStart(2, '0')}</span>${esc(nome)}<small>${itens.length}</small></div><div class="gp-rack">${linhas}</div></div>`;
    }
    html += '</div></section>';
  });
  el.innerHTML = html || '<div class="docker-vazio">nenhuma rua visível</div>';
  el.querySelectorAll('[data-pp]').forEach((b) => { b.onclick = () => { GE.pp = b.dataset.pp; store.set('galpaoPP', GE.pp); desenharGalpao(); }; });
  el.querySelectorAll('[data-nivel]').forEach((b) => { b.onclick = () => { GE.nivel = b.dataset.nivel; store.set('galpaoNivel', GE.nivel); desenharGalpao(); }; });
  ligarRevisaoDasMentes(el);
  ligarInventario(el);
  el.querySelectorAll('.gp-p[data-chave]').forEach((b) => { b.onclick = async () => {
    el.querySelectorAll('.gp-sel').forEach((x) => x.classList.remove('gp-sel')); b.classList.add('gp-sel');
    await abrirPaginaDaMemoria(b.dataset.chave, false);
    const box = $('#grafoPagina'); const n = GE.dados.nos.find((x) => x.chave === b.dataset.chave);
    const mt = n && n.mente && (GE.dados.mentes.mentes || []).find((m) => m.id === n.mente);
    if (box) box.insertAdjacentHTML('afterbegin', `<div class="gp-endereco">📍 ${esc(b.dataset.end)}</div>` + (mt ? `<div class="gp-mente-ficha">${esc(mt.icone + ' ' + mt.nome)}${n.mentesTambem && n.mentesTambem.length ? ' · também: ' + esc(n.mentesTambem.join(', ')) : ''}<small>${esc(n.menteMotivo || '')}</small></div>` : ''));
  }; });
}
