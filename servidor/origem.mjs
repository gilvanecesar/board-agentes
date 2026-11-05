// "A tela do board": quem pode clicar nas ações que só o dono faz (🚀 publicar, SIM da Central, permissões, teclas das
// Sessões, "sempre pode" do navegador) — e de quais endereços (#238: o board pelo Tailscale, fora de casa).
//
// - Tela local: Origin `http://<Host>` com Host LOCAL (localhost/127.0.0.1/[::1]). Exigir o Host local fecha o DNS
//   rebinding: uma página de fora que aponta o nome dela para 127.0.0.1 manda Origin e Host iguais (`http://evil:4488`).
// - Tela pelo Tailscale: só os endereços da lista EXPLÍCITA `BOARD_ORIGENS_EXTRAS` (ex.: `https://mac.tailXXXX.ts.net`),
//   e só se (1) o pedido chega do loopback — o `tailscale serve` repassa de 127.0.0.1 (medido em 28/10) —, (2) o Host é o
//   mesmo endereço do Origin (o serve preserva o Host) e (3) com `BOARD_TAILSCALE_LOGINS`, o login que o serve informa
//   (`Tailscale-User-Login`) está na lista. O serve APAGA esse cabeçalho vindo do cliente e põe o verdadeiro (medido:
//   mandar "forjado@x" chega como o login real); quem fala direto com 127.0.0.1 já é desta máquina.
// - Sem a lista, nada muda: só a tela local. Origin de qualquer outro endereço: 403 sempre. Não existe curinga.
// ⚠️ Barreira contra chamada sem querer e página de outro site, não cofre: quem roda nesta máquina forja o cabeçalho.
export const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
export const doLoopback = (req) => /^(127\.|::1$|::ffff:127\.)/.test(String(req.socket?.remoteAddress || ""));

const lista = (v) => String(v || "").split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

/** As origens extras válidas (só http/https, sem caminho, sem curinga, sem usuário). Lidas a cada pedido: o ↻ não é preciso. */
export function origensExtras() {
  const ok = [];
  for (const x of lista(process.env.BOARD_ORIGENS_EXTRAS)) {
    if (x.includes("*")) continue;
    try {
      const u = new URL(x);
      if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.pathname !== "/" || u.search || u.hash) continue;
      ok.push(u.origin.toLowerCase());
    } catch { /* endereço inválido: ignorado, nunca vira "qualquer um" */ }
  }
  return ok;
}

/** O Host do pedido no formato do `URL.host` (sem a porta padrão do protocolo), para comparar com o Origin. */
function hostNormal(protocolo, host) {
  try { return new URL(`${protocolo}//${host}`).host.toLowerCase(); } catch { return null; }
}

const loginOk = (req) => {
  const logins = lista(process.env.BOARD_TAILSCALE_LOGINS).map((x) => x.toLowerCase());
  return !logins.length || logins.includes(String(req.headers["tailscale-user-login"] || "").toLowerCase());
};

/** O pedido chegou por um endereço do Tailscale da lista (Host = um deles, do loopback, login aceito). */
export function viaTailnet(req) {
  if (!doLoopback(req)) return false;
  const host = String(req.headers.host || "");
  return loginOk(req) && origensExtras().some((o) => { const u = new URL(o); return hostNormal(u.protocol, host) === u.host; });
}

/** O pedido veio da própria tela do board: a local, ou um endereço do Tailscale da lista. */
export function daTela(req) {
  const origem = String(req.headers.origin || "").toLowerCase();
  const host = String(req.headers.host || "");
  if (!origem) return false;
  if (LOCAL.test(host) && origem === `http://${host.toLowerCase()}`) return true;
  if (!origensExtras().includes(origem)) return false;
  const u = new URL(origem);
  return hostNormal(u.protocol, host) === u.host && viaTailnet(req);
}

/** Host aceito para o que é "só desta máquina" (o terminal das sessões): loopback com Host local, ou o Tailscale da lista. */
export const hostDaMaquina = (req) => (doLoopback(req) && LOCAL.test(String(req.headers.host || ""))) || viaTailnet(req);
