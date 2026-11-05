// O board rodando NO Atena (BOARD_SERVIDOR=local, #246): Monitoramento e Controle mostrando a realidade de lá.
// (a) o ai-memory responde 403 "root-only" ao token de usuário comum: lido por sudo fixo, e sem sudo "no ar, sem os números";
// (b) o Drive pelo rclone do root (sudo -n, só leitura); (c) motor sem binário = "não instalado nesta máquina", não vermelho;
// (d) o mapa com o board, a Central, a robo e o CRM no Atena e o Mac como reserva; (f) o cartão da robo.
// #255: o espelho da memória NO servidor (~/Memoria/ai-memory, timer memoria-espelho) alimenta o menu Memória e o Controle.
import { test, afterEach } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, readFileSync, rmSync, mkdirSync, existsSync, utimesSync, readdirSync, statSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { criarCaixa, criarProjeto, subirBoard, limparCaixa, esperar } from "./ajuda.mjs";

let atual = [];
afterEach(async () => { for (const [b, c, nav] of atual) { if (nav) await nav.fechar(); await b.fim(); limparCaixa(c); } atual = []; });

const STATUS_ROOT = "ai-memory 2.4.0 (server)\n  pages:        739 (all versions: 1281)\n  sessions:     6402\n  observations: 69132\n  spool:\n    pending:    0\n  ingest (server, this process):\n    last write: 7s\n";
const SERVE = { TCP: { 443: { HTTPS: true }, 8443: { HTTPS: true }, 8444: { HTTPS: true } }, AllowFunnel: { "atena.ts.net:443": true },
  Web: { "atena.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:39001" } } }, "atena.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:49374" } } },
    "atena.ts.net:8444": { Handlers: { "/": { Proxy: "http://127.0.0.1:4488" } } } } };
const STATUS_TS = { Peer: { a: { HostName: "funnel-ingress-node", OS: "", Online: true }, b: { HostName: "MacBook", DNSName: "macbook.ts.net.", OS: "macOS", Online: true, TailscaleIPs: ["100.1.2.3"] } } };
const chave = (u) => u.replace(/[^A-Za-z0-9]/g, "_");

/** Uma caixa "Atena": só o Claude instalado, ai-memory com 403 para o usuário, tailscale serve, CRM, Mac e a robo. */
async function atena({ sudo = true, env = {}, antes } = {}) {
  const caixa = criarCaixa();
  criarProjeto(caixa, "demo");
  for (const m of ["codex", "agy", "opencode"]) rmSync(join(caixa.bin, m)); // (c) não instalados nesta máquina
  const h = caixa.home, url = "http://127.0.0.1:49374";
  writeFileSync(join(h, ".ai-memory-env.sh"), `export AI_MEMORY_SERVER_URL="${url}"\n`);
  writeFileSync(join(h, ".claude.json"), JSON.stringify({ mcpServers: { "ai-memory": { url } } }));
  mkdirSync(join(h, ".claude"), { recursive: true });
  writeFileSync(join(h, ".claude", "settings.json"), JSON.stringify({ hooks: { x: url } }));
  writeFileSync(join(h, "ai-memory-403"), "");
  writeFileSync(join(h, "ai-memory-status-root.txt"), STATUS_ROOT);
  if (sudo) writeFileSync(join(h, "sudo-ok"), "");
  writeFileSync(join(h, "rclone.json"), JSON.stringify({ "": [], "board-backup": [{ Name: "board.json", Size: 10, ModTime: "2026-10-29T03:31:00Z" }] }));
  writeFileSync(join(h, "tailscale-status.json"), JSON.stringify(STATUS_TS));
  writeFileSync(join(h, `curl-${chave("http://127.0.0.1:39001")}.txt`), "200");
  writeFileSync(join(h, `curl-${chave("https://macbook.ts.net/api/usage")}.txt`), "200");
  // a robo: pasta com o last do vigia, tmux "robo" vivo, vigia e claude rodando, serviço robo-tmux ativo
  const robo = join(caixa.raiz, "atendimento"); mkdirSync(robo);
  writeFileSync(join(robo, "last"), "28001\n");
  utimesSync(join(robo, "last"), new Date("2026-10-29T12:17:07Z"), new Date("2026-10-29T12:17:07Z"));
  writeFileSync(join(caixa.bin, "tmux"), `#!/bin/sh\n[ "$1 $3" = "has-session robo" ] && exit 0; exit 1\n`);
  writeFileSync(join(h, "pgrep-vigia.txt"), "4242\n");
  writeFileSync(join(h, "pgrep-claude.txt"), "4241\n");
  writeFileSync(join(h, "systemctl.txt"), "active\n");
  // o transcrito da robo: um ./qf-enviar barrado (não conta) e um que deu certo (é a hora do último envio)
  const tr = join(h, ".claude", "projects", robo.replace(/[^A-Za-z0-9]/g, "-")); mkdirSync(tr, { recursive: true });
  const uso = (id, ts, cmd) => JSON.stringify({ timestamp: ts, message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: cmd } }] } });
  const res = (id, ts, erro) => JSON.stringify({ timestamp: ts, message: { content: [{ type: "tool_result", tool_use_id: id, is_error: erro, content: "x" }] } });
  writeFileSync(join(tr, "s.jsonl"), [uso("t1", "2026-10-29T11:00:00Z", "printf 'oi' | ./qf-enviar 451"), res("t1", "2026-10-29T11:00:01Z", false),
    uso("t2", "2026-10-29T12:15:52Z", "printf 'olá' | ./qf-enviar 452"), res("t2", "2026-10-29T12:15:53Z", true)].join("\n") + "\n");
  if (antes) antes(h, caixa);
  const b = await subirBoard(caixa, { BOARD_SERVIDOR: "local", BOARD_ROBO_PASTA: robo, ...env });
  // o serve leva a 8444 à porta do board DA CAIXA (sorteada): só se sabe depois de subir — a 1ª leitura é no 1º GET
  writeFileSync(join(h, "tailscale-serve.json"), JSON.stringify(SERVE).replace("127.0.0.1:4488", "127.0.0.1:" + new URL(b.url).port));
  const item = [b, caixa, null]; atual.push(item);
  return { caixa, b, item };
}
async function ate(fn, limite = 20000) { const t0 = Date.now(); let v; while (Date.now() - t0 < limite) { v = await fn(); if (v) return v; await esperar(200); } return v; }
const monitoramento = (b) => ate(async () => { const x = (await b.api("GET", "/api/monitoring")).json; return x.timestamp && x.noSaturno && x; });

test("Atena (a)(b)(c)(f): ai-memory pelo sudo fixo, Drive pelo rclone do root, motores 'não instalado' e o que roda lá", async () => {
  const { caixa, b } = await atena();
  const mon = await monitoramento(b);
  assert.ok(mon, "a leitura de fundo terminou");
  // (a) o token comum leva 403; o sudo fixo lê os números — e o servidor no ar não é "Offline"
  assert.equal(mon.aiMemory.online, true);
  assert.equal(mon.aiMemory.pages, 739);
  assert.equal(mon.aiMemory.via, "sudo");
  // (b) o Drive pelo rclone do root
  assert.equal(mon.googleDrive.online, true, "rclone lsd pelo sudo -n");
  // só comandos FIXOS de leitura passaram pelo sudo
  const sudo = readFileSync(join(caixa.home, "sudo.log"), "utf8").trim().split("\n");
  for (const l of sudo) assert.match(l, /^sudo -n (-u ai-memory sh -c AI_MEMORY_AUTH_TOKEN=.* exec ai-memory --data-dir \/var\/lib\/ai-memory status|rclone (lsd|size|lsjson) )/, l);
  // (c) só o Claude existe nesta máquina
  const ms = Object.fromEntries(mon.aiMemory.motores.map((m) => [m.nome, m]));
  assert.equal(ms["Claude Code"].instalado, true);
  for (const n of ["Codex", "Gemini (agy)", "opencode"]) assert.equal(ms[n].instalado, false, n);
  // (d) o que roda no Atena
  const ns = mon.noSaturno;
  assert.equal(mon.local, true);
  assert.deepEqual(ns.serve.map((p) => [p.porta, p.papel]), [[443, "CRM (Funnel, público)"], [8443, "ai-memory"], [8444, "board"]]);
  assert.equal(ns.board.tailnet, 8444);
  assert.equal(ns.crm.online, true);
  assert.deepEqual({ online: ns.mac.online, board: ns.mac.board, endereco: ns.mac.endereco }, { online: true, board: true, endereco: "https://macbook.ts.net" });
  assert.equal(mon.mac.online, true, "o Mac é lido pela tailnet, não 'online' de fábrica");
  // (f) a robo: tmux vivo, vigia rodando, o last, e o último ./qf-enviar QUE DEU CERTO (o barrado não conta)
  assert.equal(ns.robo.tmux, true); assert.equal(ns.robo.vigia, 1); assert.equal(ns.robo.servico, "active");
  assert.equal(ns.robo.last, "28001");
  assert.equal(ns.robo.lastEm, "2026-10-29T12:17:07.000Z");
  assert.equal(ns.robo.ultimoEnvio, "2026-10-29T11:00:00Z");
  // Controle: motores não instalados não viram "Motor sem memória"; o backup do board é o data/ daqui
  const ctl = await ate(async () => { const x = (await b.api("GET", "/api/controle")).json; return x.lidoEm && x.memoria && x; });
  assert.equal(ctl.memoria.online, true); assert.equal(ctl.memoria.paginas, 739, JSON.stringify({ ...ctl.memoria, recentes: 0 }));
  assert.ok(!ctl.alertas.some((a) => /Motor sem memória/.test(a.texto)), JSON.stringify(ctl.alertas));
  assert.ok(!ctl.alertas.some((a) => /cópia do board para o Atena/i.test(a.texto)), "no servidor não há cópia Mac → Atena a cobrar");
});

test("Atena sem sudo livre: o ai-memory aparece NO AR sem os números (não 'Offline'), e o Controle diz por quê", async () => {
  const { b } = await atena({ sudo: false });
  const mon = await monitoramento(b);
  assert.equal(mon.aiMemory.online, true, "403 = o servidor atendeu");
  assert.equal(mon.aiMemory.numeros, false);
  assert.match(mon.aiMemory.motivo, /root/);
  assert.equal(mon.googleDrive.online, false, "sem o rclone do root, o Drive fica sem leitura");
  assert.match(mon.googleDrive.aviso, /sudo -n pediu senha/);
  const ctl = await ate(async () => { const x = (await b.api("GET", "/api/controle")).json; return x.lidoEm && x.memoria && x; });
  assert.equal(ctl.memoria.online, true);
  assert.ok(ctl.alertas.some((a) => a.nivel === "aviso" && /no ar, mas sem os números/.test(a.texto)));
  assert.ok(!ctl.alertas.some((a) => /memória compartilhada não responde/.test(a.texto)), JSON.stringify(ctl.alertas));
  // #255: sem o timer memoria-espelho nesta máquina, o Controle diz que o menu Memória fica vazio
  assert.ok(ctl.alertas.some((a) => /espelho da memória não existe nesta máquina/.test(a.texto)), JSON.stringify(ctl.alertas));
  assert.match((await b.api("GET", "/api/memoria/grafo")).json.erro, /rode memoria-espelho/);
});

// ── #255: o espelho da memória no servidor ─────────────────────────────────────────────────────────────────────
const ESPELHAR = join(process.env.BOARD_TESTE_FONTE || join(fileURLToPath(import.meta.url), "..", ".."), "memoria", "servidor", "memoria-espelho");
const pagina = (dir, nome, txt) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, nome), txt); };

test("memoria-espelho: o wiki do ai-memory vira ~/Memoria/ai-memory/<projeto> como o memoria-obsidian do Mac", () => {
  const raiz = mkdtempSync(join(tmpdir(), "espelho-")), wiki = join(raiz, "wiki"), cofre = join(raiz, "Memoria");
  try {
    pagina(join(wiki, "ws1", "p1"), "_meta.md", "---\nproject: alfa\n---\n");
    pagina(join(wiki, "ws1", "p1"), "regra.md", "# Regra\nver [[decisao]]\n");
    pagina(join(wiki, "ws1", "p1", "decisions"), "decisao.md", "# Decisão\n");
    pagina(join(wiki, "ws1", "p1", "_lint"), "x.md", "lint");
    pagina(join(wiki, "ws2", "p2"), "_meta.md", "project: alfa\n");           // mesmo nome noutro workspace → alfa-2
    pagina(join(wiki, "ws2", "p2"), "outra.md", "# Outra\n");
    pagina(join(wiki, "ws2", "p3"), "_meta.md", "project: teste-captura\n");  // projeto de teste: fora
    pagina(join(wiki, "ws2", "p3"), "t.md", "t");
    pagina(join(wiki, "ws2", "p4"), "_meta.md", "project: ..\n");             // nome que sairia da pasta: fora
    pagina(join(wiki, "ws2", "p4"), "fuga.md", "x");
    pagina(join(cofre, "ai-memory", "velho"), "sumiu.md", "projeto que saiu do wiki");
    const env = { ...process.env, MEMORIA_SUDO: "", MEMORIA_WIKI: wiki, MEMORIA_COFRE: cofre, MEMORIA_CACHE: join(raiz, "cache") };
    const out = execFileSync("bash", [ESPELHAR], { env, encoding: "utf8" });
    assert.match(out, /espelho atualizado: 3 páginas/);
    assert.deepEqual(readdirSync(join(cofre, "ai-memory")).sort(), ["alfa", "alfa-2"]);
    assert.deepEqual(readdirSync(join(cofre, "ai-memory", "alfa")).sort(), ["decisions", "regra.md"], "sem _meta.md nem _lint/");
    assert.ok(existsSync(join(cofre, "ai-memory", "alfa-2", "outra.md")));
    assert.ok(existsSync(join(cofre, ".espelho-ok")), "a marca que o board lê");
    assert.equal(statSync(cofre).mode & 0o777, 0o700, "a memória tem texto do dono: só ele lê");
    // o wiki sumiu (ai-memory parado, sudo negado): falha alto e NÃO toca a marca
    utimesSync(join(cofre, ".espelho-ok"), new Date("2026-01-01"), new Date("2026-01-01"));
    const r = spawnSync("bash", [ESPELHAR], { env: { ...env, MEMORIA_WIKI: join(raiz, "nao-existe") }, encoding: "utf8" });
    assert.equal(r.status, 1); assert.match(r.stderr, /não consegui ler o wiki/);
    assert.equal(statSync(join(cofre, ".espelho-ok")).mtime.toISOString(), new Date("2026-01-01").toISOString());
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test("Atena #255: Memória e Controle leem o espelho de ~/Memoria (sem caminho do Mac) e o Controle cobra a idade dele", async () => {
  // a caixa NÃO passa BOARD_ESPELHO_MEMORIA: vale o padrão do servidor, ~/Memoria/ai-memory
  const { caixa, b } = await atena({ env: { BOARD_ESPELHO_MEMORIA: null }, antes: (h) => {
    const mes = new Date().toISOString().slice(0, 7), agora = new Date().toISOString();
    const esp = join(h, "Memoria", "ai-memory");
    pagina(join(esp, "_global"), "regra-do-dono.md", "---\nmetadata:\n  modified: 2026-10-29T10:00:00Z\n---\n# Regra do dono\nver [[decisao-atena]]\n");
    pagina(join(esp, "board", "decisions"), "decisao-atena.md", "---\nmetadata:\n  modified: 2026-10-28T10:00:00Z\n---\n# Board no Atena\n");
    pagina(join(esp, "board"), `log-${mes}.md`, `## [${agora}] user-prompt\n\n## [${agora}] tool-use\n`);
    writeFileSync(join(h, "Memoria", ".espelho-ok"), "");
  } });
  const g = (await b.api("GET", "/api/memoria/grafo")).json;
  assert.ok(!g.erro, g.erro);
  assert.deepEqual(g.nos.map((n) => n.chave).sort(), ["_global/regra-do-dono", "board/decisao-atena", `board/log-${new Date().toISOString().slice(0, 7)}`].sort());
  assert.deepEqual(g.ligacoes, [{ a: "_global/regra-do-dono", b: "board/decisao-atena" }]);
  const ctl = await ate(async () => { const x = (await b.api("GET", "/api/controle")).json; return x.lidoEm && x.memoria && x; });
  assert.equal(ctl.memoria.paginas, 739, "o status pelo sudo fixo");
  assert.deepEqual(ctl.memoria.recentes.map((x) => x.chave), ["_global/regra-do-dono", "board/decisao-atena"], "últimas memórias salvas, sem o log");
  assert.equal(ctl.memoria.captura[0].projeto, "board"); assert.equal(ctl.memoria.captura[0].pedidosHoje, 1);
  assert.equal(ctl.memoria.espelho.via, "memoria-espelho");
  assert.ok(!ctl.alertas.some((a) => /espelho/.test(a.texto)), JSON.stringify(ctl.alertas));
  // o timer parou há 2 h: o aviso aparece no pedido seguinte (é um stat, não espera a leitura de 1 min)
  const marca = join(caixa.home, "Memoria", ".espelho-ok"), velho = new Date(Date.now() - 2 * 3600000);
  utimesSync(marca, velho, velho);
  const a = await ate(async () => (await b.api("GET", "/api/controle")).json.alertas.find((x) => /espelho da memória .* está desatualizado/.test(x.texto)));
  assert.ok(a, "aviso de espelho parado"); assert.match(a.texto, /12\d min atrás/);
});

test("Atena #259: o Descartar do inventário passa pelo sudo FIXO quando o token leva 403 — e sem sudo o erro chega legível", async () => {
  const velha = (caixa) => pagina(join(caixa.raiz, "memoria", "demo", "sessions"), "velha.md", "---\nmetadata:\n  modified: 2026-09-01T10:00:00Z\n---\n# Sessão velha\nrotina\n");
  const { caixa, b } = await atena({ antes: (h, c) => velha(c) });
  assert.ok((await b.api("POST", "/api/memoria/inventario/rodar")).json.vencidas.some((v) => v.chave === "demo/velha"));
  const r = await b.api("POST", "/api/memoria/inventario/descartar", { chave: "demo/velha" });
  assert.equal(r.status, 200, r.txt);
  assert.ok(!existsSync(join(caixa.raiz, "memoria", "demo", "sessions", "velha.md")), "saiu da memória");
  const sudo = readFileSync(join(caixa.home, "sudo.log"), "utf8").trim().split("\n").filter((l) => /delete-page/.test(l));
  assert.equal(sudo.length, 1, "uma chamada pelo sudo");
  // o comando é o FIXO; projeto e caminho vão como argumentos posicionais, depois do script
  assert.match(sudo[0], /^sudo -n -u ai-memory sh -c AI_MEMORY_AUTH_TOKEN=.* exec ai-memory --data-dir \/var\/lib\/ai-memory delete-page --workspace default --project "\$1" --path "\$2" sh demo sessions\/velha\.md$/);

  const sem = await atena({ sudo: false, antes: (h, c) => velha(c) });
  await sem.b.api("POST", "/api/memoria/inventario/rodar");
  const e = await sem.b.api("POST", "/api/memoria/inventario/descartar", { chave: "demo/velha" });
  assert.equal(e.status, 500);
  assert.match(e.json.error, /root-only/, "o motivo de verdade, não a linha de log do CLI");
  assert.doesNotMatch(e.json.error, /INFO|\x1b/);
  assert.ok(existsSync(join(sem.caixa.raiz, "memoria", "demo", "sessions", "velha.md")), "nada sumiu");
  assert.ok((await sem.b.api("GET", "/api/memoria/inventario")).json.vencidas.some((v) => v.chave === "demo/velha"), "continua na lista");
});

// (d) na tela: o mapa do Monitoramento saiu em 04/11 (pedido do dono). Os dados que ele desenhava são conferidos pela
// rota em (a)(b)(c)(f), e o painel do monitor (painel.mjs) lê a mesma rota: test/painel-tty.test.mjs.

test("fora do servidor (o Mac) nada disso aparece: sem painel do Atena, board 'roda no Mac', nada de sudo", async () => {
  const caixa = criarCaixa(); criarProjeto(caixa, "demo");
  writeFileSync(join(caixa.home, "sudo-ok"), ""); writeFileSync(join(caixa.home, "ai-memory-403"), "");
  const b = await subirBoard(caixa); atual.push([b, caixa, null]);
  const mon = await ate(async () => { const x = (await b.api("GET", "/api/monitoring")).json; return x.timestamp && x; });
  assert.equal(mon.local, false); assert.equal(mon.noSaturno, null);
  assert.equal(mon.aiMemory.via, null, "no Mac o board não chama o sudo");
  assert.ok(!existsSync(join(caixa.home, "sudo.log")), "nenhuma chamada ao sudo");
  assert.ok(mon.aiMemory.motores.every((m) => m.instalado === true), "na caixa os 4 motores existem");
});
