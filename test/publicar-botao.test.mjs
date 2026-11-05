// 🚀 depois do clique (#214, dono em 27/10: "depois que clico em publicar, o botão fica disponível pra clicar de novo" —
// ele publicou ERP e CRM que já estavam em dia). Os quatro estados na TELA: rodando (⏳ desabilitado em toda tela e em
// outra aba), em dia (sem botão, só "republicar" com confirmação a mais), publicado (✅ até a main andar) e falhou
// (o botão volta com o motivo). Comando falso, `gh api` falso e "app no ar" falso — nada de produção.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createServer } from "node:http";
import { writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { criarCaixa, criarProjeto, subirBoard, limparCaixa, esperar } from "./ajuda.mjs";
import { abrirNavegador, CHROME } from "./navegador.mjs";

const SEM_CHROME = { skip: !CHROME && "sem Chrome nesta máquina" };
let atual = [];
afterEach(async () => { for (const [b, c, app] of atual) { await b?.fim(); limparCaixa(c); app?.close(); } atual = []; });

const sha = (p) => (p + "0".repeat(40)).slice(0, 40);
const C4 = sha("a4b4c4d"), C3 = sha("a3b3c3d"), C0 = sha("c0ffee1");
const commit = (s, msg, dia) => ({ sha: s, commit: { message: msg, committer: { date: `2026-10-${dia}T10:00:00Z` } } });
const COMMITS = [commit(C3, "Coisa nova (#14)", 27), commit(C0, "Base (#10)", 20)];
const ARQ_COMMITS = "gh-api-repos_dono_alfa_commits_per_page_50.json";

/** O "app no ar": o bundle traz C0; depois que o comando deixa $HOME/publicou.txt, traz C3 (a main). */
async function appNoAr(home) {
  const s = createServer((req, res) => {
    const hash = existsSync(join(home, "publicou.txt")) ? C3.slice(0, 7) : C0.slice(0, 7);
    if (req.url === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(`<html><script type="module" src="/assets/app.js"></script></html>`); }
    if (req.url === "/assets/app.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(`const sel={sha:"${hash}"};`); }
    res.writeHead(404); res.end();
  });
  await new Promise((ok) => s.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${s.address().port}/`, close: () => s.close() };
}

async function preparar(comando, { emDia = false, publicacoes, tarefa = {}, commits = COMMITS } = {}) {
  const caixa = criarCaixa();
  criarProjeto(caixa, "alfa");
  execFileSync("git", ["-C", join(caixa.dev, "alfa"), "remote", "add", "origin", "git@github.com:dono/alfa.git"]);
  writeFileSync(join(caixa.board, "data", "projetos.json"), JSON.stringify({ visiveis: ["alfa"], rotulos: { alfa: "Alfa" } }));
  writeFileSync(join(caixa.home, ARQ_COMMITS), JSON.stringify(commits));
  if (emDia) writeFileSync(join(caixa.home, "publicou.txt"), "já estava no ar\n");
  const app = await appNoAr(caixa.home);
  writeFileSync(join(caixa.board, "data", "publicar.json"), JSON.stringify({ alfa: { comando, conferir: app.url } }));
  // Uma tarefa com o PR #14 já mesclado: a ficha dela mostra o 🚀 Publicar Alfa (o rótulo, #249).
  const em = "2026-10-27T10:00:00.000Z";
  writeFileSync(join(caixa.board, "data", "board.json"), JSON.stringify({ seq: 1, tasks: [{ id: 1, title: "tarefa do PR 14", text: "tarefa do PR 14",
    project: "alfa", status: "executada", entrega: "pr", prUrl: "https://github.com/dono/alfa/pull/14", merged: { em }, createdAt: em, updatedAt: em, ...tarefa }], ...(publicacoes ? { publicacoes } : {}) }));
  const fila = [null, caixa, app]; atual.push(fila);
  fila[0] = await subirBoard(caixa, { BOARD_DONO: "Dono Teste", BOARD_PUBLICAR_CONFERIR_S: "0.3", BOARD_PUBLICAR_CONFERIR_TENTATIVAS: "4" });
  return { caixa, b: fila[0], app };
}

/** O que o 🚀 mostra numa tela: o texto do lugar do botão e cada botão (texto, desabilitado, se é o "republicar"). */
const ACAO = (sel) => `(() => [...document.querySelectorAll(${JSON.stringify(sel)})].map((el) => ({
  texto: el.innerText.trim(),
  botoes: [...el.querySelectorAll("button[data-publicar]")].map((b) => ({ texto: b.innerText.trim(), off: b.disabled, re: !!b.dataset.republicar })),
})))()`;
async function esperarAcao(nav, sel, cond, rotulo, limite = 20000) {
  const t0 = Date.now(); let v;
  while (Date.now() - t0 < limite) { v = await nav.avaliar(ACAO(sel)); if (v.length && v.every(cond)) return v; await esperar(150); }
  throw new Error(`${rotulo}: ${JSON.stringify(v)}`);
}
const rodando = (a) => a.botoes.length === 1 && a.botoes[0].off && /⏳ publicando…/.test(a.botoes[0].texto);
const publicadoOk = (a) => /✅ publicado às \d\d:\d\d por Dono Teste/.test(a.texto) && a.botoes.length === 1 && a.botoes[0].re && !a.botoes[0].off;

test("tela: publicando, o botão vira ⏳ desabilitado no menu PRs, na ficha e na Central de OUTRA aba; no fim, ✅ publicado até a main andar", SEM_CHROME, async () => {
  const { caixa, b } = await preparar('echo subindo; sleep 4; touch "$HOME/publicou.txt"; echo pronto');
  const [a, outra] = [await abrirNavegador(), await abrirNavegador()];
  try {
    await a.carregar(b.url + "/#/prs");
    await outra.carregar(b.url + "/#/t/1");
    await esperarAcao(a, '[data-pubacao="alfa"]', (x) => x.botoes.length === 1 && x.botoes[0].texto === "🚀 Publicar" && !x.botoes[0].off, "menu PRs com o botão");
    await esperarAcao(outra, '[data-pubacao="alfa"]', (x) => x.botoes[0]?.texto === "🚀 Publicar Alfa" && !x.botoes[0].off, "ficha com o botão");

    await a.avaliar(`document.querySelector('[data-pubacao="alfa"] [data-publicar]').click()`);
    await esperarAcao(a, '[data-pubacao="alfa"]', rodando, "menu PRs desabilitado enquanto roda");
    await esperarAcao(outra, '[data-pubacao="alfa"]', rodando, "ficha na outra aba (pelo SSE)");
    await outra.avaliar(`location.hash = "#/central"`);
    await esperarAcao(outra, '.cl-publicar [data-pubacao="alfa"]', rodando, "Central na outra aba");
    // Clicar no ⏳ não faz nada: o servidor não recebe outra publicação.
    await a.avaliar(`document.querySelector('[data-pubacao="alfa"] [data-publicar]').click()`);

    await esperarAcao(a, '[data-pubacao="alfa"]', publicadoOk, "menu PRs depois de publicar");
    await esperarAcao(outra, '.cl-publicar [data-pubacao="alfa"]', publicadoOk, "Central depois de publicar");
    assert.equal(a.dialogos.filter((d) => /PUBLICAR Alfa EM PRODUÇÃO/.test(d)).length, 1, "um clique, uma confirmação");
    const inicios = (await b.api("GET", "/api/publicar/alfa/log")).json.events.filter((e) => e.t === "inicio");
    assert.equal(inicios.length, 1, "uma publicação só");

    // A main andou (PR #15 mesclado): o botão volta, e só aí.
    writeFileSync(join(caixa.home, ARQ_COMMITS), JSON.stringify([commit(C4, "Mais uma (#15)", 28), ...COMMITS]));
    await a.avaliar(`document.querySelector('#prsAtualizar').click()`);
    const [v] = await esperarAcao(a, '[data-pubacao="alfa"]', (x) => x.botoes.length === 1 && x.botoes[0].texto === "🚀 Publicar" && !x.botoes[0].off, "botão de volta com a main à frente");
    assert.doesNotMatch(v.texto, /✅/);
    assert.deepEqual([...a.erros, ...outra.erros], []);
  } finally { await a.fechar(); await outra.fechar(); }
});

test("tela: projeto EM DIA não mostra o botão — só '✅ em dia' e um 'republicar' que avisa que não há nada novo", SEM_CHROME, async () => {
  const { b } = await preparar('touch "$HOME/republicou.txt"', { emDia: true });
  const nav = await abrirNavegador();
  try {
    await nav.carregar(b.url + "/#/prs");
    const [v] = await esperarAcao(nav, '[data-pubacao="alfa"]', (x) => /✅ em dia/.test(x.texto), "em dia no menu PRs");
    assert.deepEqual(v.botoes.map((x) => [x.texto, x.re]), [["republicar", true]], "sem o botão principal");
    await nav.carregar(b.url + "/#/t/1");
    const [f] = await esperarAcao(nav, '[data-pubacao="alfa"]', (x) => /✅ em dia/.test(x.texto), "em dia na ficha");
    assert.deepEqual(f.botoes.map((x) => x.texto), ["republicar"]);

    // Desistir na confirmação a mais: nada roda.
    await nav.avaliar(`window.confirm = (m) => { (window.__perguntas ||= []).push(m); return false; }`);
    await nav.avaliar(`document.querySelector('[data-pubacao="alfa"] [data-republicar]').click()`);
    let perguntas = [];
    for (let i = 0; i < 40 && !perguntas.length; i++) { await esperar(150); perguntas = await nav.avaliar("window.__perguntas || []"); }
    assert.equal(perguntas.length, 1, "parou na 1ª pergunta");
    assert.match(perguntas[0], /NÃO HÁ NADA NOVO para publicar em Alfa[\s\S]*já é a main \(a3b3c3d\)[\s\S]*Republicar mesmo assim\?/);
    await esperar(500);
    assert.equal((await b.api("GET", "/api/publicar/alfa")).json.ultima, null, "não publicou");
    assert.deepEqual(nav.erros, []);
  } finally { await nav.fechar(); }
});

test("tela: publicação que FALHA devolve o botão com o motivo", SEM_CHROME, async () => {
  const { b } = await preparar("echo tentando; exit 3");
  const nav = await abrirNavegador();
  try {
    await nav.carregar(b.url + "/#/prs");
    await esperarAcao(nav, '[data-pubacao="alfa"]', (x) => x.botoes[0]?.texto === "🚀 Publicar", "botão antes");
    await nav.avaliar(`document.querySelector('[data-pubacao="alfa"] [data-publicar]').click()`);
    const [v] = await esperarAcao(nav, '[data-pubacao="alfa"]', (x) => /✗ a última falhou: o comando saiu com código 3/.test(x.texto)
      && x.botoes.length === 1 && x.botoes[0].texto === "🚀 Publicar" && !x.botoes[0].off, "botão de volta com o motivo");
    assert.equal(v.botoes[0].re, false);
    await nav.carregar(b.url + "/#/t/1");
    await esperarAcao(nav, '[data-pubacao="alfa"]', (x) => /✗ a última falhou: o comando saiu com código 3/.test(x.texto) && x.botoes[0]?.texto === "🚀 Publicar Alfa" && !x.botoes[0].off, "ficha com o motivo");
    assert.deepEqual(nav.erros, []);
  } finally { await nav.fechar(); }
});

// #244 (print do dono: "✅ em dia · publicado às 09:12" e, colado, "⚠ a versão no ar não confere"). A conferência das 09:12
// rodou sem o gh logado e gravou ok=false; a leitura de AGORA é quem manda: no ar = main → sem ⚠ nas 3 telas; no ar
// diferente da main que subiu → com ⚠.
for (const [nome, emDia, comAviso] of [["leitura atual em dia", true, false], ["leitura atual divergente", false, true]]) {
  test(`tela: conferência antiga que falhou + ${nome} → ${comAviso ? "COM" : "sem"} ⚠ (menu PRs, Central e ficha)`, SEM_CHROME, async () => {
    const fim = "2026-10-28T09:12:00.000Z", quem = "Dono Teste (clique na tela)";
    const { b } = await preparar("exit 0", { emDia,
      publicacoes: { alfa: { ok: true, em: "2026-10-28T09:10:00.000Z", fim, quem, mainSha: C3, prs: [14],
        conferido: { ok: false, hash: null, em: fim, erro: "⚠ não consegui conferir a versão no ar: não achei em … nenhum dos últimos 0 commits da main" } } },
      tarefa: { publicado: { em: fim, slug: "alfa", quem, conferido: false } } });
    const nav = await abrirNavegador();
    const aviso = /⚠/;
    try {
      await nav.carregar(b.url + "/#/prs");
      const [m] = await esperarAcao(nav, '[data-pubacao="alfa"]', (x) => /✅ (em dia · )?publicado/.test(x.texto), "menu PRs publicado");
      assert.equal(aviso.test(m.texto), comAviso, "menu PRs: " + m.texto);
      const pe = await nav.avaliar(`document.querySelector('[data-pub="alfa"] .pub-pe').innerText`);
      assert.equal(/⚠ não conferiu no ar/.test(pe), comAviso, "menu PRs, linha da última: " + pe);
      await nav.carregar(b.url + "/#/central");
      const [c] = await esperarAcao(nav, '.cl-publicar [data-pubacao="alfa"]', (x) => /✅/.test(x.texto), "Central publicado");
      assert.equal(aviso.test(c.texto), comAviso, "Central: " + c.texto);
      await nav.carregar(b.url + "/#/t/1");
      const [f] = await esperarAcao(nav, '[data-pubacao="alfa"]', (x) => /✅/.test(x.texto), "ficha publicado");
      assert.equal(aviso.test(f.texto), comAviso, "ficha, botão: " + f.texto);
      let selo = "";
      for (let i = 0; i < 40; i++) { selo = await nav.avaliar(`document.querySelector('[data-pubaviso="alfa"]')?.innerText ?? "?"`); if (/⚠/.test(selo) === comAviso) break; await esperar(150); }
      assert.equal(/⚠ não conferiu no ar/.test(selo), comAviso, "ficha, selo 🚀 publicado: " + selo);
      assert.deepEqual(nav.erros, []);
    } finally { await nav.fechar(); }
  });
}

// Revisor da #244: a main andou DEPOIS da publicação (PR #15 mesclado), e no ar continua o sha que subiu (C3). Não é
// "em dia", mas a versão no ar confere com a publicação: o selo da ficha não pode voltar a dizer ⚠. Com o mainSha gravado
// na tarefa e, em tarefa antiga sem ele, pelo da última publicação (mesma hora de fim).
for (const [nome, comSha] of [["mainSha gravado na tarefa", true], ["tarefa antiga, sem mainSha", false]]) {
  test(`tela: conferência antiga falhou, main andou depois e no ar = o sha que subiu → selo da ficha sem ⚠ (${nome})`, SEM_CHROME, async () => {
    const fim = "2026-10-28T09:12:00.000Z", quem = "Dono Teste (clique na tela)";
    const { b } = await preparar("exit 0", { emDia: true, commits: [commit(C4, "Mais uma (#15)", 28), ...COMMITS],
      publicacoes: { alfa: { ok: true, em: "2026-10-28T09:10:00.000Z", fim, quem, mainSha: C3, prs: [14], conferido: { ok: false, hash: null, em: fim } } },
      tarefa: { publicado: { em: fim, slug: "alfa", quem, conferido: false, ...(comSha ? { mainSha: C3 } : {}) } } });
    const nav = await abrirNavegador();
    try {
      await nav.carregar(b.url + "/#/t/1");
      await esperarAcao(nav, '[data-pubacao="alfa"]', (x) => x.botoes[0]?.texto === "🚀 Publicar Alfa", "ficha com o botão (main à frente)");
      let selo = "?";
      for (let i = 0; i < 40; i++) { selo = await nav.avaliar(`document.querySelector('[data-pubaviso="alfa"]')?.innerText ?? "?"`); if (selo !== "?" && !/⚠/.test(selo)) break; await esperar(150); }
      assert.equal(selo, "", "selo sem ⚠: " + selo);
      assert.deepEqual(nav.erros, []);
    } finally { await nav.fechar(); }
  });
}

// #240 (print do dono: na Central, com "✗ a última falhou: …" o 🚀 Publicar vazava pela direita do cartão). Com um motivo
// LONGO, no computador e no celular: o botão fica dentro do cartão, na mesma linha do nome, e a falha numa linha própria embaixo.
test("tela: na coluna da Central, a falha longa quebra numa linha própria e o 🚀 Publicar fica dentro do cartão (computador e celular)", SEM_CHROME, async () => {
  const motivo = "o comando saiu com código 255 — ssh: connect to host erp-producao.exemplo.com.br port 22: Connection timed out depois de 3 tentativas";
  const { b } = await preparar("exit 0", { publicacoes: { alfa: { ok: false, code: 255, motivo, em: "2026-10-28T10:00:00.000Z", fim: "2026-10-28T10:00:05.000Z" } } });
  for (const largura of [1440, 390]) {
    const nav = await abrirNavegador({ largura, altura: 900 });
    try {
      await nav.carregar(b.url + "/#/central");
      await esperarAcao(nav, '.cl-publicar [data-pubacao="alfa"]', (x) => x.texto.includes(motivo) && x.botoes[0]?.texto === "🚀 Publicar", `Central com a falha (${largura})`);
      if (largura <= 760) await nav.avaliar(`verInspetor(true); 1`); // Cockpit (#364): no celular o inspetor é uma aba ao lado da conversa
      const m = await nav.avaliar(`(() => {
        const r = (el) => { const q = el.getBoundingClientRect(); return { l: q.left, r: q.right, t: q.top, b: q.bottom }; };
        const linha = document.querySelector('.cl-publicar .cl-pub');
        return { cartao: r(document.querySelector('#centralLado')), linha: r(linha), nome: r(linha.querySelector(':scope > b')),
          botao: r(linha.querySelector('button[data-publicar]')), motivo: r(linha.querySelector('.pub-motivo')),
          rolaDeLado: document.documentElement.scrollWidth > innerWidth };
      })()`);
      const tag = `(${largura}px) ${JSON.stringify(m)}`;
      assert.ok(m.botao.r <= m.cartao.r && m.botao.l >= m.cartao.l, "botão dentro do cartão " + tag);
      assert.ok(m.motivo.r <= m.cartao.r && m.motivo.l >= m.cartao.l, "falha dentro do cartão " + tag);
      assert.ok(Math.abs((m.botao.t + m.botao.b) / 2 - (m.nome.t + m.nome.b) / 2) < 4, "nome e botão na mesma linha " + tag);
      assert.ok(m.motivo.t >= m.botao.b - 1, "a falha fica embaixo do nome e do botão " + tag);
      assert.ok(m.motivo.b - m.motivo.t > 20, "a falha longa quebra em mais de uma linha " + tag);
      assert.equal(m.rolaDeLado, false, "a página não rola de lado " + tag);
      assert.deepEqual(nav.erros, []);
    } finally { await nav.fechar(); }
  }
});
