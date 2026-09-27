// Monitoramento: o mapa (memória, Mac, servidor, Drive) e os containers Docker.
// ── monitoring: diagrama em tempo real de ai-memory, mac, saturno, google drive ────
let monitorTimer = null;
let monitorGeneration = 0;
const monitorIcon = (kind) => {
  const paths = {
    mac: '<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8m-4-5v5"/>',
    memory: '<rect x="6" y="6" width="12" height="12" rx="3"/><path d="M9 1v5m6-5v5M9 18v5m6-5v5M1 9h5m-5 6h5m12-6h5m-5 6h5"/><rect x="10" y="10" width="4" height="4" rx="1"/>',
    server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M12 6.5h5m-5 11h5"/>',
    cloud: '<path d="M6 19a5 5 0 0 1-1-9.9 7 7 0 0 1 13.6-1A5.5 5.5 0 0 1 18 19H6Z"/><path d="m9 13 3-3 3 3m-3-3v7"/>',
    box: '<path d="M21 8 12 3 3 8v8l9 5 9-5V8Z"/><path d="m3 8 9 5 9-5M12 13v8"/>'
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[kind]}</svg>`;
};
// Containers: exited(0) é serviço de rodar uma vez (ex.: migrar) — "Concluído", não problema.
function estadoContainer(c) {
  if (c.estado === 'running') {
    if (c.saude === 'doente') return ['offline', 'Doente'];
    if (c.saude === 'subindo') return ['unknown', 'Subindo'];
    return ['online', c.saude === 'saudavel' ? 'Saudável' : 'No ar'];
  }
  if (c.estado === 'exited') return c.codigo === 0 ? ['done', 'Concluído'] : ['offline', 'Parado · erro' + (c.codigo != null ? ' ' + c.codigo : '')];
  return ['unknown', c.estado || 'Sem leitura'];
}
const memCurta = (m) => { const r = String(m || '').match(/([\d.]+)\s*([KMG])i?B/i); if (!r) return m || ''; const v = Number(r[1]), u = r[2].toUpperCase(); return u === 'G' ? v.toFixed(1).replace('.', ',') + ' GB' : Math.round(u === 'K' ? v / 1024 : v) + ' MB'; };
function pintarDocker(el, d, quando) {
  const body = el.querySelector('#dockerBody'), health = el.querySelector('#dockerHealth');
  if (!body || !health || !d) return;
  let total = 0, noAr = 0, problema = 0, idx = 0;
  body.innerHTML = [['mac', 'Mac', 'mac'], ['saturno', 'Saturno', 'server']].map(([k, nome, icone]) => {
    const h = d[k] || {};
    if (h.online !== true) return `<div class="docker-host" data-host="${h.online === false ? 'off' : 'unknown'}"><div class="docker-host-head"><span class="service-icon">${monitorIcon(icone)}</span><strong>${nome}</strong><span class="docker-host-note">${esc(h.motivo || 'Sem leitura')}</span></div></div>`;
    const cs = h.containers || [];
    const grupos = {};
    for (const c of cs) (grupos[c.projeto || 'sem compose'] ||= []).push(c);
    const conta = { online: 0, offline: 0, done: 0, unknown: 0 };
    const gruposHtml = Object.entries(grupos).sort(([a], [b]) => (a === 'sem compose') - (b === 'sem compose') || a.localeCompare(b)).map(([proj, lista]) => `<div class="docker-group"><div class="map-caption docker-caption">＋ ${esc(proj.toUpperCase())}</div><div class="docker-grid">${lista.map((c) => {
      const [st, rot] = estadoContainer(c);
      total++; conta[st]++; if (st === 'online') noAr++; if (st === 'offline') problema++;
      const curto = proj !== 'sem compose' && c.nome.startsWith(proj + '-') ? c.nome.slice(proj.length + 1) : c.nome;
      return `<div class="service-card" data-state="${st}" title="${esc(c.nome)} · ${esc(c.status)}"><div class="service-top"><span class="service-icon">${monitorIcon('box')}</span><span class="service-index">${String(++idx).padStart(2, '0')}</span></div><h3>${esc(curto)}</h3><p>${esc(c.imagem)}</p><div class="service-bottom"><span class="service-dot"></span><b>${esc(rot)}</b><span class="service-detail">${c.cpu ? esc(c.cpu.replace('.', ',')) + ' · ' + esc(memCurta(c.mem)) : ''}</span></div></div>`;
    }).join('')}</div></div>`).join('');
    const nota = `${cs.length} container${cs.length === 1 ? '' : 's'} · ${conta.online} no ar${conta.done ? ' · ' + conta.done + ' concluído' + (conta.done > 1 ? 's' : '') : ''}${conta.offline ? ' · ' + conta.offline + ' com problema' : ''}`;
    return `<div class="docker-host" data-host="${conta.offline ? 'problema' : 'ok'}"><div class="docker-host-head"><span class="service-icon">${monitorIcon(icone)}</span><strong>${nome}</strong><span class="docker-host-note">${nota}</span></div>${gruposHtml}</div>`;
  }).join('');
  health.dataset.state = problema ? 'offline' : total ? 'online' : 'unknown';
  health.textContent = problema ? `${problema} com problema · ${noAr} no ar` : total ? `${noAr} de ${total} no ar` : 'Nenhum container';
  const t = el.querySelector('#dockerTime');
  if (t && quando) t.textContent = 'Leitura dos containers · ' + new Date(quando).toLocaleTimeString('pt-BR') + ' · a cada 30 s';
}
// A troca de modelo só leva a memória junto se o motor estiver ligado (MCP) e capturando (ganchos)
// no MESMO servidor — a tela mostra isso motor a motor, mais a captura e os backups (Saturno → Drive).
function pintarMemoria(el, st) {
  const grid = el.querySelector('#memGrid'), health = el.querySelector('#memHealth');
  if (!grid || !health) return;
  const a = st.aiMemory || {}, g = st.googleDrive || {}, b = g.backups || {}, c = st.copiaBoard || {};
  const quando = (d) => d ? new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'nunca';
  const velho = (d, h) => !d || Date.now() - Date.parse(d) > h * 3600000;
  const card = (i, icone, nome, desc, estado, rot, det) => `<div class="service-card" data-state="${estado}"><div class="service-top"><span class="service-icon">${monitorIcon(icone)}</span><span class="service-index">${String(i).padStart(2, '0')}</span></div><h3>${esc(nome)}</h3><p>${esc(desc)}</p><div class="service-bottom"><span class="service-dot"></span><b>${esc(rot)}</b><span class="service-detail">${esc(det || '')}</span></div></div>`;
  const ms = a.motores || [];
  let i = 0;
  const cards = ms.map((m) => card(++i, 'memory', m.nome, m.memoria && m.captura ? 'memória e captura ligadas' : m.memoria ? 'memória ligada, sem captura' : 'desligado da memória',
    m.memoria && m.captura ? 'online' : 'offline', m.memoria && m.captura ? 'Ligado' : 'Desligado', ''));
  cards.push(card(++i, 'box', 'Captura automática', 'sessões e observações gravadas', a.sessoes ? 'online' : 'unknown', a.sessoes ? 'Capturando' : 'Nada ainda',
    `${a.sessoes || 0} sessões · ${a.observacoes || 0} obs.`));
  cards.push(card(++i, 'cloud', 'Backup da memória', 'Saturno → Drive, toda madrugada', velho(b.memoria, 26) ? 'offline' : 'online', b.memoria ? quando(b.memoria) : 'Nunca', (b.arquivo || '').split(' ').pop()));
  cards.push(card(++i, 'cloud', 'Backup do board', 'Saturno → Drive, toda madrugada', velho(b.board, 26) ? 'offline' : 'online', b.board ? quando(b.board) : 'Nunca', ''));
  // os backups dos bancos ficam no menu Controle, que lê a lista configurada (data/backups.json)
  cards.push(card(++i, 'server', 'Cópia do board', 'Mac → Saturno a cada 30 min', c.ok === false || velho(c.quando, 2) ? (c.quando ? 'offline' : 'unknown') : 'online',
    c.quando ? (c.ok ? quando(c.quando) : 'Falhou') : 'Aguardando', c.erro || ''));
  grid.innerHTML = cards.join('');
  const ligados = ms.filter((m) => m.memoria && m.captura).length;
  const reserva = /reserva/.test(a.host || '');
  health.dataset.state = reserva ? 'offline' : ligados === ms.length && ms.length ? 'online' : 'offline';
  health.textContent = reserva ? 'Reserva ligada: memória no Mac' : `${ligados} de ${ms.length} motores ligados`;
  el.querySelector('#memServidor').textContent = a.url ? 'servidor: ' + a.url + (a.host ? ' (' + a.host + ')' : '') : 'servidor: sem leitura';
  el.querySelector('#memReserva').textContent = reserva ? 'LIGADA' : 'desligada';
}
async function pintarComplementoDoMapa(el, st) {
  const box = el.querySelector('#mapaExtras'), fios = el.querySelector('#mapaFios'); if (!box || !fios) return;
  let ctl = null; try { ctl = await api('/controle', { signal: AbortSignal.timeout(8000) }); } catch {}
  const h = (iso) => iso ? (Date.now() - Date.parse(iso)) / 3600000 : Infinity;
  const peca = (cls, x, y, estado, nome, sub, titulo) => `<div class="map-extra ${cls}" data-state="${estado}" style="left:${x}%;top:${y}%" title="${esc(titulo || '')}"><i></i><span>${esc(nome)}${sub ? `<small>${esc(sub)}</small>` : ''}</span></div>`;
  const motores = st.aiMemory?.motores || [];
  const xs = [26, 40, 54, 68];
  let html = motores.map((m, i) => peca('motor', xs[i] ?? 26 + i * 14, 8, m.memoria && m.captura ? 'online' : 'offline', m.nome, m.memoria && m.captura ? 'memória + captura' : m.memoria ? 'sem captura' : 'desligado')).join('');
  let linhas = motores.map((m, i) => `<path data-state="${m.memoria && m.captura ? 'online' : 'offline'}" d="M${(xs[i] ?? 26 + i * 14) * 10} 64L470 150"/>`).join('');
  const c = st.copiaBoard || ctl?.copiaBoard || {};
  const cEstado = c.quando ? (c.ok === false || h(c.quando) > 2 ? 'offline' : 'online') : 'unknown';
  html += peca('', 14, 74, cEstado, 'board', c.quando ? 'cópia ' + new Date(c.quando).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : 'aguardando a 1ª cópia', 'O board espelha data/ no servidor a cada 30 min');
  html += '<span class="map-rot" style="left:44%;top:74%">dados do board · 30 min</span><span class="map-rot" style="left:14%;top:57%">roda no Mac</span>';
  const origens = (ctl?.backups || []).filter((b) => b.id !== 'memoria' && b.id !== 'board');
  origens.forEach((b, i) => {
    const y = origens.length === 1 ? 40 : 18 + i * (44 / Math.max(1, origens.length - 1));
    const oks = b.rodadas.filter((r) => r.ok), ult = b.rodadas[b.rodadas.length - 1], ok = oks[oks.length - 1];
    const estado = !ok ? 'offline' : (ult && !ult.ok) || h(ok.fim) > 26 ? 'offline' : 'online';
    html += peca('', 92, y, estado, b.nome, ok ? 'backup ' + new Date(ok.fim).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'sem backup', b.origem);
    linhas += `<path data-state="${estado}" d="M920 ${y * 6}L740 240"/>`;
  });
  if (origens.length) html += '<span class="map-rot" style="left:84%;top:67%">backup dos bancos</span>';
  html += '<span class="map-rot" style="left:63%;top:85%">backup toda madrugada</span><span class="map-rot" style="left:47%;top:15%">MCP + captura</span>';
  box.innerHTML = html;
  fios.querySelectorAll('[data-extra]').forEach((p) => p.remove());
  fios.insertAdjacentHTML('beforeend', linhas.replaceAll('<path ', '<path data-extra="1" '));
  fios.querySelector('[data-wire="board"]').dataset.state = st.mac?.online ? 'online' : 'unknown';
  fios.querySelector('[data-wire="copia"]').dataset.state = cEstado;
}
async function renderMonitoring() {
  const el = $("#monitoring"); if (!el) return;
  clearTimeout(monitorTimer);
  const generation = ++monitorGeneration;
  const nodes = [['mac','Mac','Estação local','mac'],['aiMemory','ai-memory','Memória compartilhada','memory'],['saturno','Saturno','Servidor remoto','server'],['googleDrive','Google Drive','Destino de backup','cloud']];
  el.innerHTML = `<section class="network-panel">
    <div class="network-heading"><div><span class="eyebrow">TOPOLOGIA DO WORKSPACE</span><h2>Uma rede. Todo o contexto.</h2></div><span class="network-health" id="networkHealth" role="status">Verificando serviços</span></div>
    <div class="network-map" aria-label="Mapa de conexão entre Mac, ai-memory, Saturno e Google Drive">
      <div class="map-caption"><span class="map-cross">＋</span> INFRAESTRUTURA / 01</div>
      <svg class="network-wires" viewBox="0 0 1000 600" preserveAspectRatio="none" aria-hidden="true" id="mapaFios"><path class="wire-base" d="M140 240H740"/><path data-wire="mac" d="M140 240H470"/><path data-wire="saturno" d="M740 240H470"/><path data-wire="googleDrive" d="M740 240V510H470"/><path data-wire="board" d="M140 444V240"/><path data-wire="copia" d="M140 444H760V272"/></svg>
      <div id="mapaExtras"></div>
      <div class="network-orbit orbit-outer"></div><div class="network-orbit orbit-inner"></div>
      ${nodes.map(([key,name,desc,icon])=>`<div class="network-node node-${key}" data-service="${key}" data-state="unknown">
        <div class="node-icon">${monitorIcon(icon)}</div><strong>${name}</strong><span class="node-description">${desc}</span><span class="node-state">Aguardando leitura</span>
        ${key === 'aiMemory' ? '<span class="memory-pages" id="memoryPages">— <small>páginas indexadas</small></span>' : ''}
      </div>`).join('')}
      <div class="map-legend"><span><i class="legend-online"></i>Disponível</span><span><i class="legend-offline"></i>Indisponível</span><span><i></i>Sem leitura</span></div>
      <span class="map-coordinate">LOCAL + CLOUD</span>
    </div>
    <div class="network-services">${nodes.map(([key,name,desc,icon],i)=>`<div class="service-card" data-summary="${key}" data-state="unknown"><div class="service-top"><span class="service-icon">${monitorIcon(icon)}</span><span class="service-index">0${i+1}</span></div><h3>${name}</h3><p>${desc}</p><div class="service-bottom"><span class="service-dot"></span><b>Aguardando</b><span class="service-detail"></span></div></div>`).join('')}</div>
    <div class="network-footer"><span id="monTime">Aguardando primeira leitura</span><span>Verificação automática <span class="footer-separator">/</span> a cada 3s após a resposta</span></div>
  </section>
  <section class="network-panel docker-panel">
    <div class="network-heading"><div><span class="eyebrow">MEMÓRIA ENTRE MOTORES</span><h2>Um modelo acaba, o outro continua.</h2></div><span class="network-health" id="memHealth" role="status">Verificando</span></div>
    <div class="docker-grid" id="memGrid"><div class="docker-vazio">Aguardando primeira leitura</div></div>
    <div class="network-footer"><span id="memServidor">—</span><span>reserva: <b id="memReserva">—</b> <span class="footer-separator">/</span> memoria-reserva ligar|desligar</span></div>
  </section>
  <section class="network-panel docker-panel">
    <div class="network-heading"><div><span class="eyebrow">CONTAINERS DOCKER</span><h2>O que está rodando.</h2></div><span class="network-health" id="dockerHealth" role="status">Verificando containers</span></div>
    <div class="docker-body" id="dockerBody"><div class="docker-vazio">Aguardando primeira leitura</div></div>
    <div class="network-footer"><span id="dockerTime">Leitura a cada 30 s no Mac e no Saturno</span><span>docker ps <span class="footer-separator">/</span> docker stats</span></div>
  </section>`;
  const current = () => generation === monitorGeneration && el.isConnected && view.name === 'list' && store.get('tab','ativas') === 'monitoring';
  async function updateMon() {
    if (!current()) return;
    try {
      const st = await api('/monitoring', {signal: AbortSignal.timeout(15000)});
      if (!current()) return;
      let onlineCount = 0;
      for (const [key] of nodes) {
        let state = st[key]?.online === true ? 'online' : st[key]?.online === false ? 'offline' : 'unknown';
        let label = {online:'Online',offline:'Offline',unknown:'Sem leitura'}[state];
        // Drive "online" só diz que o rclone alcança o Google; o que importa é o backup ter saído.
        if (key === 'googleDrive' && state === 'online' && st.googleDrive?.backupEmDia === false) {
          state = 'offline'; label = st.googleDrive.lastSync ? 'Backup atrasado' : 'Sem backup';
        }
        if (state === 'online') onlineCount++;
        const node = el.querySelector(`[data-service="${key}"]`);
        const card = el.querySelector(`[data-summary="${key}"]`);
        node.dataset.state = card.dataset.state = state;
        node.querySelector('.node-state').textContent = label;
        card.querySelector('.service-bottom b').textContent = label;
        const detail = card.querySelector('.service-detail');
        const ligados = (st.aiMemory?.motores || []).filter((m) => m.memoria && m.captura).length;
        detail.textContent = key === 'aiMemory' && state === 'online' ? `${Number(st.aiMemory.pages || 0).toLocaleString('pt-BR')} páginas · ${ligados}/4 motores` : '';
        if (key === 'aiMemory') {
          const onde = st.aiMemory?.host ? 'Memória compartilhada · roda no ' + st.aiMemory.host : 'Memória compartilhada';
          node.querySelector('.node-description').textContent = onde; card.querySelector('p').textContent = onde;
        }
        if (key === 'googleDrive') {
          const b = st.googleDrive?.backups || {};
          const quando = (d) => d ? new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'nunca';
          detail.textContent = st.googleDrive?.lastSync ? 'Último backup ' + quando(st.googleDrive.lastSync) : 'Nenhum backup ainda';
          detail.title = 'memória: ' + quando(b.memoria) + ' · board: ' + quando(b.board);
        }
      }
      const memoryOnline = st.aiMemory?.online === true;
      el.querySelector('#memoryPages').innerHTML = `${memoryOnline ? Number(st.aiMemory.pages || 0).toLocaleString('pt-BR') : '—'} <small>páginas indexadas</small>`;
      for (const key of ['mac','saturno','googleDrive']) el.querySelector(`[data-wire="${key}"]`).dataset.state = memoryOnline && st[key]?.online === true ? 'online' : 'offline';
      const health = el.querySelector('#networkHealth');
      health.dataset.state = onlineCount === 4 ? 'online' : 'offline';
      health.textContent = onlineCount === 4 ? 'Todos os serviços online' : `${onlineCount} de 4 serviços online`;
      el.querySelector('#monTime').textContent = `Última leitura · ${new Date().toLocaleTimeString('pt-BR')}`;
      pintarDocker(el, st.docker, st.timestamp);
      pintarMemoria(el, st);
      pintarComplementoDoMapa(el, st);
    } catch {
      if (!current()) return;
      el.querySelector('#networkHealth').textContent = 'Não foi possível atualizar';
      el.querySelector('#networkHealth').dataset.state = 'unknown';
      el.querySelector('#monTime').textContent = 'Sem leitura atual · tentando novamente';
      el.querySelectorAll('[data-service], [data-summary], [data-wire]').forEach(n => n.dataset.state = 'unknown');
      el.querySelectorAll('.node-state, .service-bottom b').forEach(n => n.textContent = 'Sem leitura');
      el.querySelectorAll('.service-detail').forEach(n => n.textContent = '');
      el.querySelector('#memoryPages').innerHTML = '— <small>páginas indexadas</small>';
      const dh = el.querySelector('#dockerHealth'); if (dh) { dh.dataset.state = 'unknown'; dh.textContent = 'Sem leitura'; }
    } finally {
      if (current()) monitorTimer = setTimeout(updateMon, 3000);
    }
  }
  updateMon();
}

