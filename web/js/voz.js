// 🎙 Modo voz da Central (#286): mãos livres. Com o modo ligado, o microfone fica aberto em QUALQUER tela do board (#296: "tem de
// ser um diálogo") e também com a aba escondida ou o navegador atrás de outra janela (#303: "preciso estar em outra tela e quando eu
// falar você me responde"). A VAD daqui percebe começo e fim da fala, o trecho vai ao board, e quando a resposta termina o board fala
// sozinho. Tudo isso anda por áudio, fetch e SSE, nada por timer: timer é estrangulado em aba escondida. Só desliga quando ele
// desligar. Dentro do board o aviso é a barra #vozFora; fora dele, o ponto vermelho do Chrome e o título da aba. Tela do aparelho
// bloqueada fecha o microfone (a fala em curso termina, o modo segue ligado e ele reabre), e sem como saber disso (voz-bloqueio.js)
// fora de vista também fecha. Com o modo desligado, nada fica ouvindo. O estado é deste aparelho (localStorage), e só uma aba dele
// ouve e fala: a dona, a última que ele usou.
//
// Fora da Central à vista (outra tela, outra aba, board escondido) só vale a fala que começa com o nome de chamada (#305). Quem julga é
// o servidor, que tem o texto; daqui vai só o que a fala precisa ter, decidido quando ela começa: "nome", ou "janela" logo depois de uma resposta.
//
// 🔴 A tela nunca manda o texto transcrito para a Central: quem transforma áudio em mensagem é a rota /api/voz/ouvir, que
// marca a origem "voz" (SIM falado não vale). O ✓ Aprovar continua sendo a mensagem digitada de sempre.

/**
 * Detector de fala por energia. Não conhece microfone nem tela: recebe blocos.
 * O piso de ruído é o MÍNIMO de energia dos últimos segundos, medido sempre, também durante a fala: fala tem vales entre as
 * sílabas e ruído constante (ventilador, ar-condicionado) não. Sem isso, ruído acima do limiar nunca era aprendido e a pausa não chegava.
 */
class VadVoz {
  constructor({ taxa, pausaMs = 1500, preMs = 400, arranqueMs = 150, minVozMs = 150, maxFalaMs = 90000, janelaPisoMs = 3000, aoComecar, aoTerminar, aoDescartar }) {
    Object.assign(this, { taxa, pausaMs, preMs, arranqueMs, minVozMs, maxFalaMs, janelaPisoMs, aoComecar, aoTerminar, aoDescartar });
    this.recentes = []; this.piso = 0.003; this.minimo = 0.008; this.fator = 3; this.extra = 0; // `extra`: limiar mínimo enquanto o board fala
    this.nivel = 0; this.limpar();
  }
  limpar() { this.emFala = false; this.pre = []; this.preMsAtual = 0; this.partes = []; this.acima = 0; this.silencio = 0; this.voz = 0; this.total = 0; this.maior = 0; }
  limiar() { return Math.max(this.minimo, this.piso * this.fator, this.extra); }
  quadro(bloco) {
    let soma = 0;
    for (let i = 0; i < bloco.length; i++) soma += bloco[i] * bloco[i];
    const rms = Math.sqrt(soma / bloco.length), ms = bloco.length / this.taxa * 1000;
    this.nivel = rms;
    this.recentes.push(rms);
    const cheia = this.recentes.length * ms > this.janelaPisoMs;
    if (cheia) this.recentes.shift();
    // Janela ainda enchendo (microfone recém-aberto): quem fala logo de cara não pode virar o próprio piso.
    this.piso = cheia ? Math.min(...this.recentes) : Math.min(0.003, ...this.recentes);
    if (this.emFala) return this.durante(bloco, rms, ms);
    this.pre.push(bloco); this.preMsAtual += ms;
    while (this.preMsAtual - ms * 1 > this.preMs && this.pre.length > 1) { this.pre.shift(); this.preMsAtual -= ms; }
    this.acima = rms > this.limiar() ? this.acima + ms : 0;
    if (this.acima >= this.arranqueMs) {
      this.emFala = true; this.partes = this.pre; this.pre = []; this.preMsAtual = 0;
      this.total = this.partes.length * ms; this.voz = this.acima; this.silencio = 0; this.maior = rms;
      if (this.aoComecar) this.aoComecar();
    }
  }
  durante(bloco, rms, ms) {
    this.partes.push(bloco); this.total += ms; this.maior = Math.max(this.maior, rms);
    if (rms > this.limiar() * 0.7) { this.voz += ms; this.silencio = 0; } else this.silencio += ms;
    if (this.silencio >= this.pausaMs || this.total >= this.maxFalaMs) this.fim();
  }
  fim() {
    // Nada no trecho passou do piso aprendido nesse meio-tempo: era o ruído chegando, não fala. Não vale gastar o whisper.
    const partes = this.partes, voz = this.voz, soRuido = this.maior <= this.limiar();
    this.limpar();
    if (voz >= this.minVozMs && !soRuido) this.aoTerminar(partes); else if (this.aoDescartar) this.aoDescartar();
  }
}

/** PCM da taxa do navegador → WAV 16 kHz mono de 16 bits (o que o whisper lê direto, igual no Chrome e no Safari). */
function wavDeVoz(partes, taxa) {
  const total = partes.reduce((n, p) => n + p.length, 0), passo = taxa / 16000, n = Math.floor(total / passo);
  const entrada = new Float32Array(total); let o = 0;
  for (const p of partes) { entrada.set(p, o); o += p.length; }
  const buf = new ArrayBuffer(44 + n * 2), d = new DataView(buf);
  const txt = (i, s) => { for (let k = 0; k < s.length; k++) d.setUint8(i + k, s.charCodeAt(k)); };
  txt(0, "RIFF"); d.setUint32(4, 36 + n * 2, true); txt(8, "WAVEfmt "); d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true);
  d.setUint32(24, 16000, true); d.setUint32(28, 32000, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true); txt(36, "data"); d.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    // Média das amostras do intervalo: o filtro mais simples que evita o chiado de só pular amostra.
    const ini = Math.floor(i * passo), fim = Math.max(ini + 1, Math.floor((i + 1) * passo));
    let s = 0; for (let k = ini; k < fim; k++) s += entrada[k];
    d.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s / (fim - ini))) * 32767, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

const VOZ_AUDIO = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } }; // o cadastro da voz (#298) usa o mesmo
const VOZ = {
  fase: "parado", // parado | ouvindo | gravando | transcrevendo | falando | cortado | toque
  ctx: null, stream: null, no: null, vad: null, abrindo: false, escrita: null,
  servidor: null, fala: null, fila: [], envios: Promise.resolve(), trava: null, semEco: false, testeSemEco: false,
  sabeBloqueio: false, bloqueada: false, // voz-bloqueio.js: o vigia da tela do aparelho está ligado? a tela está bloqueada?
  cadastrando: false, barradas: 0, naoReconhecidaAte: 0, filtroFora: null, // "só a minha voz" (#298): gravando o cadastro, trechos descartados, até quando o aviso fica, motor fora
  ouvidas: 0, falas: 0, // contadores para os testes, como somEnvio.vezes
  janelaAte: 0, exigeTrecho: "", // a continuação sem o nome vale até aqui (hora, não timer: em aba escondida timer é estrangulado); o que a fala em curso precisa ter
  ligado: () => store.get("vozLigado", false) === true,
  comando: () => store.get("vozComando", false) === true,
  pausa: () => Number(store.get("vozPausa", 1500)) || 1500,
  janela: () => Number(store.get("vozJanela", 15)) || 15, // segundos de continuação sem o nome depois de uma resposta
  nome: () => VOZ.servidor?.nome || "o nome", // uma configuração só: BOARD_VOZ_NOME, no servidor
  vozEscolhida: () => store.get("vozVoz", ""),
  ajusteFala: () => store.get("vozAjuste", {}), // o jeito de falar (#313): o servidor limita e completa com o padrão
  dona: () => [null, TELA.id].includes(store.get("vozDona", null)), // a aba deste aparelho que ouve e fala
  visivel: () => document.visibilityState === "visible",
  // Ele pode estar em outra aba ou programa, mas não com a tela bloqueada; e fora de vista só vale sabendo disso (#303).
  presente: () => !VOZ.bloqueada && (VOZ.visivel() || VOZ.sabeBloqueio),
  // Só escutando o comando "modo voz" (modo desligado), a escuta continua sendo só da tela da Central, à vista.
  querMicrofone() { return VOZ.ligado() ? VOZ.dona() && VOZ.presente() : VOZ.comando() && !!view.central && VOZ.visivel(); },
};
// "A aba que ele está usando": ligar, voltar a ela, clicar nela. As outras ficam sabendo pelo evento `storage` e soltam o microfone.
function vozTomar() {
  if (!VOZ.ligado() || !VOZ.visivel() || store.get("vozDona", null) === TELA.id) return;
  store.set("vozDona", TELA.id);
  vozAplicar();
}
window.addEventListener("storage", (e) => { if (["board.vozDona", "board.vozLigado", "board.vozComando"].includes(e.key)) { vozAplicar(); renderCabecaCentral(); } });
window.addEventListener("focus", vozTomar);

// ── Ligar, desligar e abrir o microfone ─────────────────────────────────────
function vozBotaoHtml() {
  const l = VOZ.ligado();
  return `<button class="btn voz-botao${l ? " ligado" : ""}" type="button" aria-pressed="${l}" title="${l ? "Voltar ao texto: o microfone fecha" : "Falar e ouvir, sem apertar nada (ou diga “modo voz”, se a escuta do comando estiver ligada)"}" onclick="alternarVoz()">🎙 Modo voz${l ? ": ligado" : ""}</button>`;
}
// O contexto de áudio nasce no clique: o Safari só libera tocar som depois de um gesto, e depois disso fala sem pedir de novo.
function vozCtx() {
  VOZ.ctx ||= new (window.AudioContext || window.webkitAudioContext)();
  if (VOZ.ctx.state === "suspended") VOZ.ctx.resume().catch(() => {});
  return VOZ.ctx;
}
async function alternarVoz() {
  store.set("vozLigado", !VOZ.ligado());
  if (VOZ.ligado()) { VOZ.fila = []; vozCtx(); store.set("vozDona", TELA.id); vozPedirBloqueio(); vozAquecer(); }
  else vozCortarFala();
  await vozAplicar();
  renderCabecaCentral();
}
function renderCabecaCentral() { pintarVoz(); if (view.central && $(".chead")) { $(".chead").outerHTML = centralHead((S.conversas || {}).central || {}); rolarProFim(); } } // o rótulo do botão pode quebrar linha: quem acompanha o fim continua nele
function alternarComandoVoz(ligar) { store.set("vozComando", !!ligar); if (ligar) vozCtx(); vozAplicar(); }
function vozPorComando(ligar) {
  store.set("vozLigado", ligar);
  VOZ.fila = [];
  if (ligar) { store.set("vozDona", TELA.id); vozAquecer(); } else vozCortarFala();
  somEnvio.tocar();
  vozAplicar(); renderCabecaCentral();
}

/** Abre ou fecha o microfone conforme o que esta aba quer agora. Tela bloqueada fica sem microfone, e a fala em curso termina. */
async function vozAplicar() {
  vozVigiarBloqueio();
  if (VOZ.querMicrofone()) { if (!VOZ.stream && !VOZ.abrindo) await vozAbrir(); }
  else if (VOZ.ligado() && VOZ.dona()) vozSoltarMicrofone();
  else vozFechar();
  pintarVoz();
}
async function vozAbrir() {
  if (!navigator.mediaDevices?.getUserMedia) return vozSemMicrofone("este endereço não libera o microfone: use o https do Tailscale ou localhost");
  VOZ.abrindo = true;
  let stream = null;
  const soltar = () => { if (stream) stream.getTracks().forEach((t) => t.stop()); }; // enquanto não está em VOZ, o vozFechar não o enxerga
  try {
    stream = await navigator.mediaDevices.getUserMedia(VOZ_AUDIO);
    if (!VOZ.querMicrofone()) return soltar(); // saiu da tela enquanto o navegador perguntava
    const ctx = vozCtx();
    if (!VOZ.moduloPronto) { await ctx.audioWorklet.addModule("/js/voz-captura.js"); VOZ.moduloPronto = true; }
    if (!VOZ.querMicrofone()) return soltar(); // saiu da tela enquanto o módulo carregava
    const fonte = ctx.createMediaStreamSource(stream), no = new AudioWorkletNode(ctx, "voz-captura");
    const mudo = ctx.createGain(); mudo.gain.value = 0;
    fonte.connect(no); no.connect(mudo); mudo.connect(ctx.destination); // sem destino, o Safari não chama o worklet
    VOZ.vad = new VadVoz({ taxa: ctx.sampleRate, pausaMs: VOZ.pausa(), aoComecar: vozComecouFala, aoTerminar: vozTerminouFala, aoDescartar: vozFalaDescartada });
    // Com o 🎤 ditado gravando, a fala é para a caixa de texto, não para a Central. Gravando o cadastro da voz, é a leitura do texto.
    no.port.onmessage = (e) => { if (VOZ.vad && ditado !== "gravando" && !VOZ.cadastrando) { VOZ.vad.quadro(e.data); vozMedidor(); } };
    Object.assign(VOZ, { stream, no, fonte, mudo });
    if (VOZ.fala) VOZ.vad.extra = Math.max(0.02, VOZ.fala.ecoMax * 2.5); // voltou à aba com a voz ainda falando
    vozFasePadrao();
    // Sem cancelamento de eco o microfone ouviria a fala: então fica mudo enquanto o board fala, e cortar é no botão.
    VOZ.semEco = VOZ.testeSemEco || stream.getAudioTracks()[0].getSettings?.().echoCancellation === false;
    stream.getAudioTracks()[0].addEventListener("ended", vozCortado);
    stream.getAudioTracks()[0].addEventListener("mute", vozCortado);
    stream.getAudioTracks()[0].addEventListener("unmute", () => { if (VOZ.fase === "cortado") vozFasePadrao(); });
    if (ctx.state === "suspended") await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 400))]);
    if (ctx.state !== "running" && VOZ.stream) VOZ.fase = "toque"; // Safari: áudio só depois de um toque. A tela pede; ninguém fica achando que está ouvindo.
    vozManterTela();
  } catch (e) { soltar(); vozSemMicrofone(e.message); }
  finally { VOZ.abrindo = false; pintarVoz(); }
}
function vozSemMicrofone(motivo) {
  store.set("vozLigado", false); store.set("vozComando", false);
  vozFechar(); toast("Modo voz: sem acesso ao microfone. " + motivo, 7000, "erro");
  renderCabecaCentral();
}
function vozFecharCaptura() {
  if (VOZ.stream) VOZ.stream.getTracks().forEach((t) => t.stop());
  if (VOZ.no) { VOZ.no.port.onmessage = null; try { VOZ.fonte.disconnect(); VOZ.no.disconnect(); VOZ.mudo.disconnect(); } catch { /* já solto */ } }
  Object.assign(VOZ, { stream: null, no: null, fonte: null, mudo: null, vad: null });
  if (VOZ.trava) { VOZ.trava.release().catch(() => {}); VOZ.trava = null; }
}
/** Desligou (ou outra aba assumiu): fecha tudo, inclusive a fala e o que esperava a vez. O trecho no meio é descartado. */
function vozFechar() {
  vozCortarFala();
  vozFecharCaptura();
  Object.assign(VOZ, { fase: "parado", fila: [], pronta: null });
}
/** O modo segue ligado, só o microfone fecha (tela bloqueada): o que ele já tinha dito vai, e a fala em curso continua até o fim. */
function vozSoltarMicrofone() {
  if (!VOZ.stream) return;
  if (VOZ.vad?.emFala) VOZ.vad.fim();
  vozFecharCaptura();
  if (VOZ.fase !== "transcrevendo") vozFasePadrao();
}
// A trilha é quem sabe: a fase não pode voltar a "ouvindo" com ela morta (QA da #296: a fala acabava e a barra mentia).
function vozMicMorto() { const t = VOZ.stream?.getAudioTracks()[0]; return !!t && (t.readyState === "ended" || t.muted); }
function vozCortado() { if (vozMicMorto()) { VOZ.fase = "cortado"; pintarVoz(); } }
// A tela apagada corta o microfone no celular: enquanto o modo está ligado, ela fica acesa (onde o navegador deixa).
async function vozManterTela() {
  if (VOZ.trava || VOZ.pedindoTrava || !VOZ.ligado() || !VOZ.stream || !navigator.wakeLock) return;
  VOZ.pedindoTrava = true; // o pedido demora: um 2º chamado agora faria outra trava, que ninguém soltaria
  try {
    const t = await navigator.wakeLock.request("screen");
    if (!VOZ.ligado() || !VOZ.stream) return void t.release().catch(() => {}); // desligou enquanto o navegador respondia
    t.addEventListener("release", () => { if (VOZ.trava === t) VOZ.trava = null; });
    VOZ.trava = t;
  } catch { /* sem bateria, ou aba escondida */ } finally { VOZ.pedindoTrava = false; }
}
document.addEventListener("visibilitychange", async () => {
  if (!VOZ.visivel()) return vozAplicar();
  vozTomar();
  if (!VOZ.querMicrofone()) return vozAplicar();
  if (VOZ.ctx && VOZ.ctx.state !== "running") await VOZ.ctx.resume().catch(() => {});
  if (VOZ.stream && VOZ.stream.getAudioTracks()[0].readyState === "ended") vozSoltarMicrofone();
  await vozAplicar(); vozManterTela();
  if (VOZ.fase === "cortado" || VOZ.fase === "toque") vozFasePadrao();
  if (VOZ.ctx && VOZ.ctx.state !== "running" && VOZ.stream) { VOZ.fase = "toque"; pintarVoz(); }
});
["pointerdown", "keydown"].forEach((ev) => document.addEventListener(ev, () => {
  vozTomar();
  if (VOZ.fase === "cortado" && VOZ.stream?.getAudioTracks()[0].readyState === "ended") { vozSoltarMicrofone(); vozAplicar(); } // fone tirado: o toque abre o microfone que houver
  if (VOZ.fase === "toque" && VOZ.ctx) VOZ.ctx.resume().then(() => { vozFasePadrao(); vozProximaFala(); }).catch(() => {});
}, { capture: true, passive: true }));
// Com trechos na fila, a resposta do anterior pode chegar com o dono já falando o seguinte: a fase não volta a "ouvindo" por cima dele.
function vozFasePadrao() { VOZ.fase = VOZ.vad?.emFala ? "gravando" : VOZ.fala && !VOZ.fala.pausada ? "falando" : !VOZ.stream ? "parado" : vozMicMorto() ? "cortado" : "ouvindo"; pintarVoz(); }
window.addEventListener("hashchange", vozAplicar); // só a escuta do comando depende da tela; o modo ligado segue junto
// A página nasce (recarregar, abrir o board): o modo guardado reabre o microfone na tela que for, já com o aviso. Áudio travado pede um toque.
function vozPartida() {
  if (!VOZ.ligado()) return;
  if (VOZ.visivel()) store.set("vozDona", TELA.id);
  vozAplicar(); carregarEstadoVoz();
}
// A Central desenha: reabre o microfone da escuta do comando e a faixa ganha os detalhes.
function vozAoDesenharCentral() { vozAplicar(); carregarEstadoVoz(); }
async function carregarEstadoVoz() { if (!VOZ.servidor) { try { VOZ.servidor = await api("/voz/estado"); pintarVoz(); } catch { /* a faixa fica sem o detalhe */ } } }

// ── Ouvir ───────────────────────────────────────────────────────────────────
// Falar por cima do board não é continuação: com a janela aberta, quem interrompe ainda é outra conversa na sala até dizer o nome.
function vozExige() {
  if (view.central && VOZ.visivel()) return "";
  return !VOZ.fala && Date.now() < VOZ.janelaAte ? "janela" : "nome";
}
function vozAbrirJanela() {
  VOZ.janelaAte = Date.now() + VOZ.janela() * 1000;
  setTimeout(pintarVoz, VOZ.janela() * 1000 + 50); // só o rótulo da barra: quem decide é a hora, em `vozExige`
}
function vozComecouFala() {
  telaUsada(); // falar é usar: no modo voz ele não toca na tela
  VOZ.exigeTrecho = vozExige(); // no começo da fala: trocar de tela no meio não muda o que ela precisa ter
  if (VOZ.fala) {
    // Sem cancelamento de eco, na amostra da voz, ou nos primeiros 500 ms (ainda medindo o eco que sobrou): o que entrou é o
    // próprio board. A amostra não tem resposta para o eco ser comparado no servidor: nela o microfone não vale nada, e cortar é no ⏹.
    // Vale em TODO pedaço do Kokoro (#327: `comeco` é do pedaço que começou a tocar), e no intervalo entre
    // dois pedaços, logo depois de um acabar (o rabo do som ainda está na sala).
    if (VOZ.semEco || VOZ.semEcoAgora || VOZ.fala.amostra || vozEcoAgora(VOZ.fala)) return VOZ.vad.limpar();
    vozPausarFala(); // falou por cima: a voz para na hora; a transcrição decide se volta ou se acabou
  }
  VOZ.fase = "gravando"; pintarVoz();
}
function vozFalaDescartada() { vozRetomarOuSeguir(); } // tosse ou estalo: a resposta que chegou no meio não pode ficar muda
function vozTerminouFala(partes) {
  const wav = wavDeVoz(partes, VOZ.ctx.sampleRate), fala = VOZ.fala;
  const exige = VOZ.ligado() && VOZ.exigeTrecho ? `&exige=${VOZ.exigeTrecho}` : "";
  const q = (VOZ.ligado() ? (fala ? `falando&n=${fala.n}` : "conversa") : "espera") + exige;
  VOZ.ouvidas++;
  if (VOZ.ligado()) VOZ.fase = "transcrevendo";
  pintarVoz();
  // Um trecho por vez, na ordem em que ele falou.
  VOZ.envios = VOZ.envios.then(() => vozEnviarAudio(wav, q)).catch((e) => { toast("Modo voz: " + e.message, 5000, "erro"); vozRetomarOuSeguir(); });
}
async function vozEnviarAudio(wav, q) {
  const r = await fetch(`/api/voz/ouvir?modo=${q}`, { method: "POST", body: wav, headers: { "content-type": "audio/wav" } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "erro " + r.status);
  VOZ.ultima = d;
  if (d.filtro || d.filtroFora) VOZ.filtroFora = d.filtroFora || null; // sem cadastro nada disso vem, e a faixa fica como sempre
  if (d.naoReconhecida) { vozNaoReconhecida(); return vozRetomarOuSeguir(); } // a fala cortada continua, como no ruído
  if (d.comando === "ligar") { if (!VOZ.ligado()) vozPorComando(true); return vozRetomarOuSeguir(); }
  if (d.comando === "desligar") return vozPorComando(false);
  if (d.comando === "cortar") { VOZ.fila = []; vozCortarFala(); vozAbrirJanela(); return vozFasePadrao(); } // "para" cala também o que esperava a vez: o texto está na tela
  if (d.chamado) { vozCortarFala(); vozAbrirJanela(); somEnvio.tocar(); vozFasePadrao(); return vozProximaFala(); } // só o nome: ele vai dizer o resto
  // Falou por cima: a fala em curso acabou. O que esperava a vez é resposta que ele ainda não ouviu: segue na ordem.
  if (d.enviado) { vozCortarFala(); somEnvio.tocar(); if (view.central) rolarProFim(true); vozFasePadrao(); return vozProximaFala(); }
  vozRetomarOuSeguir(); // ruído ou eco: a fala cortada continua de onde parou
}
// Hora, não timer, para decidir: o timer aqui só repinta, e em aba escondida ele atrasa sem mudar nada.
function vozNaoReconhecida() {
  VOZ.barradas++; VOZ.naoReconhecidaAte = Date.now() + 8000;
  setTimeout(pintarVoz, 8050);
}
function vozRetomarOuSeguir() { if (VOZ.fala && VOZ.fala.pausada) vozRetomarFala(); else { if (VOZ.fase !== "cortado") vozFasePadrao(); vozProximaFala(); } }

// ── Falar ───────────────────────────────────────────────────────────────────
/** A resposta da Central terminou (SSE `log`): entra na fila de fala. Histórico não passa por aqui: SSE não repete o passado. */
function aoRespostaDaCentral(ev) {
  if (ev.t !== "resultado" || !ev.texto || !ev.n || !VOZ.ligado() || !VOZ.dona()) return; // aba escondida também fala: o microfone é que fecha
  VOZ.fila.push(ev.n);
  vozProximaFala();
}
// Os primeiros 500 ms de cada pedaço que começa a tocar e os 500 ms depois de um pedaço acabar: o que entra é eco.
const vozEcoAgora = (f) => performance.now() - f.comeco < 500 || (f.esperando && performance.now() - (f.fimPedaco || 0) < 500);
const vozOcupado = () => VOZ.cadastrando || VOZ.fala || VOZ.fase === "gravando" || VOZ.fase === "transcrevendo" || VOZ.fase === "toque" || VOZ.pedindo;
async function vozProximaFala() {
  if (!VOZ.fila.length || vozOcupado() || !VOZ.ligado()) return;
  const n = VOZ.fila.shift();
  const pronta = VOZ.pronta?.n === n ? VOZ.pronta.f : null; VOZ.pronta = null;
  VOZ.pedindo = true;
  try {
    const f = pronta || await vozPedirFala({ n, voz: VOZ.vozEscolhida(), ajuste: VOZ.ajusteFala() });
    VOZ.pedindo = false;
    if (VOZ.ligado() && VOZ.dona() && VOZ.fase !== "gravando" && VOZ.fase !== "transcrevendo") vozTocar(n, f);
    // Um som começou enquanto o pedaço era gerado: o áudio pronto espera a vez (#327). Jogá-lo fora fazia o Kokoro gerar o pedaço 0
    // de novo a cada trecho barrado, e a resposta parecia recomeçar.
    else { VOZ.fila.unshift(n); VOZ.pronta = { n, f }; }
  } catch (e) { VOZ.pedindo = false; toast("Modo voz: " + e.message, 5000, "erro"); vozProximaFala(); }
}
async function vozPedirFala(corpo) {
  const r = await fetch("/api/voz/fala", { method: "POST", body: JSON.stringify(corpo), headers: { "content-type": "application/json" } });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "erro " + r.status);
  if ((r.headers.get("content-type") || "").includes("audio")) return { audio: await vozCtx().decodeAudioData(await r.arrayBuffer()), texto: decodeURIComponent(r.headers.get("x-voz-texto") || ""), partes: Number(r.headers.get("x-voz-partes")) || 1, corpo };
  return r.json();
}
function vozTocar(n, f, { amostra = false } = {}) {
  if (!amostra) VOZ.falas++;
  VOZ.fala = { n, amostra, texto: f.texto, audio: f.audio || null, pos: 0, pausada: false, ecoMax: 0, comeco: performance.now(), parte: 0, partes: f.partes || 1, corpo: f.corpo };
  vozPedirSeguinte(VOZ.fala);
  VOZ.fase = "falando";
  if (VOZ.vad) VOZ.vad.extra = 0.02;
  if (f.audio) vozTocarTrecho();
  else vozFalaDoNavegador(f.texto); // sem voz nenhuma no navegador, acaba aqui mesmo: a resposta fica só escrita
  pintarVoz();
}
function vozTocarTrecho() {
  const f = VOZ.fala, s = VOZ.ctx.createBufferSource();
  s.buffer = f.audio; s.connect(VOZ.ctx.destination);
  s.onended = () => { if (VOZ.fala !== f || f.pausada) return; f.fonte = null; f.fimPedaco = performance.now(); if (f.parte + 1 < f.partes) vozProximoPedaco(f); else vozFimDaFala(); };
  s.start(0, f.pos);
  f.fonte = s; f.inicio = VOZ.ctx.currentTime - f.pos;
  if (!f.pos) f.comeco = performance.now(); // pedaço novo: mede o eco de novo (vozMedidor) e o começo dele não interrompe a fala. A volta de uma pausa não: ele pode estar dizendo "espera".
}
// Kokoro (#314): a fala vem em pedaços. O seguinte é pedido assim que um começa a tocar, e entra quando ele acaba.
function vozPedirSeguinte(f) { f.proxima = f.parte + 1 < f.partes ? vozPedirFala({ ...f.corpo, parte: f.parte + 1 }).catch(() => null) : null; }
async function vozProximoPedaco(f) {
  f.esperando = true;
  const prox = await f.proxima;
  f.esperando = false;
  if (VOZ.fala !== f) return; // cortada enquanto esperava
  if (!prox?.audio) return vozFimDaFala(); // o pedaço falhou: o resto está escrito na tela
  f.parte++; f.audio = prox.audio; f.pos = 0;
  vozPedirSeguinte(f);
  if (!f.pausada) vozTocarTrecho();
}
function vozFalaDoNavegador(texto) {
  // A voz do sistema não passa pelo cancelamento de eco do navegador: o microfone ignora o que chega até ela acabar.
  VOZ.fala.doNavegador = true; VOZ.semEcoAgora = true;
  if (!window.speechSynthesis) return vozFimDaFala();
  const u = new SpeechSynthesisUtterance(texto); u.lang = "pt-BR"; u.rate = 1.05;
  const voz = speechSynthesis.getVoices().find((v) => /^pt[-_]BR/i.test(v.lang)); if (voz) u.voice = voz;
  const f = VOZ.fala;
  u.onend = u.onerror = () => { if (VOZ.fala === f) vozFimDaFala(); };
  speechSynthesis.speak(u);
}
function vozPausarFala() {
  const f = VOZ.fala; if (!f || f.pausada) return;
  f.pausada = true;
  if (f.doNavegador) window.speechSynthesis?.pause();
  else if (f.fonte && !f.esperando) { f.pos = VOZ.ctx.currentTime - f.inicio; f.fonte.onended = null; try { f.fonte.stop(); } catch { /* já acabou */ } f.fonte = null; }
}
function vozRetomarFala() {
  const f = VOZ.fala; if (!f) return;
  f.pausada = false; VOZ.fase = "falando";
  if (f.doNavegador) window.speechSynthesis?.resume(); else if (!f.esperando) vozTocarTrecho();
  pintarVoz();
}
function vozFimDaFala() {
  if (!VOZ.fala?.amostra) vozAbrirJanela();
  VOZ.fala = null; VOZ.semEcoAgora = false;
  if (VOZ.vad) VOZ.vad.extra = 0;
  if (VOZ.fase === "falando") vozFasePadrao();
  vozProximaFala();
}
function vozCortarFala() {
  const f = VOZ.fala; if (!f) return;
  VOZ.fala = null; VOZ.semEcoAgora = false;
  if (f.doNavegador) window.speechSynthesis?.cancel();
  else if (f.fonte) { f.fonte.onended = null; try { f.fonte.stop(); } catch { /* já acabou */ } }
  if (VOZ.vad) VOZ.vad.extra = 0;
  if (VOZ.fase === "falando") vozFasePadrao();
}
function pararFalaBotao() { vozCortarFala(); VOZ.fila = []; pintarVoz(); }
async function ouvirAmostraVoz(voz = VOZ.vozEscolhida()) {
  vozCtx();
  VOZ.pedindo = true; // uma resposta que chegue agora espera a amostra acabar
  try {
    const f = await vozPedirFala({ amostra: true, voz, ajuste: VOZ.ajusteFala() });
    if (!f.audio) return toast(f.motivo || "Sem voz nesta máquina", 5000);
    // Pelo mesmo caminho da resposta: a tela diz "falando", o ⏹ corta e o microfone não ouve a própria voz.
    vozCortarFala();
    if (VOZ.vad) VOZ.vad.limpar();
    vozTocar(null, f, { amostra: true });
  } catch (e) { toast("Modo voz: " + e.message, 5000, "erro"); }
  finally { VOZ.pedindo = false; vozProximaFala(); }
}

// ── A faixa na tela ─────────────────────────────────────────────────────────
const VOZ_FASES = {
  parado: ["", ""], ouvindo: ["👂 ouvindo", "Pode falar: mando quando você fizer uma pausa"],
  gravando: ["🔴 ouvindo você", "Termine de falar: mando na pausa"], transcrevendo: ["⏳ transcrevendo", "Virando texto aqui no servidor"],
  pensando: ["💭 pensando", "A Central está respondendo; quando terminar, ela fala. Pode continuar falando: entra na vez"],
  falando: ["🔊 falando", "A resposta inteira está escrita na tela. Fale por cima (“espera”, “para”) ou use o botão"],
  cortado: ["⛔ microfone cortado", "O aparelho cortou o microfone. Toque na tela para reabrir"],
  toque: ["🖐 toque na tela", "O navegador só libera o áudio depois de um toque: toque em qualquer lugar"],
  pausado: ["⏸ microfone fechado", "Fora de vista sem saber se a tela bloqueou: o microfone reabre quando você voltar"],
  bloqueado: ["🔒 tela bloqueada", "Microfone fechado: reabre quando você desbloquear"],
  outra: ["🎙 ouvindo em outra aba", "Só uma aba ouve: clique aqui para o modo voz vir para esta"],
  ditado: ["🎤 ditando na caixa", "A fala vai para a caixa de texto, não para a Central: pare no ⏹ da caixa"],
  comando: ["👂 só o comando “modo voz”", "Microfone aberto nesta tela, à espera do comando; todo o resto é descartado"],
};
function vozFaseNaTela() {
  if (VOZ.fase === "parado" && VOZ.ligado()) return !VOZ.dona() ? "outra" : VOZ.bloqueada ? "bloqueado" : "pausado";
  if (ditado === "gravando" && VOZ.stream && VOZ.fase !== "falando") return "ditado";
  if (VOZ.fase === "ouvindo" && VOZ.ligado() && ((S.conversas || {}).central || {}).busy) return "pensando";
  return VOZ.fase;
}
// O painel do modo voz (#307, pedido falado do dono: "colocar do lado esquerdo do Board"): mora no menu lateral (#vozPainel, montado
// pelo renderNavigation e nunca redesenhado com ele), à vista em toda tela, e a caixa de escrever fica livre. Em cima, a barra
// (#vozFora): estado, medidor, ⏹ parar a fala e Desligar. Embaixo, a faixa (#vozFaixa): ligar, a fala, ajustes, cadastro e limites.
// No computador a barra é parte do painel (o menu é fixo, nunca sai da tela); no celular o menu fica no alto da página e rola junto,
// então a barra se prende no alto da tela, como na #296, e só ela: a faixa fica no menu, sem cobrir a caixa de escrever.
function vozDesligar() { if (VOZ.ligado()) alternarVoz(); else alternarComandoVoz(false); }
function pintarVozFora() {
  const escutaComando = !VOZ.ligado() && !!VOZ.stream, comBarra = VOZ.ligado() || escutaComando; // o microfone aberto só à espera do comando também conta
  const chip = $("#chipVoz"); // o selo do modo voz no cabeçalho da Central (Cockpit, #364)
  if (chip) { chip.classList.toggle("on", VOZ.ligado()); chip.textContent = VOZ.ligado() ? `● ouvindo — diga “${VOZ.nome()}”` : "🎙 voz desligada"; }
  let el = $("#vozFora");
  document.body.classList.toggle("com-voz", comBarra);
  if (!comBarra) { document.body.style.removeProperty("--voz-altura"); return el?.remove(); }
  const casa = $("#vozBarra") || document.body; // o painel ainda não existe só antes do primeiro desenho do menu
  if (!el) {
    el = document.createElement("div"); el.id = "vozFora"; el.className = "voz-fora"; el.setAttribute("role", "status");
    el.innerHTML = `<span class="selo voz-estado" id="vozForaTxt"></span><span class="voz-nivel" aria-hidden="true"><i id="vozNivel"></i></span>
      <button class="btn" id="vozForaParar" type="button" hidden onclick="pararFalaBotao()">⏹ parar a fala</button>
      <span class="voz-quem" id="vozForaQuem" hidden></span>
      <a class="btn" id="vozForaCentral" href="#/central">Central</a><button class="btn" id="vozForaDesligar" type="button" onclick="vozDesligar()">Desligar</button>`;
    // A barra muda de altura sozinha (o ⏹ aparece, o texto quebra): o espaço reservado no alto (celular) acompanha (#364).
    if (typeof ResizeObserver === "function") new ResizeObserver(() => { if (el.isConnected) pintarVozFora(); }).observe(el);
  }
  if (el.parentNode !== casa) casa.append(el);
  const fase = escutaComando ? "comando" : vozFaseNaTela(), txt = $("#vozForaTxt");
  let [rotulo, dica] = VOZ_FASES[fase] || VOZ_FASES.ouvindo;
  if (fase === "ouvindo" && VOZ.ligado()) {
    const exige = vozExige();
    if (exige === "nome") { rotulo = `👂 ouvindo: comece com “${VOZ.nome()}”`; dica = `Fora da Central só vale a fala que começa com ${VOZ.nome()}: o resto é descartado`; }
    if (exige === "janela") { rotulo = "👂 ouvindo: pode continuar"; dica = `Depois de uma resposta, por ${VOZ.janela()} s, não precisa repetir o nome`; }
  }
  txt.textContent = VOZ.abrindo ? "⏳ abrindo o microfone" : rotulo;
  txt.dataset.fase = fase; txt.title = dica;
  const quem = vozQuemAgora(), bq = $("#vozForaQuem");
  bq.hidden = !quem; bq.textContent = quem; bq.title = VOZ.filtroFora || "Voz diferente da cadastrada: descartada antes de virar texto";
  $("#vozForaParar").hidden = !VOZ.fala;
  $("#vozForaCentral").hidden = !!view.central;
  // Com o modo ligado, o Desligar é o botão do modo (o mesmo papel do "Ligar" da faixa); com só a escuta do comando, ele desliga a escuta.
  const des = $("#vozForaDesligar"), l = VOZ.ligado();
  des.classList.toggle("voz-botao", l); des.classList.toggle("ligado", l);
  if (l) des.setAttribute("aria-pressed", "true"); else des.removeAttribute("aria-pressed");
  des.title = l ? "Desligar o modo voz: o microfone fecha" : "Parar de escutar o comando";
  // Só a barra presa no alto (celular) pede espaço no começo da tela; no menu do computador ela não cobre nada.
  const presa = getComputedStyle(el).position === "fixed";
  const altura = presa ? Math.ceil(el.getBoundingClientRect().bottom) + 12 + "px" : ""; // quebra em duas linhas conforme a largura
  if (altura === document.body.style.getPropertyValue("--voz-altura")) return;
  if (altura) document.body.style.setProperty("--voz-altura", altura); else document.body.style.removeProperty("--voz-altura");
  if (["conversa", "detail"].includes(view.name)) rolarProFim(); // a página desceu: quem acompanha o fim continua nele
}
window.addEventListener("resize", pintarVozFora);
// O título da aba é o aviso que sobra com o board fora de vista (#303), junto do ponto vermelho do Chrome: só diz "ouvindo" com microfone aberto aqui.
const VOZ_TITULO_BASE = document.title;
function vozTitulo() {
  const fase = VOZ.stream ? ({ cortado: "⛔ microfone cortado", toque: "🖐 toque na tela", gravando: "🔴 ouvindo você" })[VOZ.fase] || (vozNaoReconheceuAgora() ? "🚫 voz não reconhecida" : "🎙 ouvindo") : VOZ.ligado() && VOZ.dona() ? "⏸ microfone fechado" : "";
  const titulo = fase ? `${fase} · ${VOZ_TITULO_BASE}` : VOZ_TITULO_BASE;
  if (document.title !== titulo) document.title = titulo;
}
// "Voz não reconhecida" (#298): aparece na barra e na faixa, onde ele estiver, e passa sozinho. O filtro fora é aviso até o motor voltar.
const vozNaoReconheceuAgora = () => Date.now() < VOZ.naoReconhecidaAte;
const vozQuemAgora = () => vozNaoReconheceuAgora() ? "🚫 voz não reconhecida" : VOZ.filtroFora ? "⚠ filtro de voz fora: qualquer voz passa" : "";
function pintarMinhaVoz() {
  const a = $("#vozMinhaVoz"), imp = VOZ.servidor?.impressao; if (!a) return;
  a.textContent = imp?.cadastrada ? "🔒 só a sua voz: ligado" : "🔒 só a minha voz";
  const q = $("#vozQuem"); if (!q) return;
  const t = vozQuemAgora();
  q.hidden = !t && !VOZ.barradas;
  q.textContent = t + (VOZ.barradas ? `${t ? " · " : ""}${VOZ.barradas} ${VOZ.barradas === 1 ? "trecho descartado" : "trechos descartados"} por outra voz` : "");
}
// Os blocos recolhidos lembram se ele os deixou abertos (por aparelho): o painel muda de desenho ao ligar e desligar.
const vozBloco = (chave, titulo, corpo) => `<details class="voz-mais" data-bloco="${chave}" ${store.get("vozAberto." + chave, false) ? "open" : ""} ontoggle="store.set('vozAberto.${chave}', this.open)"><summary>${titulo}</summary>${corpo}</details>`;
function pintarVoz() {
  vozTitulo();
  pintarVozFora();
  const el = $("#vozFaixa"); if (!el) return;
  const ligado = VOZ.ligado(), srv = VOZ.servidor, fase = vozFaseNaTela();
  const semWhisper = srv && !srv.whisper.ok;
  el.dataset.fase = ligado ? fase : VOZ.comando() ? "espera" : "desligado";
  if (!ligado) {
    const desenho = "off" + VOZ.comando() + !!view.central;
    if (el.dataset.desenho === desenho) return pintarMinhaVoz();
    el.dataset.desenho = desenho;
    const espera = VOZ.comando() ? (view.central ? "👂 microfone aberto nesta tela, só à espera do comando “modo voz” ou “vamos conversar”; todo o resto é descartado" : "👂 na Central à vista o microfone fica aberto só à espera do comando “modo voz” ou “vamos conversar”; aqui ele está fechado") : "Modo voz desligado: nada fica ouvindo.";
    el.innerHTML = `<div class="voz-titulo">🎙 Modo voz</div>
      <button class="btn voz-botao" type="button" aria-pressed="false" title="Falar e ouvir, sem apertar nada, em qualquer tela (ou diga “modo voz”, se a escuta do comando estiver ligada)" onclick="alternarVoz()"><span class="vb-ico" aria-hidden="true">🎙</span><span class="vb-txt"> Ligar o modo voz</span><span class="vb-curto" aria-hidden="true">ligar</span></button>
      <label class="voz-comando" title="Com isto ligado o microfone fica aberto na Central e só o comando é aceito: o resto é descartado na hora, sem ir para a Central"><input type="checkbox" id="vozComando" ${VOZ.comando() ? "checked" : ""} onchange="alternarComandoVoz(this.checked)"> ouvir o comando “modo voz”</label>
      <span class="hint" id="vozAviso">${espera}</span>
      <a class="voz-link" id="vozMinhaVoz" href="#/voz"></a>`;
    return pintarMinhaVoz();
  }
  if (el.dataset.desenho !== "on") {
    el.dataset.desenho = "on";
    el.innerHTML = `<div class="hint voz-dica" id="vozDica"></div>
      <div class="hint voz-quem" id="vozQuem" hidden></div>
      <div class="hint voz-aviso" id="vozAviso"></div>
      ${vozBloco("ajustes", "Ajustes", `<div class="voz-ajustes">
        <label title="Quanto silêncio conta como “terminei de falar”">pausa <input type="range" id="vozPausa" min="800" max="3000" step="100" value="${VOZ.pausa()}" oninput="mudarPausaVoz(this.value)"> <span id="vozPausaTxt"></span></label>
        <label title="Depois de uma resposta, por quanto tempo dá para continuar sem repetir o nome (fora da Central)">continuação <input type="range" id="vozJanela" min="5" max="60" step="5" value="${VOZ.janela()}" oninput="mudarJanelaVoz(this.value)"> <span id="vozJanelaTxt"></span></label>
        <span id="vozVozes"></span></div>`)}
      <a class="voz-link" id="vozMinhaVoz" href="#/voz"></a>
      <div class="hint voz-sim">🔴 SIM por voz não vale: aprove no botão ✓ Aprovar.</div>
      ${vozBloco("limites", "Limites", `<div class="hint voz-limites">A conversa segue até você desligar, em qualquer tela do board, com este painel no menu (no celular, a barra no alto). Também segue com o board em outra aba ou o navegador atrás de outro programa: o microfone continua aberto, e o que avisa é só o ponto vermelho do Chrome na aba e o título da aba (“🎙 ouvindo”). Tela do aparelho bloqueada fecha o microfone e a fala em curso termina; desbloqueou, reabre. Para isso o Chrome pede a permissão de saber quando a tela bloqueia: sem ela, ou em navegador que não diz isso (Safari), fora de vista o microfone fecha e reabre na volta. <span id="vozLimiteNome"></span> Com “Só a minha voz”, outra voz é descartada antes de virar texto, mas isso tira a TV da sala, não protege nada: gravação ou voz parecida pode passar. 🔴 SIM por voz não vale: o pedido é lido em voz alta e você aprova no botão ✓ Aprovar.</div>`)}`;
    pintarVozes();
  }
  const dica = $("#vozDica");
  dica.textContent = VOZ.fala && !VOZ.fala.pausada ? VOZ.fala.texto : (VOZ_FASES[fase] || VOZ_FASES.parado)[1];
  dica.title = dica.textContent; // o painel é estreito: a fala longa aparece cortada, inteira ao passar o mouse (e escrita na Central)
  $("#vozPausaTxt").textContent = (VOZ.pausa() / 1000).toLocaleString("pt-BR", { minimumFractionDigits: 1 }) + " s";
  $("#vozJanelaTxt").textContent = VOZ.janela() + " s";
  const nome = VOZ.nome();
  $("#vozLimiteNome").textContent = `Fora da Central à vista (outra tela, outra aba, board escondido) só vale a fala que COMEÇA com “${nome}”: o resto é descartado, sem ir à Central e sem guardar texto. Depois de uma resposta dá para continuar sem o nome por ${VOZ.janela()} s. Desligar por voz fora da Central sempre pede o nome. O nome é palavra, não senha: outra pessoa dizendo o nome passa, e conversa que comece com ele (“${nome} caiu”) vira mensagem. Quem fala antes e emenda sem pausa perde a frase: o nome tem de abrir o trecho.`;
  const avisos = [];
  if (semWhisper) avisos.push("⚠ " + srv.whisper.motivo);
  if (srv && !srv.piper.ok) avisos.push("⚠ " + srv.piper.motivo);
  if (!VOZ.sabeBloqueio) avisos.push(`⚠ Fora de vista o microfone fecha: ${window.IdleDetector ? "aceite o pedido do Chrome para saber quando a tela bloqueia (ou libere nas configurações do site)" : "este navegador não diz quando a tela bloqueia"}`);
  if (VOZ.semEco && VOZ.stream) avisos.push("⚠ este navegador não cancelou o eco: o microfone fica mudo enquanto o board fala, e cortar é no botão");
  if (srv?.impressao?.aviso) avisos.push("⚠ " + srv.impressao.aviso);
  $("#vozAviso").textContent = avisos.join(" · ");
  pintarMinhaVoz();
  pintarVozes();
  // No celular o painel fica no começo da página: mudar de altura empurra a conversa, e quem acompanha o fim continua nele.
  if (el.offsetHeight !== VOZ.alturaFaixa) { VOZ.alturaFaixa = el.offsetHeight; if (["conversa", "detail"].includes(view.name)) rolarProFim(); }
}
// As vozes (#314): Piper e Kokoro no mesmo seletor, e um ▶ por voz com a mesma frase, para o dono comparar pelo ouvido.
function vozesDoServidor() {
  const srv = VOZ.servidor; if (!srv) return [];
  return srv.vozes || (srv.piper.vozes || []).map((id) => ({ id, nome: id, motor: "piper" }));
}
function pintarVozes() {
  const el = $("#vozVozes"); if (!el || !VOZ.servidor) return;
  const vs = vozesDoServidor(), chave = vs.map((v) => v.id).join(",");
  if (el.dataset.n === chave) return;
  el.dataset.n = chave;
  const atual = vs.some((v) => v.id === VOZ.vozEscolhida()) ? VOZ.vozEscolhida() : vs[0]?.id;
  el.innerHTML = vs.length ? `<label>voz <select id="vozVoz" onchange="escolherVoz(this.value)">${vs.map((v) => `<option value="${esc(v.id)}" ${v.id === atual ? "selected" : ""}>${esc(v.nome)}</option>`).join("")}</select></label> <button class="btn" type="button" onclick="ouvirAmostraVoz()">▶ ouvir</button>
    ${vs.length > 1 ? `<div class="voz-amostras" id="vozAmostras"><span class="hint">Mesma frase em cada voz:</span>${vs.map((v) => `<button class="btn" type="button" data-amostra="${esc(v.id)}" title="Ouvir ${esc(v.nome)}" onclick="ouvirAmostraVoz(this.dataset.amostra)">▶ ${esc(v.nome)}</button>`).join("")}</div>` : ""}${vozJeitoHtml()}` : "";
}
function escolherVoz(id) { store.set("vozVoz", id); vozAquecer(); }
/** Voz do Kokoro escolhida e modo ligado: o servidor sobe o motor antes da 1ª resposta (a carga leva alguns segundos). */
function vozAquecer() {
  if (!VOZ.ligado() || !/^kokoro-/.test(VOZ.vozEscolhida())) return;
  fetch("/api/voz/aquecer", { method: "POST", body: JSON.stringify({ voz: VOZ.vozEscolhida() }), headers: { "content-type": "application/json" } }).catch(() => {});
}
function mudarJanelaVoz(v) { store.set("vozJanela", Number(v)); pintarVoz(); }
function mudarPausaVoz(v) { store.set("vozPausa", Number(v)); if (VOZ.vad) VOZ.vad.pausaMs = Number(v); pintarVoz(); }
function vozMedidor() {
  const el = $("#vozNivel"); if (el && VOZ.vad) el.style.width = Math.min(100, Math.round(Math.sqrt(VOZ.vad.nivel) * 220)) + "%";
  // Os primeiros 500 ms de cada pedaço medem o eco que sobrou (o maior até aqui vale); para interromper, tem de falar bem acima dele.
  const f = VOZ.fala;
  if (f && !f.pausada && VOZ.vad && performance.now() - f.comeco < 500) { f.ecoMax = Math.max(f.ecoMax, VOZ.vad.nivel); VOZ.vad.extra = Math.max(0.02, f.ecoMax * 2.5); }
}
