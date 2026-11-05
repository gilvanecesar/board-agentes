// O Chrome pelo protocolo do DevTools (CDP), com o WebSocket que já vem no Node — zero dependência.
// Usado pelo navegador dos agentes (servidor/navegador.mjs) e pelo Chrome dos testes (test/navegador.mjs).
import { existsSync } from "node:fs";
import { createServer } from "node:net";

const CANDIDATOS = [process.env.BOARD_NAVEGADOR_CHROME, process.env.CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter(Boolean);
export const acharChrome = () => CANDIDATOS.find((c) => existsSync(c)) || null;

export const portaLivre = () => new Promise((ok, bad) => {
  const s = createServer(); s.unref(); s.on("error", bad);
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); });
});

/**
 * Liga num alvo do CDP (`webSocketDebuggerUrl`). Todo comando tem prazo: uma chamada feita com a página navegando
 * pode nunca ter resposta. `ouvir(fn)` recebe cada evento; devolve a função que para de ouvir.
 */
export async function conectarCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error("não consegui ligar no Chrome (" + wsUrl + ")")); });
  let seq = 0; const pend = new Map(); const ouvintes = new Set(); let fechado = false;
  ws.onmessage = (m) => {
    let d; try { d = JSON.parse(m.data); } catch { return; }
    if (d.id && pend.has(d.id)) { const [ok, bad] = pend.get(d.id); pend.delete(d.id); d.error ? bad(new Error(d.error.message)) : ok(d.result); return; }
    for (const f of ouvintes) { try { f(d); } catch { /* ouvinte com defeito não derruba os outros */ } }
  };
  ws.onclose = () => { fechado = true; for (const [, [, bad]] of pend) bad(new Error("o Chrome fechou a conexão")); pend.clear(); };
  // `sessionId`: comando para uma sessão filha (iframe de outro processo, worker), ligada com Target.setAutoAttach + flatten.
  const cmd = (method, params = {}, prazo = 20000, sessionId) => new Promise((ok, bad) => {
    if (fechado) return bad(new Error("o Chrome fechou a conexão"));
    const id = ++seq; const t = setTimeout(() => { pend.delete(id); bad(new Error(`o Chrome não respondeu a ${method}`)); }, prazo);
    pend.set(id, [(v) => { clearTimeout(t); ok(v); }, (e) => { clearTimeout(t); bad(e); }]);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const ouvir = (fn) => { ouvintes.add(fn); return () => ouvintes.delete(fn); };
  const fechar = () => { try { ws.close(); } catch { /* já fechou */ } };
  return { cmd, ouvir, fechar, aberto: () => !fechado };
}
