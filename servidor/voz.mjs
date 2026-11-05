// 🎙 Modo voz da Central (#286, 31/10: "não quero apertar nada pra ouvir sua resposta; simplesmente quero falar e, quando
// você estiver pronto, você fala"). O navegador percebe a fala (web/js/voz.js) e manda o trecho para cá; aqui ele vira
// texto (whisper) e segue para a Central, e a resposta volta em voz (Piper). Tudo local: nenhum áudio sai desta máquina.
//
// 🔴 Quem transforma áudio em mensagem é SÓ esta rota, com a origem "voz" gravada pelo servidor: a tela não tem como dizer
// que uma fala foi digitada, e `board aprovacao` recusa o que veio daqui (ruído, TV ou outra pessoa podem soar como "sim").
import { spawn } from "child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { basename, dirname, join } from "path";
import { cut, VOZ_NOME } from "./config.mjs";
import { broadcast, logEvent, readLog, save } from "./estado.mjs";
import { daTela } from "./origem.mjs";
import { lerBinario } from "./anexos.mjs";
import { refereDe, registrarAprovacao } from "./aprovacoes.mjs";
import { conversaDe, conversaId, falarNaConversa } from "./conversa.mjs";
import { ditadoModelo, transcrever, whisperBin } from "./ditado.mjs";
import { CENTRAL } from "./central.mjs";
import { conferirVoz, estadoImpressao, marcaDoFiltro, rotaImpressao } from "./voz-quem.mjs";
import { aquecerKokoro, ehVozKokoro, pedacosDaFala, sintetizarKokoro, vozesKokoro } from "./voz-kokoro.mjs";
import { comandoDeVoz, ehEco, ehInvencaoDoWhisper, lerChamada, paraPronuncia, pareceFrase, podeSerComando, PROMPT_CURTO, textoDaFala, trechoCurto } from "./voz-texto.mjs";

const HOME = () => process.env.HOME || homedir();
const PASTA_VOZ = () => process.env.BOARD_VOZ_PASTA || join(HOME(), ".local/share/board-voz");
const piperBin = () => process.env.BOARD_VOZ_PIPER || join(PASTA_VOZ(), "piper/piper");
const VOZ_PADRAO = process.env.BOARD_VOZ_PADRAO || "faber";
const AUDIO_MAX = 12 * 1024 * 1024; // ~6 min de wav 16 kHz: a tela corta bem antes

// ── A voz (Piper, na CPU) ─────────────────────────────────────────────────────
export function vozesInstaladas() {
  let nomes = [];
  try { nomes = readdirSync(PASTA_VOZ()); } catch { return []; }
  return nomes.map((f) => f.match(/^pt_BR-(.+)-(medium|low|high)\.onnx$/)).filter(Boolean).map((m) => ({ id: m[1], arquivo: join(PASTA_VOZ(), m[0]) }))
    .sort((a, b) => (b.id === VOZ_PADRAO) - (a.id === VOZ_PADRAO) || a.id.localeCompare(b.id));
}

export function estadoVoz() {
  const modelo = ditadoModelo(), vozes = vozesInstaladas();
  const temWhisper = existsSync(modelo) && (whisperBin() === "whisper-cli" || existsSync(whisperBin()));
  const temPiper = existsSync(piperBin()) && vozes.length > 0;
  return {
    nome: VOZ_NOME,
    impressao: estadoImpressao(),
    whisper: { ok: temWhisper, modelo: basename(modelo), motivo: temWhisper ? null : `falta o whisper ou o modelo (${basename(modelo)}) nesta máquina` },
    kokoro: { ok: vozesKokoro().length > 0, motivo: vozesKokoro().length ? null : "Kokoro não instalado nesta máquina (scripts/instalar-kokoro.sh)" },
    // Todas as vozes do seletor (#314): o Piper primeiro (a Faber segue padrão até o dono escolher), depois as do Kokoro.
    vozes: [...(temPiper ? vozes.map((v) => ({ id: v.id, nome: `${v.id[0].toUpperCase()}${v.id.slice(1)} (Piper)`, motor: "piper" })) : []),
      ...vozesKokoro().map((v) => ({ id: v.id, nome: v.nome, motor: "kokoro" }))],
    piper: { ok: temPiper, vozes: vozes.map((v) => v.id), ajuste: Object.fromEntries(Object.entries(AJUSTE_FALA).map(([k, a]) => [k, { min: a.min, max: a.max, padrao: a.padrao() }])), motivo: temPiper ? null : "sem Piper nesta máquina: a voz é a do navegador, sem interromper falando" },
  };
}

// O jeito de falar (#313). Medido com a Faber, 5 frases de colega, whisper conferindo (CLAUDE.md): ruído maior que o do modelo
// só piorou o entendimento, e o tempo de geração não muda (~0,4 s por frase, quase tudo é carregar o modelo). O que mudou o
// padrão foi a pausa entre frases: 0,2 s → 0,4 s. Quem decide pelo ouvido é o dono, nos Ajustes do painel; o servidor só limita.
const num = (v, d) => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? d : Number(v));
export const AJUSTE_FALA = {
  ritmo: { arg: "--length_scale", min: 0.7, max: 1.4, padrao: () => num(process.env.BOARD_VOZ_VELOCIDADE, 1) },
  entonacao: { arg: "--noise_scale", min: 0.3, max: 1.0, padrao: () => num(process.env.BOARD_VOZ_ENTONACAO, 0.667) },
  variacao: { arg: "--noise_w", min: 0.3, max: 1.2, padrao: () => num(process.env.BOARD_VOZ_VARIACAO, 0.8) },
  pausa: { arg: "--sentence_silence", min: 0, max: 1.0, padrao: () => num(process.env.BOARD_VOZ_PAUSA_FRASES, 0.4) },
};
/** O ajuste pedido pela tela, sempre dentro dos limites; o que faltar ou vier torto vale o padrão. */
export function ajusteDaFala(pedido = {}) {
  const out = {};
  for (const [k, a] of Object.entries(AJUSTE_FALA)) out[k] = Math.round(Math.min(a.max, Math.max(a.min, num(pedido?.[k], a.padrao()))) * 1000) / 1000;
  return out;
}

/** Texto → WAV. Sem Piper devolve null e a tela cai na voz do navegador (speechSynthesis). */
export function sintetizar(texto, vozPedida, ajuste = {}) {
  const vozes = vozesInstaladas(), voz = vozes.find((v) => v.id === vozPedida) || vozes[0];
  if (!voz || !existsSync(piperBin())) return Promise.resolve(null);
  const dir = mkdtempSync(join(tmpdir(), "board-fala-")), saida = join(dir, "fala.wav");
  return new Promise((ok, bad) => {
    // CPU de propósito: o binário do Piper não leva GPU, e o CUDA fica fora do ambiente de qualquer forma.
    const cp = spawn(piperBin(), ["--model", voz.arquivo, "--output_file", saida, ...Object.entries(ajusteDaFala(ajuste)).flatMap(([k, v]) => [AJUSTE_FALA[k].arg, String(v)])],
      { env: { ...process.env, CUDA_VISIBLE_DEVICES: "-1", LD_LIBRARY_PATH: dirname(piperBin()) }, stdio: ["pipe", "ignore", "pipe"] });
    let erro = "";
    const prazo = setTimeout(() => cp.kill("SIGKILL"), 60000);
    cp.stderr.on("data", (d) => { erro = (erro + d).slice(-400); });
    cp.on("error", (e) => { clearTimeout(prazo); bad(e); });
    cp.on("close", (code) => {
      clearTimeout(prazo);
      if (code === 0 && existsSync(saida)) ok(readFileSync(saida)); else bad(new Error(`o Piper saiu com código ${code}: ${erro.trim()}`));
    });
    cp.stdin.on("error", () => { /* saiu antes de ler: o close diz por quê */ });
    cp.stdin.end(paraPronuncia(texto) + "\n");
  }).finally(() => rmSync(dir, { recursive: true, force: true }));
}

// A mesma frase para toda voz (#314): o dono compara Piper e Kokoro ouvindo o mesmo texto.
export const AMOSTRA = "Oi, sou eu, a voz da Central. Olha, é desse jeito que eu vou te responder. Se quiser, ajusta aí que eu mudo. Beleza?";

/**
 * Um pedaço da fala na voz pedida. Kokoro: o texto vai em pedaços (`pedacosDaFala`), a tela pede um por vez; o Piper é rápido
 * (~0,4 s a resposta inteira) e vai de uma vez. Kokoro que falha no 1º pedaço cai no Piper (a reserva), com o motivo no registro.
 */
export async function falarPedaco(texto, voz, ajuste, parte = 0) {
  if (ehVozKokoro(voz) && vozesKokoro().some((v) => v.id === voz)) {
    const pedacos = pedacosDaFala(paraPronuncia(texto));
    if (parte >= pedacos.length) throw new Error("esse pedaço não existe");
    try {
      const r = await sintetizarKokoro(pedacos[parte], voz, { velocidade: Math.round((1 / ajuste.ritmo) * 1000) / 1000, pausa: ajuste.pausa });
      return { wav: r.wav, motor: "kokoro", partes: pedacos.length };
    } catch (e) {
      if (parte > 0) throw e;
      const wav = await sintetizar(texto, VOZ_PADRAO, ajuste);
      return { wav, motor: "piper", partes: 1, reserva: cut(e.message, 200) };
    }
  }
  if (parte > 0) throw new Error("esse pedaço não existe");
  return { wav: await sintetizar(texto, voz, ajuste), motor: "piper", partes: 1 };
}

// ── Do áudio à mensagem ───────────────────────────────────────────────────────
const registro = (ev) => logEvent("voz", { t: "voz", ...ev }); // só medição: nunca o texto nem o áudio

/** Manda à Central o que foi falado. O id da aprovação leva a origem "voz", assinada: `board aprovacao` recusa. */
function enviarFalada(texto) {
  const id = conversaId(CENTRAL);
  const { id: aprovacao } = registrarAprovacao({ texto, refere: refereDe(readLog(id), null), origem: "voz" });
  falarNaConversa(CENTRAL, texto, { aprovacao, voz: true })
    .catch((e) => { logEvent(id, { t: "solto", texto: "⚠ " + e.message }); conversaDe(CENTRAL).busy = false; save(); broadcast("state"); });
  return aprovacao;
}

function falaDaResposta(n) {
  const ev = readLog(conversaId(CENTRAL)).find((e) => e.t === "resultado" && e.n === n && e.texto);
  return ev ? textoDaFala(ev.texto, ev.pedidoSim) : null;
}

/**
 * O texto do trecho e, se for o caso, o comando. A 1ª passada, com o vocabulário de sempre, decide se houve fala e dá o texto da
 * mensagem. Só o que ela ouviu, em trecho curto e sem ser comando, vai à 2ª passada, com as frases dos comandos no prompt: dela só
 * se aproveita um comando, e só se a 1ª for parecida com ele. Esse prompt puxa o que ouve para os comandos: ruído virava "Vamos
 * conversar. Espera." e "Pode falar." virava "Para de falar." (QA da #286), e aí a 1ª é quem vale.
 * O comando é lido sem o nome de chamada: "Atena, modo texto" é o comando, em qualquer tela (#305).
 */
async function transcreverTrecho(buf, falando) {
  const texto = await transcrever(buf);
  if (ehInvencaoDoWhisper(texto)) return { texto, comando: null, nada: true };
  const chamada = lerChamada(texto), dito = chamada.citou ? chamada.resto : texto;
  const comando = comandoDeVoz(dito, { falando });
  if (comando || !dito || !trechoCurto(buf.length) || !podeSerComando(dito)) return { texto, chamada, comando };
  const segunda = lerChamada(await transcrever(buf, { prompt: PROMPT_CURTO })), outra = segunda.citou ? segunda.resto : segunda.texto;
  return { texto, chamada, comando: pareceFrase(dito, outra) ? comandoDeVoz(outra, { falando }) : null };
}

/**
 * Fora da Central (#305) a fala só vale com o nome no começo. `exige`: "nome" ou "janela" (a continuação logo depois de uma resposta).
 * Desligar pede o nome sempre, também na janela. Cortar o board enquanto ele fala não pede: calar é o que tem de ser na hora, e não manda nada.
 */
function valeSemCentral({ exige, citou, comando, falando }) {
  if (citou) return true;
  if (comando === "desligar") return false;
  if (comando === "cortar" && falando) return true;
  return exige === "janela";
}

/**
 * Um trecho de áudio da tela. `modo`:
 * - "conversa": comando ou mensagem para a Central;
 * - "espera": a tela só espera o comando "modo voz": o que não for ele é descartado, sem log nem resposta;
 * - "falando": chegou enquanto o board falava (`n` = a resposta): comando, eco do board ou mensagem.
 * `exige` (#305): a tela diz o que esta fala precisa ter. Vazio = a Central à vista, tudo como sempre. "nome"/"janela" = fora da Central: quem
 * não passa é descartado aqui, sem texto na resposta nem no registro.
 * Quem fala (#298) vem antes de tudo, antes do whisper e em todo modo, comandos inclusive: voz que não é a do dono nem vira texto.
 * Com cadastro os dois filtros têm de passar: a voz aqui, o nome depois do texto.
 */
export async function ouvir(buf, { modo, n, exige = "" }) {
  const comecou = Date.now();
  const quem = await conferirVoz(buf);
  const marca = marcaDoFiltro(quem);
  // Na resposta, só com cadastro: a tela mostra o aviso, e sem cadastro nada muda.
  const doFiltro = quem.fora ? { filtroFora: quem.fora } : "passou" in quem ? { filtro: true } : {};
  const medida = (ms, resultado) => registro({ acao: "ouviu", modo, ...(exige ? { exige } : {}), ms, bytes: buf.length, resultado, ...marca });
  if (quem.passou === false) { const ms = Date.now() - comecou; medida(ms, "naoReconhecida"); return { naoReconhecida: true, nota: quem.nota, limiar: quem.limiar, ...doFiltro, ms }; }
  const { texto, chamada, comando, nada } = await transcreverTrecho(buf, modo === "falando");
  const ms = Date.now() - comecou;
  const fim = (r) => { medida(ms, r.comando || Object.keys(r)[0]); return { ...r, ...doFiltro, ms }; };
  if (nada) return fim({ nada: true });
  if (modo === "espera") return fim(comando === "ligar" ? { comando } : { nada: true });
  if (exige && !valeSemCentral({ exige, citou: chamada.citou, comando, falando: modo === "falando" })) return fim({ semNome: true });
  if (comando) return fim({ comando });
  if (modo === "falando" && ehEco(texto, falaDaResposta(n) || "")) return fim({ eco: true });
  const mensagem = exige && chamada.citou ? chamada.resto : texto;
  if (!mensagem) return fim({ chamado: true }); // só o nome: a tela abre a continuação para ele dizer o resto
  return fim({ enviado: enviarFalada(mensagem), texto: cut(mensagem, 4000) });
}

// ── Rotas: tudo só da própria tela (a barreira do 🚀) ─────────────────────────
export async function rotaVoz(req, res, url, { json, readBody }) {
  const path = url.pathname;
  if (req.method === "GET" && path === "/api/voz/estado") return json(res, 200, estadoVoz());
  if (path.startsWith("/api/voz/impressao")) return rotaImpressao(req, res, url, { json, readBody });
  if (req.method !== "POST") return json(res, 404, { error: "rota não existe" });
  if (!daTela(req)) return json(res, 403, { error: "o modo voz só funciona pela tela do board" });

  if (path === "/api/voz/ouvir") {
    const modo = url.searchParams.get("modo") || "conversa";
    if (!["conversa", "espera", "falando"].includes(modo)) return json(res, 400, { error: "modo inválido" });
    const exige = url.searchParams.get("exige") || "";
    if (!["", "nome", "janela"].includes(exige)) return json(res, 400, { error: "exigência inválida" });
    // Celular que perde a rede ou aba fechada no meio do envio: a leitura rejeita. Nunca pode virar erro solto, que derruba o board.
    if (Number(req.headers["content-length"]) > AUDIO_MAX) return json(res, 413, { error: "áudio grande demais" });
    let buf;
    try { buf = await lerBinario(req, AUDIO_MAX); }
    catch (e) { return json(res, /grande/.test(e.message) ? 413 : 400, { error: "áudio incompleto: " + cut(e.message, 120) }); }
    if (!buf.length) return json(res, 400, { error: "áudio vazio" });
    try { return json(res, 200, await ouvir(buf, { modo, exige, n: Number(url.searchParams.get("n")) || null })); }
    catch (e) { return json(res, 500, { error: "não consegui transcrever: " + cut(String(e.stderr || e.message), 200) }); }
  }
  if (path === "/api/voz/aquecer") {
    let b = {};
    try { b = await readBody(req); } catch { /* sem corpo */ }
    return json(res, 200, { ok: ehVozKokoro(b.voz) ? aquecerKokoro() : false });
  }
  if (path === "/api/voz/fala") {
    let b;
    try { b = await readBody(req); } catch { return json(res, 400, { error: "pedido inválido" }); }
    const texto = b.amostra ? AMOSTRA : falaDaResposta(Number(b.n));
    if (!texto) return json(res, 404, { error: "não achei essa resposta na Central" });
    const comecou = Date.now();
    const ajuste = ajusteDaFala(b.ajuste), voz = String(b.voz || ""), parte = Math.max(0, Math.floor(Number(b.parte) || 0));
    let fala = null, motivo = null;
    try { fala = await falarPedaco(texto, voz, ajuste, parte); } catch (e) { motivo = cut(e.message, 200); }
    registro({ acao: "falou", ms: Date.now() - comecou, chars: texto.length, ok: !!fala?.wav, ajuste, ...(fala ? { motor: fala.motor, parte, partes: fala.partes, ...(fala.reserva ? { reserva: fala.reserva } : {}) } : {}), ...(motivo ? { motivo } : {}) });
    if (!fala?.wav) return parte > 0 ? json(res, 502, { error: motivo || "sem voz" }) : json(res, 200, { texto, voz: null, motivo: motivo || estadoVoz().piper.motivo });
    res.writeHead(200, { "content-type": "audio/wav", "content-length": fala.wav.length, "cache-control": "no-store", "x-voz-texto": encodeURIComponent(texto),
      "x-voz-motor": fala.motor, "x-voz-parte": String(parte), "x-voz-partes": String(fala.partes) });
    return res.end(fala.wav);
  }
  return json(res, 404, { error: "rota não existe" });
}
