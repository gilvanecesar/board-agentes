// Pull Requests (#/prs): os PRs abertos de cada projeto da seleção, com os checks do GitHub, a tarefa do board
// que abriu cada um (e o que a conferência disse), e o "Mesclar" que o dono clica. Só mescla — publicar é o 🚀 de cada projeto (fim do arquivo).
let PRS = { dados: null, carregando: false, erro: null, mesclando: null };

async function carregarPrs(fresco = false) {
  PRS.carregando = true; pintarPrs();
  try { PRS.dados = await api("/prs" + (fresco ? "?fresco" : "")); PRS.erro = null; }
  catch (e) { PRS.erro = e.message; }
  PRS.carregando = false; pintarPrs();
}

const CHECK_TXT = { ok: "✓", falhou: "✗", rodando: "…", sem: "·" };
function prLinha(pr) {
  const t = pr.tarefa;
  const conf = t ? `<a class="pr-tarefa" href="#/t/${t.id}" title="${esc(t.title)}">#${t.id}</a>${t.conferindo ? ` <span class="pr-alerta">conferindo</span>` : t.reprovado ? ` <span class="pr-alerta">reprovada</span>` : t.revisor || t.qa ? ` <span class="pr-ok">conferida</span>` : ""}` : `<span class="pr-mudo">sem tarefa do board</span>`;
  const bloqueio = pr.rascunho ? "rascunho" : pr.conflito ? "conflito com a main" : "";
  const v = vigiaDoPr(pr), aviso = v && !pr.rascunho ? vigiaTxt(v) : bloqueio; // a tarefa já cuida dele: o dono não precisa fazer nada
  return `<div class="pr" data-url="${esc(pr.url)}">
    <div class="pr-main">
      <a class="pr-titulo" href="${esc(pr.url)}" target="_blank" rel="noopener">#${pr.numero} ${esc(pr.titulo)}</a>
      <div class="meta"><span>${esc(pr.branch)}</span>${pr.autor ? `<span>${esc(pr.autor)}</span>` : ""}<span title="${esc(fmtDay(pr.criadoEm))}">${esc(haQuanto(pr.criadoEm) || fmtDay(pr.criadoEm))}</span>
        <span class="pr-checks ${esc(pr.checks.estado)}" title="checks do GitHub">${CHECK_TXT[pr.checks.estado] || ""} ${esc(pr.checks.texto)}</span>${conf}${aviso ? `<span class="${v && v.estado !== "esgotado" && !pr.rascunho ? "pr-atualizando" : "pr-alerta"}">${esc(aviso)}</span>` : ""}</div>
    </div>
    <button class="btn primary" data-mesclar="${esc(pr.url)}" ${bloqueio || PRS.mesclando ? "disabled" : ""}>${PRS.mesclando === pr.url ? "mesclando…" : "Mesclar"}</button>
  </div>`;
}

function prsHtml() {
  if (PRS.erro && !PRS.dados) return `<div class="empty">Não consegui ler os PRs: ${esc(PRS.erro)}</div>`;
  if (!PRS.dados) return `<div class="empty">lendo os PRs no GitHub…</div>`;
  const total = PRS.dados.projetos.reduce((n, p) => n + p.abertos.length, 0);
  return `<div class="pr-topo"><span>${total} PR${total === 1 ? "" : "s"} aberto${total === 1 ? "" : "s"} · lido ${esc(haQuanto(PRS.dados.lidoEm) || "agora")}</span>
      <button class="btn" id="prsAtualizar" ${PRS.carregando ? "disabled" : ""}>${PRS.carregando ? "lendo…" : "↻ Atualizar"}</button></div>`
    + PRS.dados.projetos.map((p) => `<section class="pr-projeto">
      <div class="grupo"><span class="proj">${esc(p.label)}</span><b>${p.abertos.length}</b>${p.repo ? `<a class="pr-mudo" href="https://github.com/${esc(p.repo)}/pulls" target="_blank" rel="noopener">${esc(p.repo)}</a>` : ""}</div>
      ${publicarBloco(p.slug)}
      ${p.erro ? `<div class="empty">${esc(p.erro)}</div>` : p.abertos.length ? p.abertos.map(prLinha).join("") : `<div class="empty">Nenhum PR aberto.</div>`}
      ${p.mesclados.length ? `<details class="pr-mesclados"><summary>Mesclados recentes (${p.mesclados.length})</summary>${p.mesclados.map((m) =>
        `<div class="pr pr-feito"><a class="pr-titulo" href="${esc(m.url)}" target="_blank" rel="noopener">#${m.numero} ${esc(m.titulo)}</a><span class="pr-mudo">${esc(fmtDay(m.mescladoEm))}${m.tarefa ? ` · tarefa #${m.tarefa.id}` : ""}</span></div>`).join("")}</details>` : ""}
    </section>`).join("");
}

/** O "atualizando (conflito)" vem da tarefa, não da leitura do GitHub: muda sem a lista de PRs mudar. */
const assinaturaVigia = () => JSON.stringify((S.tasks || []).filter((t) => t.prVigia).map((t) => [t.prUrl, t.prVigia.estado, t.prVigia.motivo]));
function pintarPrs() {
  const el = $("#prsLista");
  if (!el) return;
  PRS.vigia = assinaturaVigia();
  el.innerHTML = prsHtml();
  if ($("#prsAtualizar")) $("#prsAtualizar").onclick = () => { carregarPrs(true); carregarPublicar(true); };
  el.querySelectorAll("[data-mesclar]").forEach((b) => { b.onclick = () => mesclarPeloBoard(b.dataset.mesclar); });
  ligarPublicar(el);
}

async function mesclarPeloBoard(url, forcar = false) {
  const pr = PRS.dados?.projetos.flatMap((p) => p.abertos.map((x) => ({ ...x, projeto: p.label }))).find((x) => x.url === url);
  if (!pr) return;
  if (!forcar && !confirm(`MESCLAR na main de ${pr.projeto}:\n\n#${pr.numero} ${pr.titulo}\n(${pr.branch} → squash, e a branch é apagada)\n\nChecks: ${pr.checks.texto}.\nIsso só mescla — publicar é o 🚀 do projeto, à parte.`)) return;
  PRS.mesclando = url; pintarPrs();
  try {
    await api("/prs/mesclar", { method: "POST", body: { url, forcar } });
    toast(`PR #${pr.numero} mesclado em ${pr.projeto}.`, 5000);
    PRS.mesclando = null; await carregarPrs(true);
  } catch (e) {
    PRS.mesclando = null; pintarPrs();
    // A trava da #188: tarefa ainda conferindo ou reprovada pede uma SEGUNDA confirmação, com o motivo escrito.
    if (/conferida|REPROVOU/.test(e.message) && confirm(`⚠ ${e.message}\n\nMesclar MESMO ASSIM?`)) return mesclarPeloBoard(url, true);
    if (!/conferida|REPROVOU/.test(e.message)) toast("Não mesclou: " + e.message, 8000, "erro");
  }
}

function renderPrs() {
  const app = $("#app");
  if (app.dataset.prs === "1" && $("#prsLista")) { renderHeader(); if (assinaturaVigia() !== PRS.vigia) pintarPrs(); return; }
  app.dataset.prs = "1"; delete app.dataset.task; delete app.dataset.conversa; delete app.dataset.busca;
  app.className = "wrap prs";
  app.innerHTML = headerHtml(`<button class="back" onclick="location.hash=''">← voltar</button>`) + workspaceIntro("prs") + mheadHtml("Pull Requests", `<span class="chip">abertos e mesclados de cada projeto · 🚀 publicar só no seu clique</span>`) + `<div id="prsLista"></div>`;
  pintarPrs();
  if (!PRS.dados || Date.now() - Date.parse(PRS.dados.lidoEm) > 30000) carregarPrs();
  carregarPublicar();
}

// ── 🚀 Publicar por projeto (#205): versão no ar × main, PRs que ainda não subiram e o botão que SÓ o dono clica ──
// O comando vem de data/publicar.json (NÃO do deploy.json, que é o "Mesclar e publicar" automático da tarefa).
let PUB = { dados: null, carregando: false, logs: {}, abertos: {}, iniciando: {} };

async function carregarPublicar(fresco = false) {
  PUB.carregando = true;
  try { PUB.dados = await api("/publicar" + (fresco ? "?fresco" : "")); } catch { /* o bloco diz "lendo…" */ }
  PUB.carregando = false;
  for (const p of PUB.dados?.projetos || []) if (p.rodando && !PUB.logs[p.slug]) await carregarLogPublicar(p.slug);
  pintarPublicarEmTudo();
}
/** A ficha da tarefa e a Central também mostram o botão: carregam o estado na 1ª vez que precisam dele. */
function garantirPublicar() { if (!PUB.dados && !PUB.carregando) carregarPublicar(); }

/**
 * Em que pé está a publicação do projeto (27/10, a #214: o dono publicou ERP e CRM que já estavam em dia, porque o
 * botão ficava igual depois do clique). A MESMA resposta no menu PRs, na Central e na ficha da tarefa:
 * rodando → ⏳ desabilitado · falhou → o botão volta com o motivo · publicado (a main não andou desde a última
 * publicação que deu certo) ou em dia (no ar = main) → sem botão, só "republicar" · senão → 🚀 Publicar.
 */
function situacaoPublicar(p) {
  if (!p || !p.configurado) return { estado: "off" };
  const u = p.ultima;
  if (p.rodando || PUB.iniciando[p.slug] || u?.emAndamento) return { estado: "rodando" };
  if (u && u.ok === false) return { estado: "falhou", motivo: u.interrompida ? "interrompida — o board caiu no meio; confira o servidor" : u.motivo || "falhou" };
  if (u?.ok && u.mainSha && p.main?.sha && p.main.sha === u.mainSha) return { estado: "publicado", u };
  if (p.emDia) return { estado: "emDia", u: u?.ok ? u : null };
  return { estado: "pendente" };
}
/** "às 14:03" hoje; "em 26/10 às 14:03" em outro dia. */
function quandoPublicou(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? `às ${fmtAt(iso)}` : `em ${d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} às ${fmtAt(iso)}`;
}
const quemPublicou = (u) => String(u?.quem || "").replace(/\s*\(clique na tela\)\s*$/, "");
/**
 * A conferência pós-publicação falhou: o aviso "não confere" ainda vale? (#244: a das 09:12 rodou sem o gh logado e
 * gravou ok=false; depois, com o gh logado, a leitura de AGORA dizia no ar = main e o ⚠ velho seguia ao lado do ✅.)
 * Vale a leitura atual: no ar = main, ou = o sha que subiu (`mainSha`) → sem aviso. Sem leitura atual (não sei qual
 * está no ar) → o aviso antigo fica: não há prova nova contra ele.
 */
function naoConfereAgora(p, mainSha) {
  const h = p?.noAr?.hash;
  if (!h) return true;
  return !(p.emDia || (mainSha && mainSha.startsWith(h)));
}
/**
 * O "⚠ não conferiu no ar" do selo da tarefa publicada (ficha), redesenhado quando o estado do 🚀 chega. `mainSha` = o que
 * subiu naquela publicação (task.publicado.mainSha); tarefa publicada antes de ele ser gravado usa o da última publicação,
 * se for a mesma (mesma hora de fim).
 */
function avisoPublicadoHtml(slug, mainSha, em) {
  const p = pubDe(slug), u = p?.ultima;
  return naoConfereAgora(p, mainSha || (u?.ok && u.fim === em ? u.mainSha : null)) ? " · ⚠ não conferiu no ar" : "";
}

/** O botão (ou o selo que fica no lugar dele). `rotulo` = o texto do botão ("🚀 Publicar" no menu, "🚀 Publicar ERP" na ficha). */
function acaoPublicarHtml(slug, { rotulo = "🚀 Publicar", sm = false } = {}) {
  const p = pubDe(slug), s = situacaoPublicar(p);
  const cls = `btn ${sm ? "sm" : "primary"}`;
  const botao = `<button class="${cls}" data-publicar="${esc(slug)}" title="Abre a confirmação com o comando e os PRs que sobem — nada roda sem o seu OK">${esc(rotulo)}</button>`;
  const republicar = `<button class="pub-republicar" data-publicar="${esc(slug)}" data-republicar="1" title="Não há nada novo para subir: pede uma confirmação a mais">republicar</button>`;
  const publicado = (u) => `publicado ${esc(quandoPublicou(u.fim || u.em))}${quemPublicou(u) ? ` por ${esc(quemPublicou(u))}` : ""}${u.conferido && !u.conferido.ok && naoConfereAgora(pubDe(slug), u.mainSha) ? ` · <span class="pr-alerta">⚠ a versão no ar não confere</span>` : ""}`;
  if (s.estado === "off") return "";
  if (s.estado === "rodando") return `<button class="${cls}" data-publicar="${esc(slug)}" disabled aria-busy="true">⏳ publicando…</button>`;
  if (s.estado === "falhou") return `<span class="pub-motivo pr-alerta" title="${esc(s.motivo)}">✗ a última falhou: ${esc(s.motivo)}</span>${botao}`;
  if (s.estado === "publicado") return `<span class="pub-feito">✅ ${publicado(s.u)}</span>${republicar}`;
  if (s.estado === "emDia") return `<span class="pub-feito">✅ em dia${s.u ? " · " + publicado(s.u) : ""}</span>${republicar}`;
  return botao;
}

/** Redesenha o botão onde ele estiver: menu PRs inteiro, coluna da Central e cada [data-pubacao] (ficha da tarefa). */
function pintarPublicarEmTudo() {
  pintarPrs();
  if (typeof pintarLadoCentral === "function") pintarLadoCentral();
  document.querySelectorAll("[data-pubacao]").forEach((el) => { el.innerHTML = acaoPublicarHtml(el.dataset.pubacao, { rotulo: el.dataset.rotulo || undefined, sm: el.dataset.sm === "1" }); });
  document.querySelectorAll("[data-pubaviso]").forEach((el) => { el.textContent = avisoPublicadoHtml(el.dataset.pubaviso, el.dataset.pubsha, el.dataset.pubem); });
}
async function carregarLogPublicar(slug) {
  try { PUB.logs[slug] = (await api(`/publicar/${encodeURIComponent(slug)}/log`)).events || []; } catch { PUB.logs[slug] = []; }
}
const pubDe = (slug) => (PUB.dados?.projetos || []).find((p) => p.slug === slug);
const curto = (h) => esc(String(h || "").slice(0, 7));

/** O texto do log da ÚLTIMA publicação (do último "inicio" em diante): saída do comando, fim e conferência. */
function textoDoLogPublicar(evs = []) {
  let i = evs.map((e) => e.t).lastIndexOf("inicio");
  const ult = i < 0 ? evs : evs.slice(i);
  return ult.map((e) => e.t === "saida" ? e.texto
    : e.t === "inicio" ? `▶ ${fmtDay(e.at)} — ${e.texto || ""}\n$ ${e.comando}\n`
    : e.t === "fim" ? `\n${e.status === "publicado" ? "✓ comando terminou bem" : "✗ " + (e.motivo || "falhou")}${e.dur ? ` (${fmtDur(e.dur)})` : ""}\n${e.cauda && !/\S/.test(ult.filter((x) => x.t === "saida").map((x) => x.texto).join("")) ? e.cauda + "\n" : ""}`
    : e.t === "conferido" ? e.texto + "\n" : "").join("");
}

function publicarBloco(slug) {
  const p = pubDe(slug);
  if (!PUB.dados) return "";
  if (!p) return "";
  if (!p.configurado) return `<div class="pub pub-off">🚀 Publicar desligado — para ligar, escreva o comando de ${esc(p.label || nomeProj(slug))} em <code>board/data/publicar.json</code>.<details class="pasta-rec"><summary>como</summary><code>{"${esc(slug)}": {"comando": "…", "conferir": "https://…"}}</code></details></div>`;
  const noAr = p.noAr ? (p.noAr.hash ? `<b>${curto(p.noAr.hash)}</b>${p.noAr.versao ? ` (v${esc(p.noAr.versao)})` : ""}` : `<span class="pr-alerta" title="${esc(p.noAr.erro || "")}">não sei</span>`) : `<span class="pr-mudo" title="sem 'conferir' em data/publicar.json">sem leitura</span>`;
  const main = p.main ? `<b>${curto(p.main.hash)}</b>` : `<span class="pr-alerta" title="${esc(p.erroMain || "")}">não li</span>`;
  const pend = p.pendentes
    ? p.emDia ? `<span class="pr-ok">em dia: nada mesclado esperando</span>`
      : `<span class="pr-alerta">${p.pendentes.n} PR${p.pendentes.n === 1 ? "" : "s"} mesclado${p.pendentes.n === 1 ? "" : "s"} não publicado${p.pendentes.n === 1 ? "" : "s"}</span>${p.pendentes.prs.length ? " " + p.pendentes.prs.map((x) => `<span title="${esc(x.titulo)}">#${x.numero}</span>`).join(" ") : ""}${p.pendentes.semPr ? ` <span class="pr-mudo">+ ${p.pendentes.semPr} commit(s) sem PR</span>` : ""}${p.pendentes.fonte === "ultima-publicacao" ? ` <span class="pr-mudo">(desde a última publicação pelo board)</span>` : ""}`
    : `<span class="pr-mudo">PRs a subir: não sei — ${esc(p.pendentesMotivo || "")}</span>`;
  const u = p.ultima;
  const ultima = u ? `<span class="pr-mudo">última: ${esc(fmtDay(u.em))} · ${esc(u.quem || "")} · ${u.emAndamento ? "rodando" : u.ok ? "✓ terminou bem" + (u.conferido ? u.conferido.ok ? " · conferida no ar" : naoConfereAgora(p, u.mainSha) ? " · ⚠ não conferiu no ar" : " · a conferência de então falhou, mas no ar agora é a versão que subiu" : "") : u.interrompida ? "✗ interrompida" : "✗ " + esc(u.motivo || "falhou")}</span>` : "";
  const log = PUB.logs[slug];
  const mostrarLog = p.rodando || PUB.abertos[slug];
  return `<div class="pub" data-pub="${esc(slug)}">
    <div class="pub-linha">
      <div class="pub-info"><span>No ar: ${noAr}</span><span>main: ${main}</span>${pend}</div>
      <div class="pub-acao" data-pubacao="${esc(slug)}">${acaoPublicarHtml(slug)}</div>
    </div>
    <div class="pub-pe">${ultima}${u ? ` <button class="btn sm" data-publog="${esc(slug)}">${mostrarLog ? "esconder log" : "ver log"}</button>` : ""}</div>
    ${mostrarLog && log ? `<pre class="md-code pub-log" data-publogtxt="${esc(slug)}"><code>${esc(textoDoLogPublicar(log))}</code></pre>` : ""}
  </div>`;
}

/** A confirmação: o comando EXATO, a pasta onde roda e os PRs que vão subir. Só depois disso o servidor aceita. */
async function publicarProjeto(slug) {
  if (PUB.iniciando[slug]) return;
  let p;
  try { p = await api(`/publicar/${encodeURIComponent(slug)}?fresco`); } catch (e) { return toast("Não consegui ler o estado da publicação: " + e.message, 8000, "erro"); }
  if (!p.configurado) return toast(`Publicar desligado para ${nomeProj(slug)}: escreva o comando em board/data/publicar.json.`, 9000);
  if (p.rodando) { carregarPublicar(); return toast(`Já há uma publicação de ${p.label} rodando.`, 5000); }
  // Nada novo para subir (no ar = main, ou a main não andou desde a última publicação): uma confirmação A MAIS, dizendo isso.
  const s = situacaoPublicar(p);
  if ((s.estado === "emDia" || s.estado === "publicado")
    && !confirm(`NÃO HÁ NADA NOVO para publicar em ${p.label}.\n\n${s.estado === "emDia" ? `A versão no ar já é a main (${p.main?.hash || "?"}).` : `A main (${p.main?.hash || "?"}) é a mesma da última publicação, ${quandoPublicou(s.u.fim || s.u.em)}${quemPublicou(s.u) ? ` por ${quemPublicou(s.u)}` : ""}.`}\nRepublicar roda o comando de novo em produção, sem nenhum PR novo.\n\nRepublicar mesmo assim?`)) return;
  const sobem = p.pendentes ? (p.pendentes.prs.length ? p.pendentes.prs.map((x) => `  #${x.numero} ${x.titulo}`).join("\n") : "  (nenhum PR — " + (p.emDia ? "a versão no ar já é a main" : `${p.pendentes.commits} commit(s) sem PR`) + ")") : `  não sei — ${p.pendentesMotivo}`;
  const pasta = p.pasta ? `\nPasta: branch ${p.pasta.branch}${p.pasta.sujos ? `, ${p.pasta.sujos} arquivo(s) alterado(s) sem commit` : ", limpa"}.` : "";
  if (!confirm(`PUBLICAR ${p.label} EM PRODUÇÃO?\n\nComando (roda na pasta de ${p.label}):\n$ ${p.comando}\n${pasta}\nNo ar: ${p.noAr?.hash ? p.noAr.hash.slice(0, 7) : "não sei"} · main: ${p.main?.hash || "não li"}\nVai subir:\n${sobem}\n\n${p.conferir ? `Depois eu confiro a versão no ar em ${p.conferir}.` : "Sem 'conferir': não vou conseguir conferir a versão no ar."}`)) return;
  // ⏳ já no clique: o servidor ainda lê o estado antes de começar, e o botão não pode ficar clicável nesse meio-tempo.
  PUB.iniciando[slug] = true; pintarPublicarEmTudo();
  try {
    await api(`/publicar/${encodeURIComponent(slug)}`, { method: "POST", body: { confirmo: p.comando } });
    toast(`🚀 Publicando ${p.label} — o log aparece no menu Pull Requests.`, 5000, "info");
    PUB.abertos[slug] = true; PUB.logs[slug] = [];
    delete PUB.iniciando[slug];
    if (view.name !== "prs") location.hash = "#/prs";
    await carregarPublicar();
  } catch (e) {
    delete PUB.iniciando[slug];
    toast("Não publicou: " + e.message, 8000, "erro");
    await carregarPublicar();
  }
}

/** Log ao vivo (SSE "log" com id publicar-<slug>): só redesenha o <pre>, sem refazer a tela. */
function aoLogDePublicar(slug, ev) {
  if (!PUB.logs[slug]) return;
  PUB.logs[slug].push(ev);
  const pre = document.querySelector(`[data-publogtxt="${CSS.escape(slug)}"]`);
  if (!pre) return;
  const fim = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
  pre.querySelector("code").textContent = textoDoLogPublicar(PUB.logs[slug]);
  if (fim) pre.scrollTop = pre.scrollHeight;
}

// O 🚀 de qualquer tela (menu PRs, Central, ficha da tarefa): escuta delegada, porque o botão é redesenhado a cada evento.
document.addEventListener("click", (e) => {
  const b = e.target.closest && e.target.closest("[data-publicar]");
  if (b && !b.disabled) publicarProjeto(b.dataset.publicar);
});

function ligarPublicar(el) {
  el.querySelectorAll("[data-publog]").forEach((b) => {
    b.onclick = async () => {
      const s = b.dataset.publog;
      PUB.abertos[s] = !PUB.abertos[s];
      if (PUB.abertos[s]) await carregarLogPublicar(s);
      pintarPrs();
    };
  });
  el.querySelectorAll(".pub-log").forEach((pre) => { pre.scrollTop = pre.scrollHeight; });
}
