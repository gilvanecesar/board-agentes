// Utilitários da tela: estado (S), formatação, markdown, api(), toast e o uso do plano.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const STATUS_LABEL = { pendente: "Pendente", fila: "Na fila", rodando: "Rodando", executada: "Executada", concluida: "Concluída", erro: "Erro" };
// `busy` sem `rodando` é a tarefa respondendo no chat: também está trabalhando, e a tela
// precisa dizer isso — senão o agente trabalha e o quadro continua escrito "Pendente".
const trabalhando = (t) => t.status === "rodando" || t.busy;
// ⚡ aprovado que NÃO entrou na pasta principal (26/10: a #200 ficou assim parecendo "executada"). Estado próprio na tela toda.
const naoJuntada = (t) => (t.worktree || {}).juntar === "conflito" && !t.worktree.removida;
// Quando a tarefa em erro volta sozinha — ou por que não volta.
const retryTxt = (t) => {
  if (!t.retentativa) return "";
  const h = new Date(t.retentativa.em).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return t.retentativa.tipo === "cota" ? `⏸ espera a cota: volta às ${h}` : `↻ volta às ${h} (${t.retentativa.n}/${t.retentativa.max})`;
};
const ETAPA = { agente: "Rodando", portao: "Verificando", revisor: "Revisando", qa: "Testando (QA)", entrega: "Entregando", merge: "Mesclando", deploy: "Publicando" };
const ENTREGA_LABEL = { direto: "Direto na pasta (sem PR)", pr: "Abrir Pull Request (o dono revisa)", deploy: "PR, mesclar e publicar (o board faz tudo)" };
const estado = (t) => t.status === "rodando" ? { cls: "rodando", label: ETAPA[t.etapa] || "Rodando" }
  : t.busy ? { cls: "rodando", label: "Respondendo" }
  : t.status === "fila" && t.acao ? { cls: "fila", label: t.acao === "deploy" ? "Na fila · publicar" : "Na fila · PR" }
  : t.status === "erro" && t.retentativa ? { cls: "fila", label: t.retentativa.tipo === "cota" ? "Esperando cota" : "Vai tentar de novo" }
  : naoJuntada(t) && t.status !== "concluida" ? { cls: "naojuntada", label: "Não juntada — conflito" }
  : { cls: t.status, label: STATUS_LABEL[t.status] };
// Selos do que já foi conferido: o dono precisa ver "passou no portão" sem abrir a tarefa.
const selos = (t) => [
  t.gate ? `<span class="selo ${t.gate.ok ? "ok" : "nao"}" title="${esc(t.gate.comando)}">⛨ portão ${t.gate.ok ? "✓" : "✗"}</span>` : "",
  t.revisor ? `<span class="selo ${t.revisor.veredito === "APROVADO" ? "ok" : "nao"}">🔍 revisor ${t.revisor.veredito === "APROVADO" ? "✓" : "✗"}</span>` : "",
  t.qa ? `<span class="selo ${t.qa.veredito === "APROVADO" ? "ok" : "nao"}">🧪 QA ${t.qa.veredito === "APROVADO" ? "✓" : "✗"}</span>` : "",
  t.merged ? `<span class="selo ok">⇪ mesclado</span>` : "",
  t.deploy ? `<span class="selo ${t.deploy.ok ? "ok" : "nao"}" title="${esc(t.deploy.comando)}">⇪ publicado ${t.deploy.ok ? "✓" : "✗"}</span>` : "",
].join("");
const ORDER = { rodando: 0, fila: 1, pendente: 2, erro: 3, executada: 4, concluida: 5 };
const fmtCost = (v) => v ? "US$ " + Number(v).toFixed(2) : "";
const cutTxt = (s, n) => { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const fmtDur = (ms) => { if (!ms) return ""; const m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000); return m ? `${m}min ${s}s` : `${s}s`; };
const fmtAt = (iso) => iso ? new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "";
const fmtDay = (iso) => iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
// Há quanto tempo a tarefa está parada — o que faz a aba Pendentes valer como lembrete.
const haQuanto = (iso) => {
  if (!iso) return "";
  const dias = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return dias >= 1 ? `há ${dias} dia${dias > 1 ? "s" : ""}` : "";
};
// O que um porte faz neste motor: no Claude é esforço (o modelo não muda); nos outros, o modelo do porte.
const efeitoPorte = (motor, p) => {
  const c = CAT[motor || "claude"] || {};
  if (c.portes?.[p]) return c.portes[p];
  if (c.esforcos) return c.esforcos[p] ? "esforço " + c.esforcos[p] : "esforço padrão";
  return "";
};
// "claude-opus-5-5" → "Opus 5.5": o nome que o dono reconhece.
const nomeModelo = (m) => {
  const x = String(m || "");
  const r = x.match(/^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i);
  if (r) return r[1][0].toUpperCase() + r[1].slice(1) + " " + r[2] + (r[3] ? "." + r[3] : "");
  if (/^(opus|sonnet|haiku)$/i.test(x)) return x[0].toUpperCase() + x.slice(1);
  return x || "padrão";
};
const rotuloAgente = (t) => `#${t.agente} · ${nomeModelo(t.modeloUsado)}${t.esforcoUsado ? " · " + t.esforcoUsado : ""}`;
// O agente aparece enquanto trabalha; na tarefa ⚡ fica sempre (é a cópia dele).
const agenteSelo = (t) => t.agente && (trabalhando(t) || t.paralelo)
  ? `<span class="agente${trabalhando(t) ? " on" : ""}" title="agente, modelo e esforço desta tarefa${t.paralelo ? " — cópia isolada (⚡ paralelo)" : ""}">${t.paralelo ? "⚡ " : ""}${esc(rotuloAgente(t))}</span>` : "";
const juntarSelo = (t) => {
  const j = (t.worktree || {}).juntar;
  if (j === "ok") return `<span class="selo ok" title="o trabalho da cópia já está na pasta principal">⇲ juntou</span>`;
  if (j === "pendente") return `<span class="selo" title="junta quando a pasta principal estiver livre">⇲ esperando a pasta</span>`;
  if (j === "consertando") return `<span class="selo" title="a junção deu conflito: o agente está resolvendo na cópia, com o estado atual da pasta principal trazido para ela">⇄ resolvendo conflito da junção</span>`;
  if (j === "conflito") return `<span class="selo nao naojuntada" title="${esc(((t.worktree.conflito || {}).motivo || "conflito com a pasta principal") + ": nada foi aplicado; o trabalho está em " + t.worktree.dir)}">⚠ não juntada — conflito</span>`;
  return "";
};
// A vigia dos PRs (#279): "atualizando" diz ao dono que não precisa fazer nada; "precisa de você" só depois de esgotar.
const prEsgotado = (t) => t.prVigia?.estado === "esgotado";
const vigiaDoPr = (pr) => (S.tasks || []).find((t) => t.prUrl === pr.url)?.prVigia || null;
const vigiaTxt = (v) => v.estado === "esgotado" ? `${v.motivo === "checks" ? "PR com check falhando" : "PR em conflito"} — precisa de você`
  : `atualizando (${v.motivo === "checks" ? "check falhando" : "conflito"})`;
/** O chat consertou uma tarefa reprovada e portão, revisor e QA ainda não rodaram (#288). */
const faltaConferir = (t) => !!t.conferir && t.status === "fila";
const conferirSelo = (t) => faltaConferir(t) ? `<span class="pr-atualizando" title="o chat mudou arquivo depois da reprovação">falta conferir</span>` : "";
const prVigiaSelo = (t) => t.prVigia
  ? `<span class="selo${prEsgotado(t) ? " nao naojuntada" : ""}" title="${esc(t.prVigia.porque || (t.prVigia.estado === "esperando" ? "a tarefa está andando: volta para atualizar quando ela terminar" : `o board devolveu a tarefa para atualizar o mesmo PR (tentativa ${t.prVigia.n} de ${t.prVigia.max}); não precisa fazer nada`))}">⇄ ${esc(vigiaTxt(t.prVigia))}</span>` : "";
const store = { get: (k, d) => { try { return JSON.parse(localStorage.getItem("board." + k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem("board." + k, JSON.stringify(v)); } catch {} } };
// Rascunho por caixa (26/10, "o texto não pode sumir"): gravado a cada tecla, devolvido quando a caixa
// é desenhada de novo (trocar de aba refaz a tela), apagado só ao enviar. Vazio sai do localStorage.
const rascunho = {
  ler: (k) => store.get("rascunho." + k, ""),
  gravar: (k, v) => { if (v) store.set("rascunho." + k, v); else try { localStorage.removeItem("board.rascunho." + k); } catch {} },
};
function ligarRascunho(ta, chave) {
  ta.dataset.rascunho = chave; // é o que diz ao ditado que a caixa continua a mesma
  if (!ta.value) ta.value = rascunho.ler(chave);
  ta.addEventListener("input", () => rascunho.gravar(chave, ta.value));
  autoAltura(ta);
}

// A caixa de escrever cresce com o texto (28/10, #225: "ele tá comendo as frases"). Altura = conteúdo, de 1 linha
// até o teto (40% da janela ou 12 linhas, o menor), sempre um número INTEIRO de linhas — nunca corta linha ao meio.
// Passou do teto, rola por dentro com o cursor à vista. Vale para toda caixa de escrever (Central, conversa, chat, nova).
// A altura é dada por `rows`, não por px: o Safari tem `zoom` no <html> e misturar px do CSS com scrollHeight errava a
// conta. Linha e padding saem do próprio elemento (clientHeight com rows=1 e rows=2), na mesma unidade do scrollHeight.
const ALTURA_LINHAS_MAX = 12;
function autoAltura(ta) {
  if (!ta || !ta.isConnected) return;
  const rolagem = window.scrollY, dentro = ta.scrollTop;
  ta.style.height = ""; ta.style.minHeight = "0"; ta.style.overflowY = "hidden";
  ta.rows = 1; const h1 = ta.clientHeight, t1 = ta.getBoundingClientRect().height;
  ta.rows = 2; const linha = ta.clientHeight - h1, linhaTela = ta.getBoundingClientRect().height - t1;
  ta.rows = 1;
  // Vazia = tamanho mínimo (o Chrome conta o placeholder no scrollHeight). Escondida (sem layout) também fica com 1
  // linha; é medida de novo quando aparecer.
  if (linha > 0 && ta.value) {
    const linhas = Math.max(1, Math.round((ta.scrollHeight - (h1 - linha)) / linha)); // scrollHeight = texto + padding
    const teto = Math.max(1, Math.min(ALTURA_LINHAS_MAX, Math.floor(window.innerHeight * 0.4 / linhaTela)));
    ta.rows = Math.min(linhas, teto);
    ta.style.overflowY = linhas > teto ? "auto" : "hidden";
    // Rolando por dentro: cursor no fim → mostra o fim; no meio, volta onde estava (o navegador já o pôs à vista).
    if (linhas > teto) ta.scrollTop = ta.selectionEnd === ta.value.length ? ta.scrollHeight : dentro;
  }
  ta.style.minHeight = "";
  if (window.scrollY !== rolagem) window.scrollTo(window.scrollX, rolagem);
}
function ligarAltura(ta) {
  if (!ta) return;
  ta.addEventListener("input", () => autoAltura(ta));
  autoAltura(ta);
  requestAnimationFrame(() => autoAltura(ta)); // caixa recém-desenhada: mede de novo depois do layout (fontes, grid)
}
let alturaResize = 0;
window.addEventListener("resize", () => {
  cancelAnimationFrame(alturaResize);
  alturaResize = requestAnimationFrame(() => document.querySelectorAll("textarea.cresce").forEach(autoAltura));
});

// Markdown da resposta do agente → HTML. Escapa ANTES de tudo: o texto vem de um modelo e não é confiável.
function mdInline(s) {
  return s.split(/(`[^`]+`)/g).map((p) => (p.length > 1 && p.startsWith("`") && p.endsWith("`"))
    ? `<code>${p.slice(1, -1)}</code>`
    : p.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*(?!\s)([^*]+?)\*(?!\w)/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
  ).join("");
}
function mdToHtml(txt) {
  if (!txt) return "";
  const L = esc(txt).replace(/\r/g, "").split("\n");
  const out = [];
  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l || "");
  const isSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l || "");
  const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => mdInline(c.trim()));
  const ITEM = /^\s*([-*+]|\d+[.)])\s+/;
  const HR = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
  let i = 0;
  while (i < L.length) {
    const l = L[i];
    let m;
    if (/^\s*```/.test(l)) {
      const buf = []; i++;
      while (i < L.length && !/^\s*```/.test(L[i])) buf.push(L[i++]);
      i++;
      out.push(`<pre class="md-code"><code>${buf.join("\n")}</code></pre>`);
    } else if (!l.trim()) {
      i++;
    } else if ((m = l.match(/^(#{1,4})\s+(.*)$/))) {
      const n = Math.min(m[1].length + 1, 4);
      out.push(`<h${n}>${mdInline(m[2])}</h${n}>`); i++;
    } else if (HR.test(l)) {
      out.push("<hr>"); i++;
    } else if (isRow(l) && isSep(L[i + 1])) {
      const head = cells(l); i += 2;
      const rows = [];
      while (i < L.length && isRow(L[i])) rows.push(cells(L[i++]));
      out.push(`<div class="md-tw"><table class="md-table"><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
    } else if (/^\s*&gt;\s?/.test(l)) {
      const buf = [];
      while (i < L.length && /^\s*&gt;\s?/.test(L[i])) buf.push(mdInline(L[i++].replace(/^\s*&gt;\s?/, "")));
      out.push(`<blockquote>${buf.join("<br>")}</blockquote>`);
    } else if (ITEM.test(l)) {
      const ordered = /^\s*\d+[.)]\s+/.test(l), inicio = parseInt(l, 10) || 1, items = [];
      while (i < L.length && ITEM.test(L[i])) {
        const sub = L[i].match(/^\s*/)[0].length >= 2;
        let corpo = mdInline(L[i].replace(ITEM, "")); i++;
        while (i < L.length && L[i].trim() && /^\s{2,}/.test(L[i]) && !ITEM.test(L[i])) corpo += "<br>" + mdInline(L[i++].trim());
        items.push(`<li${sub ? ' class="sub"' : ""}>${corpo}</li>`);
      }
      out.push(ordered ? `<ol${inicio > 1 ? ` start="${inicio}"` : ""}>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
    } else {
      const buf = [mdInline(L[i++])];
      while (i < L.length && L[i].trim() && !/^\s*(```|#{1,4}\s|&gt;)/.test(L[i]) && !ITEM.test(L[i]) && !HR.test(L[i]) && !(isRow(L[i]) && isSep(L[i + 1]))) buf.push(mdInline(L[i++]));
      out.push(`<p>${buf.join("<br>")}</p>`);
    }
  }
  return out.join("");
}


let S = { tasks: [], projects: [], config: {} };
// O nome do projeto NA TELA (#249): sempre o rótulo de data/projetos.json ("CRM"), nunca o slug da pasta ("acme" é outra
// empresa). `S.rotulos` vale também para projeto escondido; sem rótulo, o slug é o nome. Caminho de pasta: `pastaRecolhida`.
const nomeProj = (slug) => (S.rotulos || {})[slug] || (S.projects || []).find((p) => p.slug === slug)?.label || slug;
/** Nome técnico que leva o slug (container "crm-antigo-prod-app-1", imagem "crm-antigo:v0.1"): o slug vira o rótulo, como
 *  palavra inteira, e a repetição que sobra some ("crm-CRM-prod" → "CRM-prod"). Só a TELA muda; o nome de verdade é o do Docker. */
function nomeNaTela(texto) {
  const q = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let s = String(texto ?? "");
  for (const [slug, rot] of Object.entries(S.rotulos || {})) {
    if (!rot || slug === rot) continue;
    s = s.replace(new RegExp(`(^|[^a-z0-9])${q(slug)}(?=$|[^a-z0-9])`, "gi"), (_, a) => a + rot)
      .replace(new RegExp(`(^|[^a-z0-9])${q(rot)}[-_ ]${q(rot)}(?=$|[^a-z0-9])`, "gi"), (_, a) => a + rot);
  }
  return s;
}
/** Caminho de pasta só por motivo técnico: recolhido, aparece no clique (o slug da pasta pode ser um nome que não vai à tela). */
const pastaRecolhida = (caminho, rotulo = "pasta") => caminho ? `<details class="pasta-rec"><summary>${esc(rotulo)}</summary><code>${esc(caminho)}</code></details>` : "";
let connected = false;
let view = { name: "list", id: null };
let logCache = {};    // id → eventos
let tarefaCheia = {}; // id → tarefa com texto e resumo (o estado da lista vem sem eles)
let lastLine = {}; // id → último evento textual (pra mostrar na lista)

async function api(path, opts = {}) {
  const r = await fetch("/api" + path, { headers: { "content-type": "application/json" }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ("erro " + r.status));
  return d;
}
// Som de envio (27/10, pedido do dono: "o mesmo som do iMessage"): um swoosh curto SINTETIZADO na hora — nada de
// arquivo de som da Apple no repo (é deles, e o board tem cópia pública). Toca só no envio que deu certo.
// 🔔/🔕 no cabeçalho, guardado no navegador, ligado por padrão. Safari só toca áudio depois de interação: o contexto é
// criado e destravado no 1º toque/tecla do dono; quando o envio volta do servidor (depois de um await) ele já está pronto.
// 28/10 (#223): o dono achou baixo — o ganho subiu (pico 0,5 × volume; antes 0,07 fixo) e há um volume (0–100%,
// `board.somVolume`, padrão 70%) ao lado do 🔔. O teto fica abaixo de 1 somando senoide + ruído: não distorce.
const somEnvio = {
  ctx: null, vezes: 0,
  ligado: () => store.get("somEnvio", true) !== false,
  volume: () => { const v = Number(store.get("somVolume", 0.7)); return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.7; },
  contexto() {
    if (!somEnvio.ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null; try { somEnvio.ctx = new AC(); } catch { return null; } }
    if (somEnvio.ctx.state === "suspended") somEnvio.ctx.resume().catch(() => {});
    return somEnvio.ctx;
  },
  tocar() {
    if (!somEnvio.ligado()) return;
    somEnvio.vezes++;
    const ac = somEnvio.contexto(); if (!ac) return;
    const pico = 0.5 * somEnvio.volume(); if (pico < 0.001) return;
    try {
      const t = ac.currentTime + 0.01, dur = 0.15;
      const vol = ac.createGain(); vol.connect(ac.destination);
      // Envelope: sobe rápido, cai até quase zero em ~150 ms.
      vol.gain.setValueAtTime(0.0001, t); vol.gain.exponentialRampToValueAtTime(pico, t + 0.015); vol.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      // O "fiu": senoide varrendo para cima, rápida.
      const osc = ac.createOscillator(); osc.type = "sine";
      osc.frequency.setValueAtTime(380, t); osc.frequency.exponentialRampToValueAtTime(1500, t + dur * 0.8);
      osc.connect(vol); osc.start(t); osc.stop(t + dur + 0.02);
      // O ar do swoosh: um pouco de ruído passando por um filtro que varre junto.
      const n = Math.floor(ac.sampleRate * dur), buf = ac.createBuffer(1, n, ac.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      const ruido = ac.createBufferSource(); ruido.buffer = buf;
      const filtro = ac.createBiquadFilter(); filtro.type = "bandpass"; filtro.Q.value = 1.2;
      filtro.frequency.setValueAtTime(900, t); filtro.frequency.exponentialRampToValueAtTime(4000, t + dur);
      const arVol = ac.createGain(); arVol.gain.value = 0.35;
      ruido.connect(filtro); filtro.connect(arVol); arVol.connect(vol); ruido.start(t); ruido.stop(t + dur);
    } catch { /* som é enfeite: nunca atrapalha o envio */ }
  },
  // Som de RECEBIMENTO (#223): um sininho de 3 notas subindo (Sol5 → Dó6 → Mi6), cada uma senoide + um parcial
  // inarmônico (×2,76, o "metal" do sino) com ataque curto e queda exponencial — ~420 ms. Sintetizado, nada da Apple.
  recebidas: 0,
  receber() {
    if (!somEnvio.ligado()) return;
    somEnvio.recebidas++;
    const ac = somEnvio.contexto(); if (!ac) return;
    const pico = 0.28 * somEnvio.volume(); if (pico < 0.001) return;
    try {
      const t0 = ac.currentTime + 0.01;
      [784, 1046.5, 1318.5].forEach((f, i) => {
        const t = t0 + i * 0.09, dur = 0.33;
        const vol = ac.createGain(); vol.connect(ac.destination);
        vol.gain.setValueAtTime(0.0001, t); vol.gain.exponentialRampToValueAtTime(pico, t + 0.006); vol.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        [[f, 1], [f * 2.76, 0.18]].forEach(([freq, nivel]) => {
          const osc = ac.createOscillator(); osc.type = "sine"; osc.frequency.setValueAtTime(freq, t);
          const g = ac.createGain(); g.gain.value = nivel; osc.connect(g); g.connect(vol);
          osc.start(t); osc.stop(t + dur + 0.02);
        });
      });
    } catch { /* enfeite */ }
  },
};
["pointerdown", "keydown"].forEach((ev) => document.addEventListener(ev, () => { if (somEnvio.ligado()) somEnvio.contexto(); }, { capture: true, passive: true }));
// O que chega ao vivo (SSE `log`) e merece o sininho. Histórico vem pela API, nunca por aqui, e o SSE não repete o
// passado ao reconectar: recarregar a página não toca. A mensagem do próprio dono (`dono`) nunca toca.
// - ✉ mensagem de outra sessão na Central (`sessao`);
// - `resultado` com texto de uma conversa (projeto ou Central) — menos o que fecha um turno espontâneo, que já tocou no ✉;
// - `resultado` do AGENTE numa tarefa só quando responde a uma mensagem do chat dela (revisor, QA e rodada da fila não tocam).
function deveTocarRecebida(id, ev, anteriores) {
  if (id === "conversa-central" && VOZ.ligado()) return false; // 🎙 quem avisa é a própria fala, e o sininho entraria no microfone
  if (ev.t === "sessao") return String(id).startsWith("conversa-");
  if (ev.t !== "resultado" || !String(ev.texto || "").trim() || ev.importado) return false; // histórico trazido do terminal (#234) não toca
  if (ev.quem && ev.quem !== "agente") return false;
  let gatilho = null; // o que veio desde o resultado anterior: o dono escreveu, ou outra sessão mandou
  for (let i = anteriores.length - 1; i >= 0; i--) {
    const a = anteriores[i];
    if (a.t === "resultado") break;
    if (a.t === "dono" || a.t === "sessao") { gatilho = a.t; break; }
  }
  if (String(id).startsWith("conversa-")) return gatilho !== "sessao";
  return gatilho === "dono";
}
const somBotao = () => (somEnvio.ligado()
  ? `<button class="ib som-envio" style="display:inline-grid;width:22px;height:22px;vertical-align:middle" title="Sons do chat (envio e resposta): ligados (clique para desligar)" aria-pressed="true" onclick="alternarSom(this)">🔔</button>`
  : `<button class="ib som-envio" style="display:inline-grid;width:22px;height:22px;vertical-align:middle" title="Sons do chat (envio e resposta): desligados (clique para ligar)" aria-pressed="false" onclick="alternarSom(this)">🔕</button>`)
  + `<input type="range" class="som-volume" min="0" max="100" step="5" value="${Math.round(somEnvio.volume() * 100)}" title="Volume dos sons: ${Math.round(somEnvio.volume() * 100)}%" aria-label="Volume dos sons" style="width:64px;height:22px;vertical-align:middle;accent-color:var(--accent,#b9ed80)" oninput="mudarVolume(this)" onchange="mudarVolume(this, true)">`;
function alternarSom(btn) {
  store.set("somEnvio", !somEnvio.ligado());
  if (btn) { const v = btn.nextElementSibling; if (v && v.classList.contains("som-volume")) v.remove(); btn.outerHTML = somBotao(); }
  if (somEnvio.ligado()) somEnvio.tocar(); // ouvir o som na hora em que liga
}
function mudarVolume(el, soltou = false) {
  store.set("somVolume", Math.min(1, Math.max(0, Number(el.value) / 100)));
  el.title = `Volume dos sons: ${el.value}%`;
  if (soltou && somEnvio.ligado()) somEnvio.receber(); // ouvir como ficou
}

function toast(msg, ms = 3500, tipo = "") { const t = document.createElement("div"); t.className = "toast" + (tipo ? " " + tipo : ""); t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), ms); }

// Plano do Claude: o servidor devolve a última leitura na hora e avisa ("uso") quando atualiza.
let USO = null;
let GASTO = null; // o que cada motor gastou nas tarefas do board (vem do /api/usage, por motor)
let CAT = {}; // catálogo de modelos por motor (vem do /api/modelos)
async function carregarModelos() { try { CAT = await api("/modelos"); render(); } catch { /* segue com o padrão */ } }
const nivel = (pct) => (pct >= 90 ? "limite" : pct >= 70 ? "atencao" : "ok");
const NIVEL_TXT = { ok: "", atencao: "⚠ atenção", limite: "⛔ quase no limite" };
async function carregarUso(fresco = false) {
  try { USO = await api("/claude-uso" + (fresco ? "?fresco=1" : "")); } catch { return; }
  renderHeader();
}
// Telas que saíram do menu em 04/11 (pedido do dono): aba guardada ou destino antigo cai no quadro. As APIs ficam.
const TELAS_REMOVIDAS = ["navegador", "memoria", "consumo", "monitoring"];
// A cota de cada motor (a ficha da tarefa mostra ao lado do "⇄ passar para"). Quem manda é o SERVIDOR (`pct`/`semCota`);
// o cálculo local é só o socorro para um servidor antigo no ar. (Moravam no consumo.js, que saiu com a tela.)
const pctLocal = (u) => {
  if (!u || !u.ok || !u.limites?.length) return null;
  const curtos = u.limites.filter((l) => !/semana|week/i.test(l.nome));
  return Math.max(...(curtos.length ? curtos : u.limites).map((l) => l.pct));
};
const pctUso = (u) => (u && u.pct != null ? u.pct : pctLocal(u));
const emQuanto = (iso) => {
  const ms = new Date(iso).getTime() - Date.now(); if (!(ms > 0)) return "";
  const min = Math.round(ms / 60000), h = Math.floor(min / 60), d = Math.floor(h / 24);
  return d >= 1 ? `em ${d} dia${d > 1 ? "s" : ""} e ${h % 24}h` : h >= 1 ? `em ${h}h ${min % 60}min` : `em ${min} min`;
};
const quandoCurto = (iso) => new Date(iso).toLocaleString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

// Eventos chegam em rajada (uma tarefa rodando dispara vários seguidos). Redesenhar a lista a cada
// um deixava a tela pesada; aqui eles se juntam em uma atualização só.
let stateAgendado = null;
function agendarState() {
  if (stateAgendado) return;
  stateAgendado = setTimeout(() => { stateAgendado = null; loadState(); }, 250);
}
/** Assinatura do que a LISTA mostra: se não mudou, não redesenha. */
const assinaturaLista = () => JSON.stringify([
  S.tasks.map((t) => [t.id, t.status, t.etapa, t.busy, t.order, t.cost, t.entrega, t.prUrl, (t.gate || {}).ok,
    (t.revisor || {}).veredito, (t.qa || {}).veredito, (t.retentativa || {}).em, (t.anexos || []).length, t.acao, t.title, t.porte, t.classificando, t.agente, t.modeloUsado, t.esforcoUsado, t.paralelo, (t.worktree || {}).juntar, ((t.worktree || {}).conflito || {}).em, (t.prVigia || {}).estado, (t.prVigia || {}).n, (t.sobras || []).length]),
  S.config.filaPausada, S.config.reinicioPendente, USO && USO.ok && USO.limites.map((l) => l.pct),
  (S.projects || []).map((p) => p.slug + "=" + p.label), JSON.stringify(S.rotulos || {}), // projeto novo (pela tela ou pela CLI) entra na seleção
  S.tasks.map((t) => t.projetoSugerido?.slug || "")]);

/** O aviso "parece ser de outro projeto": a tarefa espera o dono mover ou confirmar (na lista e na ficha). */
function avisoProjeto(t) {
  const s = t.projetoSugerido;
  if (!s) return "";
  const aqui = nomeProj(t.project);
  return `<div class="aviso-projeto" role="alert" onclick="event.stopPropagation()"><span>⚠ Parece ser do <b>${esc(s.label)}</b>, não do <b>${esc(aqui)}</b> — a tarefa espera você.</span>
    <button class="btn primary" onclick="resolverProjeto(${t.id}, 'mover')">Mover para ${esc(s.label)}</button>
    <button class="btn" onclick="resolverProjeto(${t.id}, 'manter')">Está certo: ${esc(aqui)}</button></div>`;
}
async function resolverProjeto(id, acao) {
  try { await api(`/tasks/${id}/projeto`, { method: "POST", body: { acao } }); await loadState(); }
  catch (e) { toast("Não deu: " + e.message, 5000, "erro"); }
}
let ultimaAssinatura = null;

async function loadState() {
  const antes = S.carregado ? new Set(S.tasks.filter(naoJuntada).map((t) => t.id)) : null;
  const prAntes = S.carregado ? new Set(S.tasks.filter(prEsgotado).map((t) => t.id)) : null;
  S = await api("/state"); S.carregado = true;
  // O aviso na hora em que a junção recusa (a faixa no Meu quadro e o selo ficam; isto é para quem está em outra tela).
  if (antes) for (const t of S.tasks.filter(naoJuntada)) if (!antes.has(t.id)) toast(`⚠ #${t.id} não juntada — conflito: o trabalho aprovado ficou só na cópia. Abra a tarefa para ver.`, 9000, "erro");
  if (prAntes) for (const t of S.tasks.filter(prEsgotado)) if (!prAntes.has(t.id)) toast(`⚠ #${t.id}: ${vigiaTxt(t.prVigia)}. Abra a tarefa para ver o motivo.`, 9000, "erro");
  render();
  pintarVozFora(); // "pensando" vem do estado da Central, e fora dela ninguém mais repinta o aviso
}
/** A faixa do Meu quadro: tarefa ⚡ aprovada que não entrou na pasta. Some quando juntar ou for concluída. */
function faixaNaoJuntadas() {
  const ts = S.tasks.filter((t) => naoJuntada(t) && t.status !== "concluida");
  if (!ts.length) return "";
  return `<div class="faixa-naojuntada" role="alert"><b>⚠ ${ts.length === 1 ? "1 tarefa não juntada" : ts.length + " tarefas não juntadas"} — conflito</b>
    <span>O trabalho foi aprovado, mas não entrou na pasta principal: está só na cópia.</span>
    ${ts.map((t) => `<a href="#/t/${t.id}">#${t.id} ${esc(nomeProj(t.project))} · ${esc(cutTxt(t.title, 50))}</a>`).join("")}</div>`;
}

// Ditado: 🎤 grava, ⏹ para e o Mac transcreve. O estado fica aqui porque a lista é redesenhada a cada evento.
let ditado = "parado"; // parado | gravando | transcrevendo
let gravador = null;
let ditadoAlvo = "newTask"; // id da caixa de texto que recebe o que foi falado
let ditadoCaixa = null; // o rascunho dessa caixa: o mesmo id (#convIn) serve a várias conversas
const micHtml = (alvo, desligado = false) => `<button class="ib microfone" data-alvo="${alvo}" title="Ditar: clique ou Shift duas vezes, fale, e de novo para parar" ${desligado ? "disabled" : ""}>🎤</button>`;
function ligarMic(raiz = document) {
  raiz.querySelectorAll(".ib.microfone").forEach((b) => { b.onclick = () => gravarAudio(b.dataset.alvo); });
  pintarMic();
}
function pintarMic() {
  document.querySelectorAll(".ib.microfone").forEach((b) => {
    const meu = b.dataset.alvo === ditadoAlvo, st = meu ? ditado : "parado";
    b.textContent = st === "gravando" ? "⏹" : st === "transcrevendo" ? "⏳" : "🎤";
    b.classList.toggle("gravando", st === "gravando");
    if (ditado !== "parado") b.disabled = !(meu && st === "gravando");
    else b.disabled = !!$("#" + b.dataset.alvo)?.disabled;
    b.title = st === "gravando" ? "Gravando — clique ou Shift duas vezes para parar e transcrever" : st === "transcrevendo" ? "Transcrevendo…" : "Ditar: clique ou Shift duas vezes, fale, e de novo para parar";
  });
  pintarVoz(); // com o ditado gravando, a barra do modo voz diz que a fala vai para a caixa
}
// Atalho: Shift duas vezes (em até 400 ms, sem outra tecla no meio) liga e desliga o ditado.
// Vale para a caixa com o cursor; sem cursor numa delas, a primeira caixa com 🎤 da tela.
let shiftSolo = false, ultimoShift = 0;
document.addEventListener("keydown", (e) => { shiftSolo = e.key === "Shift" && !e.repeat; }, true);
document.addEventListener("keyup", (e) => {
  if (e.key !== "Shift" || !shiftSolo) return;
  shiftSolo = false;
  const agora = Date.now();
  if (agora - ultimoShift > 400) { ultimoShift = agora; return; }
  ultimoShift = 0;
  if (ditado === "gravando") { gravarAudio(ditadoAlvo); return; }
  const foco = document.activeElement && document.activeElement.id;
  const b = (foco && document.querySelector(`.ib.microfone[data-alvo="${foco}"]`)) || document.querySelector(".ib.microfone");
  if (b && !b.disabled) gravarAudio(b.dataset.alvo);
}, true);
async function gravarAudio(alvo = "newTask") {
  if (ditado === "gravando") { gravador.stop(); return; }
  if (ditado !== "parado") return;
  ditadoAlvo = alvo; ditadoCaixa = $("#" + alvo)?.dataset.rascunho || null;
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { toast("Sem acesso ao microfone: " + e.message, 5000, "erro"); return; }
  const partes = [];
  gravador = new MediaRecorder(stream);
  gravador.ondataavailable = (e) => { if (e.data.size) partes.push(e.data); };
  gravador.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    ditado = "transcrevendo"; pintarMic();
    try {
      const blob = new Blob(partes, { type: gravador.mimeType || "audio/webm" });
      const r = await fetch("/api/transcrever-audio", { method: "POST", body: blob, headers: { "content-type": blob.type } });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "erro " + r.status);
      if (!d.texto) toast("Não ouvi nada. Tente falar mais perto do microfone.", 4000);
      else entregarDitado(d.texto);
    } catch (e) { toast("Ditado: " + e.message, 5000, "erro"); }
    ditado = "parado"; gravador = null; pintarMic();
  };
  gravador.start();
  ditado = "gravando"; pintarMic();
  pararDitadoSemCaixa();
}
const comDitado = (antes, texto) => (antes.trim() ? antes.trimEnd() + " " : "") + texto;
const caixaDoDitado = () => { const ta = $("#" + ditadoAlvo); return ta && (ta.dataset.rascunho || null) === ditadoCaixa ? ta : null; };
/** A caixa já não está na tela: o que ele ditou vai para o rascunho dela, e volta quando ela for desenhada de novo. */
function entregarDitado(texto) {
  const ta = caixaDoDitado();
  if (ta) { ta.value = comDitado(ta.value, texto); ta.dispatchEvent(new Event("input")); ta.focus(); return; }
  if (!ditadoCaixa) return toast("Ditado (a caixa saiu da tela): " + texto, 15000);
  if (ditadoCaixa === "nova") store.set("rascunho", comDitado(store.get("rascunho", ""), texto));
  else rascunho.gravar(ditadoCaixa, comDitado(rascunho.ler(ditadoCaixa), texto));
  toast("O ditado ficou no rascunho da caixa de onde você saiu.", 5000);
}
// Saiu da tela da caixa: o ditado acaba ali. Gravando sem caixa, ninguém mais via o ⏹ dele, e o modo voz ficava surdo (QA da #296).
function pararDitadoSemCaixa() {
  const vigia = new MutationObserver(() => {
    if (ditado !== "gravando") return vigia.disconnect();
    if (!caixaDoDitado()) { vigia.disconnect(); gravador.stop(); }
  });
  vigia.observe($("#app"), { childList: true, subtree: true });
}

