// A headless Chrome driven over the DevTools protocol (WebSocket built into Node 22) — no npm dependency.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { portaLivre, esperar } from "./ajuda.mjs";

const CANDIDATOS = [process.env.CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter(Boolean);
export const CHROME = CANDIDATOS.find((c) => existsSync(c)) || null;

/** Script injected before any page script: frozen clock and a seeded Math.random (the graph layout uses it). */
export const roteiroFixo = (agora) => `(() => {
  const T = ${agora}; const Real = Date;
  window.Date = class extends Real { constructor(...a) { if (a.length) super(...a); else super(T); } static now() { return T; } };
  let s = 42; Math.random = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
})();`;

export async function abrirNavegador({ largura = 1440, altura = 1000, agora = null } = {}) {
  if (!CHROME) throw new Error("Chrome não encontrado (defina CHROME=<caminho>)");
  const porta = await portaLivre();
  const perfil = mkdtempSync(join(tmpdir(), "board-chrome-"));
  const cp = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${porta}`, `--user-data-dir=${perfil}`, "--no-first-run",
    "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", "--lang=pt-BR",
    "--font-render-hinting=none", "--disable-features=BackForwardCache", // o cache de "voltar" guardava as páginas com a conexão de eventos aberta: com 6 presas, o Chrome não navega mais
     `--window-size=${largura},${altura}`, ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let errChrome = ""; cp.stderr.on("data", (d) => { errChrome = (errChrome + d).slice(-2000); });
  const mata = () => { try { cp.kill("SIGKILL"); } catch { /* já saiu */ } };
  process.on("exit", mata); // quem nos derruba não deixa Chrome órfão para trás
  let alvo;
  // Até 30 s: numa máquina de CI fria o Chrome já levou mais de 10 s para abrir (27/09, o teste desistia antes).
  for (let i = 0; i < 300 && !alvo && cp.exitCode === null; i++) {
    await esperar(100);
    try { alvo = (await (await fetch(`http://127.0.0.1:${porta}/json`)).json()).find((t) => t.type === "page"); } catch { /* ainda subindo */ }
  }
  if (!alvo) { cp.kill("SIGKILL"); throw new Error(`o Chrome não abriu a porta de depuração (${cp.exitCode !== null ? "saiu com código " + cp.exitCode : "30 s sem resposta"}): ${errChrome.trim().slice(-600)}`); }
  const ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
  let seq = 0; const pend = new Map(); const erros = []; const ouvintes = []; const abertos = new Map(); const dialogos = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { const [ok, bad] = pend.get(d.id); pend.delete(d.id); d.error ? bad(new Error(d.error.message)) : ok(d.result); return; }
    if (d.method === "Runtime.exceptionThrown") erros.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
    if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") erros.push(d.params.args.map((a) => a.value ?? a.description).join(" "));
    if (d.method === "Page.javascriptDialogOpening") { dialogos.push(d.params.message); cmd("Page.handleJavaScriptDialog", { accept: true }).catch(() => {}); }
    if (d.method === "Network.requestWillBeSent") abertos.set(d.params.requestId, d.params.request.url);
    if (d.method === "Network.loadingFinished" || d.method === "Network.loadingFailed") abertos.delete(d.params.requestId);
    for (const f of ouvintes) f(d);
  };
  // Every command has a deadline: a call made while the page is navigating can otherwise never get an answer.
  const cmd = (method, params = {}, prazo = 20000) => new Promise((ok, bad) => {
    const id = ++seq; const t = setTimeout(() => { pend.delete(id); bad(new Error(`o Chrome não respondeu a ${method}`)); }, prazo);
    pend.set(id, [(v) => { clearTimeout(t); ok(v); }, (e) => { clearTimeout(t); bad(e); }]);
    ws.send(JSON.stringify({ id, method, params }));
  });
  await cmd("Runtime.enable"); await cmd("Page.enable"); await cmd("Network.enable");
  // Avaliação: TELA_COBERTURA=<pasta> grava quais funções dos scripts da tela rodaram (cobertura do V8 no Chrome).
  const cobertura = process.env.TELA_COBERTURA; const coletas = [];
  if (cobertura) { await cmd("Profiler.enable"); await cmd("Profiler.startPreciseCoverage", { callCount: true, detailed: false }); }
  const coletar = async () => { if (cobertura) try { coletas.push(...(await cmd("Profiler.takePreciseCoverage")).result.filter((r) => /\/js\/[\w-]+\.js$/.test(r.url))); } catch { /* página trocando */ } };
  await cmd("Emulation.setTimezoneOverride", { timezoneId: "America/Sao_Paulo" });
  await cmd("Emulation.setLocaleOverride", { locale: "pt-BR" });
  await cmd("Emulation.setDeviceMetricsOverride", { width: largura, height: altura, deviceScaleFactor: 1, mobile: largura < 760 });
  if (agora) await cmd("Page.addScriptToEvaluateOnNewDocument", { source: roteiroFixo(agora) });
  const avaliar = async (expr) => {
    const r = await cmd("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, 15000);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  /** Navigates and waits until THAT page says it finished loading (asking the page, not trusting CDP events). */
  const carregar = async (url) => {
    await coletar(); // antes de trocar de página, guarda o que a anterior executou
    try { await cmd("Page.navigate", { url }); }
    catch (e) {
      const srv = await Promise.race([fetch(url).then((r) => "o servidor responde " + r.status), esperar(3000).then(() => "o servidor NÃO responde")]).catch((x) => x.message);
      throw new Error(`${e.message} (${srv}; pedidos ainda abertos no Chrome: ${[...abertos.values()].join(", ") || "nenhum"})`);
    }
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      try { if (await avaliar(`document.readyState === "complete" && location.href === ${JSON.stringify(new URL(url).href)}`)) return; }
      catch { /* contexto trocando no meio da navegação: pergunta de novo */ }
      await esperar(100);
    }
    throw new Error("a página não terminou de carregar: " + url);
  };
  /** Waits until the page stops changing (the screens fill in after their fetches). */
  const quieto = async ({ min = 300, max = 8000 } = {}) => {
    let antes = null, igual = 0; const t0 = Date.now();
    while (Date.now() - t0 < max) {
      await esperar(150);
      const agora = await avaliar(`document.body.innerHTML.length + ":" + document.body.innerText.includes("carregando…")`);
      if (agora === antes && !agora.endsWith("true")) { igual += 150; if (igual >= min) return; } else igual = 0;
      antes = agora;
    }
  };
  const foto = async () => (await cmd("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })).data;
  const tamanho = (l, a) => cmd("Emulation.setDeviceMetricsOverride", { width: l, height: a, deviceScaleFactor: 1, mobile: l < 760 });
  const fechar = async () => {
    if (cobertura) { await coletar(); const { writeFileSync } = await import("node:fs"); writeFileSync(join(cobertura, `tela-${process.pid}-${Date.now()}.json`), JSON.stringify(coletas)); }
    try { ws.close(); } catch { /* já fechou */ } cp.kill("SIGKILL"); await esperar(200); rmSync(perfil, { recursive: true, force: true }); };
  return { cmd, avaliar, carregar, quieto, foto, tamanho, fechar, erros, dialogos };
}
