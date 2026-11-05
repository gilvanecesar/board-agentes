// O Chrome de LOGIN do navegador dos agentes (#218): o "fechar" dizia "fechado" e o Chrome de login seguia vivo (no Mac,
// fechar a janela não encerra o Chrome), com toda ação recusada. Aqui o Chrome é FALSO: um processo que segura o perfil
// como o de verdade (SingletonLock "host-pid"), diz quantas janelas tem por um arquivo e, no SIGTERM, "grava os cookies"
// e sai. Prova: fechar (CLI e HTTP) encerra com SIGTERM e só então responde; a janela fechada volta ao modo agente
// sozinha; board reiniciado acha o login aberto; e NENHUM outro Chrome (outro perfil, pid de outro programa) é tocado.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { spawn, execFile } from "node:child_process";
import { hostname } from "node:os";
import { abrirNavegador, CHROME } from "./navegador.mjs";
import { criarCaixa, criarProjeto, subirBoard, limparCaixa, esperar, envDaCaixa } from "./ajuda.mjs";

let atual = [];
const outros = [];
afterEach(async () => {
  for (const [b, c] of atual) { await b?.fim(); limparCaixa(c); }
  for (const p of outros.splice(0)) { try { process.kill(p.pid, "SIGKILL"); } catch { /* já saiu */ } }
  atual = [];
});

// O Chrome falso. Lê --user-data-dir, escreve o SingletonLock, anota os argumentos e as janelas (1 ao abrir), e no
// SIGTERM grava "cookies" e tira o lock. Se o perfil já está seguro por outro vivo, só "passa a janela" e sai (como o Chrome).
const CHROME_FALSO = `#!/usr/bin/env node
const fs = require("fs"), path = require("path"), os = require("os");
const dir = (process.argv.find((a) => a.startsWith("--user-data-dir=")) || "").slice(16);
const lock = path.join(dir, "SingletonLock");
try { const pid = Number(fs.readlinkSync(lock).split("-").pop()); process.kill(pid, 0); fs.writeFileSync(path.join(dir, "janelas"), "1"); process.exit(0); } catch {}
try { fs.unlinkSync(lock); } catch {}
fs.symlinkSync(os.hostname() + "-" + process.pid, lock);
fs.writeFileSync(path.join(dir, "janelas"), process.env.FALSO_SEM_JANELA ? "0" : "1");
fs.appendFileSync(path.join(dir, "chrome.log"), "abriu " + process.pid + " " + process.argv.slice(2).join(" ") + "\\n");
process.on("SIGTERM", () => { fs.writeFileSync(path.join(dir, "Cookies"), "gravados"); fs.appendFileSync(path.join(dir, "chrome.log"), "sigterm\\n"); try { fs.unlinkSync(lock); } catch {} setTimeout(() => process.exit(0), 300); });
setInterval(() => {}, 1000);
`;
// Quantas janelas o pid tem: o que o Chrome falso escreveu no perfil dele.
const JANELAS = `#!/bin/sh
d=$(ps -p "$1" -o args= | sed -n 's/.*--user-data-dir=\\([^ ]*\\).*/\\1/p')
cat "$d/janelas" 2>/dev/null || echo 0
`;

function preparar(caixa) {
  const bin = join(caixa.raiz, "chrome-falso"); mkdirSync(bin, { recursive: true });
  const chrome = join(bin, "Google Chrome"); writeFileSync(chrome, CHROME_FALSO); chmodSync(chrome, 0o755);
  const janelas = join(bin, "janelas"); writeFileSync(janelas, JANELAS); chmodSync(janelas, 0o755);
  return { chrome, janelas, perfil: join(caixa.home, ".board-navegador") };
}
async function subir(env = {}) {
  const caixa = criarCaixa(); criarProjeto(caixa, "alfa");
  const f = preparar(caixa);
  const b = await subirBoard(caixa, { BOARD_NAVEGADOR_CHROME: f.chrome, BOARD_NAVEGADOR_JANELAS: f.janelas, BOARD_NAVEGADOR_VIGIA_MS: "300", BOARD_NAVEGADOR_LOGIN_ESPERA_S: "2", ...env });
  atual.push([b, caixa]);
  return { caixa, b, ...f };
}
const vivo = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const estado = async (b) => (await b.api("GET", "/api/navegador")).json;
async function ate(cond, ms = 10000) { const fim = Date.now() + ms; while (Date.now() < fim) { if (await cond()) return true; await esperar(150); } return false; }
const cli = (caixa, b, args) => new Promise((ok) => execFile(process.execPath, [join(caixa.board, "board-cli.mjs"), ...args],
  { env: envDaCaixa(caixa, { BOARD_URL: b.url }) }, (e, out, err) => ok({ codigo: e ? e.code : 0, out: String(out), err: String(err) })));

test("fechar encerra o Chrome de login com SIGTERM, espera sair e só então diz fechado — e as ações voltam", async () => {
  const { b, caixa, perfil } = await subir();
  const r = await b.api("POST", "/api/navegador/logar", {});
  assert.equal(r.status, 200);
  const pid = r.json.pid; assert.ok(vivo(pid), "o Chrome de login está vivo");
  assert.match(readFileSync(join(perfil, "chrome.log"), "utf8"), /--user-data-dir=.*\.board-navegador.*--new-window/);
  const e = await estado(b); assert.equal(e.logando, true); assert.equal(e.loginPid, pid);
  // ação de agente com o login aberto: 409, dizendo como sair
  const a = await b.api("POST", "/api/navegador/ler", { quem: "teste" });
  assert.equal(a.status, 409); assert.match(a.json.error, /Terminei de logar/);

  const c = await cli(caixa, b, ["navegador", "fechar"]);
  assert.equal(c.codigo, 0, c.err); assert.match(c.out, /Chrome de login encerrado/);
  assert.equal(vivo(pid), false, "quando o fechar respondeu, o Chrome de login já tinha saído");
  assert.match(readFileSync(join(perfil, "chrome.log"), "utf8"), /sigterm/, "o Chrome falso não é app de janela: o Sair não o pega e a reserva é o SIGTERM");
  assert.equal(readFileSync(join(perfil, "Cookies"), "utf8"), "gravados");
  assert.equal((await estado(b)).logando, false);
  const reg = (await estado(b)).registro.filter((x) => x.acao === "logar").map((x) => x.alvo);
  assert.deepEqual(reg, ["janela aberta", "login encerrado"]);
});

test("o dono fechou a última janela: o board percebe sozinho, encerra o Chrome e volta ao modo agente", async () => {
  const { b, perfil } = await subir();
  const pid = (await b.api("POST", "/api/navegador/logar", {})).json.pid;
  await esperar(1000);
  assert.equal((await estado(b)).logando, true, "com janela aberta, continua em modo login");
  writeFileSync(join(perfil, "janelas"), "0"); // fechou a janela; o processo segue vivo (o Chrome do Mac)
  assert.ok(await ate(async () => !(await estado(b)).logando), "voltou ao modo agente");
  assert.equal(vivo(pid), false);
  assert.match(readFileSync(join(perfil, "chrome.log"), "utf8"), /sigterm/);
  assert.ok((await estado(b)).registro.some((x) => x.acao === "logar" && /última janela/.test(x.texto || "")));
});

test("o Chrome de login saiu sozinho: volta ao modo agente", async () => {
  const { b } = await subir();
  const pid = (await b.api("POST", "/api/navegador/logar", {})).json.pid;
  process.kill(pid, "SIGKILL");
  assert.ok(await ate(async () => !(await estado(b)).logando));
});

test("janela que nunca apareceu: espera o prazo e então encerra (não fica preso no modo login)", async () => {
  const { b } = await subir({ FALSO_SEM_JANELA: "1" });
  const pid = (await b.api("POST", "/api/navegador/logar", {})).json.pid;
  await esperar(800);
  assert.equal((await estado(b)).logando, true, "dentro do prazo, ainda espera a janela nascer");
  assert.ok(await ate(async () => !(await estado(b)).logando, 12000));
  assert.equal(vivo(pid), false);
});

test("board reiniciado com o login aberto: acha o Chrome pelo perfil, segue recusando e o fechar encerra", async () => {
  const { b, caixa, chrome, perfil } = await subir({ BOARD_NAVEGADOR_LOGIN_ESPERA_S: "600" });
  const pid = (await b.api("POST", "/api/navegador/logar", {})).json.pid;
  await b.fim(); atual = []; // o board cai; o Chrome de login fica
  outros.push({ pid });
  assert.ok(vivo(pid));
  const b2 = await subirBoard(caixa, { BOARD_NAVEGADOR_CHROME: chrome, BOARD_NAVEGADOR_JANELAS: join(caixa.raiz, "chrome-falso", "janelas"), BOARD_NAVEGADOR_VIGIA_MS: "300", BOARD_NAVEGADOR_LOGIN_ESPERA_S: "600" });
  atual.push([b2, caixa]);
  assert.ok(await ate(async () => (await estado(b2)).logando), "achou o login aberto");
  assert.equal((await estado(b2)).loginPid, pid);
  assert.equal((await b2.api("POST", "/api/navegador/abrir", { quem: "teste", url: "http://127.0.0.1:9/" })).status, 409);
  // logar de novo não abre outro Chrome
  assert.equal((await b2.api("POST", "/api/navegador/logar", {})).json.jaAberto, true);
  const f = await b2.api("POST", "/api/navegador/fechar", {});
  assert.equal(f.json.login, true); assert.equal(f.json.logando, false);
  assert.equal(vivo(pid), false);
  assert.match(readFileSync(join(perfil, "chrome.log"), "utf8"), /sigterm/);
});

test("nunca mexe em outro Chrome: outro perfil e pid de outro programa no lock ficam vivos", async () => {
  const { b, caixa, chrome, perfil } = await subir();
  // o "Chrome do dono": o mesmo binário, OUTRO perfil
  const outroPerfil = join(caixa.raiz, "perfil-do-dono"); mkdirSync(outroPerfil, { recursive: true });
  const dono = spawn(chrome, [`--user-data-dir=${outroPerfil}`], { stdio: "ignore" }); outros.push(dono);
  // um programa qualquer, e o lock do NOSSO perfil apontando para ele (pid reaproveitado / lock forjado)
  const qualquer = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }); outros.push(qualquer);
  await esperar(500);
  mkdirSync(perfil, { recursive: true });
  try { rmSync(join(perfil, "SingletonLock")); } catch { /* não havia */ }
  symlinkSync(`${hostname()}-${qualquer.pid}`, join(perfil, "SingletonLock"));
  await esperar(1200); // algumas voltas da vigia
  assert.equal((await estado(b)).logando, false, "lock de processo que não é Chrome deste perfil não vira login");
  const f = await b.api("POST", "/api/navegador/fechar", {});
  assert.equal(f.status, 200); assert.equal(f.json.login, false);
  assert.ok(vivo(qualquer.pid), "o programa qualquer não foi tocado");
  assert.ok(vivo(dono.pid), "o Chrome de outro perfil não foi tocado");
  // e com o login de verdade aberto, fechar encerra só ele
  rmSync(join(perfil, "SingletonLock"));
  const pid = (await b.api("POST", "/api/navegador/logar", {})).json.pid;
  assert.notEqual(pid, dono.pid);
  await b.api("POST", "/api/navegador/fechar", {});
  assert.equal(vivo(pid), false);
  assert.ok(vivo(dono.pid), "o Chrome do outro perfil continua vivo");
  assert.ok(!existsSync(join(outroPerfil, "Cookies")), "e não recebeu SIGTERM");
});

// A tela do Navegador (com o ✓ Terminei de logar) saiu em 04/11: o fim do login é o `board navegador fechar`, testado acima.
