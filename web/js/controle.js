// Controle: backups da madrugada, memória e Drive num lugar só.
// ── Controle (menu "Controle"): backups, memória e cópias fora das máquinas ──────────────────────────
// Só MOSTRA: o que é problema quem decide é o servidor (alertas em /api/controle).
let controleTimer = null, controleGeracao = 0;
const CTL = { aberto: new Set() };
function haQuantoCtl(iso) {
  if (!iso) return 'nunca';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 90 ? 'agora há pouco' : s < 3600 ? 'há ' + Math.round(s / 60) + ' min' : s < 172800 ? 'há ' + Math.round(s / 3600) + ' h' : 'há ' + Math.round(s / 86400) + ' dias';
}
const quandoCtl = (iso) => iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
// Os scripts escrevem o tamanho cada um de um jeito ("6.33 MiB", "4,0M", "1,5G"): tudo vira "6,3 MB".
function tamanhoCtl(t) {
  const m = String(t || '').match(/([\d.,]+)\s*([KMGT])?/i); if (!m) return t || '—';
  const n = parseFloat(m[1].replace(',', '.')) * ({ K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[(m[2] || '').toUpperCase()] || 1);
  return bytesTxt(n);
}
const bytesTxt = (b) => b == null ? '—' : b >= 1e9 ? (b / 1e9).toFixed(1).replace('.', ',') + ' GB' : b >= 1e7 ? Math.round(b / 1e6) + ' MB' : b >= 1e6 ? (b / 1e6).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';
function proximaRodada(c) {
  if (!c) return null;
  const d = new Date(); d.setUTCHours(c.h, c.m, 0, 0); if (d <= new Date()) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}
function estadoBackup(b, alertas) {
  const oks = b.rodadas.filter((r) => r.ok), ult = b.rodadas[b.rodadas.length - 1];
  const erro = alertas.find((a) => a.backup === b.id && a.nivel === 'erro');
  if (!oks.length) return ['erro', 'Nunca rodou'];
  if (ult && !ult.ok) return ['erro', 'Falhou'];
  if (erro) return ['erro', 'Atenção'];
  return ['ok', 'Em dia'];
}
function faixaDias(b) {
  // 14 dias, do mais velho ao de hoje, no horário daqui. Verde = rodada automática ok; contorno = só manual.
  const dias = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
    const fim = new Date(d); fim.setDate(fim.getDate() + 1);
    const doDia = b.rodadas.filter((r) => { const t = new Date(r.fim); return t >= d && t < fim; });
    const tipo = doDia.some((r) => !r.ok) && !doDia.some((r) => r.ok) ? 'falhou' : doDia.some((r) => r.ok && r.automatica) ? 'auto' : doDia.some((r) => r.ok) ? 'manual' : 'nada';
    const rot = { falhou: 'falhou', auto: 'automático ok', manual: 'só rodada manual', nada: 'sem backup' }[tipo];
    dias.push(`<i class="ctl-dia ctl-${tipo}" title="${d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' })} · ${rot}"></i>`);
  }
  return `<span class="ctl-faixa" aria-label="últimos 14 dias">${dias.join('')}</span>`;
}
async function renderControle() {
  const el = $('#controle'); if (!el) return;
  clearTimeout(controleTimer);
  const geracao = ++controleGeracao;
  const atual = () => geracao === controleGeracao && el.isConnected && view.name === 'list' && store.get('tab', 'ativas') === 'controle';
  let c; try { c = await api('/controle', { signal: AbortSignal.timeout(15000) }); } catch { if (atual()) el.innerHTML = '<div class="empty">Não consegui ler o controle.</div>'; return; }
  if (!atual()) return;
  if (!c.lidoEm) { el.innerHTML = '<div class="empty">Primeira leitura em andamento (Saturno, memória e Drive)…</div>'; controleTimer = setTimeout(renderControle, 4000); return; }
  const al = c.alertas || [], erros = al.filter((a) => a.nivel === 'erro'), m = c.memoria || {};
  const oks = (c.backups || []).map((b) => b.rodadas.filter((r) => r.ok).pop()).filter(Boolean);
  const maisVelho = oks.length === (c.backups || []).length && oks.length ? oks.map((r) => r.fim).sort()[0] : null;
  const drive = c.drive || [], noDrive = drive.reduce((a, p) => a + (p.arquivos || 0), 0), bytesDrive = drive.reduce((a, p) => a + (p.bytes || 0), 0);
  const motoresOk = (m.motores || []).filter((x) => x.memoria && x.captura).length;
  const veredito = erros.length ? ['offline', erros.length + (erros.length > 1 ? ' problemas' : ' problema')] : al.length ? ['online', 'Protegido · ' + al.length + (al.length > 1 ? ' avisos' : ' aviso')] : ['online', 'Tudo protegido'];
  const tile = (rot, valor, sub, estado) => `<div class="ctl-tile" data-state="${estado}"><span>${esc(rot)}</span><b>${esc(valor)}</b><small>${esc(sub)}</small></div>`;
  const linhaBackup = (b) => {
    const [est, rot] = estadoBackup(b, al), ok = b.rodadas.filter((r) => r.ok).pop();
    const pasta = drive.find((p) => p.pasta === b.drive);
    const noDriveOk = ok && pasta && pasta.ok && (b.id === 'board' ? pasta.arquivos > 0 : pasta.lista.some((x) => x.nome === ok.arquivo));
    const prox = proximaRodada(b.cronUTC);
    const aberto = CTL.aberto.has(b.id);
    return `<div class="ctl-linha" data-state="${est}">
      <button class="ctl-cab" data-abre="${b.id}" aria-expanded="${aberto}">
        <span class="ctl-nome"><b>${esc(b.nome)}</b><small>${esc(b.origem)}</small></span>
        <span class="ctl-pill">${esc(rot)}</span>
        <span class="ctl-col"><b>${ok ? haQuantoCtl(ok.fim) : '—'}</b><small>${ok ? quandoCtl(ok.fim) + (ok.automatica ? ' · automático' : ' · manual') : 'nenhum ainda'}</small></span>
        <span class="ctl-col"><b>${ok && ok.tamanho ? esc(tamanhoCtl(ok.tamanho)) : b.id === 'board' && pasta ? bytesTxt(pasta.bytes) : '—'}</b><small>${noDriveOk ? '✓ no Drive' : pasta && !pasta.ok ? 'Drive sem leitura' : ok ? 'não achei no Drive' : '—'}</small></span>
        <span class="ctl-col"><b>${prox ? prox.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—'}</b><small>${prox ? (prox.toDateString() === new Date().toDateString() ? 'próxima: hoje' : 'próxima: amanhã') : 'sem agendamento'}</small></span>
        ${faixaDias(b)}
      </button>
      ${aberto ? `<div class="ctl-det">
        <div><span class="eyebrow">Guarda</span><p>${esc(b.guarda)}</p><span class="eyebrow">Onde fica no Drive</span><p><code>gdrive_backup:${esc(b.drive)}</code>${pasta && pasta.ok ? ' · ' + pasta.arquivos + ' arquivo(s) · ' + bytesTxt(pasta.bytes) : ''}</p><span class="eyebrow">Como recuperar</span><p><code>${esc(b.recuperar)}</code></p></div>
        <div><span class="eyebrow">Últimas rodadas</span>${b.rodadas.slice(-8).reverse().map((r) => `<div class="ctl-rodada ${r.ok ? '' : 'ctl-rfalha'}"><span>${quandoCtl(r.fim)}</span><span>${r.ok ? (r.automatica ? 'automática' : 'manual') : 'falhou'}</span><span>${esc(r.ok ? [r.arquivo, r.tamanho && tamanhoCtl(r.tamanho)].filter(Boolean).join(' · ') || 'ok' : r.motivo)}</span></div>`).join('') || '<div class="docker-vazio">nenhuma rodada no log</div>'}</div>
      </div>` : ''}
    </div>`;
  };
  el.innerHTML = `
  <section class="network-panel">
    <div class="network-heading"><div><span class="eyebrow">VEREDITO</span><h2>${erros.length ? 'Tem coisa precisando de você.' : 'Suas cópias estão fora das máquinas.'}</h2></div><span class="network-health" data-state="${veredito[0]}" role="status">${esc(veredito[1])}</span></div>
    <div class="ctl-tiles">
      ${tile('Memória · última gravação', haQuantoCtl(m.ultimaGravacao), m.online ? 'servidor no ' + (m.reserva ? 'Mac (reserva)' : 'Saturno') : 'sem resposta', m.online ? 'ok' : 'erro')}
      ${tile('Backup mais antigo dos 4', maisVelho ? haQuantoCtl(maisVelho) : '—', maisVelho ? quandoCtl(maisVelho) : 'algum ainda não rodou', maisVelho && (Date.now() - Date.parse(maisVelho)) < 26 * 3600000 ? 'ok' : 'erro')}
      ${tile('Guardado no Drive', bytesTxt(bytesDrive), noDrive + ' arquivos em ' + drive.filter((p) => p.ok).length + ' pastas', drive.length && drive.every((p) => p.ok) ? 'ok' : 'erro')}
      ${tile('Motores na memória', motoresOk + ' de ' + (m.motores || []).length, 'trocar de modelo não perde o contexto', motoresOk === (m.motores || []).length && motoresOk ? 'ok' : 'erro')}
    </div>
    ${al.length ? `<ul class="ctl-alertas">${al.map((a) => `<li data-nivel="${a.nivel}">${esc(a.texto)}</li>`).join('')}</ul>` : ''}
  </section>
  <section class="network-panel docker-panel">
    <div class="network-heading"><div><span class="eyebrow">BACKUPS DA MADRUGADA</span><h2>Quatro cópias, todo dia, fora da VPS e do Mac.</h2></div><span class="ctl-legenda"><i class="ctl-dia ctl-auto"></i>automático <i class="ctl-dia ctl-manual"></i>manual <i class="ctl-dia ctl-falhou"></i>falhou <i class="ctl-dia ctl-nada"></i>nada</span></div>
    <div class="ctl-tabela"><div class="ctl-titulos"><span>Backup</span><span>Estado</span><span>Último</span><span>Tamanho</span><span>Próximo</span><span>14 dias</span></div>${(c.backups || []).map(linhaBackup).join('') || '<div class="docker-vazio">Saturno sem leitura</div>'}</div>
    <div class="network-footer"><span>logs e cron do Saturno · horários no fuso daqui · clique numa linha para ver rodadas e como recuperar</span><span>Saturno: ${c.saturno && c.saturno.discoLivre ? bytesTxt(c.saturno.discoLivre) + ' livres' : 'sem leitura'}</span></div>
  </section>
  <section class="network-panel docker-panel">
    <div class="network-heading"><div><span class="eyebrow">MEMÓRIA COMPARTILHADA</span><h2>O que os agentes guardaram.</h2></div><span class="network-health" data-state="${m.online ? 'online' : 'offline'}">${m.online ? (m.paginas || 0) + ' páginas' : 'sem resposta'}</span></div>
    <div class="ctl-mem">
      <div class="ctl-mem-num">
        ${[['Páginas', m.paginas], ['Sessões capturadas', m.sessoes], ['Observações', m.observacoes], ['Esperando para subir', m.filaPendente]].map(([r, v]) => `<div><b>${Number(v || 0).toLocaleString('pt-BR')}</b><span>${r}</span></div>`).join('')}
        <div class="ctl-motores">${(m.motores || []).map((x) => `<span data-state="${x.memoria && x.captura ? 'ok' : 'erro'}">${esc(x.nome)}</span>`).join('')}</div>
        <span class="eyebrow" style="margin-top:14px">Captura por projeto</span>
        ${(m.captura || []).map((x) => `<div class="ctl-cap"><span>${esc(x.projeto)}</span><span>${haQuantoCtl(x.ultimo)}</span><span>${x.eventosHoje} eventos hoje</span></div>`).join('') || '<div class="docker-vazio">nada capturado este mês</div>'}
      </div>
      <div class="ctl-recentes"><span class="eyebrow">Últimas memórias salvas</span>
        ${(m.recentes || []).map((x) => `<button class="ctl-pag" data-chave="${esc(x.chave)}" title="Abrir no grafo da memória"><span>${x.sessao ? '◷ ' : ''}${esc(x.titulo)}</span><small>${esc(x.projeto)} · ${haQuantoCtl(x.atualizada)}</small></button>`).join('') || '<div class="docker-vazio">espelho da memória ainda vazio</div>'}
      </div>
    </div>
    <div class="network-footer"><span>${esc(m.url || '')} · ◷ = resumo de sessão</span><span>espelho: ${m.espelho ? haQuantoCtl(m.espelho.quando) : 'aguardando'} (a cada 10 min)</span></div>
  </section>
  <section class="network-panel docker-panel">
    <div class="network-heading"><div><span class="eyebrow">GOOGLE DRIVE</span><h2>A cópia que sobra se tudo cair.</h2></div><span class="network-health" data-state="${drive.length && drive.every((p) => p.ok) ? 'online' : 'offline'}">lido ${c.driveLidoEm ? haQuantoCtl(c.driveLidoEm) : '—'}</span></div>
    <div class="ctl-drive">${drive.map((p) => `<div class="ctl-pasta" data-state="${p.ok ? 'ok' : 'erro'}"><code>${esc(p.pasta)}</code><b>${p.ok ? bytesTxt(p.bytes) : 'sem leitura'}</b><small>${p.ok ? p.arquivos + ' arquivo(s)' + (p.lista && p.lista[0] ? ' · mais novo: ' + esc(p.lista[0].nome) : '') : esc(p.erro || '')}</small></div>`).join('') || '<div class="docker-vazio">Drive ainda não lido</div>'}</div>
    <div class="network-footer"><span>rclone com chave própria · só enxerga as pastas de backup (drive.file)</span><span>se o Saturno cair: memoria-reserva ligar</span></div>
  </section>
  <div class="ctl-rodape">última leitura ${quandoCtl(c.lidoEm)} · atualiza sozinho a cada minuto</div>`;
  el.querySelectorAll('[data-abre]').forEach((bt) => { bt.onclick = () => { const id = bt.dataset.abre; CTL.aberto.has(id) ? CTL.aberto.delete(id) : CTL.aberto.add(id); renderControle(); }; });
  el.querySelectorAll('[data-chave]').forEach((bt) => { bt.onclick = () => { GE.sel = bt.dataset.chave; navigateBoard('memoria'); }; });
  controleTimer = setTimeout(() => { if (atual()) renderControle(); }, 60000);
}
// O complemento do mapa: os 4 motores ligados à memória, o board (que copia os dados para o servidor) e as ORIGENS
// dos backups (os bancos das VPSs), lidas da mesma lista do Controle. Nada aqui é inventado: sem leitura, fica cinza.
