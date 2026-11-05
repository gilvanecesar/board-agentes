// 🎙 "Só a minha voz" (#298, tela #/voz): o dono grava ~30 s lendo o texto, o board guarda só a impressão, e o modo voz passa a descartar outra voz
// antes de transcrever. Quem decide é o servidor (servidor/voz-quem.mjs): daqui só saem áudio e o nível da sensibilidade, com o Origin da tela.
// O áudio da gravação fica na memória até o envio e não é guardado em lugar nenhum. O microfone fecha ao terminar, ao cancelar, ao sair da tela
// e com a aba escondida. Enquanto grava, o modo voz não escuta (senão a leitura iria para a Central) e não fala.
const VOZ_TEXTO_CADASTRO = "Eu vou contar como foi o meu dia de trabalho. Hoje cedo abri o quadro de tarefas, conferi o que ficou pendente e falei com a equipe sobre os fretes da semana. O caminhão saiu de Goiânia para Curitiba com a carga completa, e o motorista mandou a foto do canhoto assim que chegou. Depois revisei as notas fiscais, corrigi um valor errado e pedi para publicarem a nova versão do sistema. No almoço pensei nas próximas ideias para o site, nos clientes novos e no que precisamos entregar até sexta-feira. À tarde, quero olhar o relatório, responder as mensagens e deixar tudo organizado para amanhã bem cedo.";
const VOZ_NIVEIS = ["aceita bem mais", "aceita mais", "padrão", "exige mais", "exige bem mais"];
const CAD = { gravando: null, pct: 0, nivel: 0, parar: null, enviando: false, teste: null, erro: "" };

/** Grava `seg` segundos pelo mesmo caminho e com o mesmo tratamento do modo voz: a impressão tem de ser do microfone que ele usa. */
async function vozGravar(seg, tipo) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("este endereço não libera o microfone: use o https do Tailscale ou localhost");
  if (ditado === "gravando") throw new Error("pare o ditado antes de gravar");
  const stream = await navigator.mediaDevices.getUserMedia(VOZ_AUDIO);
  let fonte, no, mudo;
  const soltar = () => { stream.getTracks().forEach((t) => t.stop()); try { fonte?.disconnect(); no?.disconnect(); mudo?.disconnect(); } catch { /* já solto */ } };
  try {
    const ctx = vozCtx();
    if (!VOZ.moduloPronto) { await ctx.audioWorklet.addModule("/js/voz-captura.js"); VOZ.moduloPronto = true; }
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    if (view.name !== "voz" || !VOZ.visivel()) { soltar(); return null; } // saiu enquanto o navegador perguntava
    fonte = ctx.createMediaStreamSource(stream); no = new AudioWorkletNode(ctx, "voz-captura"); mudo = ctx.createGain(); mudo.gain.value = 0;
    fonte.connect(no); no.connect(mudo); mudo.connect(ctx.destination);
    vozCortarFala(); if (VOZ.vad) VOZ.vad.limpar();
    VOZ.cadastrando = true;
    Object.assign(CAD, { gravando: tipo, pct: 0, erro: "" });
    const partes = [], alvo = seg * ctx.sampleRate;
    let n = 0;
    return await new Promise((ok) => {
      CAD.parar = (guardar) => {
        no.port.onmessage = null; CAD.parar = null; soltar();
        Object.assign(CAD, { gravando: null, nivel: 0 }); VOZ.cadastrando = false;
        ok(guardar && partes.length ? wavDeVoz(partes, ctx.sampleRate) : null);
        vozProximaFala(); // a resposta que esperava a gravação
      };
      no.port.onmessage = (e) => {
        partes.push(e.data); n += e.data.length;
        let s = 0; for (const v of e.data) s += v * v;
        CAD.nivel = Math.sqrt(s / e.data.length); CAD.pct = Math.min(100, n / alvo * 100);
        pintarVozCadastroAoVivo();
        if (n >= alvo) CAD.parar(true);
      };
      pintarVozCadastro();
    });
  } catch (e) { soltar(); VOZ.cadastrando = false; CAD.gravando = null; throw e; }
}
const vozPararGravacao = (guardar) => CAD.parar?.(guardar);
window.addEventListener("hashchange", () => { if (view.name !== "voz") vozPararGravacao(false); });
document.addEventListener("visibilitychange", () => { if (!VOZ.visivel()) vozPararGravacao(false); });
window.addEventListener("pagehide", () => vozPararGravacao(false));

async function vozEnviarGravacao(rota, wav) {
  const r = await fetch(rota, { method: "POST", body: wav, headers: { "content-type": "audio/wav" } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "erro " + r.status);
  return d;
}
async function vozRecarregarEstado() {
  try { VOZ.servidor = await api("/voz/estado"); } catch { /* fica o que havia */ }
  if (!VOZ.servidor?.impressao?.cadastrada) VOZ.filtroFora = null; // apagou: não há filtro para estar fora
  pintarVoz(); pintarVozCadastro();
}
async function vozCadastrar() {
  const imp = VOZ.servidor?.impressao;
  if (CAD.gravando || CAD.enviando || !imp) return;
  if (imp.cadastrada && !confirm("Gravar de novo troca a impressão atual da sua voz. Continuar?")) return;
  try {
    const wav = await vozGravar(imp.cadastroSeg, "cadastro");
    if (!wav) return pintarVozCadastro();
    CAD.enviando = true; CAD.teste = null; pintarVozCadastro();
    await vozEnviarGravacao("/api/voz/impressao", wav);
    toast("Voz cadastrada. O áudio não foi guardado.");
    await vozRecarregarEstado();
  } catch (e) { CAD.erro = e.message; }
  finally { CAD.enviando = false; pintarVozCadastro(); }
}
async function vozTestar() {
  if (CAD.gravando || CAD.enviando) return;
  try {
    const wav = await vozGravar(5, "teste");
    if (!wav) return pintarVozCadastro();
    CAD.enviando = true; pintarVozCadastro();
    CAD.teste = await vozEnviarGravacao("/api/voz/impressao/testar", wav);
    await vozRecarregarEstado();
  } catch (e) { CAD.erro = e.message; }
  finally { CAD.enviando = false; pintarVozCadastro(); }
}
async function vozApagar() {
  if (!confirm("Apagar a impressão da sua voz? O modo voz volta a aceitar qualquer voz.")) return;
  try { await api("/voz/impressao", { method: "DELETE" }); CAD.teste = null; toast("Impressão apagada."); await vozRecarregarEstado(); }
  catch (e) { toast("Voz: " + e.message, 5000, "erro"); }
}
async function vozAjustar(v) {
  try { await api("/voz/impressao/ajuste", { method: "POST", body: { nivel: Number(v) } }); CAD.teste = null; await vozRecarregarEstado(); }
  catch (e) { toast("Voz: " + e.message, 5000, "erro"); }
}

// ── A tela ───────────────────────────────────────────────────────────────────
function renderVozCadastro() {
  const app = $("#app");
  if ($("#vozCad")) return renderHeader(); // o board manda evento o tempo todo: redesenhar a tela arrancaria o controle da mão dele
  delete app.dataset.task; delete app.dataset.conversa; delete app.dataset.busca; delete app.dataset.prs;
  app.className = "wrap";
  app.innerHTML = headerHtml(`<button class="back" onclick="location.hash='#/central'">← voltar</button>`) + `<section class="voz-cad" id="vozCad"></section>`;
  window.scrollTo(0, 0); // vem da Central, muitas vezes rolada até o fim
  if (VOZ.servidor) pintarVozCadastro();
  vozRecarregarEstado(); // o estado da Central pode ser de antes do cadastro feito em outro aparelho
}
const virgula = (n) => String(n ?? "—").replace(".", ",");
const fracaoHtml = (f) => f?.janelas ? `${f.passariam} de ${f.janelas}` : "sem janelas para medir";
function pintarVozCadastroAoVivo() {
  const b = $("#vozCadBarra"), m = $("#vozCadNivel");
  if (b) b.style.width = CAD.pct + "%";
  if (m) m.style.width = Math.min(100, Math.round(Math.sqrt(CAD.nivel) * 220)) + "%";
}
function pintarVozCadastro() {
  const el = $("#vozCad"); if (!el) return;
  const imp = VOZ.servidor?.impressao;
  if (!imp) { el.innerHTML = `<p class="hint">Lendo o estado da voz…</p>`; return; }
  const ocupado = !!CAD.gravando || CAD.enviando, u = imp.uso, m = imp.medido;
  const estado = imp.cadastrada ? `<span class="selo voz-estado" data-fase="falando">🔒 Só a sua voz: ligado</span> <span class="hint">gravada em ${esc(new Date(imp.em).toLocaleString("pt-BR"))}, ${esc(virgula(imp.segundos))} s de voz</span>` : `<span class="selo voz-estado">Sem cadastro: o modo voz aceita qualquer voz</span>`;
  const gravacao = CAD.gravando
    ? `<div class="voz-cad-grava"><span class="selo voz-estado" data-fase="gravando">🔴 ${CAD.gravando === "teste" ? "Fale uma frase" : "Gravando: leia o texto"}</span><span class="voz-nivel" aria-hidden="true"><i id="vozCadNivel"></i></span>
        <span class="voz-cad-progresso" role="progressbar" aria-label="Tempo de gravação"><i id="vozCadBarra"></i></span>
        ${CAD.gravando === "cadastro" ? `<button class="btn" type="button" onclick="vozPararGravacao(true)">Terminei</button>` : ""}<button class="btn" type="button" onclick="vozPararGravacao(false)">Cancelar</button></div>`
    : CAD.enviando ? `<p class="hint">⏳ Conferindo aqui no servidor…</p>`
      : `<div class="voz-linha"><button class="btn primary" type="button" id="vozCadGravar" ${imp.motor.ok ? "" : "disabled"} onclick="vozCadastrar()">🔴 ${imp.cadastrada ? "Gravar de novo" : "Gravar minha voz"}</button>
        ${imp.cadastrada ? `<button class="btn" type="button" id="vozCadTestar" onclick="vozTestar()">🎤 Testar uma frase</button><button class="btn" type="button" id="vozCadApagar" onclick="vozApagar()">Apagar</button>` : ""}</div>`;
  const teste = CAD.teste ? `<p class="voz-cad-teste" id="vozCadTeste" data-passou="${CAD.teste.passou}">${CAD.teste.passou ? "✓ Passaria" : "🚫 Voz não reconhecida"}: nota ${esc(virgula(CAD.teste.nota))}, o limiar para ${esc(virgula(CAD.teste.seg))} s de voz é ${esc(virgula(CAD.teste.limiar))}.</p>` : "";
  const ajuste = imp.cadastrada ? `<h3>Sensibilidade</h3>
    <div class="voz-linha voz-ajustes"><label>${esc(VOZ_NIVEIS[0])} <input type="range" id="vozNivelCad" min="1" max="${imp.niveis}" step="1" value="${imp.nivel}" ${ocupado ? "disabled" : ""} onchange="vozAjustar(this.value)"> ${esc(VOZ_NIVEIS[imp.niveis - 1])}</label><span class="hint" id="vozNivelTxt">${esc(VOZ_NIVEIS[imp.nivel - 1])}: comando curto a partir de ${esc(virgula(imp.limiares.curto))}, frase a partir de ${esc(virgula(imp.limiares.longo))}</span></div>
    <p class="hint">O padrão prefere deixar passar uma voz estranha a barrar a sua. Se sua voz está caindo, puxe para a esquerda; se outra voz entra, para a direita.</p>
    <h3>Medido com a sua voz</h3>
    <ul class="voz-cad-medidas"><li>Na gravação: ${esc(fracaoHtml(m?.curtas))} pedaços do tamanho de um comando passariam, e ${esc(fracaoHtml(m?.longas))} do tamanho de uma frase.</li>
      <li id="vozCadUso">No uso, desde o cadastro: ${u.dono} trechos passaram, ${u.outra} não reconhecidos${u.fora ? `, ${u.fora} com o filtro fora` : ""}${u.msMediano ? `. Conferir leva ${u.msMediano} ms` : ""}.</li></ul>` : "";
  const avisos = [imp.motor.motivo, imp.aviso].filter((a, i, l) => a && l.indexOf(a) === i);
  el.innerHTML = `<h2>Só a minha voz</h2>
    <p class="voz-linha">${estado}</p>
    ${avisos.map((a) => `<p class="voz-aviso">⚠ ${esc(a)}</p>`).join("")}
    ${CAD.erro ? `<p class="voz-aviso" id="vozCadErro">⚠ ${esc(CAD.erro)}</p>` : ""}
    <p class="hint">Grave ${imp.cadastroSeg} segundos lendo o texto abaixo em voz normal, no aparelho e no lugar onde usa o modo voz. O áudio é conferido aqui no servidor e descartado: fica só uma impressão numérica da voz, que você pode apagar.</p>
    <blockquote class="voz-cad-texto">${esc(VOZ_TEXTO_CADASTRO)}</blockquote>
    ${gravacao}${teste}${ajuste}
    <h3>Limites</h3>
    <p class="hint voz-limites">Isto tira a TV e a conversa da sala, não protege nada. 🔴 Não é senha: gravação da sua voz ou uma voz parecida pode passar, e comando curto é o que mais erra. A impressão nunca aprova nada: SIM por voz continua sem valer, e você aprova no botão ✓ Aprovar. Com o motor fora do ar a fala passa sem filtro, e a barra do modo voz avisa.</p>
    <p><a href="#/central">Voltar à Central</a></p>`;
  pintarVozCadastroAoVivo();
}
