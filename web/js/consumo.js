// Consumo: gasto do board por papel/motor e o plano de cada motor (cartões, troca de motor).
// ── consumo: só o que o CLI contou (custo por rodada), somado ────────────────
const fmtDia = (iso) => { const [y, m, d] = iso.split("-"); return `${d}/${m}`; };
async function renderConsumo() {
  const el = $("#consumo"); if (!el) return;
  let u; try { u = await api("/usage"); }
  catch (e) { el.innerHTML = `<div class="empty">Esta aba precisa do board reiniciado (código novo no disco, servidor antigo no ar). Reinicie quando a fila esvaziar.<br><span style="font-family:var(--mono);font-size:12px">${esc(e.message)}</span></div>`; return; }
  GASTO = u.porMotor || {}; // o rodapé de cada cartão de motor mostra o que ele gastou aqui
  const maxProj = Math.max(1, ...u.porProjeto.map((p) => p.custo));
  const maxDia = Math.max(0.01, ...u.porDia.map((d) => d.custo));
  const hoje = new Date().toISOString().slice(0, 10);
  const tot = u.porPapel.agente + u.porPapel.revisor + (u.porPapel.qa || 0) || 1;
  const pct = (v) => Math.round((v / tot) * 100);
  el.innerHTML = `
    <div class="plano" id="plano"><div class="empty" style="padding:14px 0">lendo o /usage do Claude… (a primeira leitura leva uns 20 segundos)</div></div>
    <div class="bloco" style="padding:10px 16px"><h3 style="margin:0">O que as tarefas do board custaram · valor de referência em dólar, somado das rodadas</h3></div>
    <div class="tiles">
      <div class="tile"><div class="k">Hoje</div><div class="v">${fmtCost(u.hoje) || "US$ 0,00"}</div></div>
      <div class="tile"><div class="k">Últimos 7 dias</div><div class="v">${fmtCost(u.semana) || "US$ 0,00"}</div></div>
      <div class="tile"><div class="k">Total do quadro</div><div class="v">${fmtCost(u.total) || "US$ 0,00"}</div><div class="s">${u.rodadas} rodada(s) do claude</div></div>
    </div>
    <div class="bloco"><h3>Por dia (últimos 14)</h3>
      <div class="dias">${u.porDia.map((d) => `<div class="d ${d.custo ? "" : "zero"} ${d.dia === hoje ? "hoje" : ""}" style="height:${Math.max(2, Math.round((d.custo / maxDia) * 100))}%" title="${fmtDia(d.dia)}: ${fmtCost(d.custo) || "US$ 0,00"}"></div>`).join("")}</div>
      <div class="dias-l">${u.porDia.map((d, i) => `<span>${i % 2 ? "" : fmtDia(d.dia)}</span>`).join("")}</div>
    </div>
    <div class="bloco"><h3>Por projeto</h3>
      ${u.porProjeto.length ? u.porProjeto.map((p) => `<div class="brow" title="${esc(p.projeto)}: ${fmtCost(p.custo)}"><span class="n">${esc(p.projeto)}</span><div class="t"><div class="b" style="width:${Math.round((p.custo / maxProj) * 100)}%"></div></div><span class="v">${fmtCost(p.custo)}</span></div>`).join("") : `<div class="empty">nada gasto ainda</div>`}
    </div>
    <div class="bloco"><h3>Agente × revisor × QA</h3>
      <div class="split"><div class="a" style="width:${pct(u.porPapel.agente)}%" title="agente: ${fmtCost(u.porPapel.agente)}"></div><div class="r" style="width:${pct(u.porPapel.revisor)}%" title="revisor: ${fmtCost(u.porPapel.revisor)}"></div><div class="q" style="width:${pct(u.porPapel.qa || 0)}%" title="QA: ${fmtCost(u.porPapel.qa || 0)}"></div></div>
      <div class="legend"><span><i style="background:var(--c-agente)"></i>agente <b>${fmtCost(u.porPapel.agente) || "US$ 0,00"}</b> · ${pct(u.porPapel.agente)}%</span><span><i style="background:var(--c-revisor)"></i>revisor <b>${fmtCost(u.porPapel.revisor) || "US$ 0,00"}</b> · ${pct(u.porPapel.revisor)}%</span><span><i style="background:var(--c-qa)"></i>QA <b>${fmtCost(u.porPapel.qa || 0) || "US$ 0,00"}</b> · ${pct(u.porPapel.qa || 0)}%</span></div>
    </div>
    ${Object.keys(u.porMotor || {}).length > 1 ? `<div class="bloco"><h3>Por motor</h3>
      ${Object.entries(u.porMotor).map(([m, v]) => `<div class="mrow"><span class="n">${esc(rotuloDoMotor(m))}</span><span class="r">${v.rodadas} rodada(s)</span><span class="v">${v.usd ? fmtCost(v.usd) : (v.tokens || 0).toLocaleString("pt-BR") + " tokens"}</span></div>`).join("")}
      <div class="aviso" style="margin-top:6px">O Claude informa o custo em dólar por rodada; o Codex informa tokens. O board mostra o que cada um conta.</div>
    </div>` : ""}
    <div class="bloco"><h3>Tarefas que mais gastaram</h3>
      <table class="top"><thead><tr><th>#</th><th>Tarefa</th><th>Projeto</th><th style="text-align:right">Turnos</th><th style="text-align:right">Custo</th></tr></thead>
      <tbody>${u.tarefas.map((t) => `<tr onclick="location.hash='#/t/${t.id}'"><td class="num">${t.id}</td><td>${esc(t.titulo)}</td><td style="color:var(--violet)">${esc(t.projeto)}</td><td class="num">${t.turnos}</td><td class="num">${fmtCost(t.custo)}</td></tr>`).join("")}</tbody></table>
    </div>
    <div class="aviso">O painel do plano é o próprio /usage do Claude Code, lido e traduzido, sem estimativa. Os valores em dólar abaixo dele são o custo de referência que o CLI informa a cada rodada do board. Numa assinatura eles não são cobrados um a um: o que conta pro seu limite são as porcentagens do plano.</div>
  `;
  renderPlano();
  if (!USO) carregarUso();
}

// ── o plano de cada motor: um cartão por CLI, lado a lado ────────────────────
// Quem manda no vermelho é o SERVIDOR (`pct`/`semCota` vêm do mesmo cálculo que decide a passagem
// de bastão) — o cálculo local abaixo é só o socorro para um servidor antigo no ar.
const pctLocal = (u) => {
  if (!u || !u.ok || !u.limites?.length) return null;
  const curtos = u.limites.filter((l) => !/semana|week/i.test(l.nome));
  return Math.max(...(curtos.length ? curtos : u.limites).map((l) => l.pct));
};
const pctUso = (u) => (u && u.pct != null ? u.pct : pctLocal(u));
const esgotado = (u) => (u && u.semCota != null ? !!u.semCota : (pctUso(u) != null && pctUso(u) >= ((USO && USO.teto) || 98)));
// A troca move o que ESPERA (o que roda não se interrompe, e pendente não entra na fila sozinha).
const motorDaTarefa = (t) => t.motor || (S.config || {}).motor || "claude";
const esperandoNoMotor = (id) => (S.tasks || []).filter((t) => motorDaTarefa(t) === id && !t.busy && ["fila", "erro"].includes(t.status));
const rodandoNoMotor = (id) => (S.tasks || []).filter((t) => motorDaTarefa(t) === id && (t.busy || t.status === "rodando"));
let trocaAberta = null; // qual cartão está com a lista de destinos aberta
function abrirTroca(id) { trocaAberta = trocaAberta === id ? null : id; renderPlano(); }
async function trocarMotor(de, para) {
  const quantas = esperandoNoMotor(de).length;
  if (!confirm(`Passar ${quantas} tarefa(s) de ${rotuloDoMotor(de)} para ${rotuloDoMotor(para)}?\n\nElas voltam pra fila no outro motor. A sessão NÃO atravessa: vai o bastão por escrito (a tarefa, o resumo do agente anterior, os últimos passos e o estado da pasta).`)) return;
  try {
    const r = await api("/motores/passar", { method: "POST", body: { de, para } });
    trocaAberta = null;
    toast(`${r.trocadas.length} tarefa(s) na fila de ${rotuloDoMotor(para)}${r.trocadas.length ? ": #" + r.trocadas.join(", #") : ""}`, 6000);
  } catch (e) { toast(e.message); }
}
const rotuloDoMotor = (id) => (S.motores || []).find((m) => m.id === id)?.rotulo || (USO && USO.motores && USO.motores[id] || {}).rotulo || id;

function cartaoMotor(id, u) {
  const padrao = (S.config || {}).motor || "claude";
  const lido = u.medidoEm || USO.atualizadoEm;
  const ha = lido ? Math.round((Date.now() - new Date(lido).getTime()) / 60000) : null;
  const pct = pctUso(u), sem = esgotado(u), n = pct == null ? "ok" : nivel(pct);
  const espera = esperandoNoMotor(id), roda = rodandoNoMotor(id);
  const gasto = (GASTO || {})[id];
  const outros = (S.motores || []).filter((m) => m.id !== id);
  return `<div class="mcard ${sem ? "esgotado" : ""} ${u.ok ? "" : "mudo"}">
    <div class="mtop">
      <span class="mnome">${esc(u.rotulo || id)}</span>
      ${u.modo ? `<span class="mtag">${esc(u.modo)}</span>` : ""}
      ${id === padrao ? `<span class="mtag padrao" title="motor padrão das tarefas novas">PADRÃO</span>` : ""}
      ${sem ? `<span class="mtag esgotada" title="o board considera este motor sem cota (${(USO && USO.teto) || 98}% ou mais na janela mais apertada) e passa o bastão para outro">⛔ SEM COTA</span>`
        : u.ok ? `<span class="mtag livre">com cota</span>` : ""}
      <span class="quando">${u.medidoEm ? "do último uso" : ha != null ? (ha < 1 ? "lido agora" : `lido há ${ha} min`) : ""}</span>
    </div>
    ${u.ok ? `
      <div class="mgrande ${n}">${pct}%<small>usado · restam ${Math.max(0, Math.round((100 - pct) * 10) / 10)}%</small></div>
      <div class="mlims">${u.limites.map((l) => {
        const nl = nivel(l.pct);
        return `<div class="mlim">
          <div class="lr"><span>${esc(l.nome)}${NIVEL_TXT[nl] ? ` <span class="rot ${nl}">${NIVEL_TXT[nl]}</span>` : ""}</span><b class="${nl}">${l.pct}%</b></div>
          <div class="trilho" title="${l.pct}% usado"><div class="enche ${nl}" style="width:${Math.min(100, l.pct)}%"></div></div>
          ${l.renovaEm ? `<div class="quando2"><span>renova ${esc(quandoCurto(l.renovaEm))}</span><span>${esc(emQuanto(l.renovaEm))}</span></div>`
            : l.renovaTexto ? `<div class="quando2"><span>${esc(l.renovaTexto)}</span></div>` : ""}
        </div>`;
      }).join("")}</div>
      ${u.contrib?.length ? `<details><summary>o que está pesando</summary><div class="contrib">${u.contrib.map((c) => `<div><h4>${esc(c.janela)}</h4><div class="res">${esc(c.resumo)}</div><ul>${c.itens.map((i) => `<li>${esc(i)}</li>`).join("")}</ul></div>`).join("")}</div></details>` : ""}`
    : `<div class="msem">${esc(u.erro || "sem dados de uso")}</div>`}
    <div class="mrod">
      <span title="o que este motor já gastou nas tarefas do board">${gasto ? (gasto.usd ? fmtCost(gasto.usd) : (gasto.tokens || 0).toLocaleString("pt-BR") + " tokens") : "nada gasto aqui"}</span>
      <span title="tarefas deste motor no quadro">${roda.length ? `▶ ${roda.length} rodando · ` : ""}${espera.length} esperando</span>
      ${outros.length ? `<button class="btn sm" onclick="abrirTroca('${id}')" title="Passar para outro motor as tarefas que esperam neste">⇄ Trocar</button>` : ""}
      ${id === "claude" ? `<button class="btn sm" onclick="this.disabled=true;this.textContent='lendo… (~20 s)';carregarUso(true)">atualizar</button>` : ""}
    </div>
    ${trocaAberta === id ? `<div class="mdest">${espera.length ? `passar ${espera.length} tarefa(s) para:` : "nada esperando neste motor — não há o que passar"}
      ${espera.length ? outros.map((m) => `<button class="btn sm" onclick="trocarMotor('${id}','${m.id}')" title="${esc(m.rotulo)} assume: a sessão não atravessa, vai o bastão por escrito${cotaTxt(m.id)}">${esc(m.rotulo)}${cotaSelo(m.id)}</button>`).join("") : ""}</div>` : ""}
  </div>`;
}

function renderPlano() {
  const el = $("#plano"); if (!el || !USO) return;
  const motores = USO.motores || (USO.ok ? { claude: { rotulo: "Claude", ...USO } } : {});
  if (Object.keys(motores).length) {
    const semCota = Object.entries(motores).filter(([, u]) => esgotado(u)).map(([id, u]) => esc(u.rotulo || id));
    el.innerHTML = `
      ${semCota.length ? `<div class="alerta">⛔ ${semCota.join(" e ")} sem cota — o board passa o bastão sozinho para um motor com folga; se nenhum tiver, a fila pausa até a cota voltar.</div>` : ""}
      <div class="mgrid">${Object.entries(motores).map(([id, u]) => cartaoMotor(id, u)).join("")}</div>
      <div class="mem">🧠 <span><b>Memória compartilhada entre os motores:</b> a sessão NÃO atravessa — cada CLI tem a sua. O que atravessa, no clique de Trocar e na troca automática por falta de cota, é o bastão POR ESCRITO: a tarefa original, o resumo do agente anterior, os últimos passos dele, o que a conferência apontou e o estado da pasta (git status). Projeto, anexos, modo de entrega, ordem na fila e a esteira de conferência acompanham; só o modelo fixo é descartado, porque modelo é de uma família só.</span></div>`;
    return;
  }
  if (!USO.ok) {
    el.innerHTML = `<div class="cab"><h3>Seu plano do Claude</h3><button class="btn sm" onclick="this.disabled=true;this.textContent='lendo…';carregarUso(true)">tentar de novo</button></div>
      <div class="nota">Não consegui ler o /usage: ${esc(USO.erro || "resposta sem as porcentagens do plano")}</div>
      ${USO.bruto ? `<pre style="white-space:pre-wrap;color:var(--dim2);font-size:12px;margin:0">${esc(USO.bruto)}</pre>` : ""}`;
    return;
  }
  const lido = USO.atualizadoEm ? new Date(USO.atualizadoEm) : null;
  const ha = lido ? Math.round((Date.now() - lido.getTime()) / 60000) : null;
  el.innerHTML = `
    <div class="cab">
      <h3>Seu plano do Claude${USO.modo === "assinatura" ? " · assinatura" : ""}</h3>
      <span class="quando">${lido ? (ha < 1 ? "lido agora" : `lido há ${ha} min`) : ""}</span>
      <button class="btn sm" onclick="this.disabled=true;this.textContent='lendo… (~20 s)';carregarUso(true)">atualizar agora</button>
    </div>
    <div class="medidores">${USO.limites.map((l) => {
      const n = nivel(l.pct), resta = Math.max(0, Math.round((100 - l.pct) * 10) / 10);
      return `<div class="medidor">
        <div class="l1"><span class="n">${esc(l.nome)}</span>${NIVEL_TXT[n] ? `<span class="rot ${n}">${NIVEL_TXT[n]}</span>` : ""}</div>
        <div class="grande">${l.pct}% usado<small>restam ${resta}%</small></div>
        <div class="trilho" title="${l.pct}% usado"><div class="enche ${n}" style="width:${Math.min(100, l.pct)}%"></div></div>
        <div class="l3">${l.renovaEm ? `<span>renova ${esc(quandoCurto(l.renovaEm))}</span><span>${esc(emQuanto(l.renovaEm))}</span>` : `<span>${esc(l.renovaTexto)}</span>`}</div>
      </div>`;
    }).join("")}</div>
    ${USO.contrib.length ? `<div class="contrib">${USO.contrib.map((c) => `<div><h4>${esc(c.janela)}</h4><div class="res">${esc(c.resumo)}</div><ul>${c.itens.map((i) => `<li>${esc(i)}</li>`).join("")}</ul></div>`).join("")}</div>` : ""}
    ${USO.nota ? `<div class="nota">O detalhamento acima é aproximado: conta só as sessões deste Mac, sem outros aparelhos nem o claude.ai. As porcentagens do plano são as oficiais.</div>` : ""}
  `;
}

// `criada`: a linha da aba Pendentes — mostra quando a tarefa entrou no quadro no lugar do status
// (todas ali são pendentes) e não arrasta, porque aquela aba não é a ordem da fila.
