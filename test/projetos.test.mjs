// A seleção de projetos (data/projetos.json) e o projeto novo criado pela tela (23/10/2026).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync, lstatSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { criarCaixa, criarProjeto, subirBoard, esperarStatus, limparCaixa, chamadas, esperar } from "./ajuda.mjs";
import { abrirNavegador, CHROME } from "./navegador.mjs";

let atual = [];
afterEach(async () => { for (const [b, c] of atual) { await b.fim(); limparCaixa(c); } atual = []; });

async function preparar({ projetos = ["alfa", "beta", "gama"], catalogo, env = {}, cenario, mapa } = {}) {
  const caixa = criarCaixa();
  for (const p of projetos) criarProjeto(caixa, p);
  if (cenario) caixa.cenario(cenario);
  if (mapa) writeFileSync(join(caixa.dev, "CLAUDE.md"), mapa);
  if (catalogo) writeFileSync(join(caixa.board, "data", "projetos.json"), JSON.stringify(catalogo));
  const b = await subirBoard(caixa, env);
  atual.push([b, caixa]);
  return { caixa, b };
}
const selecao = async (b) => (await b.api("GET", "/api/state")).json.projects;

test("seleção: só os projetos de data/projetos.json, na ordem dele e com o nome da tela", async () => {
  const { b } = await preparar({ catalogo: { visiveis: ["gama", "alfa", "nao-existe"], rotulos: { gama: "Gama CRM" } } });
  assert.deepEqual(await selecao(b), [{ slug: "gama", label: "Gama CRM" }, { slug: "alfa", label: "alfa" }],
    "beta e DEV (raiz) ficam fora; pasta que não existe não aparece");
});

test("seleção: sem data/projetos.json aparecem todos (o comportamento de antes)", async () => {
  const { b } = await preparar();
  assert.deepEqual((await selecao(b)).map((p) => p.slug), ["DEV", "alfa", "beta", "gama"]);
});

test("projeto escondido da seleção continua rodando tarefa (a pasta dele não some do board)", async () => {
  const { b } = await preparar({ catalogo: { visiveis: ["alfa"] } });
  const [t] = (await b.api("POST", "/api/tasks", { text: "tarefa antiga", project: "beta", queue: true })).json.tasks;
  const fim = await esperarStatus(b, t.id, ["executada", "erro"]);
  assert.equal(fim.status, "executada", fim.error);
});

test("projeto novo: cria a pasta com CLAUDE.md e git, e já entra na seleção", async () => {
  const { caixa, b } = await preparar({ catalogo: { visiveis: ["alfa"] } });
  const r = await b.api("POST", "/api/projetos", { nome: "Cotação Ágil!", descricao: "Cotador de frete por WhatsApp." });
  assert.equal(r.status, 201);
  assert.deepEqual(r.json.projeto, { slug: "cotacao-agil", label: "Cotação Ágil!" });
  assert.equal(r.json.aviso, null);
  const dir = join(caixa.dev, "cotacao-agil");
  const claude = readFileSync(join(dir, "CLAUDE.md"), "utf8");
  assert.match(claude, /^# Cotação Ágil!\n\nCotador de frete por WhatsApp\./);
  assert.ok(existsSync(join(dir, ".gitignore")));
  assert.equal(execFileSync("git", ["-C", dir, "log", "--format=%s"], { encoding: "utf8" }).trim(), "Projeto criado pelo board");
  assert.deepEqual(await selecao(b), [{ slug: "alfa", label: "alfa" }, { slug: "cotacao-agil", label: "Cotação Ágil!" }]);
  const cat = JSON.parse(readFileSync(join(caixa.board, "data", "projetos.json"), "utf8"));
  assert.deepEqual(cat.visiveis, ["alfa", "cotacao-agil"]);
  // e a tarefa já roda nele
  const [t] = (await b.api("POST", "/api/tasks", { text: "primeira", project: "cotacao-agil", queue: true })).json.tasks;
  assert.equal((await esperarStatus(b, t.id, ["executada", "erro"])).status, "executada");
});

test("projeto novo: nome vazio, reservado ou pasta que já existe é recusado sem mexer em nada", async () => {
  const { caixa, b } = await preparar({ catalogo: { visiveis: ["alfa"] } });
  mkdirSync(join(caixa.dev, "pasta-solta"));
  assert.equal((await b.api("POST", "/api/projetos", { nome: "  " })).status, 400);
  assert.equal((await b.api("POST", "/api/projetos", { nome: "!!" })).status, 400);
  assert.equal((await b.api("POST", "/api/projetos", { nome: "node_modules" })).status, 400);
  const dup = await b.api("POST", "/api/projetos", { nome: "Alfa" });
  assert.equal(dup.status, 409);
  assert.match(dup.json.error, /já existe a pasta "alfa"/);
  assert.equal((await b.api("POST", "/api/projetos", { nome: "Pasta Solta" })).status, 409, "pasta sem git também conta");
  assert.ok(!existsSync(join(caixa.dev, "alfa", "CLAUDE.md.bak")));
  assert.equal(readFileSync(join(caixa.dev, "alfa", "CLAUDE.md"), "utf8"), "# alfa\n", "o projeto existente não foi tocado");
  assert.deepEqual(JSON.parse(readFileSync(join(caixa.board, "data", "projetos.json"), "utf8")).visiveis, ["alfa"]);
});

test("projeto novo sem identidade do git: cria a pasta e o repo, e AVISA que ficou sem commit (não inventa autor)", async () => {
  const vazio = { GIT_AUTHOR_NAME: "", GIT_AUTHOR_EMAIL: "", GIT_COMMITTER_NAME: "", GIT_COMMITTER_EMAIL: "" };
  const { caixa, b } = await preparar({ env: vazio });
  const r = await b.api("POST", "/api/projetos", { nome: "sem-autor" });
  assert.equal(r.status, 201);
  assert.match(r.json.aviso || "", /sem o commit inicial/);
  assert.ok(existsSync(join(caixa.dev, "sem-autor", ".git")));
});

test("tela: '＋ Novo projeto…' na seleção cria o projeto e já deixa ele escolhido", { skip: !CHROME && "sem Chrome nesta máquina" }, async () => {
  const { caixa, b } = await preparar({ catalogo: { visiveis: ["alfa", "beta"], rotulos: { beta: "Beta CRM" } } });
  const nav = await abrirNavegador();
  try {
    await nav.carregar(b.url + "/");
    await nav.quieto();
    const opcoes = () => nav.avaliar(`[...document.querySelectorAll("#proj option")].map((o) => o.textContent)`);
    assert.deepEqual(await opcoes(), ["alfa", "Beta CRM", "＋ Novo projeto…"]);
    await nav.avaliar(`window.prompt = (m) => /Nome/.test(m) ? "Projeto da Tela" : "criado pelo teste";
      const s = document.querySelector("#proj"); s.value = "__novo__"; s.dispatchEvent(new Event("change"));`);
    for (let i = 0; i < 50 && !(await opcoes()).includes("Projeto da Tela"); i++) await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(await opcoes(), ["alfa", "Beta CRM", "Projeto da Tela", "＋ Novo projeto…"]);
    assert.equal(await nav.avaliar(`document.querySelector("#proj").value`), "projeto-da-tela", "o projeto novo já fica escolhido para a próxima tarefa");
    assert.match(readFileSync(join(caixa.dev, "projeto-da-tela", "CLAUDE.md"), "utf8"), /criado pelo teste/);
    assert.deepEqual(nav.erros, []);
  } finally { await nav.fechar(); }
});

test("tela: projeto guardado no navegador que SAIU da seleção não prende o 💬 nele (26/10, #/c/crm)", { skip: !CHROME && "sem Chrome nesta máquina" }, async () => {
  const { b } = await preparar({ catalogo: { visiveis: ["alfa", "beta"] } });
  const nav = await abrirNavegador();
  try {
    await nav.carregar(b.url + "/");
    await nav.quieto();
    await nav.avaliar(`localStorage.setItem("board.project", '"gama"'); localStorage.setItem("board.filtro", '"gama"')`);
    await nav.avaliar(`[...document.querySelectorAll("#navigation .nav-item")].find((x) => /Conversas/.test(x.getAttribute("aria-label"))).click()`);
    await esperar(400);
    assert.equal(await nav.avaliar("location.hash"), "#/c/alfa", "abre o 1º da seleção, não o projeto que saiu");
    // quem chegar ao fio antigo (link, histórico) vê o motivo e os fios que existem — não um beco sem saída
    await nav.avaliar(`location.hash = "#/c/gama"`);
    await esperar(400);
    assert.match(await nav.avaliar(`document.querySelector("#app").innerText`), /"gama" não está na seleção[\s\S]*alfa[\s\S]*beta/);
    await nav.avaliar(`[...document.querySelectorAll(".conv-outros a")].find((a) => a.textContent === "beta").click()`);
    for (let i = 0; i < 25 && !(await nav.avaliar(`!!document.querySelector("#convProj")`)); i++) await esperar(200);
    assert.equal(await nav.avaliar("location.hash"), "#/c/beta");
    assert.equal(await nav.avaliar(`document.querySelector("#convProj").value`), "beta");
    assert.deepEqual(nav.erros, []);
  } finally { await nav.fechar(); }
});

const MAPA = "# Portfólio\n\n---\n\n## Projetos\n\n### 🚚 alfa — Alfa\nO primeiro.\n\n---\n\n## Convenções de ouro\n\n- regra\n";

test("projeto novo entra no MAPA do portfólio (DEV/CLAUDE.md), no fim da seção Projetos, pelo link", async () => {
  const caixa0 = criarCaixa();
  const alvo = join(caixa0.raiz, "PORTFOLIO.md");
  writeFileSync(alvo, MAPA);
  symlinkSync(alvo, join(caixa0.dev, "CLAUDE.md")); // como no dono: DEV/CLAUDE.md → repo-portfolio/PORTFOLIO.md
  criarProjeto(caixa0, "alfa");
  const b = await subirBoard(caixa0);
  atual.push([b, caixa0]);
  const r = await b.api("POST", "/api/projetos", { nome: "Cotação Ágil", descricao: "Cotador de frete por WhatsApp." });
  assert.equal(r.status, 201);
  assert.equal(r.json.aviso, null);
  const txt = readFileSync(alvo, "utf8");
  assert.ok(lstatSync(join(caixa0.dev, "CLAUDE.md")).isSymbolicLink(), "o link continua link");
  assert.match(txt, /### 🚚 alfa — Alfa\nO primeiro\.\n\n### 🆕 cotacao-agil — Cotação Ágil\nCotador de frete por WhatsApp\. Stack: a definir\. Criado pelo board em [\d/]+ \(pasta `cotacao-agil`[\s\S]*?\n\n---\n\n## Convenções de ouro\n\n- regra\n$/);
  // de novo com outro: entra depois do anterior, e sem frase não inventa nada
  await b.api("POST", "/api/projetos", { nome: "beta" });
  assert.match(readFileSync(alvo, "utf8"), /### 🆕 cotacao-agil[\s\S]*### 🆕 beta — beta\nO que é: ainda não descrito\. Stack: a definir\.[\s\S]*\n\n---\n\n## Convenções/);
});

test("sem mapa do portfólio o projeto nasce igual, sem aviso e sem criar o mapa", async () => {
  const { caixa, b } = await preparar();
  const r = await b.api("POST", "/api/projetos", { nome: "solo" });
  assert.equal(r.status, 201);
  assert.equal(r.json.aviso, null);
  assert.ok(!existsSync(join(caixa.dev, "CLAUDE.md")));
});

// ── Pasta errada: "falei do Loja estando no ERP" (23/10/2026) ──────────────────────────────
const tarefaDe = async (b, id) => (await b.api("GET", `/api/tasks/${id}`)).json.task;
async function ateQue(fn, limite = 10000) { const t0 = Date.now(); let v; while (Date.now() - t0 < limite) { v = await fn(); if (v) return v; await esperar(150); } return v; }
const MAPA2 = "# Portfólio\n\n## Projetos\n\n### 🚚 alfa — Alfa Fretes\nMarketplace de frete.\n\n### 📄 beta — Beta Fiscal\nEmissão de CT-e e MDF-e.\n\n---\n";

test("pasta errada: com certeza ALTA a tarefa NÃO roda e espera; 'mover' leva para o projeto certo e aí roda lá", async () => {
  const { caixa, b } = await preparar({ env: { BOARD_CLASSIFICAR: "1" }, catalogo: { visiveis: ["alfa", "beta"] }, mapa: MAPA2,
    cenario: { porte: '{"porte":"leve","projeto":"beta","certeza":"alta"}' } });
  const [t] = (await b.api("POST", "/api/tasks", { text: "corrigir a rejeição do CT-e", project: "alfa", queue: true })).json.tasks;
  const espera = await ateQue(async () => { const x = await tarefaDe(b, t.id); return x.projetoSugerido && x; });
  assert.deepEqual(espera.projetoSugerido, { slug: "beta", label: "beta" });
  // o classificador recebeu a lista de projetos com o resumo do mapa e o escolhido
  const p = chamadas(caixa).find((c) => c.papel === "porte").args;
  const prompt = p[p.indexOf("-p") + 1];
  assert.match(prompt, /- alfa \(alfa\): Marketplace de frete\.\n- beta \(beta\): Emissão de CT-e e MDF-e\.\nO dono abriu a tarefa no projeto "alfa"/);
  assert.match(prompt, /certeza alta = o texto cita algo que só existe em outro projeto/);
  await esperar(2500); // o runner anda a cada 1,5 s: não pode ter pegado
  assert.equal((await tarefaDe(b, t.id)).status, "fila");
  assert.ok(!chamadas(caixa).some((c) => c.papel === "agente"), "nada roda na pasta errada enquanto o dono não decide");
  const r = await b.api("POST", `/api/tasks/${t.id}/projeto`, { acao: "mover" });
  assert.equal(r.status, 200);
  const fim = await esperarStatus(b, t.id, ["executada", "erro"]);
  assert.equal(fim.status, "executada", fim.error);
  assert.equal(fim.project, "beta");
  assert.equal(chamadas(caixa).find((c) => c.papel === "agente").cwd, join(caixa.dev, "beta"), "rodou na pasta do projeto certo");
  assert.equal((await b.api("POST", `/api/tasks/${t.id}/projeto`, { acao: "mover" })).status, 400, "sem aviso, nada a resolver");
});

test("pasta errada: 'manter' roda onde o dono escolheu; certeza média nem avisa (aviso falso ensina a ignorar)", async () => {
  // o haiku de verdade devolve o slug em minúsculas ("erp" para "ERP"): tem de valer igual
  const { caixa, b } = await preparar({ env: { BOARD_CLASSIFICAR: "1" }, catalogo: { visiveis: ["alfa", "beta"] },
    cenario: { porte: '{"porte":"leve","projeto":"BETA","certeza":"Alta"}' } });
  const [t] = (await b.api("POST", "/api/tasks", { text: "x", project: "alfa", queue: true })).json.tasks;
  await ateQue(async () => (await tarefaDe(b, t.id)).projetoSugerido);
  assert.equal((await b.api("POST", `/api/tasks/${t.id}/projeto`, { acao: "manter" })).status, 200);
  const fim = await esperarStatus(b, t.id, ["executada", "erro"]);
  assert.equal(fim.project, "alfa");
  assert.equal(chamadas(caixa).find((c) => c.papel === "agente").cwd, join(caixa.dev, "alfa"));
  caixa.cenario({ porte: '{"porte":"leve","projeto":"beta","certeza":"media"}' });
  const [t2] = (await b.api("POST", "/api/tasks", { text: "y", project: "alfa", queue: true })).json.tasks;
  const fim2 = await esperarStatus(b, t2.id, ["executada", "erro"]);
  assert.equal(fim2.projetoSugerido ?? null, null);
  assert.equal(fim2.project, "alfa");
});

test("pasta errada: trocar o projeto na mão apaga o aviso; com UM projeto na seleção nem pergunta", async () => {
  const { b } = await preparar({ env: { BOARD_CLASSIFICAR: "1" }, catalogo: { visiveis: ["alfa", "beta"] }, cenario: { porte: '{"porte":"leve","projeto":"beta","certeza":"alta"}' } });
  const [t] = (await b.api("POST", "/api/tasks", { text: "x", project: "alfa" })).json.tasks;
  await ateQue(async () => (await tarefaDe(b, t.id)).projetoSugerido);
  await b.api("PATCH", `/api/tasks/${t.id}`, { project: "gama" });
  assert.equal((await tarefaDe(b, t.id)).projetoSugerido, null);
  const s = await preparar({ env: { BOARD_CLASSIFICAR: "1" }, catalogo: { visiveis: ["alfa"] }, cenario: { porte: "leve" } });
  const [u] = (await s.b.api("POST", "/api/tasks", { text: "x", project: "alfa", porte: "normal" })).json.tasks;
  assert.ok(!u.classificando, "porte escolhido e um projeto só: não há o que classificar");
});

test("conversa: a regra manda avisar quando o pedido é de OUTRO projeto (com a lista da seleção)", async () => {
  const { caixa, b } = await preparar({ env: { BOARD_CLASSIFICAR: "1" }, catalogo: { visiveis: ["alfa", "beta"], rotulos: { beta: "Beta Fiscal" } }, cenario: { conversa: ["ok"] } });
  await b.api("POST", "/api/conversa/alfa", { texto: "oi" });
  const c = await ateQue(async () => chamadas(caixa).find((x) => x.papel === "conversa"));
  const regras = c.args[c.args.indexOf("--append-system-prompt") + 1];
  assert.match(regras, /claramente de OUTRO projeto \(Beta Fiscal = beta\), NÃO mexa nesta pasta/);
});

test("tela: o aviso aparece na tarefa e 'Mover para…' resolve", { skip: !CHROME && "sem Chrome nesta máquina" }, async () => {
  const { b } = await preparar({ env: { BOARD_CLASSIFICAR: "1" }, catalogo: { visiveis: ["alfa", "beta"], rotulos: { beta: "Beta Fiscal" } },
    cenario: { porte: '{"porte":"leve","projeto":"beta","certeza":"alta"}' } });
  const [t] = (await b.api("POST", "/api/tasks", { text: "emitir CT-e", project: "alfa", queue: true })).json.tasks;
  await ateQue(async () => (await tarefaDe(b, t.id)).projetoSugerido);
  const nav = await abrirNavegador();
  try {
    await nav.carregar(b.url + "/");
    await nav.quieto();
    const aviso = () => nav.avaliar(`document.querySelector('[data-id="${t.id}"] .aviso-projeto')?.innerText || ""`);
    for (let i = 0; i < 30 && !(await aviso()); i++) await esperar(200);
    assert.match(await aviso(), /Parece ser do Beta Fiscal, não do alfa/);
    await nav.avaliar(`[...document.querySelectorAll('[data-id="${t.id}"] .aviso-projeto button')].find((x) => /Mover/.test(x.textContent)).click()`);
    assert.equal((await ateQue(async () => { const x = await tarefaDe(b, t.id); return x.project === "beta" && x; })).project, "beta");
    for (let i = 0; i < 30 && (await aviso()); i++) await esperar(200);
    assert.equal(await aviso(), "", "o aviso some depois de resolvido");
    assert.deepEqual(nav.erros, []);
  } finally { await nav.fechar(); }
});
