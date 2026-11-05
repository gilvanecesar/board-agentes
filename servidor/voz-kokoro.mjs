// 🎙 Kokoro, a 2ª voz do modo voz (#314, 02/11, decisão falada do dono: "vamos usar o Kokoro, instala e faz funcional").
// hexgrad/Kokoro-82M (Apache-2.0, código e pesos), SÓ na CPU, num ambiente Python próprio fora do board:
// `scripts/instalar-kokoro.sh` põe tudo em ~/.local/share/board-voz/kokoro (env/ + pesos/). Sem ele, nada muda: o Piper segue.
// O motor (voz-kokoro.py) fica vivo entre as falas, porque carregar custa ~3,6 s, e morre parado (BOARD_VOZ_KOKORO_OCIOSO_MIN).
// Medido no Atena (12 threads): ~0,6 s para uma frase de 80 caracteres, ~3,7 s para 280 de uma vez. Por isso a fala vai em
// PEDAÇOS (`pedacosDaFala`): a tela pede o 1º, toca, e pede o seguinte enquanto ele toca. Áudio só em memória, nunca em disco.
import { spawn } from "child_process";
import { existsSync, readdirSync } from "fs";
import { cpus, homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const HOME = () => process.env.HOME || homedir();
export const pastaKokoro = () => process.env.BOARD_VOZ_KOKORO || join(process.env.BOARD_VOZ_PASTA || join(HOME(), ".local/share/board-voz"), "kokoro");
const python = () => join(pastaKokoro(), "env/bin/python");
const pesos = () => join(pastaKokoro(), "pesos");
const MOTOR = join(dirname(fileURLToPath(import.meta.url)), "voz-kokoro.py");
const OCIOSO_MS = () => Number(process.env.BOARD_VOZ_KOKORO_OCIOSO_MIN || 15) * 60000;
const THREADS = () => process.env.BOARD_VOZ_KOKORO_THREADS || String(Math.min(12, Math.max(2, Math.floor(cpus().length / 2))));

// As vozes pt-BR do Kokoro v1.0: p = português do Brasil, f/m = feminina/masculina.
const NOMES = { pf_dora: "Dora", pm_alex: "Alex", pm_santa: "Santa" };
export function vozesKokoro() {
  if (!existsSync(python()) || !existsSync(join(pesos(), "kokoro-v1_0.pth"))) return [];
  let arqs = [];
  try { arqs = readdirSync(join(pesos(), "voices")); } catch { return []; }
  return arqs.map((f) => f.match(/^(p[fm]_[a-z]+)\.pt$/)).filter(Boolean).map((m) => ({
    id: "kokoro-" + m[1], arquivo: m[1], nome: `${NOMES[m[1]] || m[1].slice(3)} (Kokoro, ${m[1][1] === "f" ? "feminina" : "masculina"})`,
  })).sort((a, b) => a.id.localeCompare(b.id));
}
export const ehVozKokoro = (id) => /^kokoro-p[fm]_[a-z]+$/.test(String(id || ""));

/**
 * O texto da fala em pedaços que o Kokoro gera rápido: frases inteiras juntas até `max` caracteres, e o 1º menor (`primeiro`), para a
 * voz começar logo. Frase maior que o teto quebra na última vírgula antes dele. Sempre o mesmo resultado para o mesmo texto: a tela
 * pede o pedaço pelo número, e o servidor corta de novo.
 */
export function pedacosDaFala(texto, { primeiro = 90, max = 150 } = {}) {
  const frases = [];
  for (let f of String(texto || "").replace(/\s+/g, " ").trim().split(/(?<=[.!?…;:])\s+/)) {
    while (f.length > max) {
      const corte = f.lastIndexOf(", ", max);
      if (corte < max / 3) break;
      frases.push(f.slice(0, corte + 1)); f = f.slice(corte + 2);
    }
    if (f) frases.push(f);
  }
  const out = [];
  for (const f of frases) {
    const i = out.length - 1, teto = i === 0 ? primeiro : max;
    if (i >= 0 && out[i].length + 1 + f.length <= teto) out[i] += " " + f;
    else out.push(f);
  }
  return out;
}

// ── O processo do motor ──────────────────────────────────────────────────────
const K = { proc: null, pronto: null, buf: Buffer.alloc(0), espera: null, vez: Promise.resolve(), ocioso: null, erro: "" };
process.on("exit", () => { try { K.proc?.kill("SIGKILL"); } catch { /* já saiu */ } });

function parar() { try { K.proc?.kill("SIGTERM"); } catch { /* já saiu */ } K.proc = null; K.pronto = null; }

function subir() {
  if (K.pronto) return K.pronto;
  K.buf = Buffer.alloc(0); K.erro = "";
  const cp = spawn(python(), ["-I", MOTOR, pesos()], {
    env: { ...process.env, CUDA_VISIBLE_DEVICES: "-1", HF_HUB_OFFLINE: "1", KOKORO_THREADS: THREADS(), OMP_NUM_THREADS: THREADS() },
    stdio: ["pipe", "pipe", "pipe"],
  });
  K.proc = cp;
  cp.stderr.on("data", (d) => { K.erro = (K.erro + d).slice(-600); });
  cp.stdin.on("error", () => { /* saiu: o close avisa */ });
  cp.stdout.on("data", (d) => { K.buf = Buffer.concat([K.buf, d]); lerSaida(); });
  K.pronto = new Promise((ok, bad) => {
    K.espera = { cab: (c) => (c.pronto ? ok() : bad(new Error("o Kokoro respondeu sem subir"))), falha: bad };
    cp.on("error", (e) => { K.espera?.falha(e); });
    cp.on("close", (code) => {
      if (K.proc === cp) { K.proc = null; K.pronto = null; }
      K.espera?.falha(new Error(`o Kokoro saiu (código ${code}): ${K.erro.trim().split("\n").slice(-2).join(" ")}`));
      K.espera = null;
    });
  });
  return K.pronto;
}

function lerSaida() {
  while (K.espera) {
    if (K.espera.cabecalho === undefined) {
      const fim = K.buf.indexOf(10); if (fim < 0) return;
      let c; try { c = JSON.parse(K.buf.subarray(0, fim).toString()); } catch { c = { ok: false, erro: "resposta ilegível do Kokoro" }; }
      K.buf = K.buf.subarray(fim + 1);
      if (!c.bytes) { const e = K.espera; K.espera = null; e.cab(c); continue; }
      K.espera.cabecalho = c;
    }
    const c = K.espera.cabecalho;
    if (K.buf.length < c.bytes) return;
    const dados = K.buf.subarray(0, c.bytes); K.buf = K.buf.subarray(c.bytes);
    const e = K.espera; K.espera = null; e.cab(c, Buffer.from(dados));
  }
}

/** Texto (um pedaço) → WAV, um pedido por vez no mesmo processo. `velocidade` 1 = normal; `pausa` = silêncio no fim, em segundos. */
export function sintetizarKokoro(texto, voz, { velocidade = 1, pausa = 0.4 } = {}) {
  const v = vozesKokoro().find((x) => x.id === voz);
  if (!v) return Promise.reject(new Error("voz do Kokoro não instalada: " + voz));
  const vez = K.vez.then(async () => {
    clearTimeout(K.ocioso);
    await subir();
    return new Promise((ok, bad) => {
      const prazo = setTimeout(() => { bad(new Error("o Kokoro passou de 60 s")); parar(); }, 60000);
      K.espera = {
        cab: (c, dados) => { clearTimeout(prazo); c.ok ? ok({ wav: dados, ms: c.ms, seg: c.seg }) : bad(new Error("Kokoro: " + c.erro)); },
        falha: (e) => { clearTimeout(prazo); bad(e); },
      };
      K.proc.stdin.write(JSON.stringify({ texto, voz: v.arquivo, velocidade, pausa }) + "\n");
    });
  });
  K.vez = vez.catch(() => {}).then(() => { clearTimeout(K.ocioso); K.ocioso = setTimeout(parar, OCIOSO_MS()); K.ocioso.unref?.(); });
  return vez;
}
export const kokoroVivo = () => !!K.proc;
/** O modo voz ligou com uma voz do Kokoro: sobe o motor já, para a 1ª resposta não pagar os ~3,6 s de carga. */
export function aquecerKokoro() {
  if (!vozesKokoro().length) return false;
  K.vez = K.vez.then(() => subir()).catch(() => {}).then(() => { clearTimeout(K.ocioso); K.ocioso = setTimeout(parar, OCIOSO_MS()); K.ocioso.unref?.(); });
  return true;
}
