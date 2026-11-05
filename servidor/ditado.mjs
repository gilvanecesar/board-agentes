// Ditado e modo voz: o áudio da tela vira texto na própria máquina (whisper.cpp), sem mandar nada para fora.
import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { cpus, homedir, tmpdir } from "os";
import { dirname, join } from "path";
import { VOZ_NOME } from "./config.mjs";

const run = promisify(execFile);
const HOME = () => process.env.HOME || homedir();
// O modelo: escolhido pela medição da #286 (ver CLAUDE.md, "Modo voz"). No Mac segue o que já estava em ~/.dailies.
export const DITADO_MODELOS = () => [join(HOME(), ".dailies/models/ggml-small.bin"), join(HOME(), ".whisper-models/ggml-small-q5_1.bin"), join(HOME(), ".whisper-models/ggml-small.bin"), join(HOME(), ".whisper-models/ggml-large-v3-turbo-q5_0.bin")];
export const ditadoModelo = () => process.env.BOARD_DITADO_MODELO || DITADO_MODELOS().find(existsSync) || DITADO_MODELOS()[0];
// Nomes que o whisper não conhece e erraria ("Loja" e "CT-e", por exemplo).
// O nome de chamada do modo voz (#305) entra sempre, também num vocabulário próprio: sem ele o whisper erra o nome e a fala é descartada.
const BASE_VOCABULARIO = process.env.BOARD_DITADO_PROMPT || "Board, Loja, ERP, CRM, PR, deploy, commit, CT-e, MDF-e.";
export const VOCABULARIO = BASE_VOCABULARIO.toLowerCase().includes(VOZ_NOME.toLowerCase()) ? BASE_VOCABULARIO : `${VOZ_NOME}, ${BASE_VOCABULARIO}`;
const bin = (nome) => ["/opt/homebrew/bin/" + nome, "/usr/local/bin/" + nome].find(existsSync) || nome;
export const whisperBin = () => process.env.BOARD_WHISPER_BIN || ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli", join(HOME(), "whisper.cpp/build/bin/whisper-cli")].find(existsSync) || "whisper-cli";
// Metade dos núcleos, no máximo 12 (medido na #286): 8 → 2,1 s, 16 → 1,7 s; o resto do servidor continua respondendo.
const THREADS = () => String(Number(process.env.BOARD_WHISPER_THREADS) || Math.min(12, Math.max(2, Math.floor(cpus().length / 2))));
// No servidor Linux isto não usa a placa de vídeo (ver CLAUDE.md); no Mac o Metal segue valendo.
const SEM_PLACA = process.platform === "linux" ? ["-ng"] : [];

/** WAV PCM 16 kHz mono de 16 bits: é o que o whisper lê direto, e o que o modo voz manda. */
export function wavProntoParaWhisper(buf) {
  return buf.length > 44 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WAVE"
    && buf.readUInt16LE(20) === 1 && buf.readUInt16LE(22) === 1 && buf.readUInt32LE(24) === 16000 && buf.readUInt16LE(34) === 16;
}

/** `prompt`: troca o vocabulário dado ao whisper (o modo voz usa um próprio em trecho curto, ver `promptDoTrecho`). */
// Transcrições em andamento: o ↻ espera por elas, e o `process.exit` pula o `finally` de `transcrever`. Sair no meio não pode
// deixar áudio no disco nem whisper órfão (QA da #286): o que restar é apagado no evento "exit", que roda em todo fim com aviso.
export const TRANSCRICOES = new Set();
const sair = (t) => { try { t.cp?.kill("SIGKILL"); } catch { /* já saiu */ } if (t.dir) rmSync(t.dir, { recursive: true, force: true }); };
process.on("exit", () => { for (const t of TRANSCRICOES) sair(t); });
const PASTA = "board-ditado-";
const SOBRA_MIN = 10; // mais que os tetos do ffmpeg (30 s) e do whisper (120 s): pasta mais nova pode ser de outro board nesta máquina
/** kill -9 e queda de energia não avisam ninguém: ao subir, some o áudio que sobrou de um board que morreu assim. */
export function limparSobrasDeAudio(agora = Date.now()) {
  for (const nome of readdirSync(tmpdir()).filter((n) => n.startsWith(PASTA))) {
    const dir = join(tmpdir(), nome);
    try { if (agora - statSync(dir).mtimeMs > SOBRA_MIN * 60000) rmSync(dir, { recursive: true, force: true }); } catch { /* outro já apagou */ }
  }
}

export async function transcrever(buf, { prompt = VOCABULARIO } = {}) {
  const modelo = ditadoModelo();
  if (!existsSync(modelo)) throw new Error(`modelo do whisper não encontrado (${modelo})`);
  const dir = mkdtempSync(join(tmpdir(), PASTA));
  const atual = { dir, cp: null };
  TRANSCRICOES.add(atual);
  const rodar = (...a) => { const p = run(...a); atual.cp = p.child; return p; };
  try {
    const wav = join(dir, "a.wav");
    if (wavProntoParaWhisper(buf)) writeFileSync(wav, buf);
    else {
      writeFileSync(join(dir, "in"), buf);
      // O navegador grava webm/opus; o whisper só lê wav 16 kHz mono (ou mp3/ogg/flac).
      await rodar(bin("ffmpeg"), ["-nostdin", "-loglevel", "error", "-i", join(dir, "in"), "-ar", "16000", "-ac", "1", wav], { timeout: 30000 });
    }
    await rodar(whisperBin(), ["-m", modelo, "-l", "pt", ...SEM_PLACA, "-t", THREADS(), "--prompt", prompt, "-nt", "-np", "-otxt", "-of", join(dir, "a"), "-f", wav],
      { timeout: 120000, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, LD_LIBRARY_PATH: [dirname(whisperBin()), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") } });
    return readFileSync(join(dir, "a.txt"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !/^\[.*\]$/.test(l)).join(" ");
  } finally {
    TRANSCRICOES.delete(atual);
    rmSync(dir, { recursive: true, force: true }); // o áudio não fica: nem o original, nem o convertido
  }
}
