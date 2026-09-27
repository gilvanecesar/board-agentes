// The REFERENCE SNAPSHOT: every screen (DOM + screenshot, desktop and phone) and every read-only API route, on the
// fixed demo data with the clock frozen. Used to prove that a refactor changed nothing the owner can see.
//   node test/fotografia.mjs <out.json>                  (code under test: BOARD_TESTE_FONTE, default this repo)
//   node test/fotografia.mjs --comparar <a.json> <b.json>
import { writeFileSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { criarCaixa, subirBoard, limparCaixa } from "./ajuda.mjs";
import { montarDemo, AGORA } from "./demo.mjs";
import { abrirNavegador } from "./navegador.mjs";

const AQUI = dirname(fileURLToPath(import.meta.url));

export const TELAS = [
  // [nome, localStorage, hash, ação extra na página]
  ["ativas", { tab: "ativas" }, ""],
  ["ativas-filtro", { tab: "ativas", filtro: "loja-online" }, ""],
  ["pendentes", { tab: "pendentes" }, ""],
  ["executadas", { tab: "executadas" }, ""],
  ["concluidas", { tab: "concluidas" }, ""],
  ["consumo", { tab: "consumo" }, ""],
  ["status", { tab: "monitoring" }, ""],
  ["controle", { tab: "controle" }, ""],
  ["memoria-grafo", { tab: "memoria", memoriaModo: "grafo" }, ""],
  ["memoria-galpao", { tab: "memoria", memoriaModo: "galpao" }, ""],
  ["tarefa-executada", {}, "#/t/12"],
  ["tarefa-erro", {}, "#/t/14"],
  ["tarefa-pendente", {}, "#/t/3"],
  ["conversa", {}, "#/c/loja-online"],
  ["busca", {}, "#/busca"],
  ["busca-resultado", {}, "#/busca", `(() => { const i = document.querySelector("#buscaIn"); i.value = "pix webhook"; i.dispatchEvent(new Event("input", { bubbles: true })); i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`],
];
const ROTAS = ["/api/state", "/api/state?tudo=1", "/api/usage", "/api/tasks/12", "/api/tasks/12/log", "/api/tasks/14", "/api/conversa/loja-online",
  "/api/memoria/grafo", "/api/memoria/pagina?chave=api-pagamentos/pix-webhook-idempotente", "/api/memoria/mentes", "/api/memoria/inventario",
  "/api/romaneio/previa?texto=webhook%20do%20pix%20duplicado&projeto=api-pagamentos", "/api/romaneio/previa?texto=cupom&todas=1",
  "/api/busca?q=pix%20duplicado", "/api/busca/historico?n=10", "/api/busca/estado", "/api/modelos", "/api/nao-existe", "/api/tasks/999"];

// The computed style of every element (layout, color, type, spacing): equal DOM + equal styles = the same screen,
// even if a screenshot moves by a pixel of scroll. Screenshots stay for the owner to look at.
const PROPS = ["display", "position", "top", "left", "width", "height", "margin", "padding", "border", "border-radius", "color",
  "background-color", "background-image", "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "text-align",
  "text-transform", "opacity", "visibility", "flex-direction", "justify-content", "align-items", "gap", "grid-template-columns", "overflow", "z-index", "box-shadow", "transform"];
const ESTILO = `[...document.querySelectorAll("body, body *:not(script):not(style):not(link)")].map((e) => { const c = getComputedStyle(e); return e.tagName + (e.id ? "#" + e.id : "") + " " + ${JSON.stringify(PROPS)}.map((p) => c.getPropertyValue(p)).join("|"); }).join("\\n")`;

// The page as the owner sees it: without <script>, <style> and stylesheet <link> tags (where the code LIVES is not what
// the screen shows — inline or in files, the result must be the same).
const DOM = `(() => { const c = document.documentElement.cloneNode(true); c.querySelectorAll("script, style, link[rel=stylesheet]").forEach((e) => e.remove()); return c.outerHTML.replace(/\\n(\\s*\\n)+/g, "\\n"); })()`;

// What legitimately differs between two runs of the same code (process start, lock pid) is blanked out.
const limpar = (txt) => String(txt)
  .replace(/"iniciadoEm":"[^"]*"/g, '"iniciadoEm":"-"')
  .replace(/board-teste-[A-Za-z0-9]+/g, "board-teste-X")
  .replace(/"ms":\d+/g, '"ms":0');

export async function fotografar() {
  const caixa = criarCaixa();
  montarDemo(caixa.dev, join(caixa.raiz, "memoria"), join(caixa.board, "data"));
  const b = await subirBoard(caixa, { BOARD_RELOGIO: String(AGORA), TZ: "America/Sao_Paulo" }, { nodeArgs: ["--import", join(AQUI, "relogio.mjs")] });
  const nav = await abrirNavegador({ agora: AGORA });
  const saida = { telas: {}, rotas: {}, erros: {} };
  try {
    await b.api("POST", "/api/memoria/inventario/rodar");
    for (const r of ROTAS) { const x = await b.api("GET", r); saida.rotas[r] = x.status + " " + limpar(x.txt); }
    for (const [largura, altura, sufixo] of [[1440, 1000, ""], [390, 844, "@celular"]]) {
      await nav.tamanho(largura, altura);
      for (const [nome, local, hash, acao] of TELAS) {
        const t0 = Date.now();
        const vigia = setTimeout(async () => {
          const srv = await Promise.race([fetch(b.url + "/api/state").then((r) => "servidor responde " + r.status), new Promise((ok) => setTimeout(() => ok("servidor NÃO responde"), 3000))]).catch((e) => "servidor: " + e.message);
          console.error(`✗ a tela ${nome}${sufixo} travou (passo: ${passo}; ${srv})`); process.exit(3);
        }, 45000);
        let passo = "carregar";
        await nav.carregar(b.url + "/");
        await nav.avaliar(`localStorage.clear(); ${Object.entries(local).map(([k, v]) => `localStorage.setItem("board.${k}", ${JSON.stringify(JSON.stringify(v))});`).join(" ")}`);
        await nav.carregar("about:blank"); // descarrega a tela anterior: fecha a conexão de eventos (SSE) dela
        await nav.carregar(b.url + "/?tela=" + encodeURIComponent(nome + sufixo) + hash); // endereço novo = página carregada do zero
        await nav.quieto();
        passo = "ação"; if (acao) { await nav.avaliar(acao); await nav.quieto(); }
        nav.erros.length = 0;
        passo = "quieto"; await nav.quieto({ min: 600 });
        passo = "foto";
        if (process.env.FOTO_DEBUG) console.error(nome + sufixo, Date.now() - t0 + " ms");
        await nav.avaliar("document.fonts.ready.then(() => true)");
        saida.telas[nome + sufixo] = { dom: limpar(await nav.avaliar(DOM)), estilo: await nav.avaliar(ESTILO), png: await nav.foto() };
        if (nav.erros.length) saida.erros[nome + sufixo] = [...nav.erros];
        clearTimeout(vigia);
      }
    }
  } finally { await nav.fechar(); await b.fim(); limparCaixa(caixa); }
  return saida;
}

export function comparar(a, b) {
  const dif = [];
  for (const k of new Set([...Object.keys(a.rotas), ...Object.keys(b.rotas)])) if (a.rotas[k] !== b.rotas[k]) dif.push(`rota ${k}`);
  for (const k of new Set([...Object.keys(a.telas), ...Object.keys(b.telas)])) {
    if (a.telas[k]?.dom !== b.telas[k]?.dom) dif.push(`tela ${k}: DOM`);
    if (a.telas[k]?.estilo !== b.telas[k]?.estilo) {
      const x = (a.telas[k]?.estilo || "").split("\n"), y = (b.telas[k]?.estilo || "").split("\n"); const i = x.findIndex((l, n) => l !== y[n]);
      dif.push(`tela ${k}: estilo (1º elemento diferente: ${i}\n    antes:  ${x[i]}\n    depois: ${y[i]})`);
    }
  }
  return dif;
}
export function avisos(a, b) {
  const av = [];
  for (const k of Object.keys(a.telas)) if (a.telas[k]?.png !== b.telas[k]?.png && a.telas[k]?.dom === b.telas[k]?.dom && a.telas[k]?.estilo === b.telas[k]?.estilo) av.push(k);
  return av;
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--comparar") {
    const [a, b] = process.argv.slice(3).map((f) => JSON.parse(readFileSync(f, "utf8")));
    const d = comparar(a, b);
    const av = avisos(a, b);
    console.log(d.length ? `✗ ${d.length} diferença(s):\n` + d.join("\n") : `✓ idênticas: ${Object.keys(a.telas).length} telas (conteúdo e estilo de cada elemento) e ${Object.keys(a.rotas).length} rotas`
      + (av.length ? `\n  (imagem com pixel diferente, mesmo conteúdo e estilo — olhar: ${av.join(", ")})` : ""));
    process.exit(d.length ? 1 : 0);
  }
  const s = await fotografar();
  writeFileSync(process.argv[2] || "fotografia.json", JSON.stringify(s));
  console.log(`fotografia: ${Object.keys(s.telas).length} telas, ${Object.keys(s.rotas).length} rotas, erros de JS em ${Object.keys(s.erros).length} tela(s)`, s.erros);
}
