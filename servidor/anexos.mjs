// Imagens e PDFs anexados: aceitos pela assinatura do arquivo, guardados em data/anexos.
import { randomUUID } from "crypto";
import { writeFileSync, existsSync } from "fs";
import { join } from "path";
import { ANEXOS, cut } from "./config.mjs";

// ── anexos (imagens) ──────────────────────────────────────────────────────────
/**
 * O dono explica muita coisa com PRINT (foi assim a sessão inteira). A tarefa merece o mesmo:
 * a imagem é gravada em data/anexos e o CAMINHO vai no prompt — o agente lê com a ferramenta Read,
 * que enxerga imagem. Nada de base64 no prompt (estouraria o comando e o custo).
 * PDF entra pelo mesmo caminho (o Read também lê PDF) — pedido do dono em 24/09, depois que o 📎
 * recusou um PDF em silêncio.
 * ⚠️ Só o que está nesta lista, por assinatura do próprio arquivo (extensão mente), com teto de tamanho.
 */
export const TIPOS_ANEXO = [
  { ext: "png", mime: "image/png", casa: (b) => b.length > 8 && b[0] === 0x89 && b.toString("latin1", 1, 4) === "PNG" },
  { ext: "jpg", mime: "image/jpeg", casa: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "gif", mime: "image/gif", casa: (b) => b.toString("latin1", 0, 6).startsWith("GIF8") },
  { ext: "webp", mime: "image/webp", casa: (b) => b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP" },
  { ext: "pdf", mime: "application/pdf", casa: (b) => b.toString("latin1", 0, 5) === "%PDF-" },
];
export const EXTS_ANEXO = TIPOS_ANEXO.map((t) => t.ext).join("|");
export const ID_ANEXO = new RegExp(`^[0-9a-f]{16}\\.(?:${EXTS_ANEXO})$`);
export const ANEXO_MAX = Number(process.env.BOARD_ANEXO_MB || 10) * 1024 * 1024;
export const ANEXOS_POR_VEZ = 6;

export function lerBinario(req, limite = ANEXO_MAX) {
  return new Promise((ok, bad) => {
    const partes = []; let tam = 0;
    req.on("data", (d) => { tam += d.length; if (tam > limite) { bad(new Error(`arquivo grande demais (máx ${Math.round(limite / 1048576)} MB)`)); req.destroy(); return; } partes.push(d); });
    req.on("end", () => ok(Buffer.concat(partes)));
    req.on("error", bad);
  });
}

export function salvarAnexo(buf, nome) {
  const tipo = TIPOS_ANEXO.find((t) => t.casa(buf));
  if (!tipo) throw new Error("só aceito imagem (png, jpg, gif ou webp) ou PDF");
  const id = randomUUID().replace(/-/g, "").slice(0, 16) + "." + tipo.ext;
  writeFileSync(join(ANEXOS, id), buf);
  return { id, nome: cut(String(nome || "imagem"), 80), mime: tipo.mime, bytes: buf.length, caminho: join(ANEXOS, id) };
}

/** Só ids que o board gerou, e só dentro de data/anexos — nada de caminho vindo do cliente. */
export function anexosValidos(lista) {
  return (Array.isArray(lista) ? lista : []).slice(0, ANEXOS_POR_VEZ)
    .map((a) => (typeof a === "string" ? { id: a } : a))
    .filter((a) => a && typeof a.id === "string" && ID_ANEXO.test(a.id) && existsSync(join(ANEXOS, a.id)))
    .map((a) => ({ id: a.id, nome: cut(String(a.nome || "imagem"), 80), caminho: join(ANEXOS, a.id) }));
}

/** O texto que o agente recebe, com o caminho das imagens e PDFs (ele abre com Read). */
export function comAnexos(texto, anexos) {
  const lista = anexosValidos(anexos);
  if (!lista.length) return texto;
  const titulo = lista.some((a) => a.id.endsWith(".pdf")) ? "Arquivos (imagens/PDF)" : "Imagens";
  return [texto, "", `${titulo} que o dono anexou (ABRA cada um com a ferramenta Read antes de decidir):`,
    ...lista.map((a) => `- ${a.nome}: ${a.caminho}`)].join("\n");
}
