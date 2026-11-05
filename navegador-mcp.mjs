#!/usr/bin/env node
/**
 * O navegador dos agentes como servidor MCP (stdio), para QUALQUER motor (Claude, Codex, Gemini/agy, opencode).
 * Não abre Chrome nenhum: repassa cada ferramenta ao board (/api/navegador/*), que é quem tem o navegador, confere a
 * aprovação das ações de risco e registra quem fez o quê. Zero dependência: JSON-RPC 2.0, uma mensagem por linha.
 *
 *   claude mcp add board-navegador -- node ~/Documents/DEV/board/navegador-mcp.mjs
 *   codex:  [mcp_servers.board-navegador] command = "node", args = ["…/board/navegador-mcp.mjs"]
 *
 * Variáveis: BOARD_URL (padrão http://127.0.0.1:4488) · BOARD_NAVEGADOR_QUEM (nome no registro; padrão = o cliente MCP).
 */
import { createInterface } from "node:readline";

const BASE = process.env.BOARD_URL || "http://127.0.0.1:4488";
let quem = process.env.BOARD_NAVEGADOR_QUEM || "";

const alvo = { seletor: { type: "string", description: "seletor CSS do elemento" }, texto: { type: "string", description: "texto visível do botão/link (alternativa ao seletor)" } };
// A trava é a REDE: toda requisição que publica, envia, paga, apaga (POST/PUT/PATCH/DELETE ou GET com cara de ação)
// para até o SIM do dono. Qualquer ferramenta que faça a página mandar algo aceita o SIM.
const aprov = {
  aprovacao: { type: "string", description: "id da aprovação do dono (12 hex) — sem ela, toda requisição de escrita ou de ação que a página tentar é BARRADA na rede" },
  pedido: { type: "string", description: "o texto exato do PEDIDO DE SIM que o dono aprovou na Central (tem de dizer a ação e o site)" },
};
const TOOLS = [
  { name: "navegador_abrir", description: "Abre um endereço http(s) no navegador dos agentes (Chrome próprio, já logado nas contas do dono). Leitura é livre; endereço com cara de ação (delete, logout, publicar…) precisa do SIM.", inputSchema: { type: "object", properties: { url: { type: "string" }, ...aprov }, required: ["url"] } },
  { name: "navegador_ler", description: "Lê a página aberta: texto + lista de controles (modo texto) ou a árvore acessível (modo arvore). Livre.", inputSchema: { type: "object", properties: { modo: { type: "string", enum: ["texto", "arvore"] } } } },
  { name: "navegador_clicar", description: "Clica num elemento (seletor CSS ou texto visível). O clique acontece; o que ele fizer a página MANDAR (formulário, fetch, link, beacon, navegação) passa pela rede: escrita ou ação sem o SIM do dono é barrada e a resposta diz QUAL requisição parou (RECUSADO).", inputSchema: { type: "object", properties: { ...alvo, ...aprov } } },
  { name: "navegador_preencher", description: "Preenche um campo (seletor CSS ou rótulo/placeholder) com um valor.", inputSchema: { type: "object", properties: { seletor: alvo.seletor, rotulo: { type: "string", description: "rótulo, placeholder ou aria-label do campo" }, valor: { type: "string" }, ...aprov }, required: ["valor"] } },
  { name: "navegador_subir", description: "Anexa arquivo(s) da máquina num campo de arquivo (input type=file) da página. Sem seletor, usa o primeiro campo de arquivo. Se a página já enviar o arquivo ao escolher (upload), isso é escrita: precisa do SIM.", inputSchema: { type: "object", properties: { seletor: alvo.seletor, arquivos: { type: "array", items: { type: "string" }, description: "caminhos absolutos" }, ...aprov }, required: ["arquivos"] } },
  { name: "navegador_esperar", description: "Espera um seletor ou um texto aparecer na página (até 60 s), ou só espera ms.", inputSchema: { type: "object", properties: { seletor: alvo.seletor, texto: { type: "string" }, ms: { type: "number" } } } },
  { name: "navegador_captura", description: "Tira uma captura de tela da página aberta (PNG).", inputSchema: { type: "object", properties: {} } },
];

async function chamar(nome, args) {
  const acao = nome.replace(/^navegador_/, "");
  const r = await fetch(`${BASE}/api/navegador/${acao}${acao === "captura" ? "?png=1" : ""}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...args, quem: quem || "mcp" }) });
  const d = await r.json().catch(() => ({ error: "resposta inválida do board" }));
  if (!r.ok) return { isError: true, content: [{ type: "text", text: (d.recusado ? "RECUSADO: " : "erro: ") + (d.error || r.status) }] };
  if (acao === "captura") { const { png, ...resto } = d; return { content: [{ type: "image", data: png, mimeType: "image/png" }, { type: "text", text: JSON.stringify(resto) }] }; }
  return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
}

const enviar = (m) => process.stdout.write(JSON.stringify(m) + "\n");
async function tratar(m) {
  const { id, method, params = {} } = m;
  if (method === "initialize") {
    if (!quem) quem = String(params.clientInfo?.name || "mcp") + " (mcp)";
    return enviar({ jsonrpc: "2.0", id, result: { protocolVersion: params.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "board-navegador", version: "1.0.0" } } });
  }
  if (method === "tools/list") return enviar({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  if (method === "tools/call") {
    if (!TOOLS.some((t) => t.name === params.name)) return enviar({ jsonrpc: "2.0", id, error: { code: -32602, message: "ferramenta não existe: " + params.name } });
    try { return enviar({ jsonrpc: "2.0", id, result: await chamar(params.name, params.arguments || {}) }); }
    catch (e) { return enviar({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "o board está fora do ar? " + e.message }] } }); }
  }
  if (method === "ping") return enviar({ jsonrpc: "2.0", id, result: {} });
  if (id !== undefined) enviar({ jsonrpc: "2.0", id, error: { code: -32601, message: "método não existe: " + method } });
}

const rl = createInterface({ input: process.stdin });
let pendentes = 0, fim = false;
rl.on("line", (l) => {
  if (!l.trim()) return;
  let m; try { m = JSON.parse(l); } catch { return enviar({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON inválido" } }); }
  pendentes++; tratar(m).finally(() => { if (--pendentes === 0 && fim) process.exit(0); });
});
rl.on("close", () => { fim = true; if (!pendentes) process.exit(0); });
