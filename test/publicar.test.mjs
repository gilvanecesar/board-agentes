// 🚀 Publicar por projeto (#205): versão no ar × main, PRs mesclados que ainda não subiram, e o botão que SÓ o dono clica.
// Comando FALSO (echo/sleep na caixa), `gh api` falso e um "app no ar" falso servido aqui — nada de produção.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createServer } from "node:http";
import { writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { criarCaixa, criarProjeto, subirBoard, limparCaixa, esperar, esperarStatus, REPO } from "./ajuda.mjs";
import { abrirNavegador, CHROME } from "./navegador.mjs";

let atual = [];
afterEach(async () => { for (const [b, c, app] of atual) { await b?.fim(); limparCaixa(c); app?.close(); } atual = []; });

const sha = (p) => (p + "0".repeat(40)).slice(0, 40);
const C3 = sha("a3b3c3d"), C2 = sha("a2b2c2d"), C1 = sha("a1b1c1d"), C0 = sha("c0ffee1");
const COMMITS = [
  { sha: C3, commit: { message: "Coisa nova (#14)\n\ncorpo", committer: { date: "2026-10-27T10:00:00Z" } } },
  { sha: C2, commit: { message: "Outra coisa (#13)", committer: { date: "2026-10-26T10:00:00Z" } } },
  { sha: C1, commit: { message: "ajuste direto na main", committer: { date: "2026-10-25T10:00:00Z" } } },
  { sha: C0, commit: { message: "Base (#10)", committer: { date: "2026-10-20T10:00:00Z" } } },
];

/** O "app no ar": uma página que carrega um bundle com o hash embutido (como o selo do admin). Troca para a main
 *  quando o comando falso deixa a marca $HOME/publicou.txt — é assim que a conferência depois vê a versão nova. */
async function appNoAr(home) {
  const s = createServer((req, res) => {
    const hash = existsSync(join(home, "publicou.txt")) ? C3.slice(0, 7) : C0.slice(0, 7);
    if (req.url === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(`<html><script type="module" src="/assets/app-x1.js"></script></html>`); }
    if (req.url === "/assets/app-x1.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(`const a="deadbeefcafe";const sel={sha:"${hash}",v:"1.2.3"};`); }
    res.writeHead(404); res.end();
  });
  await new Promise((ok) => s.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${s.address().port}/`, close: () => s.close() };
}

async function preparar({ config, env = {}, cenario } = {}) {
  const caixa = criarCaixa();
  for (const p of ["alfa", "beta"]) criarProjeto(caixa, p);
  execFileSync("git", ["-C", join(caixa.dev, "alfa"), "remote", "add", "origin", "git@github.com:dono/alfa.git"]);
  writeFileSync(join(caixa.board, "data", "projetos.json"), JSON.stringify({ visiveis: ["alfa", "beta"], rotulos: { alfa: "Alfa" } }));
  writeFileSync(join(caixa.home, "gh-api-repos_dono_alfa_commits_per_page_50.json"), JSON.stringify(COMMITS));
  const app = await appNoAr(caixa.home);
  if (config) writeFileSync(join(caixa.board, "data", "publicar.json"), JSON.stringify(config(app.url)));
  if (cenario) caixa.cenario(cenario);
  const fila = [null, caixa, app]; atual.push(fila); // o app no ar fecha mesmo se o board não subir
  const b = fila[0] = await subirBoard(caixa, { BOARD_PUBLICAR_CONFERIR_S: "0.3", BOARD_PUBLICAR_CONFERIR_TENTATIVAS: "4", ...env });
  return { caixa, b, app };
}
/** POST como o navegador manda (com o Origin do board). */
const clicar = (b, slug, corpo, origem = b.url) => fetch(`${b.url}/api/publicar/${slug}`, { method: "POST",
  headers: { "content-type": "application/json", ...(origem ? { origin: origem } : {}) }, body: JSON.stringify(corpo) })
  .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
async function esperarFim(b, slug, limite = 20000) {
  const t0 = Date.now(); let s;
  while (Date.now() - t0 < limite) { s = (await b.api("GET", `/api/publicar/${slug}`)).json; if (!s.rodando && s.ultima && !s.ultima.emAndamento && (s.ultima.ok === false || s.ultima.conferido || !s.conferir)) return s; await esperar(200); }
  throw new Error("a publicação não terminou: " + JSON.stringify(s) + "\n" + b.saida().slice(-2000));
}

test("data/publicar.json nasce vazio: nada publicável, o botão não roda e o deploy.json não liga isso", async () => {
  const { caixa, b } = await preparar();
  writeFileSync(join(caixa.board, "data", "deploy.json"), JSON.stringify({ alfa: "touch $HOME/publicou.txt" }));
  assert.deepEqual(JSON.parse(readFileSync(join(caixa.board, "data", "publicar.json"), "utf8")), {});
  const d = (await b.api("GET", "/api/publicar")).json;
  assert.deepEqual(d.projetos.map((p) => [p.slug, p.configurado]), [["alfa", false], ["beta", false]]);
  assert.deepEqual((await b.api("GET", "/api/state")).json.publicaveis, []);
  const r = await clicar(b, "alfa", { confirmo: "touch $HOME/publicou.txt" });
  assert.equal(r.status, 400); assert.match(r.json.error, /data\/publicar\.json/);
  assert.equal(existsSync(join(caixa.home, "publicou.txt")), false);
});

test("status: versão no ar achada no bundle × main, e os PRs mesclados que ainda não subiram", async () => {
  const { b } = await preparar({ config: (url) => ({ alfa: { comando: "echo oi", conferir: url } }) });
  const s = (await b.api("GET", "/api/publicar/alfa")).json;
  assert.equal(s.configurado, true);
  assert.equal(s.noAr.hash, C0.slice(0, 7), JSON.stringify(s.noAr));
  assert.equal(s.noAr.fonte, "pagina");
  assert.equal(s.main.hash, C3.slice(0, 7));
  assert.deepEqual(s.pendentes.prs.map((x) => x.numero), [14, 13]);
  assert.equal(s.pendentes.n, 2); assert.equal(s.pendentes.semPr, 1); assert.equal(s.pendentes.fonte, "no-ar");
  assert.equal(s.emDia, false);
  assert.deepEqual(s.pasta, { branch: "main", sujos: 0 });
  assert.deepEqual((await b.api("GET", "/api/state")).json.publicaveis, ["alfa"]);
});

test("app que não diz a versão: 'não sei', nunca um número inventado", async () => {
  const { b } = await preparar({ config: () => ({ alfa: { comando: "echo oi", conferir: "http://127.0.0.1:9/" } }) });
  const s = (await b.api("GET", "/api/publicar/alfa")).json;
  assert.equal(s.noAr.hash, null); assert.match(s.noAr.erro, /não consegui ler/);
  assert.equal(s.pendentes, null); assert.match(s.pendentesMotivo, /não sei qual versão está no ar/);
});

test("Publicar: só com o Origin da tela e o comando confirmado; uma por vez; log ao vivo, quem/quando, confere no ar e anota na tarefa", async () => {
  const comando = 'echo subindo; pwd > "$HOME/publicou.txt"; sleep 1; echo pronto';
  const { caixa, b } = await preparar({
    config: (url) => ({ alfa: { comando, conferir: url } }),
    env: { BOARD_DONO: "Dono Teste" },
    cenario: { agente: [{ texto: "abri https://github.com/dono/alfa/pull/14" }] },
  });
  const [t] = (await b.api("POST", "/api/tasks", { text: "tarefa do PR 14", project: "alfa", queue: true })).json.tasks;
  await esperarStatus(b, t.id, ["executada", "erro"], 25000);

  assert.equal((await clicar(b, "alfa", { confirmo: comando }, null)).status, 403, "sem Origin (CLI, curl de agente) não");
  assert.equal((await clicar(b, "alfa", { confirmo: comando }, "http://outro.site")).status, 403);
  const errado = await clicar(b, "alfa", { confirmo: "echo outro" });
  assert.equal(errado.status, 409); assert.match(errado.json.error, /mudou desde a confirmação/);
  assert.equal(existsSync(join(caixa.home, "publicou.txt")), false, "nada rodou antes do clique certo");

  const r = await clicar(b, "alfa", { confirmo: comando });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  assert.deepEqual(r.json.prs, [14, 13]);
  const dup = await clicar(b, "alfa", { confirmo: comando });
  assert.equal(dup.status, 409); assert.match(dup.json.error, /já há uma publicação/);

  const s = await esperarFim(b, "alfa");
  assert.equal(s.ultima.ok, true); assert.equal(s.ultima.conferido.ok, true);
  assert.match(s.ultima.quem, /Dono Teste \(clique na tela\)/);
  assert.equal(readFileSync(join(caixa.home, "publicou.txt"), "utf8").trim(), join(caixa.dev, "alfa"), "roda na pasta do projeto");
  const evs = (await b.api("GET", "/api/publicar/alfa/log")).json.events;
  const ini = evs.find((e) => e.t === "inicio");
  assert.equal(ini.comando, comando); assert.match(ini.texto, /Dono Teste \(clique na tela\) clicou em Publicar Alfa/); assert.ok(ini.at);
  assert.match(evs.filter((e) => e.t === "saida").map((e) => e.texto).join(""), /subindo[\s\S]*pronto/);
  assert.equal(evs.find((e) => e.t === "fim").status, "publicado");
  assert.match(evs.find((e) => e.t === "conferido").texto, /✓ no ar: a3b3c3d/);
  const st = (await b.api("GET", "/api/publicar/alfa?fresco")).json;
  assert.equal(st.emDia, true); assert.equal(st.pendentes.n, 0);
  const tarefa = (await b.api("GET", `/api/tasks/${t.id}`)).json.task;
  assert.equal(tarefa.publicado.conferido, true);
  assert.equal(tarefa.publicado.mainSha, s.ultima.mainSha, "a tarefa guarda o sha que subiu (#244: o selo da ficha confere contra ele)");
  assert.match(tarefa.publicado.mainSha, /^a3b3c3d/);
  const log = (await b.api("GET", `/api/tasks/${t.id}/log`)).json.events.map((e) => e.texto || "").join("\n");
  assert.match(log, /🚀 PR #14 publicado por Dono Teste \(clique na tela\).*conferido no ar/);
});

test("teto de tempo: o comando é morto com o grupo e a publicação fica em erro, dizendo por quê", async () => {
  const comando = 'echo começou; sleep 4; touch "$HOME/tarde.txt"';
  const { caixa, b } = await preparar({ config: () => ({ alfa: { comando } }), env: { BOARD_PUBLICAR_TIMEOUT_MIN: "0.02" } });
  assert.equal((await clicar(b, "alfa", { confirmo: comando })).status, 202);
  const s = await esperarFim(b, "alfa");
  assert.equal(s.ultima.ok, false); assert.match(s.ultima.motivo, /passou de .* min/);
  await esperar(4500);
  assert.equal(existsSync(join(caixa.home, "tarde.txt")), false, "o sleep morreu junto");
  const fim = (await b.api("GET", "/api/publicar/alfa/log")).json.events.find((e) => e.t === "fim");
  assert.equal(fim.status, "erro");
});

test("nunca sozinho: só a rota HTTP chama publicar(); esteira, fila, tarefas e CLI não", () => {
  for (const f of readdirSync(join(REPO, "servidor"))) {
    const src = readFileSync(join(REPO, "servidor", f), "utf8");
    const imp = src.match(/import\s*\{([^}]*)\}\s*from\s*"\.\/publicar\.mjs"/);
    if (!imp) continue;
    const nomes = imp[1].split(",").map((x) => x.trim());
    if (f === "http.mjs") continue;
    assert.ok(!nomes.includes("publicar"), `${f} não pode chamar publicar()`);
  }
  assert.doesNotMatch(readFileSync(join(REPO, "board-cli.mjs"), "utf8"), /api\/publicar/);
});

test("tela: o bloco 🚀 no menu Pull Requests mostra no ar × main, confirma com o comando e mostra o log ao vivo", { skip: !CHROME && "sem Chrome nesta máquina" }, async () => {
  const comando = 'echo subindo; touch "$HOME/publicou.txt"; sleep 1; echo pronto';
  const { b } = await preparar({ config: (url) => ({ alfa: { comando, conferir: url } }) });
  const nav = await abrirNavegador();
  try {
    await nav.carregar(b.url + "/#/prs");
    await nav.quieto();
    let txt = "";
    for (let i = 0; i < 50 && !/não publicado/.test(txt); i++) { await esperar(200); txt = await nav.avaliar("document.querySelector('#prsLista')?.innerText || ''"); }
    assert.match(txt, /No ar: c0ffee1[\s\S]*main: a3b3c3d[\s\S]*2 PRs mesclados não publicados\s+#14\s+#13/);
    assert.match(txt, /Publicar desligado/, "beta sem comando diz como ligar");
    await nav.avaliar(`document.querySelector('[data-publicar="alfa"]').click()`);
    for (let i = 0; i < 60 && !/no ar: a3b3c3d/.test(txt); i++) { await esperar(250); txt = await nav.avaliar("document.querySelector('#prsLista')?.innerText || ''"); }
    assert.match(nav.dialogos.join("\n"), /PUBLICAR Alfa EM PRODUÇÃO\?[\s\S]*\$ echo subindo[\s\S]*#14 Coisa nova[\s\S]*#13 Outra coisa/);
    assert.match(txt, /subindo[\s\S]*pronto[\s\S]*✓ no ar: a3b3c3d/);
    assert.deepEqual(nav.erros, []);
  } finally { await nav.fechar(); }
});
