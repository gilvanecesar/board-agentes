// 🎙 Quem fala (#298, pedido falado do dono): o modo voz só com a voz dele. O cadastro grava ~30 s na tela, o motor local (voz-quem.py,
// na CPU) tira a impressão, e daí cada trecho é comparado ANTES do whisper: abaixo do limiar é descartado sem transcrever e sem ir à Central.
// O áudio só passa pela entrada do processo, nunca pelo disco. Fica SÓ o vetor, em data/voz-impressao.json (0600).
//
// 🔴 A impressão é um filtro de ruído, NÃO é autenticação: gravação ou voz parecida pode passar. Nada aqui fala com aprovações, e o que passa
// continua sendo mensagem com origem "voz": SIM falado não vale, com ou sem cadastro. Este módulo não importa aprovacoes.mjs, de propósito.
//
// Quem decide é o servidor: o limiar e a sensibilidade moram aqui e no arquivo, e a rota não aceita nota nem limiar vindos da tela.
import { spawn } from "child_process";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { cut, DATA } from "./config.mjs";
import { broadcast, logEvent, readLog } from "./estado.mjs";
import { daTela } from "./origem.mjs";
import { lerBinario } from "./anexos.mjs";
import { TRANSCRICOES, wavProntoParaWhisper } from "./ditado.mjs";

const ARQUIVO = () => join(DATA, "voz-impressao.json");
const MODELO = "nemo_en_titanet_small.onnx"; // ver a medição no CLAUDE.md, "Só a voz do dono"
const VERSAO = 1;
const AQUI = dirname(fileURLToPath(import.meta.url));
const PASTA = () => join(process.env.BOARD_VOZ_PASTA || join(process.env.HOME || homedir(), ".local/share/board-voz"), "quem");
const PYTHON = () => join(PASTA(), "env/bin/python");
const CAMINHO_MODELO = () => join(PASTA(), MODELO);
const AUDIO_MAX = 12 * 1024 * 1024;
const PRAZO_TRECHO_MS = 8000, PRAZO_CADASTRO_MS = 30000;
export const CADASTRO_S = () => Number(process.env.BOARD_VOZ_CADASTRO_S) || 30;
const CADASTRO_MIN_S = () => Number(process.env.BOARD_VOZ_CADASTRO_MIN_S) || 12; // segundos de VOZ, tirado o silêncio

/**
 * O limiar sobe com a voz do trecho: comando de 0,5 s mede mal e frase de 3 s separa bem (tabela no CLAUDE.md). O padrão erra para o lado
 * de aceitar o dono: no ponto em que ele passa sempre na medição, mesmo deixando parte da voz curta de outra pessoa passar.
 */
const PONTOS = [[0.8, 0.15], [1.6, 0.3], [3, 0.37]];
export const NIVEIS = { 1: -0.1, 2: -0.05, 3: 0, 4: 0.05, 5: 0.1 };
export const NIVEL_PADRAO = 3;
export function limiarDe(seg, nivel = NIVEL_PADRAO) {
  const [a] = PONTOS, b = PONTOS[PONTOS.length - 1];
  let base = seg <= a[0] ? a[1] : b[1];
  for (let i = 1; i < PONTOS.length; i++) {
    const [x0, y0] = PONTOS[i - 1], [x1, y1] = PONTOS[i];
    if (seg > x0 && seg <= x1) base = y0 + (y1 - y0) * (seg - x0) / (x1 - x0);
  }
  return Math.round((base + (NIVEIS[nivel] ?? 0)) * 1000) / 1000;
}

export function motorDaVoz() {
  if (process.env.BOARD_VOZ_QUEM) return { ok: true, modelo: MODELO, motivo: null };
  const ok = existsSync(PYTHON()) && existsSync(CAMINHO_MODELO());
  return { ok, modelo: MODELO, motivo: ok ? null : "o motor da impressão de voz não está instalado nesta máquina: rode scripts/instalar-voz-quem.sh" };
}

// ── O motor: um processo por trecho, com o áudio só na entrada dele ───────────
function medir(buf, modo, prazo) {
  const [cmd, ...args] = process.env.BOARD_VOZ_QUEM ? [process.env.BOARD_VOZ_QUEM] : [PYTHON(), "-I", join(AQUI, "voz-quem.py"), CAMINHO_MODELO()];
  return new Promise((ok, bad) => {
    const cp = spawn(cmd, [...args, modo], { env: { ...process.env, CUDA_VISIBLE_DEVICES: "-1" }, stdio: ["pipe", "pipe", "pipe"] });
    const vez = { cp }; // o ↻ espera por ele, e o board saindo não deixa o processo com o áudio na memória
    TRANSCRICOES.add(vez);
    let saida = "", erro = "";
    const parar = setTimeout(() => cp.kill("SIGKILL"), prazo);
    const fim = () => { clearTimeout(parar); TRANSCRICOES.delete(vez); };
    cp.stdout.on("data", (d) => { saida += d; });
    cp.stderr.on("data", (d) => { erro = (erro + d).slice(-400); });
    cp.on("error", (e) => { fim(); bad(e); });
    cp.on("close", (code) => {
      fim();
      if (code === 2) return bad(Object.assign(new Error("áudio em formato que o motor não lê"), { formato: true }));
      if (code !== 0) return bad(new Error(`o motor da voz saiu com código ${code}: ${erro.trim()}`));
      try { ok(JSON.parse(saida)); } catch { bad(new Error("o motor da voz respondeu algo ilegível")); }
    });
    cp.stdin.on("error", () => { /* saiu antes de ler: o close diz por quê */ });
    cp.stdin.end(buf);
  });
}

// ── A impressão ───────────────────────────────────────────────────────────────
function lerArquivo() {
  if (!existsSync(ARQUIVO())) return null;
  try {
    const i = JSON.parse(readFileSync(ARQUIVO(), "utf8"));
    return Array.isArray(i.vetor) && i.vetor.length ? i : { ilegivel: true };
  } catch { return { ilegivel: true }; }
}
function gravarArquivo(dados) {
  const tmp = ARQUIVO() + ".novo";
  writeFileSync(tmp, JSON.stringify(dados), { mode: 0o600 });
  chmodSync(tmp, 0o600); // arquivo que sobrou de uma gravação cortada mantém o modo antigo: o `mode` só vale ao criar
  renameSync(tmp, ARQUIVO());
}
const cosseno = (a, b) => a.length === b.length ? a.reduce((s, x, i) => s + x * b[i], 0) : null;
const NUM = (n) => Math.round(n * 1000) / 1000;

/**
 * O filtro: a decisão sobre um trecho, antes do whisper.
 * - `{}` sem cadastro: tudo como sempre.
 * - `{passou: true|false, nota, limiar, seg, msQuem}`.
 * - `{fora: motivo}`: há cadastro e o motor falhou. Decisão da #298: a fala passa, avisando na tela. O filtro não é barreira de segurança, e
 *   um modo voz surdo por causa do filtro é o erro que o dono pediu para evitar ("erre para o lado de aceitar"). Quem cala é o áudio ilegível.
 */
export async function conferirVoz(buf) {
  const imp = lerArquivo();
  if (!imp) return {};
  if (imp.ilegivel) return { fora: "a impressão de voz está ilegível: grave de novo" };
  if (imp.modelo !== MODELO) return { fora: "a impressão foi feita com outro modelo: grave de novo" };
  if (!wavProntoParaWhisper(buf)) return { passou: false, nota: null, limiar: null, seg: 0, msQuem: 0 }; // a tela sempre manda WAV: outro formato não fura o filtro
  if (!motorDaVoz().ok) return { fora: motorDaVoz().motivo };
  const comecou = Date.now();
  let r;
  try { r = await medir(buf, "trecho", PRAZO_TRECHO_MS); }
  catch (e) {
    if (e.formato) return { passou: false, nota: null, limiar: null, seg: 0, msQuem: Date.now() - comecou };
    return { fora: "o motor da impressão de voz falhou: " + cut(e.message, 160) };
  }
  const msQuem = Date.now() - comecou;
  const nota = r.vetor ? cosseno(r.vetor, imp.vetor) : null, limiar = limiarDe(r.seg, imp.nivel);
  if (r.vetor && nota === null) return { fora: "a impressão foi feita com outro modelo: grave de novo" };
  return { passou: nota !== null && nota >= limiar, nota: nota === null ? null : NUM(nota), limiar, seg: r.seg, msQuem };
}

/** Só os números, para voz.jsonl: nunca o vetor, nunca o texto. */
export const marcaDoFiltro = (q) => q.fora ? { quem: "fora" } : "passou" in q ? { quem: q.passou ? "dono" : "outra", nota: q.nota, limiar: q.limiar, seg: q.seg, msQuem: q.msQuem } : {};

const fracao = (notas, limiar) => ({ janelas: notas.length, passariam: notas.filter((n) => n >= limiar).length, menor: notas.length ? Math.min(...notas) : null });
/** A medição com a gravação do próprio dono: cada pedaço dela contra o resto, no limiar de um comando (curto) e de uma frase (longo). */
const medirGravacao = (j, nivel) => j ? { curtas: fracao(j.curtas || [], limiarDe(0.8, nivel)), longas: fracao(j.longas || [], limiarDe(3, nivel)) } : null;

export async function cadastrar(buf) {
  const comecou = Date.now();
  const r = await medir(buf, "cadastro", PRAZO_CADASTRO_MS);
  const min = CADASTRO_MIN_S();
  if (!r.vetor || r.seg < min) throw Object.assign(new Error(`Só ouvi ${String(r.seg || 0).replace(".", ",")} s de voz; preciso de pelo menos ${min} s. Grave de novo, lendo o texto até o fim.`), { status: 422 });
  const antes = lerArquivo(), nivel = antes && NIVEIS[antes.nivel] !== undefined ? antes.nivel : NIVEL_PADRAO;
  gravarArquivo({ versao: VERSAO, modelo: MODELO, vetor: r.vetor, em: new Date().toISOString(), segundos: r.seg, nivel, janelas: r.janelas || null });
  const medido = medirGravacao(r.janelas, nivel);
  logEvent("voz", { t: "voz", acao: "cadastrou", ms: Date.now() - comecou, seg: r.seg, curtas: medido?.curtas, longas: medido?.longas });
  return estadoImpressao();
}

export function apagarImpressao() {
  const havia = existsSync(ARQUIVO());
  rmSync(ARQUIVO(), { force: true });
  if (havia) logEvent("voz", { t: "voz", acao: "apagou" });
  return estadoImpressao();
}

export function ajustarNivel(nivel) {
  const imp = lerArquivo();
  if (!imp || imp.ilegivel) throw Object.assign(new Error("grave a sua voz antes de ajustar"), { status: 409 });
  if (NIVEIS[nivel] === undefined) throw Object.assign(new Error("sensibilidade inválida"), { status: 400 });
  gravarArquivo({ ...imp, nivel: Number(nivel) });
  logEvent("voz", { t: "voz", acao: "ajustou", nivel: Number(nivel) });
  return estadoImpressao();
}

/** Uma frase de teste: diz a nota sem transcrever nem mandar nada. É como o dono mede a própria voz depois de cadastrar. */
export async function testarVoz(buf) {
  const q = await conferirVoz(buf);
  if (!("passou" in q) && !q.fora) throw Object.assign(new Error("grave a sua voz antes de testar"), { status: 409 });
  if (q.fora) throw Object.assign(new Error(q.fora), { status: 503 });
  logEvent("voz", { t: "voz", acao: "testou", ...marcaDoFiltro(q) });
  return { passou: q.passou, nota: q.nota, limiar: q.limiar, seg: q.seg, ms: q.msQuem };
}

const mediana = (l) => { const s = [...l].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
/** O uso de verdade: quantos trechos passaram e quantos caíram desde o cadastro, com o tempo. É a medição com o microfone dele, sem guardar áudio. */
function usoDesde(em) {
  const l = readLog("voz").filter((e) => e.acao === "ouviu" && e.quem && (!em || e.at >= em)).slice(-500);
  return { dono: l.filter((e) => e.quem === "dono").length, outra: l.filter((e) => e.quem === "outra").length, fora: l.filter((e) => e.quem === "fora").length, msMediano: mediana(l.filter((e) => e.msQuem).map((e) => e.msQuem)) };
}

/** Para a tela: tudo sobre a impressão, menos a impressão. */
export function estadoImpressao() {
  const imp = lerArquivo(), motor = motorDaVoz(), base = { motor, cadastroSeg: CADASTRO_S(), cadastroMin: CADASTRO_MIN_S(), niveis: Object.keys(NIVEIS).length };
  if (!imp) return { ...base, cadastrada: false, nivel: NIVEL_PADRAO, uso: null };
  if (imp.ilegivel) return { ...base, cadastrada: false, nivel: NIVEL_PADRAO, uso: null, aviso: "a impressão de voz está ilegível: grave de novo" };
  const nivel = NIVEIS[imp.nivel] === undefined ? NIVEL_PADRAO : imp.nivel;
  return {
    ...base, cadastrada: true, em: imp.em, segundos: imp.segundos, nivel, limiares: { curto: limiarDe(0.8, nivel), longo: limiarDe(3, nivel) },
    medido: medirGravacao(imp.janelas, nivel), uso: usoDesde(imp.em), aviso: imp.modelo !== MODELO ? "a impressão foi feita com outro modelo: grave de novo" : !motor.ok ? motor.motivo : null,
  };
}

// ── Rotas: só a própria tela, a barreira do 🚀. Um agente não troca a voz do dono ─
export async function rotaImpressao(req, res, url, { json, readBody }) {
  if (!["POST", "DELETE"].includes(req.method)) return json(res, 404, { error: "rota não existe" });
  if (!daTela(req)) return json(res, 403, { error: "a impressão de voz só muda pela tela do board" });
  const path = url.pathname;
  const responder = async (fn) => {
    try { const r = await fn(); broadcast("voz-impressao", {}); return json(res, 200, r); }
    catch (e) { return json(res, e.status || (e.formato ? 400 : 500), { error: cut(e.message, 240) }); }
  };
  const audio = async (fn) => {
    if (Number(req.headers["content-length"]) > AUDIO_MAX) return json(res, 413, { error: "áudio grande demais" });
    let buf;
    try { buf = await lerBinario(req, AUDIO_MAX); }
    catch (e) { return json(res, /grande/.test(e.message) ? 413 : 400, { error: "áudio incompleto: " + cut(e.message, 120) }); }
    if (!buf.length) return json(res, 400, { error: "áudio vazio" });
    if (!wavProntoParaWhisper(buf)) return json(res, 400, { error: "áudio em formato que o motor não lê" });
    return responder(() => fn(buf));
  };
  if (req.method === "DELETE" && path === "/api/voz/impressao") return responder(() => apagarImpressao());
  if (req.method !== "POST") return json(res, 404, { error: "rota não existe" });
  if (path === "/api/voz/impressao") {
    if (!motorDaVoz().ok) return json(res, 503, { error: motorDaVoz().motivo });
    return audio(cadastrar);
  }
  if (path === "/api/voz/impressao/testar") return audio(testarVoz);
  if (path === "/api/voz/impressao/ajuste") {
    let b;
    try { b = await readBody(req); } catch { return json(res, 400, { error: "pedido inválido" }); }
    return responder(() => ajustarNivel(b.nivel));
  }
  return json(res, 404, { error: "rota não existe" });
}
