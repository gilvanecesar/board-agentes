// O SIM da Central, conferível (#213): o que o dono digita NA TELA da Central ganha um id que as outras sessões conferem
// com `board aprovacao <id> "<pedido>"`. Aqui se prova o que tem de ser RECUSADO: id forjado, vencido, texto que não cobre
// o pedido, linha gravada por fora (agente) e mensagem que não veio da tela.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { criarCaixa, criarProjeto, subirBoard, limparCaixa, esperar, envDaCaixa } from "./ajuda.mjs";
import { abrirNavegador, CHROME } from "./navegador.mjs";

let atual = [];
afterEach(async () => { for (const [b, c] of atual) { await b.fim(); limparCaixa(c); } atual = []; });

const PEDIDO = "Posso pedir ao alfa para mesclar?\n\nPEDIDO DE SIM: mesclar o PR #112 do alfa";
async function preparar(env = {}, conversa = [PEDIDO, "levando o sim ao alfa"]) {
  const caixa = criarCaixa();
  criarProjeto(caixa, "alfa"); criarProjeto(caixa, "beta");
  caixa.cenario({ conversa });
  const b = await subirBoard(caixa, env);
  atual.push([b, caixa]);
  return { caixa, b };
}
const eventos = async (b) => (await b.api("GET", "/api/conversa/central")).json.events;
async function esperarEvento(b, pred, ms = 8000) {
  for (let i = 0; i < ms / 150; i++) { const evs = await eventos(b); if (evs.some(pred)) return evs; await esperar(150); }
  throw new Error("evento não chegou: " + JSON.stringify(await eventos(b)).slice(-600));
}
// Como o navegador manda: com o Origin da própria tela.
const daTela = async (b, corpo, origem = b.url) => {
  const r = await fetch(b.url + "/api/conversa/central", { method: "POST", headers: { "content-type": "application/json", origin: origem }, body: JSON.stringify(corpo) });
  return { status: r.status, json: await r.json() };
};
const registro = (caixa) => existsSync(join(caixa.board, "data", "aprovacoes.jsonl"))
  ? readFileSync(join(caixa.board, "data", "aprovacoes.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
/** O que a sessão que recebeu o SIM roda: `board aprovacao <id> "<pedido>"`. Devolve código e saída. */
function conferir(caixa, b, ...args) {
  try { return { code: 0, out: execFileSync(process.execPath, [join(caixa.board, "board-cli.mjs"), "aprovacao", ...args], { env: envDaCaixa(caixa, { BOARD_URL: b.url }), encoding: "utf8" }) }; }
  catch (e) { return { code: e.status, out: String(e.stdout || "") + String(e.stderr || "") }; }
}
const conversas = (caixa) => existsSync(join(caixa.home, "chamadas.jsonl"))
  ? readFileSync(join(caixa.home, "chamadas.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.papel === "conversa") : [];

async function simAprovado(b) {
  await b.api("POST", "/api/conversa/central", { texto: "o alfa pode mesclar o PR?" });
  await esperarEvento(b, (e) => e.t === "resultado" && e.n === 1);
  const r = await daTela(b, { texto: "SIM", cita: 1 });
  assert.equal(r.status, 202);
  assert.match(r.json.aprovacao, /^[0-9a-f]{12}$/, "a mensagem digitada na tela ganha o id da aprovação");
  await esperarEvento(b, (e) => e.t === "resultado" && e.n === 2);
  return r.json.aprovacao;
}

test("Aprovação: o SIM digitado na tela vira registro do board, vai ao agente com o id, e a sessão confere (código 0)", async () => {
  const { caixa, b } = await preparar();
  const id = await simAprovado(b);
  const evs = await eventos(b);
  const pedido = evs.find((e) => e.t === "resultado" && e.n === 1);
  assert.equal(pedido.pedidoSim, "mesclar o PR #112 do alfa", "o pedido de SIM da Central é lido pelo board (é ele que vira o botão Aprovar)");
  const dono = evs.find((e) => e.t === "dono" && e.texto === "SIM");
  assert.equal(dono.aprovacao, id, "a mensagem do dono no log guarda o id (a tela mostra o selo)");
  assert.equal(dono.texto, "SIM", "o texto do dono fica como ele escreveu");
  const [r] = registro(caixa);
  assert.equal(r.id, id); assert.equal(r.texto, "SIM");
  assert.deepEqual({ n: r.refere.n, pedido: r.refere.pedido }, { n: 1, pedido: "mesclar o PR #112 do alfa" }, "a aprovação diz a qual pedido se refere");
  assert.match(r.assinatura, /^[0-9a-f]{64}$/);
  assert.match(conversas(caixa).at(-1).msg, new RegExp(`\\[board: aprovação #${id} `), "o agente da Central recebe o id para levar junto");
  const ok = conferir(caixa, b, id, "mesclar o PR #112 do alfa");
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /✓ CONFERE/); assert.match(ok.out, /texto do dono: "SIM"/); assert.match(ok.out, /PEDIDO DE SIM: mesclar o PR #112 do alfa/);
  assert.equal(conferir(caixa, b, "#" + id, "mesclar PR 112 (alfa)").code, 0, "o # na frente e outra redação do mesmo pedido valem");
});

test("Aprovação: id forjado, texto que não cobre o pedido e SIM sem pedido dito são RECUSADOS (código 1)", async () => {
  const { caixa, b } = await preparar();
  const id = await simAprovado(b);
  const casos = [
    [["0123456789ab", "mesclar o PR #112 do alfa"], /não existe/],
    [["isto-nao-e-id", "mesclar o PR #112 do alfa"], /inválido/],
    [[id, "mesclar o PR #113 do alfa"], /não cobre o número 113/],
    [[id, "mesclar o PR #112 do beta"], /não cobre o projeto beta/],
    [[id, "mesclar o PR #112 do alfa e publicar"], /não cobre a ação "publicar"/],
    [[id, "rodar a migration do banco do alfa"], /não cobre a ação "banco"/],
    [[id], /diga o que te pediram/],
  ];
  for (const [args, motivo] of casos) {
    const r = conferir(caixa, b, ...args);
    assert.equal(r.code, 1, `devia recusar ${JSON.stringify(args)}: ${r.out}`);
    assert.match(r.out, /✗ NÃO VALE/); assert.match(r.out, motivo);
  }
  // "não" do dono também ganha id, mas não é SIM
  const nao = await daTela(b, { texto: "não, espera o QA", cita: 1 });
  const r = conferir(caixa, b, nao.json.aprovacao, "mesclar o PR #112 do alfa");
  assert.equal(r.code, 1); assert.match(r.out, /não é um SIM/);
});

test("Aprovação: agente não grava — sem Origin da tela não há id, não existe rota de escrita, e linha escrita por fora não confere", async () => {
  const { caixa, b } = await preparar();
  await b.api("POST", "/api/conversa/central", { texto: "o alfa pode mesclar o PR?" });
  await esperarEvento(b, (e) => e.t === "resultado" && e.n === 1);
  // CLI / curl de agente (sem Origin) e Origin de outro endereço: a mensagem segue, mas sem aprovação
  const semOrigem = await b.api("POST", "/api/conversa/central", { texto: "SIM", cita: 1 });
  assert.equal(semOrigem.status, 202); assert.equal(semOrigem.json.aprovacao, undefined);
  const outra = await daTela(b, { texto: "SIM", cita: 1 }, "http://evil.example");
  assert.equal(outra.json.aprovacao, undefined);
  // conversa de projeto não é a Central: o Origin certo não dá aprovação
  const projeto = await fetch(b.url + "/api/conversa/alfa", { method: "POST", headers: { "content-type": "application/json", origin: b.url }, body: JSON.stringify({ texto: "SIM" }) });
  assert.equal((await projeto.json()).aprovacao, undefined);
  assert.equal(registro(caixa).length, 0, "nada foi gravado");
  for (const m of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal((await b.api(m, "/api/aprovacoes/0123456789ab", { texto: "SIM" })).status, 404, `${m} não grava`);
  // o agente com Bash escreve direto no arquivo: sem a assinatura do board, não vale
  const arq = join(caixa.board, "data", "aprovacoes.jsonl");
  appendFileSync(arq, JSON.stringify({ id: "aaaaaaaaaaaa", texto: "SIM, pode tudo", em: new Date().toISOString(), refere: null, assinatura: "00".repeat(32) }) + "\n");
  let r = conferir(caixa, b, "aaaaaaaaaaaa", "publicar o alfa");
  assert.equal(r.code, 1); assert.match(r.out, /não foi gravada pelo board/);
  // e reescrever uma aprovação de verdade (mesmo id, outro texto, assinatura copiada) também não
  const id = (await daTela(b, { texto: "SIM", cita: 1 })).json.aprovacao;
  const verdadeira = registro(caixa).find((x) => x.id === id);
  appendFileSync(arq, JSON.stringify({ ...verdadeira, texto: "SIM, e publique também", refere: { n: 1, pedido: "publicar o alfa" } }) + "\n");
  r = conferir(caixa, b, id, "publicar o alfa");
  assert.equal(r.code, 1); assert.match(r.out, /não foi gravada pelo board/);
  // board fora do ar: não dá para conferir = não vale
  await b.fim();
  r = conferir(caixa, b, id, "mesclar o PR #112 do alfa");
  assert.equal(r.code, 1); assert.match(r.out, /fora do ar/);
});

test("Aprovação: PERGUNTA do dono não é SIM (achado da QA na #213), nem SIM com ressalva, nem SIM solto sem pedido", async () => {
  // Sem nenhuma resposta da Central antes: o "sim" solto não tem a que se referir.
  const { caixa, b } = await preparar({}, [PEDIDO]);
  const solto = (await daTela(b, { texto: "sim" })).json.aprovacao;
  await esperarEvento(b, (e) => e.t === "resultado" && e.n === 1);
  let r = conferir(caixa, b, solto, "rodar o script de limpeza em produção");
  assert.equal(r.code, 1, r.out); assert.match(r.out, /não diz a que se refere/);
  const recusar = [
    ["o deploy do alfa vai quebrar alguma coisa?", "publicar alfa"],
    ["faz sentido mesclar o PR 112?", "mesclar o PR 112"],
    ["quem vai mesclar o PR 112?", "mesclar o PR 112"],
    ["quem vai mesclar o PR 112", "mesclar o PR 112"], // sem "?": não abre com aprovação
    ["pode mesclar o PR 112 do alfa?", "mesclar o PR 112 do alfa"],
    ["ok, mas me explica antes o que o PR 112 muda", "mesclar o PR 112"],
    ["sim, talvez depois", "mesclar o PR 112 do alfa"],
    // 2ª reprova da QA: restrição do dono não pode virar autorização ("publicar"/"113" escritos por ele EXCLUEM a ação)
    ["sim, sem publicar", "mesclar o PR 112 do alfa e publicar o alfa"],
    ["sim (menos publicar)", "publicar o alfa"],
    ["pode mesclar o PR 112, exceto o 113", "mesclar o PR 113 do alfa"],
    ["Sim, só mescla, publicar fica pra amanhã", "publicar o alfa"],
    ["s/n", "mesclar o PR 112 do alfa"],
    ["ok, entendi", "mesclar o PR 112 do alfa"],
  ];
  for (const [texto, acao] of recusar) {
    const id = (await daTela(b, { texto, cita: 1 })).json.aprovacao;
    r = conferir(caixa, b, id, acao);
    assert.equal(r.code, 1, `"${texto}" passou como SIM: ${r.out}`); assert.match(r.out, /não é um SIM/);
  }
  // e o SIM de verdade continua valendo
  for (const texto of ["SIM", "Sim, pode mesclar o PR 112 do alfa", "pode mesclar o PR #112", "Aprovado."]) {
    const id = (await daTela(b, { texto, cita: 1 })).json.aprovacao;
    r = conferir(caixa, b, id, "mesclar o PR #112 do alfa");
    assert.equal(r.code, 0, `"${texto}" devia valer: ${r.out}`);
  }
});

test("Aprovação: restrição do dono em QUALQUER palavra não autoriza o que ele excluiu (3ª reprova da QA na #213)", async () => {
  // O pedido inclui as duas coisas; o dono responde restringindo — de jeitos que nenhuma lista de palavras prevê.
  const { caixa, b } = await preparar({}, ["Posso?\n\nPEDIDO DE SIM: mesclar o PR 112 e o PR 113 do alfa e publicar o alfa"]);
  await b.api("POST", "/api/conversa/central", { texto: "o que falta no alfa?" });
  await esperarEvento(b, (e) => e.t === "resultado" && e.n === 1);
  const recusar = [
    ["sim, mescla o PR 112, nada de publicar", "publicar o alfa"],
    ["sim, mescla o PR 112, publicar jamais", "publicar o alfa"],
    ["sim, mesclar o 112; publicar é proibido", "publicar o alfa"],
    ["sim, mescla o 112 e segura o deploy", "publicar o alfa"],
    ["sim, mesclar o 112 (publicar: negativo)", "publicar o alfa"],
    ["pode mesclar o PR 112, o 113 deixa quieto", "mesclar o PR 113 do alfa"],
    ["sim, mesclar o 112", "publicar o alfa"],               // repetiu só parte do pedido: o resto não está aprovado
    ["sim, mesclar o 112", "mesclar o PR 113 do alfa"],
    ["sim, mesclar o 112 e o 113", "publicar o alfa"],
  ];
  for (const [texto, acao] of recusar) {
    const id = (await daTela(b, { texto, cita: 1 })).json.aprovacao;
    const r = conferir(caixa, b, id, acao);
    assert.equal(r.code, 1, `"${texto}" autorizou "${acao}": ${r.out}`);
  }
  // número ou ação que só o dono escreveu nunca vira cobertura, mesmo num SIM "limpo" de outro pedido
  let r = conferir(caixa, b, (await daTela(b, { texto: "SIM", cita: 1 })).json.aprovacao, "mesclar o PR 114 do alfa");
  assert.equal(r.code, 1); assert.match(r.out, /não cobre o número 114/);
  // revisor da #213: ação FORA da lista de tipos conhecidos não passa por um SIM a outro pedido
  for (const acao of ["reiniciar o nginx da VPS de producao", "rodar o script de limpeza na VPS", "alterar a env STRIPE_KEY do alfa"]) {
    r = conferir(caixa, b, (await daTela(b, { texto: "SIM", cita: 1 })).json.aprovacao, acao);
    assert.equal(r.code, 1, `um SIM a mesclar/publicar autorizou "${acao}": ${r.out}`); assert.match(r.out, /não está no pedido/);
  }
  // e valem: o SIM limpo ao pedido inteiro, e o pedido repetido pelo dono
  const valer = [
    ["SIM", "publicar o alfa"], ["SIM", "mesclar o PR 113 do alfa"],
    ["sim, mesclar o 112 e o 113 e publicar", "publicar o alfa"],
    ["pode mesclar o PR 112", "mesclar o PR 112 do alfa"], // omitir o projeto não restringe nada
  ];
  for (const [texto, acao] of valer) {
    r = conferir(caixa, b, (await daTela(b, { texto, cita: 1 })).json.aprovacao, acao);
    assert.equal(r.code, 0, `"${texto}" devia aprovar "${acao}": ${r.out}`);
  }
});

test("Aprovação: pedido que NEGA uma ação não a aprova, e ação vaga não confere (4ª reprova da QA na #213)", async () => {
  const { caixa, b } = await preparar({}, [
    "Pronto.\n\nPEDIDO DE SIM: mesclar o PR 112 do alfa, não publicar",
    "Pronto.\n\nPEDIDO DE SIM: mesclar o PR 112 do alfa sem publicar",
    "Pronto.\n\nPEDIDO DE SIM: mesclar o PR 112 do alfa",
    "ok",
  ]);
  for (let n = 1; n <= 3; n++) {
    await b.api("POST", "/api/conversa/central", { texto: "e agora?" });
    await esperarEvento(b, (e) => e.t === "resultado" && e.n === n);
  }
  const sim = async (cita) => (await daTela(b, { texto: "SIM", cita })).json.aprovacao;
  let r = conferir(caixa, b, await sim(1), "publicar o PR 112 do alfa");
  assert.equal(r.code, 1, `pedido "não publicar" aprovou publicar: ${r.out}`); assert.match(r.out, /negação ou restrição/);
  r = conferir(caixa, b, await sim(2), "mesclar o PR 112 do alfa e publicar");
  assert.equal(r.code, 1, `pedido "sem publicar" aprovou publicar: ${r.out}`); assert.match(r.out, /negação ou restrição/);
  const limpo = await sim(3);
  for (const vaga of ["mesclar", "o", "mesclar o PR do alfa", "mesclar o PR 112"]) {
    r = conferir(caixa, b, limpo, vaga);
    assert.equal(r.code, 1, `ação vaga "${vaga}" conferiu: ${r.out}`);
  }
  assert.equal(conferir(caixa, b, limpo, "mesclar o PR 112 do alfa").code, 0, "a ação completa continua valendo");
  // e a regra da Central manda pedir sem negação
  const c = conversas(caixa)[0];
  assert.match(c.args[c.args.indexOf("--append-system-prompt") + 1], /SÓ o que será feito, sem negação nem ressalva/);
});

test("Aprovação: ação com letra estranha (largura cheia, cirílico, chinês, letra trocada) não passa; pasta = rótulo do projeto (5ª reprova da QA na #213)", async () => {
  const caixa = criarCaixa();
  criarProjeto(caixa, "alfa-ofc");
  // o dono vê "Alfa" na tela; a pasta é alfa-ofc — os dois nomes são o mesmo projeto
  writeFileSync(join(caixa.board, "data", "projetos.json"), JSON.stringify({ visiveis: ["alfa-ofc"], rotulos: { "alfa-ofc": "Alfa" } }));
  caixa.cenario({ conversa: ["Posso?\n\nPEDIDO DE SIM: mesclar o PR 112 do Alfa", "ok"] });
  const b = await subirBoard(caixa);
  atual.push([b, caixa]);
  await b.api("POST", "/api/conversa/central", { texto: "o PR do alfa?" });
  await esperarEvento(b, (e) => e.t === "resultado" && e.n === 1);
  const id = (await daTela(b, { texto: "SIM", cita: 1 })).json.aprovacao;
  for (const acao of ["mesclar o PR 112 do Alfa e ｐｕｂｌｉｃａｒ", "mesclar o PR 112 do Alfa e задеплоить", "mesclar o PR 112 do Alfa e 发布到生产", "mesclar o PR 112 do Alfa e рublicar"]) {
    const r = conferir(caixa, b, id, acao);
    assert.equal(r.code, 1, `"${acao}" passou: ${r.out}`);
  }
  assert.match(conferir(caixa, b, id, "mesclar o PR 112 do Alfa e ｐｕｂｌｉｃａｒ").out, /a ação "publicar"/, "largura cheia é LIDA (NFKC) como publicar, e publicar não estava no pedido");
  assert.match(conferir(caixa, b, id, "mesclar o PR 112 do Alfa e задеплоить").out, /fora do alfabeto/, "cirílico é RECUSADO, não descartado");
  assert.match(conferir(caixa, b, id, "mesclar o PR 112 do Alfa e рublicar").out, /fora do alfabeto/, "um \"р\" cirílico no lugar do p também");
  assert.equal(conferir(caixa, b, id, "mesclar o PR 112 do alfa-ofc").code, 0, "o nome da pasta vale como o rótulo");
  assert.equal(conferir(caixa, b, id, "mesclar o PR 112 do Alfa").code, 0);
});

test("Aprovação: cada ação vai com os SEUS números — trocar ação e PR não confere (6ª reprova da QA na #213)", async () => {
  const { caixa, b } = await preparar({}, ["Posso?\n\nPEDIDO DE SIM: fechar o PR 112 e mesclar o PR 113 do alfa", "ok"]);
  await b.api("POST", "/api/conversa/central", { texto: "e os PRs do alfa?" });
  await esperarEvento(b, (e) => e.t === "resultado" && e.n === 1);
  const id = (await daTela(b, { texto: "SIM", cita: 1 })).json.aprovacao;
  for (const trocada of ["mesclar o PR 112 do alfa", "fechar o PR 113 do alfa"]) {
    const r = conferir(caixa, b, id, trocada);
    assert.equal(r.code, 1, `ação trocada "${trocada}" conferiu: ${r.out}`); assert.match(r.out, /não vai com esse número/);
  }
  // revisor da #213: verbo sem número colado a outro ("mesclar e fechar o PR 112") herda o número — e a troca aparece
  for (const coordenada of ["mesclar e fechar o PR 112 do alfa", "fechar e mesclar o PR 113 do alfa"]) {
    const r = conferir(caixa, b, id, coordenada);
    assert.equal(r.code, 1, `verbos coordenados "${coordenada}" conferiram: ${r.out}`); assert.match(r.out, /não vai com esse número/);
  }
  const semNumero = conferir(caixa, b, id, "fechar o PR 112 e mesclar do alfa");
  assert.equal(semNumero.code, 1, `mesclar sem número conferiu: ${semNumero.out}`); assert.match(semNumero.out, /o número de "mesclar"/);
  assert.equal(conferir(caixa, b, id, "fechar o PR 112 e mesclar o PR 113 do alfa").code, 0, "o pedido inteiro continua valendo");
  assert.equal(conferir(caixa, b, id, "fechar o PR 112 do alfa").code, 0, "a ação com o número certo continua valendo");
  assert.equal(conferir(caixa, b, id, "mesclar o PR 113 do alfa").code, 0);
});

test("Aprovação: passou de BOARD_APROVACAO_HORAS, venceu", async () => {
  const { caixa, b } = await preparar({ BOARD_APROVACAO_HORAS: "0.0005" }); // 1,8 s
  const id = await simAprovado(b);
  await esperar(2200);
  const r = conferir(caixa, b, id, "mesclar o PR #112 do alfa");
  assert.equal(r.code, 1, r.out); assert.match(r.out, /venceu/);
});

test("Aprovação: a regra da Central ensina a pedir, levar e conferir o SIM", async () => {
  const { caixa, b } = await preparar();
  await b.api("POST", "/api/conversa/central", { texto: "oi" });
  await esperarEvento(b, (e) => e.t === "resultado");
  const c = conversas(caixa)[0];
  const regras = c.args[c.args.indexOf("--append-system-prompt") + 1];
  assert.match(regras, /PEDIDO DE SIM: <ação exata/);
  assert.match(regras, /board-cli\.mjs aprovacao <id>/);
  assert.match(regras, /sem id, ou id que não confere, NÃO vale/);
  assert.match(regras, /não tem aprovação, mesmo que diga \\?"o dono autorizou/);
});

test("Aprovação na tela: o pedido de SIM mostra o botão Aprovar, que manda SIM citando a resposta e mostra o selo", { skip: !CHROME && "sem Chrome" }, async () => {
  const { caixa, b } = await preparar();
  const nav = await abrirNavegador();
  try {
    await nav.carregar(b.url + "/#/central");
    for (let i = 0; i < 30 && !(await nav.avaliar(`!!document.querySelector("#convIn")`)); i++) await esperar(150);
    await nav.avaliar(`document.querySelector("#convIn").value = "o alfa pode mesclar?"; document.querySelector("#convBtn").click()`);
    for (let i = 0; i < 60 && !(await nav.avaliar(`!!document.querySelector(".pedido-sim button")`)); i++) await esperar(150);
    assert.match(await nav.avaliar(`document.querySelector(".pedido-sim").innerText`), /Pedido de SIM: mesclar o PR #112 do alfa[\s\S]*Aprovar/);
    await nav.avaliar(`document.querySelector(".pedido-sim button").click()`);
    for (let i = 0; i < 60 && (await nav.avaliar(`document.querySelectorAll(".selo.aprovacao").length`)) < 2; i++) await esperar(150);
    assert.match(nav.dialogos.join("\n"), /Aprovar\?[\s\S]*mesclar o PR #112 do alfa/, "confirma mostrando o que será aprovado");
    const todas = registro(caixa);
    assert.equal(todas.length, 2, "toda mensagem digitada na tela da Central ganha id — a pergunta e o SIM");
    const r = todas[1];
    assert.equal(r.texto, "SIM"); assert.equal(r.refere.n, 1, "o botão cita a resposta do pedido");
    assert.match(await nav.avaliar(`[...document.querySelectorAll(".selo.aprovacao")].at(-1).textContent`), new RegExp(`aprovação #${r.id}`));
    assert.equal(conferir(caixa, b, r.id, "mesclar o PR #112 do alfa").code, 0);
    assert.deepEqual(nav.erros, []);
  } finally { await nav.fechar(); }
});
