// O navegador dos agentes (#217, "um Latch do board"): um Chrome PRÓPRIO, separado do Chrome do dono, com perfil em
// ~/.board-navegador (já logado nas contas dele), controlado por CDP. Qualquer sessão usa: CLI (`board navegador …`),
// MCP (navegador-mcp.mjs) ou HTTP (/api/navegador/*). A TRAVA é a REDE: toda requisição da página fica pausada no
// domínio Fetch do CDP e só segue se for leitura limpa ou estiver aprovada (`decidirRequisicao`, navegador-risco.mjs) —
// vale para link, formulário, fetch/XHR, sendBeacon, navegação por JS, botão dentro de link: tudo vira requisição.
// Cada ação e cada requisição barrada vão para o registro (data/logs/navegador.jsonl) e a tela mostra ao vivo.
import { spawn, execFile } from "node:child_process";
import { existsSync, mkdirSync, chmodSync, statSync, realpathSync, readlinkSync, writeFileSync } from "node:fs";
import { join, resolve, basename, sep } from "node:path";
import { homedir } from "node:os";
import { DATA, ROOT, cut } from "./config.mjs";
import { logEvent, readLog } from "./estado.mjs";
import { acharChrome, conectarCdp, portaLivre } from "./cdp.mjs";
import { daTela as daTelaDoBoard } from "./origem.mjs";
import { abrirLiberacao, classificarRisco, decidirRequisicao, hostDe, lerConfig, marcarSempre } from "./navegador-risco.mjs";

export const LOG_NAVEGADOR = "navegador";
export const PERFIL = () => resolve(process.env.BOARD_NAVEGADOR_PERFIL || join(homedir(), ".board-navegador"));
export const CAPTURAS = () => join(DATA, "navegador", "capturas");
const OCIOSO_MS = Number(process.env.BOARD_NAVEGADOR_OCIOSO_MIN || 15) * 60000;
const LARGURA = 1280, ALTURA = 900;
// Flags a mais do Chrome, nas DUAS formas (sem janela e a de logar) — têm de ser iguais, senão os cookies gravados numa não
// abrem na outra. Os testes usam "--use-mock-keychain": com HOME de mentira, o Chrome trava esperando o Keychain do macOS.
const ARGS_EXTRA = () => String(process.env.BOARD_NAVEGADOR_ARGS || "").split(/\s+/).filter(Boolean);
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const erro = (msg, status = 400, extra = {}) => Object.assign(new Error(msg), { status, ...extra });

// ── o perfil: fora do git, do Drive e do backup ──────────────────────────────
/** O perfil tem as sessões logadas do dono: 700, e nunca dentro de ~/Documents (Drive/iCloud), do board ou de data/. */
export function prepararPerfil() {
  const p = PERFIL();
  const proibidos = [join(homedir(), "Documents"), ROOT, DATA].map((d) => { try { return realpathSync(d); } catch { return resolve(d); } });
  let real = p; try { mkdirSync(p, { recursive: true, mode: 0o700 }); real = realpathSync(p); } catch (e) { throw erro("não consegui criar o perfil do navegador em " + p + ": " + e.message, 500); }
  if (proibidos.some((d) => real === d || real.startsWith(d + sep))) throw erro(`o perfil do navegador não pode ficar em ${real}: lá ele iria para o git, o Drive ou o backup (use ~/.board-navegador)`, 500);
  chmodSync(real, 0o700);
  return real;
}

// ── o Chrome ─────────────────────────────────────────────────────────────────
const NAV = { proc: null, cdp: null, porta: null, logando: null, ultimoUso: 0, quadro: null, espectadores: new Set(), fila: Promise.resolve(), ua: null,
  acao: null,       // a ação do agente em curso: {quem, barradas: [], liberadas: []}
  liberacao: null,  // o SIM que o agente trouxe ({id, pedido, ate}); cada requisição ainda passa por autorizar()
  rede: process.env.BOARD_NAVEGADOR_REDE !== "0" }; // desligar SÓ para a sabotagem dos testes: sem ela, nada é barrado

// Roda em TODO documento (e iframe) antes do script da página: WebSocket só para domínio liberado em data/navegador.json
// ("websocket": [...]), service worker não registra — o que nasce num worker do navegador escaparia da porta da rede —, e
// window.open não abre janela.
// ⚠️ Camada a mais, não cofre: um <iframe> about:blank criado por script ainda tem o WebSocket original.
const travaDaPagina = (permitidos) => `(() => { try {
  const ok = ${JSON.stringify(permitidos)};
  const WS = window.WebSocket;
  if (WS) {
    const Trava = function (url, protocolos) {
      let h = ""; try { h = new URL(url, location.href).hostname; } catch {}
      if (!ok.some((d) => h === d || h.endsWith("." + d))) throw new DOMException("WebSocket bloqueado pelo navegador dos agentes: " + url, "SecurityError");
      return protocolos === undefined ? new WS(url) : new WS(url, protocolos);
    };
    Trava.prototype = WS.prototype;
    Object.defineProperty(window, "WebSocket", { value: Trava, writable: false, configurable: false });
  }
  // window.open não abre (o script ficaria esperando a janela nova, que nasce PAUSADA no nível do navegador e é fechada).
  Object.defineProperty(window, "open", { value: () => null, writable: false, configurable: false });
  if (window.ServiceWorkerContainer) Object.defineProperty(ServiceWorkerContainer.prototype, "register",
    { value: () => Promise.reject(new DOMException("service worker bloqueado pelo navegador dos agentes", "SecurityError")), writable: false, configurable: false });
} catch {} })();`;

export function estadoNavegador() {
  return { rodando: !!(NAV.cdp && NAV.cdp.aberto()), logando: !!NAV.logando, loginPid: NAV.logando?.pid || null, perfil: PERFIL(), chrome: acharChrome(),
    espectadores: NAV.espectadores.size, url: NAV.url || null, titulo: NAV.titulo || null };
}

async function subir() {
  if (NAV.cdp && NAV.cdp.aberto()) return NAV.cdp;
  if (NAV.logando || await adotarLogin()) throw erro("o navegador está aberto para você logar: quando terminar, clique em ✓ Terminei de logar (menu Navegador) ou feche a janela do Chrome dele, e tente de novo", 409);
  const chrome = acharChrome();
  if (!chrome) throw erro("Chrome não encontrado nesta máquina (defina BOARD_NAVEGADOR_CHROME=<caminho>)", 503);
  const perfil = prepararPerfil();
  const porta = await portaLivre();
  const cp = spawn(chrome, ["--headless=new", `--remote-debugging-port=${porta}`, "--remote-debugging-address=127.0.0.1", `--user-data-dir=${perfil}`,
    "--no-first-run", "--no-default-browser-check", "--lang=pt-BR", `--window-size=${LARGURA},${ALTURA}`, "--disable-features=BackForwardCache",
    ...ARGS_EXTRA(), ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let errChrome = ""; cp.stderr.on("data", (d) => { errChrome = (errChrome + d).slice(-1500); });
  cp.on("exit", () => { if (NAV.proc === cp) { NAV.proc = null; NAV.cdp?.fechar(); NAV.cdp = null; } });
  NAV.proc = cp; NAV.porta = porta;
  let alvo;
  for (let i = 0; i < 300 && !alvo && cp.exitCode === null; i++) {
    await esperar(100);
    try { alvo = (await (await fetch(`http://127.0.0.1:${porta}/json`)).json()).find((t) => t.type === "page"); } catch { /* subindo */ }
  }
  if (!alvo) { cp.kill("SIGKILL"); throw erro("o Chrome do navegador não abriu: " + errChrome.trim().slice(-400), 503); }
  const cdp = await conectarCdp(alvo.webSocketDebuggerUrl);
  cdp.ouvir((d) => aoEvento(cdp, d));
  for (const m of ["Page.enable", "Runtime.enable", "DOM.enable", "Network.enable"]) await cdp.cmd(m);
  if (NAV.rede) await ligarPortaDaRede(cdp);
  await cdp.cmd("Emulation.setDeviceMetricsOverride", { width: LARGURA, height: ALTURA, deviceScaleFactor: 1, mobile: false });
  // Sem "HeadlessChrome" no agente do usuário: há site que recusa navegador sem janela.
  try { const v = await (await fetch(`http://127.0.0.1:${porta}/json/version`)).json(); NAV.ua = String(v["User-Agent"] || "").replace("HeadlessChrome", "Chrome");
    if (NAV.ua) await cdp.cmd("Network.setUserAgentOverride", { userAgent: NAV.ua, acceptLanguage: "pt-BR,pt;q=0.9" }); } catch { /* fica o padrão */ }
  if (NAV.rede) await vigiarNavegador(porta);
  NAV.cdp = cdp;
  if (NAV.espectadores.size) iniciarScreencast();
  return cdp;
}

// A porta da rede, em toda sessão: a aba e cada filha (iframe de outro processo, worker), que nascem PAUSADAS
// (waitForDebuggerOnStart) e só andam depois de ganhar a mesma porta.
async function ligarPortaDaRede(cdp, sessionId) {
  await cdp.cmd("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, 10000, sessionId);
  await cdp.cmd("Network.setBypassServiceWorker", { bypass: true }, 10000, sessionId).catch(() => {});
  await cdp.cmd("Page.addScriptToEvaluateOnNewDocument", { source: travaDaPagina(lerConfig().websocket) }, 10000, sessionId).catch(() => {});
  await cdp.cmd("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, 10000, sessionId).catch(() => {});
}
async function anexar(cdp, { sessionId, targetInfo }) {
  try { await ligarPortaDaRede(cdp, sessionId); }
  catch (e) {
    // Sem porta, a filha não anda: fica pausada (nunca roda o debugger) e o registro diz por quê.
    logEvent(LOG_NAVEGADOR, { t: "navegador", quem: "navegador", acao: "rede", alvo: `${targetInfo?.type} ${cut(targetInfo?.url, 120)}`, ok: false, recusado: true, erro: "não deu para pôr a porta da rede nesta parte da página (" + e.message + "): ela fica parada" });
    return;
  }
  cdp.cmd("Runtime.runIfWaitingForDebugger", {}, 10000, sessionId).catch(() => {});
}
// O navegador INTEIRO, não só a aba: todo alvo NOVO (aba aberta por target=_blank ou window.open, service worker,
// shared worker) nasce PAUSADO aqui, antes de mandar qualquer coisa. Aba nova é FECHADA sem rodar — teria rede própria,
// fora da porta desta aba (a sonda de 27/10 mostrou form target=_blank, <a target=_blank> e window.open chegando ao
// servidor); o registro dá o endereço, e o agente pode `abrir` ele na aba que tem porta. Worker de fora fica parado.
async function vigiarNavegador(porta) {
  const v = await (await fetch(`http://127.0.0.1:${porta}/json/version`)).json();
  const nav = await conectarCdp(v.webSocketDebuggerUrl);
  NAV.navegador = nav;
  nav.ouvir((d) => {
    if (d.method !== "Target.attachedToTarget") return;
    const { sessionId, targetInfo, waitingForDebugger } = d.params;
    if (!waitingForDebugger) return void nav.cmd("Target.detachFromTarget", { sessionId }).catch(() => {}); // os que já existiam (a aba principal)
    if (targetInfo.type === "page" || targetInfo.type === "tab") {
      nav.cmd("Target.closeTarget", { targetId: targetInfo.targetId }).catch(() => {});
      logEvent(LOG_NAVEGADOR, { t: "navegador", quem: NAV.acao?.quem || "página", acao: "rede", alvo: `aba nova ${cut(targetInfo.url, 160)}`, url: targetInfo.url,
        ok: false, recusado: true, erro: "a página tentou abrir outra aba: fechada antes de mandar qualquer coisa (abra o endereço na aba do navegador, que tem a porta da rede)" });
      NAV.acao?.barradas.push({ metodo: "ABA", url: cut(targetInfo.url || "(nova aba)", 200), acao: "navegar", motivo: "aba nova fechada sem rodar", dominio: hostDe(targetInfo.url), caminho: "" });
      return;
    }
    logEvent(LOG_NAVEGADOR, { t: "navegador", quem: "navegador", acao: "rede", alvo: `${targetInfo.type} ${cut(targetInfo.url, 120)}`, ok: false, recusado: true, erro: "fora da aba do navegador, sem porta da rede: fica parado" });
  });
  await nav.cmd("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
}

function portaDaRede(cdp, p, sessionId) {
  const { method, url } = p.request;
  // A liberação é de quem trouxe o SIM: outra sessão agindo no meio não pega carona nela.
  const lib = NAV.liberacao && (!NAV.acao || NAV.acao.quem === NAV.liberacao.quem) ? NAV.liberacao : null;
  const r = decidirRequisicao({ metodo: method, url, tipo: p.resourceType }, lib);
  if (r.ok) {
    cdp.cmd("Fetch.continueRequest", { requestId: p.requestId }, 10000, sessionId).catch(() => {});
    if (r.como === "aprovacao" || r.como === "sempre") {
      NAV.acao?.liberadas.push({ metodo: method, url, como: r.como });
      logEvent(LOG_NAVEGADOR, { t: "navegador", quem: NAV.acao?.quem || "página", acao: "rede", alvo: `${method} ${cut(url, 160)}`, url, risco: r.acao, aprovacao: r.como === "sempre" ? "sempre pode" : r.aprovacao, ok: true });
    }
    return;
  }
  cdp.cmd("Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" }, 10000, sessionId).catch(() => {});
  let caminho = ""; try { caminho = new URL(url).pathname; } catch { /* sem caminho */ }
  const barrada = { metodo: method, url: cut(url, 200), acao: r.acao, motivo: r.motivo, dominio: hostDe(url), caminho };
  NAV.acao?.barradas.push(barrada);
  logEvent(LOG_NAVEGADOR, { t: "navegador", quem: NAV.acao?.quem || "página (sem ação do agente)", acao: "rede", alvo: `${method} ${cut(url, 160)}`, url,
    risco: r.acao, ok: false, recusado: true, erro: r.motivo, barrada: { dominio: barrada.dominio, metodo: method, caminho } });
}

function aoEvento(cdp, d) {
  if (d.method === "Fetch.requestPaused") return portaDaRede(cdp, d.params, d.sessionId);
  if (d.method === "Target.attachedToTarget") return void anexar(cdp, d.params);
  if (d.sessionId) return; // o resto (quadros, diálogos, navegação) é só da aba principal
  if (d.method === "Page.screencastFrame") {
    cdp.cmd("Page.screencastFrameAck", { sessionId: d.params.sessionId }).catch(() => {});
    NAV.quadro = d.params.data;
    const msg = `event: quadro\ndata: ${JSON.stringify({ img: d.params.data })}\n\n`;
    for (const res of NAV.espectadores) { try { res.write(msg); } catch { NAV.espectadores.delete(res); } }
  }
  // Diálogo da página: aviso (alert) é aceito; confirmação e pergunta são RECUSADAS — "tem certeza que quer excluir?"
  // não pode passar sozinho. Fica no registro.
  if (d.method === "Page.javascriptDialogOpening") {
    const aceita = d.params.type === "alert";
    cdp.cmd("Page.handleJavaScriptDialog", { accept: aceita }).catch(() => {});
    logEvent(LOG_NAVEGADOR, { t: "navegador", quem: "página", acao: "dialogo", alvo: cut(d.params.message, 200), url: d.params.url, ok: true, texto: aceita ? "aviso aceito" : `${d.params.type} recusado (o board não confirma sozinho)` });
  }
  if (d.method === "Page.frameNavigated" && !d.params.frame.parentId) NAV.url = d.params.frame.url;
}

function iniciarScreencast() {
  NAV.cdp?.cmd("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: LARGURA, maxHeight: ALTURA, everyNthFrame: 1 }).catch(() => {});
}

/** Fecha o que estiver aberto no perfil: o Chrome sem janela dos agentes E o Chrome de login (#218: o "fechar" dizia
 *  "fechado" e o de login seguia vivo, com toda ação recusada). Só volta quando os dois saíram. */
export async function fecharNavegador() {
  const cp = NAV.proc, porta = NAV.porta; NAV.cdp?.fechar(); NAV.cdp = null; NAV.navegador?.fechar(); NAV.navegador = null; NAV.proc = null;
  const agente = !!(cp && cp.exitCode === null);
  if (agente) {
    // Browser.close = desligamento limpo, que grava os cookies. O SIGTERM derruba o Chrome em ~30 ms SEM gravar o que
    // mudou nos últimos ~30 s (medido em 27/10, #219): fica só de reserva.
    try { const v = await (await fetch(`http://127.0.0.1:${porta}/json/version`, { signal: AbortSignal.timeout(2000) })).json();
      const nav = await conectarCdp(v.webSocketDebuggerUrl); nav.cmd("Browser.close", {}, 3000).catch(() => {}).finally(() => nav.fechar()); } catch { /* vai o SIGTERM */ }
    for (let i = 0; i < 50 && cp.exitCode === null; i++) await esperar(100);
    if (cp.exitCode === null) { cp.kill("SIGTERM"); for (let i = 0; i < 30 && cp.exitCode === null; i++) await esperar(100); }
    if (cp.exitCode === null) cp.kill("SIGKILL");
  }
  const login = await encerrarLogin("fechado pelo board (⏹ / board navegador fechar)");
  return { agente, login: login.encerrado, forcado: login.forcado || false, limpo: login.encerrado ? login.limpo !== false : null, cookies: login.cookies ?? null };
}
process.on("exit", () => { try { NAV.proc?.kill("SIGKILL"); } catch { /* já saiu */ } });
// Parado (ninguém usa nem assiste) → fecha. Sobe de novo no próximo pedido, com as mesmas contas (o perfil fica).
setInterval(() => { if (NAV.proc && !NAV.espectadores.size && Date.now() - NAV.ultimoUso > OCIOSO_MS) fecharNavegador(); }, 60000).unref();

// ── o Chrome de login (#218) ─────────────────────────────────────────────────
// No Mac, fechar a janela NÃO encerra o Chrome: ele fica vivo, sem janela, segurando o perfil — e os agentes, recusados.
// O board guarda o pid de QUEM SEGURA O PERFIL (o SingletonLock do Chrome: "host-pid") e só mexe num processo cujos
// argumentos têm o --user-data-dir deste perfil: o Chrome do dono (outro perfil) nunca é tocado.
const LOGIN_FECHAR_MS = Number(process.env.BOARD_NAVEGADOR_FECHAR_S || 15) * 1000;      // Sair (ou SIGTERM) → espera sair
const LOGIN_ESPERA_MS = Number(process.env.BOARD_NAVEGADOR_LOGIN_ESPERA_S || 60) * 1000; // sem nunca ver janela, quanto esperar
const VIGIA_MS = Number(process.env.BOARD_NAVEGADOR_VIGIA_MS || 3000);

const vivo = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const executar = (cmd, args, ms = 5000) => new Promise((ok) => execFile(cmd, args, { timeout: ms }, (e, out) => ok(e ? null : String(out))));

/** O pid que segura o perfil, pelo SingletonLock — só se o processo está vivo E é Chrome DESTE perfil. */
async function donoDoPerfil() {
  let pid; try { pid = Number(String(readlinkSync(join(PERFIL(), "SingletonLock"))).split("-").pop()); } catch { return null; }
  if (!(pid > 1) || !vivo(pid)) return null;
  const args = await argsDe(pid);
  return args && ehDestePerfil(args) ? { pid, args } : null;
}
async function argsDe(pid) { const out = await executar("ps", ["-p", String(pid), "-o", "args="]); return out ? out.trim() : null; }
function ehDestePerfil(args) {
  const perfis = new Set([PERFIL()]); try { perfis.add(realpathSync(PERFIL())); } catch { /* ainda não existe */ }
  return [...perfis].some((p) => (" " + args + " ").includes(` --user-data-dir=${p} `));
}

/** Quantas janelas DE VERDADE o processo tem (null = não sei). No Mac pelo CGWindowList (sem permissão de acessibilidade):
 *  camada 0 e maior que 100×100 — o Chrome sem janela ainda deixa faixas de 30 px do menu e um quadrado de 64 px. */
const JXA_JANELAS = `ObjC.import('CoreGraphics');
function run(a) { const pid = Number(a[0]);
  const l = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll | $.kCGWindowListExcludeDesktopElements, 0))) || [];
  return String(l.filter((w) => w.kCGWindowOwnerPID === pid && w.kCGWindowLayer === 0 && w.kCGWindowBounds && w.kCGWindowBounds.Width > 100 && w.kCGWindowBounds.Height > 100).length); }`;
async function janelasDe(pid) {
  const cmd = process.env.BOARD_NAVEGADOR_JANELAS; // os testes trocam por um script que diz quantas
  const out = cmd ? await executar(cmd, [String(pid)]) : process.platform === "darwin" ? await executar("osascript", ["-l", "JavaScript", "-e", JXA_JANELAS, String(pid)]) : null;
  const n = Number(String(out ?? "").trim());
  return out != null && String(out).trim() !== "" && Number.isFinite(n) ? n : null;
}

/** Os sites com cookie PERSISTENTE criado desde `desde` (ms), lidos do banco de cookies do perfil (só domínio e
 *  quantidade, nunca o valor). null = não deu para ler. #219: o 1º login do dono no Meta não deixou c_user/xs no
 *  perfil e ninguém soube até o agente cair na tela de login — agora o fim do login diz o que ficou gravado. */
async function cookiesDoLogin(desde) {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const arq = join(PERFIL(), "Default", "Cookies");
    if (!existsSync(arq)) return [];
    const db = new DatabaseSync(arq, { readOnly: true });
    try {
      const desdeChrome = (BigInt(Math.floor(desde)) + 11644473600000n) * 1000n; // microssegundos desde 1601
      return db.prepare("SELECT host_key AS h, count(*) AS n FROM cookies WHERE is_persistent = 1 AND creation_utc >= ? GROUP BY host_key ORDER BY n DESC")
        .all(desdeChrome).map((r) => ({ site: String(r.h).replace(/^\./, ""), n: Number(r.n) }));
    } finally { db.close(); }
  } catch { return null; }
}

async function terminouLogin(motivo) {
  const l = NAV.logando;
  if (!l) return;
  NAV.logando = null;
  const c = await cookiesDoLogin(l.desde);
  const gravados = c == null ? "" : c.length ? ` Cookies gravados neste login: ${c.slice(0, 8).map((x) => `${x.site} (${x.n})`).join(", ")}.`
    : " ⚠ Nenhum cookie novo foi gravado neste login: se você entrou numa conta, ela NÃO ficou salva — abra o login de novo e saia pelo ✓ Terminei de logar.";
  logEvent(LOG_NAVEGADOR, { t: "navegador", quem: "dono", acao: "logar", alvo: "login encerrado", ok: true, cookies: c, texto: `${motivo} — os agentes voltam a usar o perfil.${gravados}` });
  return c;
}

// "Sair" do app SÓ daquele pid (o Cmd+Q dele: NSRunningApplication.terminate, sem permissão de acessibilidade) — o Chrome
// do dono é outro processo e nem é visto. É o desligamento limpo, que grava os cookies. O SIGTERM NÃO é (medido em 27/10,
// #219, com e sem janela: o Chrome cai em ~40 ms e o cookie gravado 3–4 s antes some — o 1º login do dono no Meta).
const JXA_SAIR = `ObjC.import('AppKit');
function run(a) { const r = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(a[0])); if (!r || r.isNil()) return 'nao'; return r.terminate ? 'ok' : 'nao'; }`;
async function sairDoApp(pid) {
  const cmd = process.env.BOARD_NAVEGADOR_SAIR; // os testes trocam por um script (o Chrome deles não é app de janela)
  const out = cmd ? await executar(cmd, [String(pid)]) : process.platform === "darwin" ? await executar("osascript", ["-l", "JavaScript", "-e", JXA_SAIR, String(pid)]) : null;
  return String(out ?? "").trim() === "ok";
}

/** Encerra o Chrome de login: "Sair" do app (grava os cookies), espera sair e só então diz encerrado. SIGTERM e
 *  SIGKILL ficam de reserva, e o registro diz quando foram usados. */
async function encerrarLogin(motivo) {
  const l = NAV.logando || (NAV.proc ? null : await adotarLogin());
  if (!l) return { encerrado: false };
  const args = await argsDe(l.pid);
  if (!vivo(l.pid)) return { encerrado: true, cookies: await terminouLogin(motivo + " (já tinha saído)") };
  if (!args) throw erro(`não consegui conferir o processo ${l.pid} antes de encerrar (ps falhou): nada foi encerrado`, 500);
  // O pid foi reaproveitado por outro programa (ou é Chrome de outro perfil): esquece, sem tocar nele.
  if (!ehDestePerfil(args)) return { encerrado: true, cookies: await terminouLogin(motivo + " (o Chrome de login já tinha saído)") };
  const limpo = await sairDoApp(l.pid);
  if (limpo) for (let t = 0; t < LOGIN_FECHAR_MS && vivo(l.pid); t += 100) await esperar(100);
  const sigterm = vivo(l.pid);
  if (sigterm) { try { process.kill(l.pid, "SIGTERM"); } catch { /* saiu agora */ } for (let t = 0; t < LOGIN_FECHAR_MS && vivo(l.pid); t += 100) await esperar(100); }
  let forcado = false;
  if (vivo(l.pid)) { forcado = true; try { process.kill(l.pid, "SIGKILL"); } catch { /* saiu */ } for (let i = 0; i < 30 && vivo(l.pid); i++) await esperar(100); }
  if (vivo(l.pid)) throw erro(`o Chrome de login (pid ${l.pid}) não saiu nem com SIGKILL`, 500);
  const cookies = await terminouLogin(forcado ? `${motivo}; não saiu nem com SIGTERM em ${LOGIN_FECHAR_MS / 1000} s e foi encerrado à força (os cookies dos últimos ~30 s podem não ter sido gravados)`
    : sigterm ? `${motivo}; encerrado com SIGTERM${limpo ? " (não saiu pelo Sair)" : ""} — o que o Chrome mudou nos últimos ~30 s pode não ter sido gravado` : motivo);
  return { encerrado: true, forcado, limpo: !sigterm, cookies };
}

/** Chrome de login que já segurava o perfil (o board reiniciou com ele aberto): vira o `logando` de novo. */
async function adotarLogin() {
  if (NAV.logando) return NAV.logando;
  const d = await donoDoPerfil();
  if (NAV.logando) return NAV.logando; // o logar abriu um enquanto o ps rodava
  if (!d || NAV.proc || /(^|\s)--headless/.test(d.args) || /--remote-debugging-port/.test(d.args)) return null;
  NAV.logando = { pid: d.pid, desde: Date.now(), viuJanela: false, semJanela: 0 };
  logEvent(LOG_NAVEGADOR, { t: "navegador", quem: "navegador", acao: "logar", alvo: "login achado aberto", ok: true, texto: `Chrome de login do perfil (pid ${d.pid}) achado aberto; os agentes esperam até ele fechar` });
  return NAV.logando;
}

/** A vigia: saiu → modo agente; sem janela (o dono fechou a última, e o Chrome do Mac continua vivo) → SIGTERM. */
let vigiando = false;
async function vigiarLogin() {
  if (vigiando) return; vigiando = true;
  try {
    const l = NAV.logando || (NAV.proc ? null : await adotarLogin());
    if (!l) return;
    if (!vivo(l.pid)) return void await terminouLogin("a janela de login foi fechada");
    const n = await janelasDe(l.pid);
    if (NAV.logando !== l) return;
    if (n == null) return; // não sei contar janelas aqui: vale só a saída do processo (ou o ✓ Terminei de logar)
    if (n > 0) { l.viuJanela = true; l.semJanela = 0; return; }
    if (!l.viuJanela && Date.now() - l.desde < LOGIN_ESPERA_MS) return; // a janela ainda está nascendo
    if (++l.semJanela >= 2) await encerrarLogin("a última janela de login foi fechada");
  } catch (e) {
    logEvent(LOG_NAVEGADOR, { t: "navegador", quem: "navegador", acao: "logar", alvo: "vigia do login", ok: false, erro: e.message });
  } finally { vigiando = false; }
}
setInterval(vigiarLogin, VIGIA_MS).unref();

/** `board navegador logar`: o MESMO perfil num Chrome com janela e SEM porta de depuração (o Google recusa login em
 *  navegador controlado). Enquanto ele está aberto, os agentes esperam (409); fecha pelo ✓ Terminei de logar, pelo
 *  ⏹/`board navegador fechar`, ou sozinho quando a última janela fecha. */
export async function abrirParaLogar(url = "") {
  if (NAV.logando || await adotarLogin()) return { ok: true, jaAberto: true };
  const chrome = acharChrome();
  if (!chrome) throw erro("Chrome não encontrado nesta máquina (defina BOARD_NAVEGADOR_CHROME=<caminho>)", 503);
  await fecharNavegador();
  const perfil = prepararPerfil();
  const alvo = /^https?:\/\//.test(url) ? url : "about:blank";
  const cp = spawn(chrome, [`--user-data-dir=${perfil}`, "--no-first-run", "--no-default-browser-check", ...ARGS_EXTRA(), "--new-window", alvo], { stdio: "ignore" });
  cp.on("error", () => {});
  const l = { pid: cp.pid, desde: Date.now(), viuJanela: false, semJanela: 0 };
  NAV.logando = l;
  // Quem segura o perfil é o pid certo (se outro Chrome deste perfil já estava vivo, o novo só lhe passa a janela e sai).
  for (let i = 0; i < 50; i++) {
    const d = await donoDoPerfil();
    if (d) { l.pid = d.pid; break; }
    if (cp.exitCode !== null) break;
    await esperar(100);
  }
  logEvent(LOG_NAVEGADOR, { t: "navegador", quem: "dono", acao: "logar", alvo: "janela aberta", url: alvo, ok: true, texto: `Chrome com janela no perfil do navegador dos agentes (pid ${l.pid})` });
  return { ok: true, perfil, pid: l.pid };
}

// ── as ferramentas ───────────────────────────────────────────────────────────
// Na página, achar o elemento pelo seletor CSS ou pelo texto visível. Volta o próprio elemento (objectId).
const ACHAR = `(function (alvo, tipo) {
  const norm = (s) => String(s || "").normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").replace(/\\s+/g, " ").trim().toLowerCase();
  const vis = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  if (alvo.seletor) return document.querySelector(alvo.seletor);
  if (tipo === "arquivo") return document.querySelector('input[type=file]');
  const t = norm(alvo.texto); if (!t) return null;
  if (tipo === "campo") {
    const campos = [...document.querySelectorAll('input:not([type=hidden]):not([type=file]),textarea,select,[contenteditable=""],[contenteditable=true]')].filter(vis);
    for (const l of document.querySelectorAll("label")) if (norm(l.innerText) === t || norm(l.innerText).includes(t)) { const c = l.control || l.querySelector("input,textarea,select"); if (c) return c; }
    const nome = (e) => norm(e.getAttribute("aria-label") || e.placeholder || e.name || e.id);
    return campos.find((e) => nome(e) === t) || campos.find((e) => nome(e).includes(t)) || null;
  }
  const cands = [...document.querySelectorAll('button,a,[role=button],[role=link],[role=menuitem],[role=tab],[role=option],input[type=submit],input[type=button],label,summary,[onclick]')].filter(vis);
  const txt = (e) => norm(e.innerText || e.value || e.getAttribute("aria-label") || e.title);
  return cands.find((e) => txt(e) === t) || cands.find((e) => txt(e).includes(t)) || null;
})`;
// Descreve o elemento (e o que fica por cima dele no ponto do clique): é com isso que o risco é julgado.
// Descreve o que o clique faz — é com isso que o risco é julgado. FAIL-CLOSED pela causa (3ª reprova da QA da #217:
// <a href=/delete-account><button>Seguir</button></a> passava porque só o elemento mais próximo era lido). Para o elemento
// que recebe o clique, sobe por TODOS os ancestrais e junta: o texto/aria-label/title de cada um que é clicável; todo
// destino — href de <a>/<area>, formaction / action do formulário (o ancestral e o do form=), data-href/data-url/
// data-link/data-action, o texto do onclick; o controle de um <label>. Elemento que navega sem destino legível
// (role=link, <a> sem href com onclick) = "destino desconhecido", que também é risco. Tudo pelos PROTÓTIPOS: num <form>,
// um campo name="action"/"getAttribute"/"innerText" ENCOBRE a propriedade (QA da #217).
const DESCREVER = `function () {
  const el = this; el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const E = Element.prototype, H = HTMLElement.prototype, N = Node.prototype;
  const get = (proto, nome, x) => { try { return Object.getOwnPropertyDescriptor(proto, nome).get.call(x); } catch { return undefined; } };
  const ga = (x, n) => (x instanceof Element ? E.getAttribute.call(x, n) : null) || "";
  const tem = (x, n) => x instanceof Element && E.hasAttribute.call(x, n);
  const tag = (x) => String(get(E, "tagName", x) || "").toLowerCase();
  const txt = (x) => String(get(H, "innerText", x) || "");
  const abs = (u) => { try { return new URL(u, document.baseURI).href; } catch { return String(u); } };
  const acaoDoForm = (f) => String(get(HTMLFormElement.prototype, "action", f) || "");
  const CLICAVEL = (x) => ["a", "area", "button", "summary", "label", "select", "option"].includes(tag(x)) || (tag(x) === "input" && /^(submit|button|image|reset|checkbox|radio)$/.test(String(ga(x, "type")).toLowerCase()))
    || /^(button|link|menuitem|menuitemcheckbox|menuitemradio|tab|option|switch|checkbox|radio)$/.test(ga(x, "role")) || tem(x, "onclick") || tem(x, "data-href") || tem(x, "data-url") || tem(x, "data-link") || tem(x, "data-action");
  const desc = (alvo) => {
    const textos = [], destinos = []; let desconhecido = false, primeiro = null;
    const vistos = new Set(); const fila = [alvo];
    while (fila.length) {
      const inicio = fila.shift();
      for (let x = inicio; x && x instanceof Element; x = get(N, "parentNode", x)) {
        if (vistos.has(x)) break; vistos.add(x);
        const t = tag(x);
        if (t === "label") { const c = get(HTMLLabelElement.prototype, "control", x); if (c && !vistos.has(c)) fila.push(c); }
        const clicavel = CLICAVEL(x);
        if (clicavel) { if (!primeiro) primeiro = x;
          textos.push(txt(x).slice(0, 300), ga(x, "aria-label"), ga(x, "title"), ga(x, "alt"));
          if (t === "input") textos.push(String(get(HTMLInputElement.prototype, "value", x) || "").slice(0, 120));
          if (t === "button") textos.push(String(get(HTMLButtonElement.prototype, "value", x) || "").slice(0, 120)); }
        for (const n of ["data-href", "data-url", "data-link", "data-action", "formaction", "action"]) if (tem(x, n) && t !== "form") destinos.push(abs(ga(x, n)));
        if (tem(x, "onclick")) destinos.push(ga(x, "onclick").slice(0, 300));
        if (t === "a" || t === "area") { if (tem(x, "href")) destinos.push(String(get(t === "a" ? HTMLAnchorElement.prototype : HTMLAreaElement.prototype, "href", x) || ga(x, "href")));
          else if (tem(x, "onclick") || ga(x, "role") === "link") desconhecido = true; }
        // <img usemap>: o clique cai na imagem e vai para a <area> do ponto — junta os destinos de todas (fail-closed).
        if (t === "img" && tem(x, "usemap")) { const nome = ga(x, "usemap").replace(/^#/, "");
          textos.push(ga(x, "alt"));
          for (const ar of Document.prototype.querySelectorAll.call(document, 'map[name="' + CSS.escape(nome) + '"] area')) {
            textos.push(ga(ar, "alt"), ga(ar, "title")); if (tem(ar, "href")) destinos.push(String(get(HTMLAreaElement.prototype, "href", ar) || "")); else desconhecido = true; } }
        if (ga(x, "role") === "link" && !tem(x, "href") && !tem(x, "data-href") && !tem(x, "data-url") && !tem(x, "data-link") && !tem(x, "onclick")) desconhecido = true;
        // Controle que ENVIA: o formulário dele (o ancestral ou o do form=).
        if ((t === "button" || t === "input") && /^(submit|image)$/.test(String(get(t === "button" ? HTMLButtonElement.prototype : HTMLInputElement.prototype, "type", x) || ""))) {
          const f = get(t === "button" ? HTMLButtonElement.prototype : HTMLInputElement.prototype, "form", x);
          if (f) destinos.push(tem(x, "formaction") ? abs(ga(x, "formaction")) : acaoDoForm(f));
        }
      }
    }
    const p = primeiro || alvo;
    return { tag: tag(p), texto: textos.filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 1500), destinos: [...new Set(destinos.filter(Boolean))], desconhecido };
  };
  // A <area> de um <img usemap> não fica DENTRO da imagem (mora no <map>), mas é ela que recebe o clique.
  const doMapa = (img, ar) => tag(img) === "img" && tag(ar) === "area" && tem(img, "usemap") && ar.parentElement && tag(ar.parentElement) === "map" && ga(ar.parentElement, "name") === ga(img, "usemap").replace(/^#/, "");
  const topo = document.elementFromPoint(cx, cy);
  return { x: cx, y: cy, visivel: r.width > 0 && r.height > 0, el: desc(el), topo: topo ? desc(topo) : null, mesmo: !!topo && (el === topo || N.contains.call(el, topo) || N.contains.call(topo, el) || doMapa(el, topo)) };
}`;

async function achar(cdp, alvo, tipo) {
  if (!alvo || (!alvo.seletor && !alvo.texto && tipo !== "arquivo")) throw erro("diga o alvo: seletor (CSS) ou texto visível");
  const r = await cdp.cmd("Runtime.evaluate", { expression: `${ACHAR}(${JSON.stringify(alvo)}, ${JSON.stringify(tipo)})`, returnByValue: false });
  if (r.exceptionDetails) throw erro("seletor inválido: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).split("\n")[0]);
  if (!r.result.objectId || r.result.subtype === "null") throw erro(`não achei ${alvo.seletor ? `"${alvo.seletor}"` : alvo.texto ? `"${alvo.texto}"` : "o campo de arquivo"} na página`, 404);
  return r.result.objectId;
}
const chamar = async (cdp, objectId, fn, args = []) => {
  const r = await cdp.cmd("Runtime.callFunctionOn", { objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw erro(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const avaliar = async (cdp, expr) => {
  const r = await cdp.cmd("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw erro(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const ondeEstou = async (cdp) => { try { const v = await avaliar(cdp, "({ url: location.href, titulo: document.title })"); NAV.url = v.url; NAV.titulo = v.titulo; return v; } catch { return { url: NAV.url || "", titulo: "" }; } };
async function esperarCarregar(cdp, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await avaliar(cdp, `document.readyState === "complete"`)) return true; } catch { /* trocando de página */ } await esperar(150); }
  return false;
}

// Arquivo que não sobe: chave, segredo, configuração escondida (um agente não manda ~/.ssh para um site).
const SENSIVEL = /(^|\/)\.[^/]+\/|(^|\/)(\.env[^/]*|id_[a-z0-9]+|[^/]*\.(pem|key|p12|pfx|kdbx)|aprovacoes\.chave|board\.env)$/i;
export function arquivoParaSubir(caminho) {
  const p = resolve(String(caminho || ""));
  if (!existsSync(p)) throw erro("arquivo não existe: " + p, 404);
  let real = p; try { real = realpathSync(p); } catch { /* fica */ }
  if (!statSync(real).isFile()) throw erro("não é arquivo: " + p);
  if (SENSIVEL.test(real) || real.startsWith(PERFIL() + sep)) throw erro("esse arquivo não sobe pelo navegador dos agentes (chave, segredo ou pasta escondida): " + basename(real), 403);
  return real;
}

const FERRAMENTAS = {
  async abrir(cdp, { url }) {
    const u = String(url || "").trim();
    if (!/^https?:\/\//i.test(u) && u !== "about:blank") throw erro("só endereço http(s): " + cut(u, 80));
    const r = await cdp.cmd("Page.navigate", { url: u }, 30000);
    if (r.errorText) throw erro(`não abriu ${u}: ${r.errorText}`, 502);
    await esperarCarregar(cdp);
    return { ...(await ondeEstou(cdp)) };
  },
  async ler(cdp, { modo = "texto" }) {
    const onde = await ondeEstou(cdp);
    if (modo === "arvore") {
      const { nodes } = await cdp.cmd("Accessibility.getFullAXTree", {}, 30000);
      const linhas = [];
      for (const n of nodes) {
        const papel = n.role?.value, nome = String(n.name?.value || "").replace(/\s+/g, " ").trim();
        if (n.ignored || !nome || ["generic", "none", "InlineTextBox", "LineBreak", "RootWebArea"].includes(papel)) continue;
        if (papel === "StaticText" && linhas.length && linhas[linhas.length - 1].endsWith(nome)) continue;
        linhas.push(`${papel}: ${cut(nome, 160)}`);
        if (linhas.length >= 600) break;
      }
      return { ...onde, arvore: linhas.join("\n") };
    }
    const v = await avaliar(cdp, `(() => {
      const vis = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
      const controles = [...document.querySelectorAll('button,a[href],[role=button],input,textarea,select,[contenteditable=true]')].filter(vis).slice(0, 120).map((e) => {
        const t = String(e.innerText || e.value || e.getAttribute("aria-label") || e.placeholder || e.name || e.title || "").replace(/\\s+/g, " ").trim().slice(0, 80);
        return (e.tagName.toLowerCase() + (e.type && e.tagName !== "BUTTON" ? "[" + e.type + "]" : "")) + ": " + t + (e.href ? " → " + e.href : "");
      });
      return { texto: String(document.body ? document.body.innerText : "").slice(0, 30000), controles };
    })()`);
    return { ...onde, ...v };
  },
  async clicar(cdp, { seletor, texto }, ctx) {
    const objectId = await achar(cdp, { seletor, texto }, "clicavel");
    const d = await chamar(cdp, objectId, DESCREVER);
    if (!d.visivel) throw erro("o elemento não está visível na página", 409);
    if (!d.mesmo) {
      // Outro elemento por cima, fora do alvo: o clique iria para ELE — recusa (clicaria no lugar errado).
      throw erro(`outro elemento está por cima de "${cut(d.el.texto || seletor || texto, 60)}" (${d.topo?.tag}: "${cut(d.topo?.texto, 60)}") — o clique iria para ele`, 409);
    }
    // O HTML é só AVISO (o que o elemento PARECE fazer, inclusive pelos ancestrais): quem decide é a porta da rede, pelo
    // que a página realmente mandar depois do clique.
    const onde = await ondeEstou(cdp); const host = hostDe(onde.url);
    const recebe = d.topo || d.el;
    const avisos = [...new Set([classificarRisco(recebe, host), classificarRisco(d.el, host)].filter(Boolean))];
    ctx.aviso = avisos.join(", ") || null; ctx.alvo = cut(recebe.texto || seletor || texto, 120);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
      await cdp.cmd("Input.dispatchMouseEvent", { type, x: d.x, y: d.y, button: "left", clickCount: type === "mouseMoved" ? 0 : 1 });
    await esperar(600); await esperarCarregar(cdp, 10000);
    return { clicado: recebe, aviso: ctx.aviso, ...(await ondeEstou(cdp)) };
  },
  async preencher(cdp, { seletor, rotulo, valor }, ctx) {
    if (valor == null) throw erro("diga o valor");
    const objectId = await achar(cdp, { seletor, texto: rotulo }, "campo");
    const info = await chamar(cdp, objectId, `function () { this.scrollIntoView({ block: "center" }); this.focus();
      if (this.tagName === "SELECT") return { select: true };
      if (this.isContentEditable) { document.execCommand("selectAll"); document.execCommand("delete"); return { editavel: true }; }
      const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(this), "value")?.set; set ? set.call(this, "") : (this.value = "");
      this.dispatchEvent(new Event("input", { bubbles: true })); return { tipo: this.type || "" }; }`);
    ctx.alvo = cut(seletor || rotulo, 120);
    if (info.select) {
      const ok = await chamar(cdp, objectId, `function (v) { const o = [...this.options].find((x) => x.value === v || x.text.trim() === v); if (!o) return false; this.value = o.value; this.dispatchEvent(new Event("change", { bubbles: true })); return true; }`, [String(valor)]);
      if (!ok) throw erro("essa opção não existe no campo: " + cut(valor, 60), 404);
    } else await cdp.cmd("Input.insertText", { text: String(valor) });
    const final = await chamar(cdp, objectId, `function () { this.dispatchEvent(new Event("change", { bubbles: true })); return this.isContentEditable ? this.innerText : this.value; }`);
    return { preenchido: info.tipo === "password" ? "••••" : cut(final, 200) };
  },
  async subir(cdp, { seletor, arquivos }, ctx) {
    const lista = [].concat(arquivos || []).filter(Boolean);
    if (!lista.length) throw erro("diga o(s) arquivo(s) a subir (caminho na máquina)");
    const reais = lista.map(arquivoParaSubir);
    const objectId = await achar(cdp, { seletor }, "arquivo");
    const ehArquivo = await chamar(cdp, objectId, `function () { return this.tagName === "INPUT" && this.type === "file"; }`);
    if (!ehArquivo) throw erro("o alvo não é um campo de arquivo (input type=file)");
    await cdp.cmd("DOM.setFileInputFiles", { files: reais, objectId });
    ctx.alvo = reais.map((f) => basename(f)).join(", ");
    return { subidos: reais.map((f) => ({ arquivo: f, bytes: statSync(f).size })) };
  },
  async esperar(cdp, { seletor, texto, ms = 10000 }) {
    const teto = Math.min(Math.max(Number(ms) || 0, 100), 60000);
    if (!seletor && !texto) { await esperar(teto); return { esperou: teto }; }
    const t0 = Date.now();
    while (Date.now() - t0 < teto) {
      const achou = await avaliar(cdp, seletor ? `!!document.querySelector(${JSON.stringify(seletor)})` : `String(document.body?.innerText || "").includes(${JSON.stringify(String(texto))})`).catch(() => false);
      if (achou) return { achou: true, ms: Date.now() - t0 };
      await esperar(200);
    }
    throw erro(`não apareceu em ${teto} ms: ${seletor || texto}`, 408);
  },
  async captura(cdp) {
    const { data } = await cdp.cmd("Page.captureScreenshot", { format: "png" });
    mkdirSync(CAPTURAS(), { recursive: true });
    const arq = join(CAPTURAS(), `${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
    writeFileSync(arq, Buffer.from(data, "base64"));
    return { arquivo: arq, png: data };
  },
};
export const NOMES_FERRAMENTAS = Object.keys(FERRAMENTAS);

/**
 * Roda uma ferramenta (uma por vez: a aba é uma só) e registra quem fez o quê, onde e com que aprovação. Com `aprovacao`
 * + `pedido`, o SIM é conferido ANTES (a #213) e vira a liberação das requisições — cada uma ainda passa por autorizar().
 * Qualquer requisição barrada durante a ação → 403 "recusado" com o método e o endereço de cada uma.
 */
export function usarNavegador(acao, params = {}, quem = "?") {
  if (!FERRAMENTAS[acao]) return Promise.reject(erro("ferramenta não existe: " + acao + " (há: " + NOMES_FERRAMENTAS.join(", ") + ")", 404));
  const vez = NAV.fila.then(async () => {
    NAV.ultimoUso = Date.now();
    const ctx = {}; const t0 = Date.now();
    NAV.acao = { quem: cut(quem, 60), barradas: [], liberadas: [] };
    const registrar = (extra) => logEvent(LOG_NAVEGADOR, { t: "navegador", quem: cut(quem, 60), acao, aviso: ctx.aviso || null,
      aprovacao: NAV.liberacao ? NAV.liberacao.id : null, ms: Date.now() - t0, ...extra });
    try {
      if (params.aprovacao) NAV.liberacao = { ...abrirLiberacao(params.aprovacao, params.pedido), quem: cut(quem, 60) };
      const cdp = await subir();
      let r, falha = null;
      try { r = await FERRAMENTAS[acao](cdp, params, ctx); } catch (e) { falha = e; }
      if (acao !== "ler" && acao !== "captura") await esperar(250); // o que a ação disparou chega à porta
      const { barradas, liberadas } = NAV.acao;
      if (barradas.length) {
        const lista = barradas.map((b) => `${b.metodo} ${b.url}`).join("; ");
        throw erro(`a página tentou ${barradas.length === 1 ? "uma requisição" : barradas.length + " requisições"} sem aprovação e o navegador barrou: ${lista} — ${String(barradas[0].motivo).replace(/^\S+ \S+ — /, "")}`,
          403, { recusado: true, risco: barradas[0].acao, barradas });
      }
      if (falha) throw falha;
      NAV.ultimoUso = Date.now();
      registrar({ alvo: ctx.alvo || (acao === "abrir" ? params.url : acao === "ler" ? params.modo || "texto" : acao === "captura" ? basename(r.arquivo) : ""),
        url: r.url || NAV.url || "", ok: true, liberadas: liberadas.length || undefined });
      return { ...r, ...(liberadas.length ? { liberadas } : {}) };
    } catch (e) {
      registrar({ alvo: ctx.alvo || params.url || params.seletor || params.texto || params.rotulo || "", url: NAV.url || "", risco: e.risco || null,
        ok: false, recusado: !!e.recusado, erro: cut(e.message, 400) });
      throw e;
    } finally { NAV.acao = null; }
  });
  NAV.fila = vez.catch(() => {});
  return vez;
}

// ── HTTP: /api/navegador/* ───────────────────────────────────────────────────
export async function rotaNavegador(req, res, url, { json, readBody }) {
  try { return await rotas(req, res, url, { json, readBody }); }
  catch (e) { return json(res, e.status || 400, { error: e.message, ...(e.recusado ? { recusado: true, risco: e.risco, barradas: e.barradas } : {}) }); }
}
async function rotas(req, res, url, { json, readBody }) {
  const path = url.pathname;
  const daTela = daTelaDoBoard(req); // a tela local ou o endereço do Tailscale da lista (#238)
  // Página de OUTRO site aberta no Chrome do dono não manda no navegador logado dele (CSRF): CLI e MCP não mandam Origin.
  if (req.headers.origin && !daTela) return json(res, 403, { error: "o navegador dos agentes não aceita pedido de outra página" });
  if (req.method === "GET" && path === "/api/navegador") {
    const n = Math.min(Number(url.searchParams.get("n")) || 200, 1000);
    const cfg = lerConfig();
    return json(res, 200, { ...estadoNavegador(), ferramentas: NOMES_FERRAMENTAS, sempre: cfg.sempre, registro: readLog(LOG_NAVEGADOR).slice(-n) });
  }
  // Ao vivo: SSE só para quem assiste (os quadros são grandes demais para o SSE geral). Sem espectador, o screencast para.
  if (req.method === "GET" && path === "/api/navegador/ao-vivo") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`event: estado\ndata: ${JSON.stringify(estadoNavegador())}\n\n`);
    if (NAV.quadro) res.write(`event: quadro\ndata: ${JSON.stringify({ img: NAV.quadro })}\n\n`);
    NAV.espectadores.add(res);
    if (NAV.espectadores.size === 1 && NAV.cdp) iniciarScreencast();
    req.on("close", () => { NAV.espectadores.delete(res); if (!NAV.espectadores.size) NAV.cdp?.cmd("Page.stopScreencast").catch(() => {}); });
    return;
  }
  if (req.method === "POST" && path === "/api/navegador/logar") { const b = await readBody(req); return json(res, 200, await abrirParaLogar(String(b.url || ""))); }
  if (req.method === "POST" && path === "/api/navegador/fechar") return json(res, 200, { ok: true, ...(await fecharNavegador()), ...estadoNavegador() });
  // "Sempre pode" por domínio + método + caminho: só o dono, pela tela (o Origin dela, a barreira do 🚀). Agente não se autoriza.
  if (req.method === "POST" && path === "/api/navegador/sempre") {
    if (!daTela) return json(res, 403, { error: "\"sempre pode\" só pelo clique do dono na tela do board" });
    const b = await readBody(req);
    const sempre = marcarSempre(b.dominio, b.metodo, b.caminho, b.ligar !== false);
    logEvent(LOG_NAVEGADOR, { t: "navegador", quem: "dono (clique na tela)", acao: "sempre", alvo: `${String(b.metodo).toUpperCase()} ${b.caminho} em ${b.dominio}`, ok: true, texto: b.ligar !== false ? "sempre pode" : "volta a pedir aprovação" });
    return json(res, 200, { sempre });
  }
  const m = path.match(/^\/api\/navegador\/([a-z]+)$/);
  if (req.method === "POST" && m) {
    const b = await readBody(req);
    const quem = String(b.quem || req.headers["x-board-quem"] || (daTela ? "dono (tela)" : "sem nome"));
    const r = await usarNavegador(m[1], b, quem);
    const { png, ...resto } = r; // a imagem vai em arquivo; quem quer o PNG (o MCP) pede ?png=1
    return json(res, 200, url.searchParams.has("png") && png ? r : resto);
  }
  return json(res, 404, { error: "rota não existe" });
}
