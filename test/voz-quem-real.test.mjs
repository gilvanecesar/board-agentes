// 🎙 Só a voz do dono (#298) com o motor DE VERDADE e vozes do Piper fazendo o papel de pessoas diferentes. Roda onde o motor e o Piper estão
// instalados (o Atena) e se pula nos outros lugares. O whisper continua falso: aqui se prova quem chega até ele.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ligada, limparVoz, esperarNaTela, ouvir, preparar } from "./voz-ajuda.mjs";
import { abrirNavegador, CHROME } from "./navegador.mjs";
import { pedirQuem } from "./voz-quem-ajuda.mjs";

afterEach(limparVoz);
const PASTA = join(homedir(), ".local/share/board-voz");
const PIPER = join(PASTA, "piper/piper");
const instalado = existsSync(join(PASTA, "quem/env/bin/python")) && existsSync(PIPER) && !spawnSync("ffmpeg", ["-version"]).error;

const dir = mkdtempSync(join(tmpdir(), "voz-real-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
let n = 0;
function fala(voz, texto) {
  const bruto = join(dir, `${n++}.wav`), saida = join(dir, `${n++}.wav`);
  execFileSync(PIPER, ["--model", join(PASTA, `pt_BR-${voz}-medium.onnx`), "--output_file", bruto], { input: texto, env: { ...process.env, LD_LIBRARY_PATH: join(PASTA, "piper") }, stdio: ["pipe", "ignore", "ignore"] });
  execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-i", bruto, "-ar", "16000", "-ac", "1", "-af", "adelay=400:all=1,apad=pad_dur=1.5,volume=0.6", saida]);
  return readFileSync(saida);
}
const LEITURA = "Eu vou contar como foi o meu dia de trabalho. Hoje cedo abri o quadro de tarefas, conferi o que ficou pendente e falei com a equipe sobre os fretes da semana. O caminhão saiu de Goiânia para Curitiba com a carga completa, e o motorista mandou a foto do canhoto assim que chegou. Depois revisei as notas fiscais, corrigi um valor errado e pedi para publicarem a nova versão do sistema.";

test("Motor real: cadastra uma voz, ela passa, outra voz do Piper cai antes do whisper; o arquivo é só a impressão", { skip: !instalado }, async () => {
  const { b, caixa, ouvido } = await preparar({ env: { BOARD_VOZ_PASTA: PASTA } });
  const cad = await pedirQuem(b, "POST", "/api/voz/impressao", fala("faber", LEITURA));
  assert.equal(cad.status, 200, JSON.stringify(cad.json));
  assert.ok(cad.json.segundos > 12);
  assert.equal(cad.json.medido.longas.passariam, cad.json.medido.longas.janelas, "a gravação inteira passa no limiar de frase");
  const arq = join(caixa.board, "data", "voz-impressao.json");
  assert.equal(statSync(arq).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(arq, "utf8")).vetor.length, 192);
  ouvido("Mensagem do dono", "Outra do dono");
  const frase = "Como estão as tarefas de hoje no quadro?";
  const dono = await ouvir(b, "modo=conversa", { audio: fala("faber", frase) });
  assert.equal(dono.json.texto, "Mensagem do dono", JSON.stringify(dono.json));
  for (const voz of ["jeff"]) { // a dupla mais parecida (faber × cadu) é o limite escrito no CLAUDE.md: não é prova de nada aqui
    const outra = await ouvir(b, "modo=conversa", { audio: fala(voz, frase) });
    assert.equal(outra.json.naoReconhecida, true, `${voz}: ${JSON.stringify(outra.json)}`);
    assert.ok(outra.json.nota < outra.json.limiar);
  }
  const antes = readFileSync(join(caixa.home, "whisper.log"), "utf8").split("\n").length;
  assert.equal(antes, 2 + 1, "só a fala do dono chegou ao whisper");
});

// O caminho inteiro do navegador: arquivo no microfone falso → worklet → wavDeVoz → motor. O filtro do Chrome não pode estragar a nota.
const mic = (voz, texto) => { const f = join(dir, `${n++}-mic.wav`); execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-f", "wav", "-i", "pipe:0", "-ar", "48000", f], { input: fala(voz, texto) }); return f; };
const chromeCom = (arq) => abrirNavegador({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${arq}%noloop`, "--autoplay-policy=no-user-gesture-required"] });

test("Motor real pela tela: cadastro lendo o microfone; a mesma voz chega ao whisper, outra voz fica na barra", { skip: !instalado || !CHROME }, async () => {
  const { b, caixa, ouvido } = await preparar({ env: { BOARD_VOZ_PASTA: PASTA, BOARD_VOZ_CADASTRO_S: "20" } });
  let nav = await chromeCom(mic("faber", LEITURA));
  await nav.carregar(b.url + "/#/voz");
  await esperarNaTela(nav, `!!$("#vozCadGravar")`);
  await nav.avaliar(`$("#vozCadGravar").click()`);
  await esperarNaTela(nav, `!!VOZ.servidor?.impressao?.cadastrada`, 40000);
  await nav.fechar();
  const FRASE = "Abre a tela de monitoramento para mim, por favor, que eu quero ver se o servidor continua lento.";
  ouvido("Chegou");
  nav = await chromeCom(mic("jeff", FRASE));
  await ligada(nav, b);
  await esperarNaTela(nav, `VOZ.barradas >= 1`, 20000);
  assert.equal(existsSync(join(caixa.home, "whisper.log")), false, "outra voz não chegou ao whisper");
  await nav.fechar();
  nav = await chromeCom(mic("faber", FRASE));
  await ligada(nav, b);
  await esperarNaTela(nav, `VOZ.ultima?.enviado`, 20000);
  assert.equal(await nav.avaliar(`VOZ.barradas`), 0);
  await nav.fechar();
  const linhas = readFileSync(join(caixa.board, "data", "logs", "voz.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.acao === "ouviu");
  assert.deepEqual([...new Set(linhas.map((l) => l.quem))].sort(), ["dono", "outra"]);
  assert.ok(linhas.every((l) => l.msQuem < 3000), "conferir é bem mais rápido que transcrever");
});
