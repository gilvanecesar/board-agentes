// Os testes não fazem barulho e não deixam nada vivo (#287). 31/10: o dono ouviu o swoosh da tela nas caixas do Atena,
// vindo do Chrome sem janela da bateria; e havia Chrome e board de teste órfãos há ~34 h, porque o process.on("exit") não
// roda quando o teste é cortado por sinal. Quem garante agora é a vigia (test/vigia.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { criarCaixa, subirBoard, limparCaixa, esperar, REPO } from "./ajuda.mjs";
import { abrirNavegador, CHROME, SEM_SOM } from "./navegador.mjs";

const semChrome = !CHROME && "sem Chrome nesta máquina";
const argumentos = () => execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8", maxBuffer: 1 << 24 });
const vivo = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const ate = async (cond, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cond()) return true; await esperar(100); } return cond(); };

test("todo Chrome dos testes sobe mudo, e o AudioContext continua rodando", { skip: semChrome }, async () => {
  const nav = await abrirNavegador();
  try {
    assert.match(execFileSync("ps", ["-o", "args=", "-p", String(nav.pid)], { encoding: "utf8" }), /--mute-audio --disable-audio-output/);
    // userGesture: é o que o toque do dono faz na tela; sem ele o Chrome deixa o contexto suspenso.
    const r = await nav.cmd("Runtime.evaluate", { userGesture: true, awaitPromise: true, returnByValue: true, expression: `(async () => {
      const c = new AudioContext(); await c.resume(); const o = c.createOscillator(), g = c.createGain(); g.gain.value = 0;
      o.connect(g).connect(c.destination); o.start(); const t0 = c.currentTime; await new Promise((ok) => setTimeout(ok, 400));
      return { estado: c.state, andou: c.currentTime > t0 }; })()` });
    assert.deepEqual(r.result.value, { estado: "running", andou: true });
  } finally { await nav.fechar(); }
  // Quem passa flags ao Chrome dos agentes nos testes leva o silêncio junto; e ninguém sobe Chrome por fora do ajudante.
  for (const a of readdirSync(join(REPO, "test")).filter((f) => f.endsWith(".mjs") && f !== "vigia.test.mjs")) {
    const src = readFileSync(join(REPO, "test", a), "utf8");
    for (const [, flags] of src.matchAll(/BOARD_NAVEGADOR_ARGS: "([^"]*)"/g)) assert.ok(flags.includes(SEM_SOM), `${a}: ${flags}`);
    if (a !== "navegador.mjs") assert.doesNotMatch(src, /spawn\(CHROME/, `${a} sobe Chrome por fora do ajudante`);
  }
});

test("o Chrome dos agentes numa caixa de teste também sobe mudo", { skip: semChrome }, async () => {
  const caixa = criarCaixa(); const b = await subirBoard(caixa, { BOARD_NAVEGADOR_CHROME: CHROME, BOARD_NAVEGADOR_ARGS: "--use-mock-keychain " + SEM_SOM });
  try {
    assert.equal((await b.api("POST", "/api/navegador/abrir", { quem: "teste", url: b.url + "/api/state" })).status, 200);
    const linha = argumentos().split("\n").find((l) => l.includes(caixa.raiz) && l.includes("--remote-debugging-port"));
    assert.ok(linha.includes(SEM_SOM), linha);
  } finally { await b.api("POST", "/api/navegador/fechar", {}).catch(() => {}); await b.fim(); limparCaixa(caixa); }
});

// Um "teste" de verdade num processo à parte: abre Chrome e board e fica parado, até ser cortado.
const CORTADO = `import { abrirNavegador } from ${JSON.stringify(join(REPO, "test/navegador.mjs"))};
import { criarCaixa, subirBoard } from ${JSON.stringify(join(REPO, "test/ajuda.mjs"))};
const nav = await abrirNavegador(); const caixa = criarCaixa(); const b = await subirBoard(caixa);
console.log(JSON.stringify({ chrome: nav.pid, perfil: nav.perfil, board: b.cp.pid, caixa: caixa.raiz })); setInterval(() => {}, 1000);`;

for (const sinal of ["SIGTERM", "SIGINT", "SIGKILL"]) {
  test(`teste cortado por ${sinal} não deixa Chrome, board nem pasta para trás`, { skip: semChrome }, async () => {
    const pasta = mkdtempSync(join(tmpdir(), "board-vigia-")); const script = join(pasta, "cortado.mjs"); writeFileSync(script, CORTADO);
    const cp = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "inherit"] });
    let saida = ""; cp.stdout.on("data", (d) => (saida += d));
    try {
      assert.ok(await ate(() => saida.includes("\n"), 60000), "o processo não abriu Chrome e board");
      const { chrome, perfil, board, caixa } = JSON.parse(saida);
      assert.ok(vivo(chrome) && vivo(board) && existsSync(perfil) && existsSync(caixa));
      cp.kill(sinal);
      assert.ok(await ate(() => !vivo(chrome) && !vivo(board) && !existsSync(perfil) && !existsSync(caixa)),
        `sobrou: chrome ${vivo(chrome)}, board ${vivo(board)}, perfil ${existsSync(perfil)}, caixa ${existsSync(caixa)}`);
      assert.ok(!argumentos().includes(perfil), "sobrou processo do perfil");
    } finally { cp.kill("SIGKILL"); rmSync(pasta, { recursive: true, force: true }); }
  });
}

test("fim normal: nada sobra, e a vigia não segura a saída do teste", { skip: semChrome }, async () => {
  const pasta = mkdtempSync(join(tmpdir(), "board-vigia-")); const script = join(pasta, "normal.mjs");
  // Sem fechar(): é o teste que esqueceu a faxina.
  writeFileSync(script, `import { abrirNavegador } from ${JSON.stringify(join(REPO, "test/navegador.mjs"))};
const nav = await abrirNavegador(); console.log(nav.pid + " " + nav.perfil); process.exit(0);`);
  try {
    const [pid, perfil] = execFileSync(process.execPath, [script], { encoding: "utf8", timeout: 60000 }).trim().split(" ");
    assert.ok(await ate(() => !vivo(Number(pid)) && !existsSync(perfil)), "Chrome ou perfil ficaram");
  } finally { rmSync(pasta, { recursive: true, force: true }); }
});
