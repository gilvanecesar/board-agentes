// A trava de um board por quadro (#309, 02/11): depois de um desligamento forçado o data/board.lock trazia o pid do boot
// anterior, que no boot novo era de um processo de OUTRO usuário (EPERM), e o board recusou subir até o systemd desistir.
// Lock velho (pid de outro usuário, pid que não existe, pid reaproveitado por outro programa, outro boot) é ignorado e
// sobrescrito; board vivo de verdade continua recusando o segundo.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { criarCaixa, criarProjeto, subirBoard, limparCaixa, envDaCaixa } from "./ajuda.mjs";

let atual = [];
afterEach(async () => { for (const [b, c, extra] of atual) { if (b) await b.fim(); if (extra) extra.kill("SIGKILL"); limparCaixa(c); } atual = []; });

function caixaCom(lock) {
  const caixa = criarCaixa();
  criarProjeto(caixa, "demo");
  if (lock != null) writeFileSync(join(caixa.board, "data", "board.lock"), typeof lock === "string" ? lock : JSON.stringify(lock));
  return caixa;
}
async function sobeComLock(lock, extra) {
  const caixa = caixaCom(lock);
  const b = await subirBoard(caixa); // lança se o board sair
  atual.push([b, caixa, extra]);
  assert.equal((await b.api("GET", "/api/state")).status, 200);
  const novo = JSON.parse(readFileSync(join(caixa.board, "data", "board.lock"), "utf8"));
  assert.equal(novo.pid, b.cp.pid, "o lock passa a ser deste board");
  assert.ok(novo.inicio, "com a hora de início do processo");
  assert.match(b.saida(), /lock velho ignorado/, "e o log diz que o lock velho foi ignorado");
  return { caixa, b, novo };
}
const segundo = (caixa) => new Promise((ok) => {
  const cp = spawn(process.execPath, ["board.mjs"], { cwd: caixa.board, env: envDaCaixa(caixa, { BOARD_PORT: "0" }), stdio: ["ignore", "pipe", "pipe"] });
  let saida = ""; cp.stderr.on("data", (d) => (saida += d)); cp.stdout.on("data", (d) => (saida += d));
  cp.on("close", (code) => ok({ code, saida }));
});

test("lock com pid de processo de OUTRO usuário (o caso de 02/11) sobe", { skip: process.getuid?.() === 0 && "rodando como root não há EPERM" }, async () => {
  // pid 1 é do root: kill(1, 0) dá EPERM, igual ao processo alheio que herdou o número no boot novo.
  let eperm = false; try { process.kill(1, 0); } catch (e) { eperm = e.code === "EPERM"; }
  assert.ok(eperm, "o teste precisa de um pid de outro usuário");
  await sobeComLock("1"); // formato antigo: só o número, como estava no Atena
});

test("lock com pid que não existe sobe", async () => {
  let pid = 4194000; while (pid > 1000) { try { process.kill(pid, 0); pid--; } catch (e) { if (e.code === "ESRCH") break; pid--; } }
  await sobeComLock({ pid, boot: "x", inicio: "1" });
});

test("lock com pid reaproveitado por outro programa do mesmo usuário sobe (formato antigo e novo)", async () => {
  const sono = spawn("sleep", ["60"], { stdio: "ignore" });
  await sobeComLock(String(sono.pid), sono);
  const sono2 = spawn("sleep", ["60"], { stdio: "ignore" });
  await sobeComLock({ pid: sono2.pid, inicio: "hora-de-outro-processo" }, sono2);
});

test("lock de outro boot sobe, mesmo com o número vivo", { skip: process.platform !== "linux" && "boot id lido do /proc" }, async () => {
  const sono = spawn("sleep", ["60"], { stdio: "ignore" });
  const inicio = readFileSync(`/proc/${sono.pid}/stat`, "utf8").split(") ")[1].split(" ")[19];
  await sobeComLock({ pid: sono.pid, boot: "boot-de-antes", inicio }, sono);
});

test("board vivo de verdade continua recusando o segundo, e o lock dele fica", async () => {
  const { caixa, b } = await sobeComLock("1");
  const antes = readFileSync(join(caixa.board, "data", "board.lock"), "utf8");
  const r = await segundo(caixa);
  assert.equal(r.code, 1);
  assert.match(r.saida, new RegExp(`já existe um board rodando \\(pid ${b.cp.pid}\\)`));
  assert.equal(readFileSync(join(caixa.board, "data", "board.lock"), "utf8"), antes, "o segundo não mexe no lock");
  assert.equal((await b.api("GET", "/api/state")).status, 200, "e o primeiro segue no ar");
});

test("board vivo com lock no formato antigo (só o pid) também recusa o segundo", async () => {
  const { caixa, b } = await sobeComLock("1");
  writeFileSync(join(caixa.board, "data", "board.lock"), String(b.cp.pid));
  const r = await segundo(caixa);
  assert.equal(r.code, 1);
  assert.match(r.saida, /já existe um board rodando/);
});
