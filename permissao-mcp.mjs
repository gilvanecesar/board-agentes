#!/usr/bin/env node
/**
 * A ferramenta de PERMISSÃO das sessões do board (#232), como servidor MCP (stdio). O board liga num `claude` com
 *   --mcp-config '{"mcpServers":{"board-permissao":{"command":"node","args":["…/permissao-mcp.mjs"],"env":{…}}}}'
 *   --permission-prompt-tool mcp__board-permissao__pedir
 * e o CLI chama `pedir` com {tool_name, input, tool_use_id} sempre que perguntaria a uma pessoa. Aqui não se decide
 * nada: o pedido vai ao board (POST /api/permissoes/pedido), que mostra o cartão ao dono e SEGURA a resposta até ele
 * clicar (ou vencer). A resposta volta como texto JSON — o formato que o CLI lê: {"behavior":"allow","updatedInput":…}
 * ou {"behavior":"deny","message":"…"}. Board fora do ar = negado (fail-closed).
 *
 * Variáveis: BOARD_URL (padrão http://127.0.0.1:4488) · BOARD_PERMISSAO_DE (JSON: {slug, tarefa?, papel} — quem pede).
 */
import { createInterface } from "node:readline";
import { request } from "node:http";

const BASE = process.env.BOARD_URL || "http://127.0.0.1:4488";
let de = {}; try { de = JSON.parse(process.env.BOARD_PERMISSAO_DE || "{}"); } catch { /* sem origem: o board recusa */ }

const TOOLS = [{
  name: "pedir",
  description: "Uso interno do board: é por aqui que o Claude Code pergunta ao dono se pode executar uma ação. Não chame diretamente.",
  inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } }, required: ["tool_name"] },
}];

// node:http, não fetch: o fetch do Node desiste de esperar os cabeçalhos em 5 min, e o pedido fica aberto até o dono
// responder (BOARD_PERMISSAO_MIN, 10 por padrão).
function postar(rota, corpo) {
  return new Promise((ok, bad) => {
    const u = new URL(rota, BASE), txt = JSON.stringify(corpo);
    const rq = request(u, { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(txt) } }, (r) => {
      let b = ""; r.setEncoding("utf8"); r.on("data", (d) => (b += d)); r.on("end", () => { try { ok({ status: r.statusCode, d: JSON.parse(b) }); } catch { ok({ status: r.statusCode, d: null }); } });
    });
    rq.on("error", bad); rq.end(txt);
  });
}

async function pedir(args) {
  try {
    const { status, d } = await postar("/api/permissoes/pedido", { de, tool_name: args.tool_name, input: args.input || {}, tool_use_id: args.tool_use_id || "" });
    if (d && (d.behavior === "allow" || d.behavior === "deny")) return d;
    return { behavior: "deny", message: "o board respondeu sem decisão: " + (d?.error || status) };
  } catch (e) { return { behavior: "deny", message: "o board está fora do ar — sem quem aprove, negado: " + e.message }; }
}

const enviar = (m) => process.stdout.write(JSON.stringify(m) + "\n");
async function tratar(m) {
  const { id, method, params = {} } = m;
  if (method === "initialize") return enviar({ jsonrpc: "2.0", id, result: { protocolVersion: params.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "board-permissao", version: "1.0.0" } } });
  if (method === "tools/list") return enviar({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  if (method === "tools/call") {
    if (params.name !== "pedir") return enviar({ jsonrpc: "2.0", id, error: { code: -32602, message: "ferramenta não existe: " + params.name } });
    const d = await pedir(params.arguments || {});
    return enviar({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(d) }] } });
  }
  if (method === "ping") return enviar({ jsonrpc: "2.0", id, result: {} });
  if (id !== undefined) enviar({ jsonrpc: "2.0", id, error: { code: -32601, message: "método não existe: " + method } });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (l) => {
  if (!l.trim()) return;
  let m; try { m = JSON.parse(l); } catch { return enviar({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON inválido" } }); }
  tratar(m);
});
// O claude fechou a entrada (parou, caiu): sai NA HORA, mesmo com pedido aberto — a conexão cai e o board tira o cartão
// (esperar a resposta aqui deixaria o dono clicando num pedido de uma sessão que não existe mais).
rl.on("close", () => process.exit(0));
