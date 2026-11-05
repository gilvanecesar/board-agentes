// `board tela link <endereço>` (#302): o que pode virar aba nova no navegador do dono. Só endereço público http/https, resolvido
// AQUI; a tela recebe o endereço já normalizado. Interno fica de fora de propósito: a aba abriria no aparelho dele, por trás da
// rede dele (o próprio board, o roteador, a tailnet), a pedido de um texto.
import { lookup } from "dns/promises";

const TETO = 2048, ESPERA_DNS_MS = 1500;
const NOMES_INTERNOS = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|home\.arpa|ts\.net)$/;

/** IP de faixa que não é internet pública. IPv6 só chega aqui pelo DNS: literal na URL é recusado antes. */
export function ipInterno(ip) {
  const s = String(ip).toLowerCase(), v4 = s.startsWith("::ffff:") ? s.slice(7) : s;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) {
    const [a, b] = v4.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
  }
  return s === "::" || s === "::1" || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith("::ffff:");
}

/** O texto → {url, host} normalizados, ou {erro}. Sem rede: a forma do endereço decide tudo o que dá para decidir. */
export function lerLink(texto) {
  const t = String(texto ?? "");
  if (!t || t.length > TETO) return { erro: `o endereço precisa ter de 1 a ${TETO} caracteres` };
  // O parser de URL engole tab e quebra de linha ("java\nscript:"): nada disso passa por ele.
  if (/[\s\p{Cc}]/u.test(t)) return { erro: "endereço com espaço ou caractere de controle" };
  if (!/^https?:\/\//i.test(t)) return { erro: "só http:// ou https://, com o endereço completo" };
  let u; try { u = new URL(t); } catch { return { erro: "endereço inválido" }; }
  if (u.username || u.password) return { erro: "endereço com usuário ou senha embutidos" }; // https://banco.com@outro.site
  const host = u.hostname.toLowerCase().replace(/\.+$/, "");
  if (!host || host.startsWith("[")) return { erro: "endereço interno: IPv6 literal não abre" };
  if (!/^[a-z0-9._-]+$/.test(host)) return { erro: "nome de site inválido" }; // `new URL` do Node aceita `a*b.com`, o navegador não: recusar aqui diz o motivo
  // `new URL` já traduziu 2130706433, 0x7f.1 e 127.1 para 127.0.0.1.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) ? ipInterno(host) : !host.includes(".") || NOMES_INTERNOS.test(host)) return { erro: `endereço interno: ${host}` };
  return { url: u.href, host: u.host };
}

/** Nome público apontando para dentro (127.0.0.1.nip.io). Sem resposta do DNS, segue: o navegador diz que o site não existe. */
export async function apontaParaDentro(url, resolver = (h) => lookup(h, { all: true })) {
  const { hostname } = new URL(url);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return false;
  let timer;
  const ips = await Promise.race([resolver(hostname).catch(() => []), new Promise((ok) => { timer = setTimeout(() => ok([]), ESPERA_DNS_MS); })]);
  clearTimeout(timer);
  return ips.some((x) => ipInterno(x.address));
}
