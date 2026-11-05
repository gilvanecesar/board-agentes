// O comum dos testes do modo voz: board na caixa com whisper e Piper falsos, e Chrome com microfone falso.
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { criarCaixa, criarProjeto, subirBoard, limparCaixa, esperar, envDaCaixa } from "./ajuda.mjs";
import { abrirNavegador, CHROME } from "./navegador.mjs";

let atual = [];
export async function limparVoz() { for (const [b, c] of atual) { await b.fim(); limparCaixa(c); } atual = []; }

/** WAV 16 kHz mono: `tons` = [[hz ou 0, ms], …]. Serve de "fala" (o tom passa da VAD) e de amostra para a rota. */
export function wavDeAmostra(tons = [[220, 400]], taxa = 16000) {
  const n = tons.reduce((s, [, ms]) => s + Math.round(ms * taxa / 1000), 0);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0, "latin1"); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8, "latin1"); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(taxa, 24); b.writeUInt32LE(taxa * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36, "latin1"); b.writeUInt32LE(n * 2, 40);
  let i = 0;
  for (const [hz, ms] of tons) for (let k = 0, q = Math.round(ms * taxa / 1000); k < q; k++, i++) {
    const t = k / taxa, v = hz ? 0.3 * (Math.sin(2 * Math.PI * hz * t) + 0.5 * Math.sin(4 * Math.PI * hz * t)) : 0;
    b.writeInt16LE(Math.round(v * 20000), 44 + i * 2);
  }
  return b;
}

// whisper falso: devolve a próxima linha de $HOME/ouvido.txt (com o prompt dos comandos, de ouvido-comando.txt), anota os argumentos e se o áudio estava lá.
const WHISPER = `#!/bin/sh
echo "$*" >> "$HOME/whisper.log"
of=""; f=""; prev=""
for x in "$@"; do [ "$prev" = "-of" ] && of="$x"; [ "$prev" = "-f" ] && f="$x"; prev="$x"; done
echo "$f" >> "$HOME/whisper-audios.log"
echo $$ >> "$HOME/whisper-pids"
arq="$HOME/ouvido.txt"; case "$*" in *"Modo voz. Modo texto."*) arq="$HOME/ouvido-comando.txt";; esac
linha=$(head -n 1 "$arq" 2>/dev/null); sed -i.bak 1d "$arq" 2>/dev/null
[ -n "$HOME_ATRASO" ] && sleep "$HOME_ATRASO"
printf '%s\\n' "$linha" > "$of.txt"
`;
// piper falso: guarda o texto recebido e grava um WAV de verdade (1 s, ou o que estiver em $HOME/fala-ms).
const PIPER = `#!/usr/bin/env node
const fs=require("fs"),{join}=require("path");const a=process.argv.slice(2),o=a[a.indexOf("--output_file")+1],m=a[a.indexOf("--model")+1];
let t="";process.stdin.on("data",(d)=>t+=d).on("end",()=>{const H=process.env.HOME;fs.appendFileSync(join(H,"piper.log"),JSON.stringify({texto:t,modelo:m,cuda:process.env.CUDA_VISIBLE_DEVICES,args:a})+"\\n");
if(fs.existsSync(join(H,"piper-quebrado")))process.exit(3);
const ms=Number(fs.existsSync(join(H,"fala-ms"))?fs.readFileSync(join(H,"fala-ms"),"utf8"):1000),n=Math.round(ms*22.05),b=Buffer.alloc(44+n*2);
b.write("RIFF",0);b.writeUInt32LE(36+n*2,4);b.write("WAVEfmt ",8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(22050,24);b.writeUInt32LE(44100,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write("data",36);b.writeUInt32LE(n*2,40);fs.writeFileSync(o,b);});
`;

export async function preparar({ conversa = ["Tudo certo por aqui.", "segunda resposta", "terceira resposta"], piper = true, env = {}, quem = null } = {}) {
  const caixa = criarCaixa();
  criarProjeto(caixa, "alfa");
  caixa.cenario({ conversa });
  const whisper = join(caixa.bin, "whisper-falso"); writeFileSync(whisper, WHISPER, { mode: 0o755 });
  mkdirSync(join(caixa.home, ".whisper-models"), { recursive: true });
  writeFileSync(join(caixa.home, ".whisper-models", "ggml-small-q5_1.bin"), "modelo");
  const pasta = join(caixa.raiz, "voz");
  mkdirSync(join(pasta, "piper"), { recursive: true });
  if (piper) {
    writeFileSync(join(pasta, "piper", "piper"), PIPER, { mode: 0o755 });
    for (const v of ["faber", "jeff"]) writeFileSync(join(pasta, `pt_BR-${v}-medium.onnx`), "voz");
  }
  const motorDaVoz = {}; // #298: o motor de quem fala é falso também; sem ele, a caixa fica sem motor instalado
  if (quem) { motorDaVoz.BOARD_VOZ_QUEM = join(caixa.bin, "quem-falso"); writeFileSync(motorDaVoz.BOARD_VOZ_QUEM, quem, { mode: 0o755 }); }
  const b = await subirBoard(caixa, { BOARD_WHISPER_BIN: whisper, BOARD_VOZ_PASTA: pasta, ...motorDaVoz, ...env });
  atual.push([b, caixa]);
  return { caixa, b, ouvido: (...l) => writeFileSync(join(caixa.home, "ouvido.txt"), l.join("\n") + "\n") };
}
export const AUDIO = wavDeAmostra();
export const esperarArquivo = async (f) => { for (let i = 0; i < 100 && !existsSync(f); i++) await esperar(100); assert.ok(existsSync(f), f); };
export const ouvir = async (b, q = "modo=conversa", { origem = b.url, audio = AUDIO } = {}) => {
  const r = await fetch(`${b.url}/api/voz/ouvir?${q}`, { method: "POST", headers: { "content-type": "audio/wav", ...(origem ? { origin: origem } : {}) }, body: audio });
  return { status: r.status, json: await r.json().catch(() => null) };
};
export const eventos = async (b) => (await b.api("GET", "/api/conversa/central")).json.events;
export async function esperarEvento(b, pred, ms = 8000) {
  for (let i = 0; i < ms / 100; i++) { const evs = await eventos(b); if (evs.some(pred)) return evs; await esperar(100); }
  throw new Error("evento não chegou: " + JSON.stringify(await eventos(b)).slice(-500));
}
export const registro = (caixa) => { const a = join(caixa.board, "data", "aprovacoes.jsonl"); return existsSync(a) ? readFileSync(a, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; };
export const conversas = (caixa) => { const a = join(caixa.home, "chamadas.jsonl"); return existsSync(a) ? readFileSync(a, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.papel === "conversa") : []; };
export function conferir(caixa, b, ...args) {
  try { return { code: 0, out: execFileSync(process.execPath, [join(caixa.board, "board-cli.mjs"), "aprovacao", ...args], { env: envDaCaixa(caixa, { BOARD_URL: b.url }), encoding: "utf8" }) }; }
  catch (e) { return { code: e.status, out: String(e.stdout || "") + String(e.stderr || "") }; }
}

// ── A tela no Chrome sem janela, com microfone falso (arquivo) ───────────────
const CHROME_VOZ = (wav) => ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}%noloop`, "--autoplay-policy=no-user-gesture-required", "--disable-popup-blocking"];
export async function tela(caixa, tons, opcoes = {}) {
  const wav = join(caixa.raiz, "mic.wav");
  writeFileSync(wav, wavDeAmostra(tons, 48000));
  return abrirNavegador({ args: CHROME_VOZ(wav), ...opcoes });
}
export const esperarNaTela = async (nav, expr, ms = 12000) => {
  for (let i = 0; i < ms / 100; i++) { if (await nav.avaliar(expr)) return; await esperar(100); }
  throw new Error(`a tela não chegou em: ${expr}\n${await nav.avaliar(`JSON.stringify({fase:VOZ.fase,ouvidas:VOZ.ouvidas,falas:VOZ.falas,barra:$("#vozFora")?.innerText,erros:0})`)}`);
};
const BLOCO = (rms) => `new Float32Array(2400).fill(${rms}).map((v,i)=>i%2?v:-v)`;
/** Empurra `ms` de "som" direto na VAD: o tempo do teste não depende do arquivo. */
export const soar = (rms, ms) => `(async()=>{for(let i=0;i<${Math.ceil(ms / 50)};i++){VOZ.vad&&VOZ.vad.quadro(${BLOCO(rms)});vozMedidor();}})()`;

// ── O comum dos testes da tela em qualquer tela (#296) ──
export const comChrome = { skip: !CHROME };
export const parar = (nav) => nav.avaliar(soar(0, 1700)); // a pausa que encerra o trecho
export const esconder = (nav, escondida = true) => nav.avaliar(`Object.defineProperty(document, "visibilityState", { value: "${escondida ? "hidden" : "visible"}", configurable: true }); document.dispatchEvent(new Event("visibilitychange"))`);
/** Esconde a aba DE VERDADE: outra aba passa para a frente, e o Chrome estrangula os timers dela (o `esconder` só finge para a página). */
export async function esconderDeVerdade(nav) {
  const { targetId } = await nav.cmd("Target.createTarget", { url: "about:blank" });
  await esperarNaTela(nav, `document.visibilityState === "hidden"`);
  return { voltar: async () => { await nav.cmd("Target.closeTarget", { targetId }); await nav.cmd("Page.bringToFront"); await esperarNaTela(nav, `document.visibilityState === "visible"`); } };
}
/** A permissão que o dono dá no Chrome ao ligar, e a tela do aparelho bloqueando (o IdleDetector real, com o estado do CDP). */
export const darPermissaoDoBloqueio = (nav, b) => nav.cmd("Browser.grantPermissions", { permissions: ["idleDetection"], origin: b.url });
export const bloquearTela = (nav, bloqueada = true) => nav.cmd("Emulation.setIdleOverride", { isUserActive: !bloqueada, isScreenUnlocked: !bloqueada });
export const espiarMic = `window.__trilhas=[];{const g=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async(c)=>{const s=await g(c);window.__trilhas.push(...s.getTracks());return s}}`;
export const micFechado = `window.__trilhas.length>0&&window.__trilhas.every((t)=>t.readyState==="ended")`;
export const recarregar = async (nav) => { await nav.cmd("Page.reload", {}); await esperar(300); };

export async function ligada(nav, b, { espiar = false } = {}) {
  await nav.carregar(b.url + "/#/central");
  await esperarNaTela(nav, `!!$(".voz-botao") && connected`);
  if (espiar) await nav.avaliar(espiarMic);
  await nav.avaliar(`document.querySelector(".voz-botao").click()`);
  await esperarNaTela(nav, `!!VOZ.stream`);
}
