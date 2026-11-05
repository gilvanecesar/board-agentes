// Test harness: an ISOLATED board (own folder, own data/, own HOME, own port) with fake CLIs.
// Nothing here touches the real board (port 4488), the real data/ or the real ~ — and no real agent runs.
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync, realpathSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { vigiarProcesso, vigiarPasta, soltarPasta } from "./vigia.mjs";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Where the board code under test comes from (default: this repo). The mutation check points it at a sabotaged copy.
const FONTE = process.env.BOARD_TESTE_FONTE || REPO;
export const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// The fake `claude`: reads the script ($HOME/cenario.json), logs every call ($HOME/chamadas.jsonl) and answers in
// stream-json like the real CLI. The role comes from the prompt the board builds (reviewer/QA/usage/size check).
const FALSO_CLAUDE = `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const H = process.env.HOME, a = process.argv.slice(2);
const arg = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : undefined; };
// Permission prompt tool (#232), like the real CLI: starts the MCP server named in --permission-prompt-tool from
// --mcp-config, calls the tool with {tool_name, input, tool_use_id} and reads the JSON text it answers.
const pedirPermissao = (pedido) => new Promise((ok) => {
  const ferr = arg("--permission-prompt-tool"); if (!ferr) return ok({ behavior: "deny", message: "sem --permission-prompt-tool" });
  const [, srv, tool] = ferr.split("__"); const cfg = JSON.parse(arg("--mcp-config")).mcpServers[srv];
  const cp = require("child_process").spawn(cfg.command, cfg.args || [], { env: { ...process.env, ...(cfg.env || {}) }, stdio: ["pipe", "pipe", "inherit"] });
  let b = ""; cp.stdout.on("data", (d) => { b += d; for (const l of b.split("\\n").slice(0, -1)) { const m = JSON.parse(l); if (m.id === 2) { cp.kill(); ok(JSON.parse(m.result.content[0].text)); } } b = b.split("\\n").pop(); });
  cp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }) + "\\n");
  cp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: { tool_name: pedido.tool_name, input: pedido.input || {}, tool_use_id: "toolu_falso" } } }) + "\\n");
});
// Conversation mode: ONE live process, one message per stdin line (like the real CLI with --input-format stream-json).
if (a.includes("--input-format")) {
  const cen = JSON.parse(fs.readFileSync(path.join(H, "cenario.json"), "utf8"));
  const cp = path.join(H, "processos-conversa"); fs.writeFileSync(cp, String((fs.existsSync(cp) ? Number(fs.readFileSync(cp, "utf8")) : 0) + 1));
  const sid = arg("--resume") || "sessao-conversa-" + process.pid; let total = 0, buf = "";
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  let vez = Promise.resolve();
  process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue; vez = vez.then(() => turno(l)); } });
  const turno = async (l) => {
    const msg = JSON.parse(l).message.content[0].text; const conta = path.join(H, "conta-conversa");
    const n = fs.existsSync(conta) ? Number(fs.readFileSync(conta, "utf8")) : 0; fs.writeFileSync(conta, String(n + 1));
    fs.appendFileSync(path.join(H, "chamadas.jsonl"), JSON.stringify({ papel: "conversa", n, args: a, cwd: process.cwd(), quem: process.env.BOARD_QUEM, msg, t: Date.now() }) + "\\n");
    const lista = (cen.conversa || ["ok"]).map((x) => typeof x === "string" ? { texto: x } : x); const item = lista[Math.min(n, lista.length - 1)]; let txt = item.texto;
    if (item.dorme) { const fim = Date.now() + item.dorme; while (Date.now() < fim) { /* segura a resposta, como um agente pensando */ } }
    if (a.includes("--replay-user-messages")) out({ type: "user", session_id: sid, message: { role: "user", content: [{ type: "text", text: msg }] } });
    total += 0.02; out({ type: "system", subtype: "init", session_id: sid });
    let negadas = [];
    // "pede": the CLI asks the permission tool and WAITS; "barra": the auto-mode classifier already said no (real text).
    if (item.pede) { const r = await pedirPermissao(item.pede); fs.appendFileSync(path.join(H, "chamadas.jsonl"), JSON.stringify({ papel: "permissao", r, t: Date.now() }) + "\\n"); txt += " [" + r.behavior + (r.message ? ": " + r.message : "") + "]"; }
    if (item.barra && !(arg("--allowedTools") || "").split(",").includes(item.barra.regra)) {
      out({ type: "assistant", session_id: sid, message: { content: [{ type: "tool_use", id: "toolu_barra" + n, name: item.barra.tool_name, input: item.barra.input }] } });
      out({ type: "user", session_id: sid, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_barra" + n, is_error: true, content: "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [" + (item.barra.motivo || "Git Destructive") + "]. If you have other tasks that don't depend on this action, continue working on those." }] } });
      negadas = [{ tool_name: item.barra.tool_name, tool_use_id: "toolu_barra" + n, tool_input: item.barra.input }];
    } else if (item.barra) txt = "rodei: " + item.barra.input.command;
    out({ type: "assistant", session_id: sid, message: { content: [{ type: "text", text: txt }] } });
    out({ type: "result", session_id: sid, result: txt, total_cost_usd: total, num_turns: 1, duration_ms: 3, permission_denials: negadas }); };
  process.stdin.on("end", () => process.exit(0));
  // Com --name a sessão tem caixa de entrada (como o CLI real): registra-se em ~/.claude/sessions e cada linha nova de
  // $HOME/inbox-<nome>.jsonl ({de, texto, resposta, dorme}) é OUTRA SESSÃO escrevendo — acorda o agente sem stdin,
  // no formato real (command_lifecycle → user repetido → assistant → result → completed).
  const nome = arg("--name");
  if (nome) {
    const sd = path.join(H, ".claude", "sessions"); fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(path.join(sd, process.pid + ".json"), JSON.stringify({ pid: process.pid, name: nome, cwd: process.cwd(), entrypoint: "sdk-cli", kind: "interactive", status: "idle" }));
    const cx = path.join(H, "inbox-" + nome + ".jsonl"); let lidas = 0;
    setInterval(() => {
      if (!fs.existsSync(cx)) return;
      const L = fs.readFileSync(cx, "utf8").split("\\n").filter(Boolean);
      for (; lidas < L.length; lidas++) {
        const m = JSON.parse(L[lidas]);
        fs.appendFileSync(path.join(H, "chamadas.jsonl"), JSON.stringify({ papel: "central-acordou", de: m.de, t: Date.now() }) + "\\n");
        out({ type: "command_lifecycle", state: "started", session_id: sid });
        if (a.includes("--replay-user-messages")) out({ type: "user", session_id: sid, message: { role: "user", content: 'Another Claude session sent a message:\\n<cross-session-message from="uds:/tmp/x.sock" from-name="' + m.de + '" from-mode="prompting">\\n' + m.texto + '\\n</cross-session-message>\\n\\nThis came from another Claude session.' } });
        if (m.dorme) { const fim = Date.now() + m.dorme; while (Date.now() < fim) { /* pensando */ } }
        total += 0.01;
        out({ type: "assistant", session_id: sid, message: { content: [{ type: "text", text: m.resposta || "relato ao dono" }] } });
        out({ type: "result", session_id: sid, result: m.resposta || "relato ao dono", total_cost_usd: total, num_turns: 1, duration_ms: 3 });
        out({ type: "command_lifecycle", state: "completed", session_id: sid });
      }
    }, 150);
  }
  return;
}
const prompt = arg("-p") || "";
const papel = prompt === "/usage" ? "uso" : /^Revise a tarefa/.test(prompt) ? "revisor" : /^Teste a entrega/.test(prompt) ? "qa"
  : /Classifique o PORTE/.test(prompt) ? "porte" : /parecem REPETIDAS/.test(prompt) ? "juntar" : "agente";
const cen = JSON.parse(fs.readFileSync(path.join(H, "cenario.json"), "utf8"));
const conta = path.join(H, "conta-" + papel);
const n = fs.existsSync(conta) ? Number(fs.readFileSync(conta, "utf8")) : 0;
fs.writeFileSync(conta, String(n + 1));
fs.appendFileSync(path.join(H, "chamadas.jsonl"), JSON.stringify({ papel, n, args: a, cwd: process.cwd(), quem: process.env.BOARD_QUEM, semFundo: process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, t: Date.now() }) + "\\n");
if (papel === "uso") { console.log(JSON.stringify({ type: "result", result: cen.usoClaude || "", total_cost_usd: 0, num_turns: 0 })); process.exit(0); }
if (papel === "porte") { console.log(JSON.stringify({ result: cen.porte || "leve", total_cost_usd: 0.001 })); process.exit(0); }
if (papel === "juntar") { console.log(JSON.stringify({ result: cen.juntar || "NAO_JUNTAR: assuntos diferentes", total_cost_usd: 0.03 })); process.exit(0); }
const lista = (cen[papel] || [{ texto: papel === "agente" ? "feito" : "APROVADO" }]).map((x) => typeof x === "string" ? { texto: x } : x);
// An item with "quando" answers the prompt it matches; the others answer in call order.
const porPedido = lista.find((x) => x.quando && new RegExp(x.quando).test(prompt));
const seq = lista.filter((x) => !x.quando);
const passo = porPedido || seq[Math.min(n, seq.length - 1)] || { texto: "feito" };
const sid = arg("--resume") || "sessao-" + papel + "-" + n + "-" + process.pid;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (passo.semSessao) process.exit(1); // morre antes de abrir sessão, como um motor que nem começou
out({ type: "system", subtype: "init", session_id: sid });
const fim = () => {
  for (const e of [].concat(passo.escreve || [])) { fs.writeFileSync(path.join(process.cwd(), e.arquivo), e.conteudo ?? "x\\n");
    out({ type: "assistant", session_id: sid, message: { content: [{ type: "tool_use", name: "Write", input: { file_path: e.arquivo } }] } }); }
  if (passo.apaga) fs.rmSync(path.join(process.cwd(), passo.apaga), { force: true });
  if (passo.altera) fs.writeFileSync(path.join(process.cwd(), passo.altera.arquivo), passo.altera.conteudo); // por comando: sem Write no stream
  out({ type: "assistant", session_id: sid, message: { content: [{ type: "text", text: passo.texto || "" }] } });
  out({ type: "result", session_id: sid, is_error: !!passo.erro, result: passo.texto || "", total_cost_usd: passo.custo ?? 0.01, num_turns: 1, duration_ms: 5,
    ...(passo.negado ? { permission_denials: [{ tool_name: "Edit", tool_use_id: "x", tool_input: { file_path: path.join(process.cwd(), passo.negado) } }] } : {}) });
  // Como o CLI com tarefa em segundo plano: o turno fecha e o processo fica vivo. "depois" abre outro turno; "preso" espera até ser cortado.
  if (passo.depois) out({ type: "result", session_id: sid, is_error: false, result: passo.depois, total_cost_usd: 0.01, num_turns: 1, duration_ms: 5 });
  if (passo.preso) return void setInterval(() => {}, 1000);
  process.exit(passo.codigo || 0);
};
const comeca = () => passo.dorme ? setTimeout(fim, passo.dorme) : fim();
if (passo.pede) pedirPermissao(passo.pede).then((r) => { fs.appendFileSync(path.join(H, "chamadas.jsonl"), JSON.stringify({ papel: "permissao", r, t: Date.now() }) + "\\n"); passo.texto = (passo.texto || "feito") + " [" + r.behavior + "]"; comeca(); });
else comeca();
`;

// The other engines, speaking the REAL formats (taken from the board's raw logs of real Codex and Gemini runs, and from
// the opencode binary itself for `run --format json`). Same scenario file: cenario.codex / cenario.gemini / cenario.opencode.
const FALSO_MOTOR = `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const H = process.env.HOME, a = process.argv.slice(2), bin = path.basename(process.argv[1]);
const motor = { codex: "codex", agy: "gemini", opencode: "opencode" }[bin];
const arg = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : undefined; };
if (bin === "agy" && a[0] === "models") process.exit(0);
if (bin === "opencode" && a[0] === "models") process.exit(0);
const prompt = bin === "codex" ? a[a.length - 1] : bin === "agy" ? arg("-p") : a[a.length - 1];
if (prompt === "/usage") {
  const c = JSON.parse(fs.readFileSync(path.join(H, "cenario.json"), "utf8"));
  if (bin === "agy" && c.usoGemini) { console.log(JSON.stringify({ conversation_id: "x", status: "SUCCESS", response: c.usoGemini, num_turns: 0, command: "/usage" })); process.exit(0); }
  process.exit(1);
}
const papel = /^Revise a tarefa/.test(prompt.split("\\n\\n---\\n\\n").pop()) ? "revisor" : /^Teste a entrega/.test(prompt.split("\\n\\n---\\n\\n").pop()) ? "qa" : "agente";
const resume = bin === "codex" ? (a[1] === "resume" ? a[a.length - 2] : undefined) : bin === "agy" ? arg("--conversation") : arg("-s");
const cen = JSON.parse(fs.readFileSync(path.join(H, "cenario.json"), "utf8"));
const conta = path.join(H, "conta-" + motor + "-" + papel);
const n = fs.existsSync(conta) ? Number(fs.readFileSync(conta, "utf8")) : 0; fs.writeFileSync(conta, String(n + 1));
fs.appendFileSync(path.join(H, "chamadas.jsonl"), JSON.stringify({ papel, motor, n, args: a, cwd: process.cwd(), t: Date.now() }) + "\\n");
// cenario.codex = the agent's answers; cenario["codex:revisor"] / ["codex:qa"] = the reviewer's/QA's (default: APROVADO).
const lista = (cen[motor + ":" + papel] || (papel === "agente" ? cen[motor] : null) || [{ texto: papel === "agente" ? "feito" : "APROVADO" }]).map((x) => typeof x === "string" ? { texto: x } : x);
const p = lista[Math.min(n, lista.length - 1)];
const sid = resume || ({ codex: "01a0c9ec-6650-7061-9c3e-", gemini: "ecd6b494-85b4-47ad-bfd2-", opencode: "ses_f27101d88ffe" }[motor] + process.pid);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (p.escreve) fs.writeFileSync(path.join(process.cwd(), p.escreve.arquivo), p.escreve.conteudo ?? "x\\n");
const arq = p.escreve ? path.join(process.cwd(), p.escreve.arquivo) : null;
if (bin === "codex") {
  out({ type: "thread.started", thread_id: sid });
  out({ type: "turn.started" });
  out({ type: "item.completed", item: { id: "item_0", type: "command_execution", command: "/bin/zsh -lc 'cat CLAUDE.md'", aggregated_output: "# demo", exit_code: 0, status: "completed" } });
  if (arq) out({ type: "item.completed", item: { id: "item_1", type: "file_change", changes: [{ path: arq, kind: "add" }], status: "completed" } });
  if (p.erro) { out({ type: "error", message: p.erro }); out({ type: "turn.failed", error: { message: p.erro } }); process.exit(1); }
  out({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: p.texto } });
  out({ type: "turn.completed", usage: { input_tokens: 54710, cached_input_tokens: 34176, output_tokens: 269, reasoning_output_tokens: 19 } });
} else if (bin === "agy") {
  out({ event: "init", conversation_id: sid, init: { cwd: process.cwd(), tools: ["view_file", "replace_file_content"] } });
  out({ event: "step_update", step_update: { conversation_id: sid, step_index: 0, state: "DONE", step_type: "user_input" } });
  out({ event: "step_update", step_update: { conversation_id: sid, step_index: 1, state: "DONE", step_type: "tool", tool_name: "view_file", tool_info: { name: "view_file", parameters: { AbsolutePath: path.join(process.cwd(), "CLAUDE.md") }, output: "1 lines" } } });
  if (arq) out({ event: "step_update", step_update: { conversation_id: sid, step_index: 2, state: "DONE", step_type: "tool", tool_name: "replace_file_content", tool_info: { name: "replace_file_content", parameters: { TargetFile: arq } } } });
  for (const pedaco of (p.texto || "").match(/.{1,7}/gs) || []) out({ event: "step_update", step_update: { conversation_id: sid, step_index: 3, state: "ACTIVE", step_type: "agent_response", text_delta: pedaco } });
  out({ event: "step_update", step_update: { conversation_id: sid, step_index: 3, state: "DONE", step_type: "agent_response", usage: { input_tokens: 12740, output_tokens: 502, total_tokens: 13242 } } });
  out({ event: "result", result: p.erro
    ? { conversation_id: sid, status: "ERROR", response: "", error: p.erro, num_turns: 4, usage: { input_tokens: 1203220, output_tokens: 65576, total_tokens: 1268796 } }
    : { conversation_id: sid, status: "SUCCESS", response: "", num_turns: 1, usage: { input_tokens: 42753, output_tokens: 666, total_tokens: 43419 } } });
} else {
  const env = (type, extra) => out({ type, timestamp: Date.now(), sessionID: sid, ...extra });
  env("step_start", { part: { type: "step-start", sessionID: sid } });
  env("tool_use", { part: { type: "tool", tool: "read", callID: "call-1", sessionID: sid, state: { status: "completed", input: { filePath: path.join(process.cwd(), "CLAUDE.md") }, output: "# demo", title: "CLAUDE.md" } } });
  if (arq) env("tool_use", { part: { type: "tool", tool: "write", callID: "call-2", sessionID: sid, state: { status: "completed", input: { filePath: arq }, title: p.escreve.arquivo } } });
  if (p.erro) { env("error", { error: { name: "APIError", data: { message: p.erro, statusCode: 429, isRetryable: false } } }); process.exit(1); }
  env("text", { part: { type: "text", text: p.texto, sessionID: sid, time: { start: 1, end: 2 } } });
  env("step_finish", { part: { type: "step-finish", reason: "stop", sessionID: sid, tokens: { total: 30257, input: 292, output: 13, reasoning: 0, cache: { write: 0, read: 29952 } }, cost: 0.0123 } });
}
process.exit(0);
`;

// The memory server: logs every call and does to the MIRROR what the real one would do to the memory (delete/write a page),
// so the board sees the result the next time it reads. "status" and anything else: not here.
const FALSO_AI_MEMORY = `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
if (process.env.FALSO_HOME) process.env.HOME = process.env.FALSO_HOME; // pelo sudo falso, o comando fixo troca o HOME
const a = process.argv.slice(2); const arg = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : undefined; };
fs.appendFileSync(path.join(process.env.HOME, "ai-memory.log"), JSON.stringify(a) + "\\n");
if (a[0] === "--data-dir") a.splice(0, 2); // o comando fixo do sudo passa a pasta antes do verbo
// #259: com "ai-memory-403", o token comum também leva 403 no delete-page/write-page (como no Atena), com a linha de log
// colorida que o CLI real escreve antes do erro; como root (pelo sudo falso), passa.
if ((a[0] === "delete-page" || a[0] === "write-page") && process.env.FALSO_ROOT !== "1" && fs.existsSync(path.join(process.env.HOME, "ai-memory-403"))) {
  console.error("\\x1b[2m2026-10-29T20:02:22Z\\x1b[0m \\x1b[32m INFO\\x1b[0m ai_memory_cli: ai-memory starting version=2.4.0\\nError: deleting page via server\\n\\nCaused by:\\n    POST /admin/delete-page: server returned 403 Forbidden: {\\"error\\":\\"admin operation is root-only in multi-user mode\\"}");
  process.exit(1);
}
const arq = () => path.join(process.env.BOARD_ESPELHO_MEMORIA, arg("--project"), arg("--path"));
if (a[0] === "delete-page") { if (!fs.existsSync(arq())) { console.error("page not found"); process.exit(1); } fs.rmSync(arq()); process.exit(0); }
// #246: "ai-memory-403" = o token de usuário comum recebe 403 no status; como root (pelo sudo falso), o ai-memory-status-root.txt.
if (a.includes("status") && process.env.FALSO_ROOT === "1" && fs.existsSync(path.join(process.env.HOME, "ai-memory-status-root.txt"))) { process.stdout.write(fs.readFileSync(path.join(process.env.HOME, "ai-memory-status-root.txt"), "utf8")); process.exit(0); }
if (a[0] === "status" && fs.existsSync(path.join(process.env.HOME, "ai-memory-403"))) { console.error('Error: GET /admin/status: server returned 403 Forbidden: {"error":"admin operation is root-only in multi-user mode"}'); process.exit(1); }
if (a[0] === "status" && fs.existsSync(path.join(process.env.HOME, "ai-memory-status.txt"))) { process.stdout.write(fs.readFileSync(path.join(process.env.HOME, "ai-memory-status.txt"), "utf8")); process.exit(0); }
if (a[0] === "write-page") { fs.mkdirSync(path.dirname(arq()), { recursive: true }); fs.writeFileSync(arq(), "---\\nname: x\\n---\\n" + arg("--body")); process.exit(0); }
process.exit(1);
`;

// The server (ssh) and the Drive (rclone) answer with what the test left in $HOME (ssh-saida.txt, rclone.json); without it,
// "not here" — exactly like the server being down.
const FALSO_SSH = `#!/bin/sh
[ -f "$HOME/ssh-saida.txt" ] && { cat "$HOME/ssh-saida.txt"; exit 0; }
echo "ssh: connect to host: Connection refused" >&2; exit 255
`;
const FALSO_RCLONE = `#!/usr/bin/env node
const fs = require("fs"), path = require("path"); const a = process.argv.slice(2);
const f = path.join(process.env.HOME, "rclone.json"); if (!fs.existsSync(f)) { console.error("didn't find section in config file"); process.exit(1); }
const drive = JSON.parse(fs.readFileSync(f, "utf8")); const pasta = (a.find((x) => x.startsWith("gdrive_backup:")) || "").slice(14);
const lista = drive[pasta]; if (!lista) { console.error("directory not found"); process.exit(3); }
if (a[0] === "size") console.log(JSON.stringify({ count: lista.length, bytes: lista.reduce((s, x) => s + x.Size, 0) }));
else console.log(JSON.stringify(lista.map((x) => ({ IsDir: false, ...x }))));
`;

// sudo (#246): anota cada chamada em $HOME/sudo.log; só roda o comando (como "root": FALSO_ROOT=1) com $HOME/sudo-ok —
// sem ele, "password is required", como num servidor sem sudo livre. Nunca chega ao sudo de verdade.
const FALSO_SUDO = `#!/bin/sh
echo "sudo $*" >> "$HOME/sudo.log"
[ -f "$HOME/sudo-ok" ] || { echo "sudo: a password is required" >&2; exit 1; }
while [ "\${1#-}" != "$1" ]; do [ "$1" = "-u" ] && shift; shift; done
FALSO_ROOT=1 FALSO_HOME="$HOME" exec "$@"
`;
// tailscale/curl/pgrep/systemctl (#246): respondem com o que o teste deixou em $HOME; sem isso, "não está aqui"
// (o curl para localhost sem resposta anotada vai ao curl de verdade: é o board da própria caixa).
const FALSO_TAILSCALE = `#!/bin/sh
f="$HOME/tailscale-$1.json"; [ "$1" = serve ] && f="$HOME/tailscale-serve.json"
[ -f "$f" ] && { cat "$f"; exit 0; }; echo "failed to connect to local tailscaled" >&2; exit 1
`;
const FALSO_CURL = `#!/bin/sh
for x in "$@"; do u="$x"; done
f="$HOME/curl-$(echo "$u" | tr -c 'A-Za-z0-9\n' '_').txt"; [ -f "$f" ] && { cat "$f"; exit 0; }
case "$u" in http://localhost:*|http://127.0.0.1:*) for c in /usr/bin/curl /opt/homebrew/bin/curl; do [ -x "$c" ] && exec "$c" "$@"; done ;; esac  # o board da própria caixa
printf 000; exit 7
`;
const FALSO_PGREP = `#!/bin/sh
for x in "$@"; do p="$x"; done
case "$p" in *vigia*) f="$HOME/pgrep-vigia.txt" ;; *claude*) f="$HOME/pgrep-claude.txt" ;; *) f="" ;; esac
[ -n "$f" ] && [ -f "$f" ] && { cat "$f"; exit 0; }; exit 1
`;
const FALSO_SYSTEMCTL = `#!/bin/sh
[ -f "$HOME/systemctl.txt" ] && { cat "$HOME/systemctl.txt"; exit 0; }; echo inactive; exit 3
`;

// Everything else that could reach the outside world answers "not here".
const MUDOS = ["tmux", "osascript", "open", "ollama"];
// docker: the containers the test left in $HOME (docker-ps.txt / docker-stats.txt); without them, "daemon not running".
const FALSO_DOCKER = `#!/bin/sh
case "$1" in
  ps) [ -f "$HOME/docker-ps.txt" ] && { cat "$HOME/docker-ps.txt"; exit 0; } ;;
  stats) [ -f "$HOME/docker-stats.txt" ] && { cat "$HOME/docker-stats.txt"; exit 0; } ;;
esac
echo "Cannot connect to the Docker daemon. Is the docker daemon running?" >&2; exit 1
`;
const FALSO_GH = `#!/bin/sh
echo "gh $*" >> "$HOME/gh.log"
case "$1 $2" in
  "pr view") echo "board/1-teste" ;;
  "pr merge") [ -f "$HOME/gh-merge-falha" ] && { echo "merge recusado" >&2; exit 1; } ;;
  "pr list") st=open; repo=""; prev=""; for x in "$@"; do [ "$prev" = "--state" ] && st="$x"; [ "$prev" = "-R" ] && repo="$x"; prev="$x"; done
    f="$HOME/gh-prs-$(echo "$repo" | tr / _)-$st.json"; if [ -f "$f" ]; then cat "$f"; else echo "[]"; fi ;;
  "api "*) f="$HOME/gh-api-$(echo "$2" | tr '/?=&' '____').json"; if [ -f "$f" ]; then cat "$f"; else echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi ;;
esac
exit 0
`;

// Os arquivos de teste rodam em processos paralelos, e entre soltar a porta e o Chrome (ou o board) ocupá-la há uma janela.
// Duas partes com a mesma porta: o 2º Chrome não abre a dele e o teste liga no Chrome do outro ("Another locale override
// is already in effect", reproduzido em 31/10, #286); o 2º board cai e o teste fala com o board alheio. Por isso a porta é
// RESERVADA entre processos (mkdir falha se já existe) e vem de fora da faixa que o sistema usa em conexões de saída.
const PORTAS_RESERVADAS = join(tmpdir(), "board-teste-portas");
const RESERVA_MS = 30 * 60000; // reserva de bateria que já acabou (ou caiu) vence sozinha
function reservarPorta(p) {
  const marca = join(PORTAS_RESERVADAS, String(p));
  mkdirSync(PORTAS_RESERVADAS, { recursive: true });
  try { mkdirSync(marca); return true; } catch { /* outro processo reservou */ }
  try {
    if (Date.now() - statSync(marca).mtimeMs < RESERVA_MS) return false;
    rmSync(marca, { recursive: true, force: true });
    mkdirSync(marca);
    return true;
  } catch { return false; }
}
const estaLivre = (p) => new Promise((ok) => { const s = createServer(); s.once("error", () => ok(false)); s.listen(p, "127.0.0.1", () => s.close(() => ok(true))); });
export async function portaLivre() {
  for (let i = 0; i < 2000; i++) {
    const p = 20000 + Math.floor(Math.random() * 12000); // 20000-31999: abaixo das portas efêmeras do Linux e do Mac
    if (reservarPorta(p) && await estaLivre(p)) return p;
  }
  throw new Error("não achei porta livre para o teste");
}

const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A git project inside the sandbox's DEV folder. `check` = what `npm run check` does (the board's gate). */
export function criarProjeto(caixa, nome, { check = "node -e \"process.exit(require('fs').existsSync('quebrado.txt')?1:0)\"", origem = false } = {}) {
  const dir = join(caixa.dev, nome);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: nome, private: true, scripts: { check } }, null, 1));
  writeFileSync(join(dir, "CLAUDE.md"), `# ${nome}\n`);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "inicio");
  if (origem) {
    const nu = join(caixa.raiz, nome + ".git");
    execFileSync("git", ["clone", "-q", "--bare", dir, nu]);
    git(dir, "remote", "add", "origin", nu);
    git(dir, "fetch", "-q", "origin");
    git(dir, "remote", "set-head", "origin", "main");
  }
  return dir;
}

/** Builds the sandbox: a copy of the board's code, empty data/, fake HOME with the fake CLIs first in PATH. */
export function criarCaixa() {
  const raiz = realpathSync(mkdtempSync(join(tmpdir(), "board-teste-"))); // /var → /private/var no macOS
  vigiarPasta(raiz); // teste cortado no meio: o board da caixa, os filhos dele e a pasta vão junto
  const board = join(raiz, "board"), home = join(raiz, "home"), dev = join(raiz, "dev"), bin = join(home, ".local", "bin");
  for (const d of [board, home, dev, bin, join(board, "data")]) mkdirSync(d, { recursive: true });
  for (const f of ["board.mjs", "busca.mjs", "board-cli.mjs", "navegador-mcp.mjs", "permissao-mcp.mjs"]) if (existsSync(join(FONTE, f))) cpSync(join(FONTE, f), join(board, f));
  cpSync(join(FONTE, "web"), join(board, "web"), { recursive: true });
  if (existsSync(join(FONTE, "servidor"))) cpSync(join(FONTE, "servidor"), join(board, "servidor"), { recursive: true });
  const escreve = (nome, txt) => { writeFileSync(join(bin, nome), txt); chmodSync(join(bin, nome), 0o755); };
  escreve("claude", FALSO_CLAUDE);
  escreve("gh", FALSO_GH);
  for (const m of ["codex", "agy", "opencode"]) escreve(m, FALSO_MOTOR);
  escreve("ai-memory", FALSO_AI_MEMORY);
  escreve("ssh", FALSO_SSH);
  escreve("rclone", FALSO_RCLONE);
  escreve("docker", FALSO_DOCKER);
  escreve("sudo", FALSO_SUDO);
  escreve("tailscale", FALSO_TAILSCALE);
  escreve("curl", FALSO_CURL);
  escreve("pgrep", FALSO_PGREP);
  escreve("systemctl", FALSO_SYSTEMCTL);
  for (const m of MUDOS) escreve(m, "#!/bin/sh\nexit 1\n");
  const caixa = { raiz, board, home, dev, bin, cenario: (c) => writeFileSync(join(home, "cenario.json"), JSON.stringify(c)) };
  caixa.cenario({});
  return caixa;
}

export function envDaCaixa(caixa, extra = {}) {
  const env = {
    PATH: `${caixa.bin}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: caixa.home, TMPDIR: tmpdir(), LANG: "en_US.UTF-8",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
    BOARD_PROJETOS: caixa.dev, BOARD_SEM_ROTINAS: "1", BOARD_CLASSIFICAR: "0", BOARD_ROMANEIO: "0",
    BOARD_NAVEGADOR_ARGS: "--mute-audio --disable-audio-output", // Chrome de verdade na caixa não toca nas caixas de som
    BOARD_BUSCA_PROVEDOR: "lexico", BOARD_LOG_CRU: "0", BOARD_RETENTATIVAS: "0", BOARD_PRODUCAO: "", BOARD_PR_VIGIA_S: "0",
    BOARD_ESPELHO_MEMORIA: join(caixa.raiz, "memoria"),
    ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}), // cobertura dos boards da caixa (avaliação)
    // Some readings call the REAL binaries (/opt/homebrew/bin comes first in their PATH): point them at nothing,
    // so the sandbox never reads the owner's containers, Drive or memory server.
    DOCKER_HOST: "unix:///nao-existe/docker.sock", RCLONE_CONFIG: join(caixa.raiz, "sem-rclone.conf"),
    AI_MEMORY_SERVER_URL: "http://127.0.0.1:9", AI_MEMORY_AUTH_TOKEN: "",
    ...extra,
  };
  for (const k of Object.keys(env)) if (env[k] === null) delete env[k]; // null = "fora do ambiente" (vale o board.env)
  return env;
}

/** Starts the isolated board and waits until it answers. Returns { url, api, fim, ... }. */
export async function subirBoard(caixa, extra = {}, { nodeArgs = [] } = {}) {
  const porta = await portaLivre();
  const cp = spawn(process.execPath, [...nodeArgs, "board.mjs"], { cwd: caixa.board, env: envDaCaixa(caixa, { BOARD_PORT: String(porta), ...extra }), stdio: ["ignore", "pipe", "pipe"] });
  vigiarProcesso(cp);
  let saida = ""; cp.stdout.on("data", (d) => (saida += d)); cp.stderr.on("data", (d) => (saida += d));
  const url = `http://127.0.0.1:${porta}`;
  for (let i = 0; i < 100; i++) {
    try { await fetch(url + "/api/state"); break; } catch { await esperar(100); }
    if (cp.exitCode !== null) throw new Error("o board não subiu:\n" + saida);
  }
  const api = async (metodo, rota, corpo) => {
    const r = await fetch(url + rota, { method: metodo, headers: corpo ? { "content-type": "application/json" } : {}, body: corpo ? JSON.stringify(corpo) : undefined });
    const txt = await r.text(); let json = null; try { json = JSON.parse(txt); } catch { /* não é JSON */ }
    return { status: r.status, json, txt, headers: r.headers };
  };
  const fim = async () => {
    if (cp.exitCode === null) { cp.kill("SIGTERM"); for (let i = 0; i < 50 && cp.exitCode === null; i++) await esperar(100); }
    if (cp.exitCode === null) cp.kill("SIGKILL");
  };
  return { url, porta, cp, api, fim, saida: () => saida };
}

/** Waits for a task to reach one of the statuses (the runner ticks every 1.5 s). */
export async function esperarStatus(b, id, status, limite = 20000) {
  const alvo = [].concat(status); const t0 = Date.now(); let t;
  while (Date.now() - t0 < limite) {
    t = (await b.api("GET", `/api/tasks/${id}`)).json?.task;
    if (t && alvo.includes(t.status) && !t.busy) return t;
    await esperar(200);
  }
  throw new Error(`a tarefa #${id} não chegou em ${alvo.join("/")} (está ${t?.status}, etapa ${t?.etapa})\n${b.saida().slice(-3000)}`);
}

export const chamadas = (caixa) => existsSync(join(caixa.home, "chamadas.jsonl"))
  ? readFileSync(join(caixa.home, "chamadas.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.papel !== "uso")
  : [];

export const limparCaixa = (caixa) => { try { rmSync(caixa.raiz, { recursive: true, force: true }); soltarPasta(caixa.raiz); } catch { /* temp: a vigia tenta de novo quando o teste sair */ } };

/**
 * A fake embeddings server (ollama's /api/embed): each text becomes a vector with one dimension per CONCEPT (regex), so
 * "same meaning, other words" is decided by the test, not by a real model. Counts the texts it embedded.
 */
export async function servidorDeSentido(conceitos) {
  const { createServer: criar } = await import("node:http");
  const estado = { textos: 0, pedidos: 0 };
  const vetor = (t) => { const s = String(t).toLowerCase(); return [0.05, ...conceitos.map((rx) => (s.match(new RegExp(rx, "g")) || []).length)]; };
  const srv = criar((req, res) => {
    let corpo = ""; req.on("data", (d) => (corpo += d)); req.on("end", () => {
      const d = JSON.parse(corpo || "{}"); const lista = [].concat(d.input || []);
      estado.pedidos++; estado.textos += lista.length;
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ model: d.model, embeddings: lista.map(vetor) }));
    });
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${srv.address().port}`, estado, fechar: () => new Promise((ok) => srv.close(ok)) };
}
