// 🎙 Só a voz do dono (#298): a rota, com whisper e motor da voz FALSOS. O motor falso devolve a nota que o teste mandar, então aqui se prova a
// decisão; `test/voz-quem-real.test.mjs` prova o motor de verdade com vozes do Piper, e `test/voz-quem-tela.test.mjs` a tela.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { esperar } from "./ajuda.mjs";
import { AUDIO, conferir, conversas, esperarEvento, eventos, limparVoz, ouvir, preparar, registro, wavDeAmostra } from "./voz-ajuda.mjs";
import { ajustar, cadastrar, CADASTRO, comQuem, pedirQuem } from "./voz-quem-ajuda.mjs";

afterEach(limparVoz);
const arquivo = (caixa) => join(caixa.board, "data", "voz-impressao.json");
const log = (caixa, n) => { const a = join(caixa.home, n); return existsSync(a) ? readFileSync(a, "utf8") : ""; };
const registroVoz = (caixa) => { const a = join(caixa.board, "data", "logs", "voz.jsonl"); return existsSync(a) ? readFileSync(a, "utf8") : ""; };
const mensagens = async (b) => (await eventos(b)).filter((e) => e.t === "dono");
const estado = async (b) => (await b.api("GET", "/api/voz/estado")).json.impressao;

test("Limiar: sobe com os segundos de voz, e cada nível da sensibilidade anda para os dois lados", async () => {
  const { b, ouvido, caixa, nota } = await comQuem();
  await cadastrar(b);
  ouvido("a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l");
  nota(0.01);
  const limiar = async (seg) => { writeFileSync(join(caixa.home, "quem-trecho-seg"), String(seg)); return (await ouvir(b)).json.limiar; };
  const tabela = [];
  for (const seg of [0.3, 0.8, 1.2, 1.6, 3, 40]) tabela.push(await limiar(seg));
  assert.deepEqual(tabela, [0.15, 0.15, 0.225, 0.3, 0.37, 0.37]);
  const longos = [];
  for (const n of [1, 2, 3, 4, 5]) { await ajustar(b, n); longos.push(await limiar(3)); }
  assert.deepEqual(longos, [0.27, 0.32, 0.37, 0.42, 0.47]);
  assert.deepEqual((await estado(b)).limiares, { curto: 0.25, longo: 0.47 });
});

test("Sem cadastro: funciona como hoje, o motor nem é chamado e a resposta não ganha campo", async () => {
  const { b, ouvido, caixa } = await comQuem();
  ouvido("Como está a fila?");
  const r = await ouvir(b);
  assert.deepEqual(Object.keys(r.json).sort(), ["enviado", "ms", "texto"]);
  assert.equal(log(caixa, "quem.log"), "", "o motor não roda sem cadastro");
  assert.doesNotMatch(registroVoz(caixa), /"quem"/);
  assert.equal((await estado(b)).cadastrada, false);
});

test("Filtro: abaixo do limiar nada é transcrito nem vai à Central, sem texto em lugar nenhum; acima segue e o registro só tem números", async () => {
  const { b, ouvido, caixa, nota } = await comQuem();
  await cadastrar(b);
  ouvido("Compra aquele carro agora", "Como está a fila?");
  nota(0.1);
  const r = await ouvir(b);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), ["filtro", "limiar", "ms", "naoReconhecida", "nota"]);
  assert.equal(r.json.naoReconhecida, true);
  assert.equal(log(caixa, "whisper.log"), "", "🔴 antes do whisper: nem transcreve");
  assert.equal((await mensagens(b)).length, 0); assert.equal(registro(caixa).length, 0);
  nota(0.9);
  const ok = await ouvir(b);
  assert.equal(ok.json.texto, "Compra aquele carro agora", "o whisper só andou agora");
  await esperarEvento(b, (e) => e.t === "dono" && e.voz);
  const linhas = registroVoz(caixa).trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.acao === "ouviu");
  assert.equal(linhas[0].resultado, "naoReconhecida"); assert.equal(linhas[0].quem, "outra"); assert.ok(linhas[0].msQuem >= 0 && linhas[0].nota === 0.1);
  assert.equal(linhas[1].quem, "dono");
  assert.doesNotMatch(registroVoz(caixa), /carro|fila|vetor/, "voz.jsonl sem texto nem impressão");
  const { uso } = await estado(b);
  assert.deepEqual([uso.dono, uso.outra], [1, 1]);
});

test("Comandos passam pelo filtro, em todo modo: outra voz não desliga, não corta, não liga; falando, a voz do board continua", async () => {
  const { b, ouvido, caixa, nota } = await comQuem();
  await cadastrar(b);
  await b.api("POST", "/api/conversa/central", { texto: "oi" });
  await esperarEvento(b, (e) => e.t === "resultado" && e.n === 1);
  ouvido("Modo texto.", "Espera.", "Modo voz.", "Modo texto.");
  nota(0.05);
  for (const q of ["modo=conversa", "modo=falando&n=1", "modo=espera", "modo=conversa&exige=nome", "modo=conversa&exige=janela"]) {
    const r = await ouvir(b, q);
    assert.equal(r.json.naoReconhecida, true, q); assert.equal(r.json.comando, undefined, q);
  }
  assert.equal(log(caixa, "whisper.log"), "");
  nota(0.9);
  assert.equal((await ouvir(b)).json.comando, "desligar", "a voz dele comanda");
  assert.equal((await ouvir(b, "modo=falando&n=1")).json.comando, "cortar");
  assert.equal((await ouvir(b, "modo=espera")).json.comando, "ligar");
});

test("Os dois filtros juntos (#305): fora da Central precisa ser a voz E o nome, por construção", async () => {
  const { b, ouvido, caixa, nota } = await comQuem();
  await cadastrar(b);
  ouvido("Como estão as tarefas?", "Atena, como estão as tarefas?");
  nota(0.9);
  assert.equal((await ouvir(b, "modo=conversa&exige=nome")).json.semNome, true, "a voz dele sem o nome não vale");
  nota(0.1);
  const antes = log(caixa, "whisper.log");
  assert.equal((await ouvir(b, "modo=conversa&exige=nome")).json.naoReconhecida, true, "o nome na voz de outro não vale");
  assert.equal(log(caixa, "whisper.log"), antes, "a voz de outro não gastou whisper");
  assert.equal((await mensagens(b)).length, 0);
  nota(0.9);
  assert.ok((await ouvir(b, "modo=conversa&exige=nome")).json.enviado);
});

test("O limiar é do servidor: parâmetro na rota não fura; outro formato de áudio não fura; a sensibilidade muda o que passa", async () => {
  const { b, ouvido, caixa, nota } = await comQuem();
  await cadastrar(b);
  ouvido("mensagem", "mensagem2");
  nota(0.3); // o motor falso diz 3 s de voz: limiar 0,37, ou 0,27 aceitando mais
  for (const q of ["modo=conversa&limiar=0&nota=1&sens=0&nivel=1", "modo=conversa&filtro=0"]) assert.equal((await ouvir(b, q)).json.naoReconhecida, true, q);
  const webm = Buffer.concat([Buffer.from("1A45DFA3", "hex"), Buffer.alloc(800, 7)]);
  assert.equal((await ouvir(b, "modo=conversa", { audio: webm })).json.naoReconhecida, true, "webm passa pelo ffmpeg no whisper, mas não pelo filtro");
  assert.equal((await ouvir(b, "modo=conversa", { audio: wavDeAmostra([[220, 400]], 8000) })).json.naoReconhecida, true, "WAV de outra taxa também não");
  assert.equal(log(caixa, "whisper.log"), "");
  const r = await ajustar(b, 1);
  assert.equal(r.status, 200); assert.equal(r.json.nivel, 1);
  assert.ok((await ouvir(b)).json.enviado, "aceitando mais, a mesma nota passa");
  assert.equal(JSON.parse(readFileSync(arquivo(caixa), "utf8")).nivel, 1, "fica no arquivo, não no navegador");
  assert.equal((await ajustar(b, 9)).status, 400);
});

test("Cadastro: só a impressão, em 0600, sem áudio em disco; pouca voz é recusada e a anterior fica; apagar e regravar", async () => {
  const { b, caixa, quemSeg } = await comQuem();
  quemSeg(3);
  const pouco = await pedirQuem(b, "POST", "/api/voz/impressao", CADASTRO);
  assert.equal(pouco.status, 422); assert.match(pouco.json.error, /3 s de voz/);
  assert.equal(existsSync(arquivo(caixa)), false);
  quemSeg(28);
  const r = await pedirQuem(b, "POST", "/api/voz/impressao", CADASTRO);
  assert.equal(r.status, 200); assert.equal(r.json.cadastrada, true); assert.equal(r.json.nivel, 3);
  assert.deepEqual(r.json.medido.curtas, { janelas: 3, passariam: 2, menor: 0.1 });
  assert.equal(JSON.stringify(r.json).includes("vetor"), false, "a impressão não sai do servidor");
  assert.equal(JSON.stringify((await b.api("GET", "/api/voz/estado")).json).includes("vetor"), false);
  assert.equal(statSync(arquivo(caixa)).mode & 0o777, 0o600);
  const dado = JSON.parse(readFileSync(arquivo(caixa), "utf8"));
  assert.deepEqual(Object.keys(dado).sort(), ["em", "janelas", "modelo", "nivel", "segundos", "versao", "vetor"], "nada de áudio no arquivo");
  assert.ok(readFileSync(arquivo(caixa)).length < 2000, "é um vetor, não uma gravação");
  assert.match(log(caixa, "quem.log"), /stdin cadastro \d+/, "o áudio foi pela entrada do processo");
  assert.doesNotMatch(log(caixa, "quem.log"), /\.wav/);
  // Sobra de uma gravação cortada, com outro modo: regravar não herda o modo dela
  writeFileSync(arquivo(caixa) + ".novo", "{}", { mode: 0o644 });
  await ajustar(b, 2);
  assert.equal(statSync(arquivo(caixa)).mode & 0o777, 0o600);
  assert.equal((await pedirQuem(b, "POST", "/api/voz/impressao", CADASTRO)).json.nivel, 2, "regravar mantém a sensibilidade");
  const apagou = await pedirQuem(b, "DELETE", "/api/voz/impressao");
  assert.equal(apagou.status, 200); assert.equal(apagou.json.cadastrada, false);
  assert.equal(existsSync(arquivo(caixa)), false);
  assert.doesNotMatch(registroVoz(caixa), /vetor/);
});

test("Barreira: toda rota nova só com o Origin da tela; agente, CLI e outra página não cadastram, não apagam, não ajustam", async () => {
  const { b, caixa, nota } = await comQuem();
  await cadastrar(b);
  const antes = readFileSync(arquivo(caixa), "utf8");
  for (const origem of [null, "https://malicioso.example", "http://localhost:1"]) {
    for (const [m, rota, corpo] of [["POST", "/api/voz/impressao", CADASTRO], ["DELETE", "/api/voz/impressao"], ["POST", "/api/voz/impressao/testar", AUDIO], ["POST", "/api/voz/impressao/ajuste", Buffer.from('{"nivel":1}')]])
      assert.equal((await pedirQuem(b, m, rota, corpo, origem)).status, 403, `${m} ${rota} com ${origem}`);
  }
  assert.equal(readFileSync(arquivo(caixa), "utf8"), antes);
  assert.equal((await pedirQuem(b, "GET", "/api/voz/impressao")).status, 404);
  nota(0.9);
  assert.equal((await pedirQuem(b, "POST", "/api/voz/impressao/testar", AUDIO)).json.passou, true);
  assert.equal((await pedirQuem(b, "POST", "/api/voz/impressao", Buffer.from("isto não é áudio"))).status, 400);
  assert.equal(JSON.parse(readFileSync(arquivo(caixa), "utf8")).segundos, 28, "lixo não troca a impressão");
});

test("🔴 A impressão não aprova nada: voz reconhecida dizendo SIM continua com origem voz e é recusada; o agente não ouve que a voz foi confirmada", async () => {
  const { b, ouvido, caixa, nota } = await comQuem({ conversa: ["Vou mesclar.\n\nPEDIDO DE SIM: mesclar o PR 112 do projeto alfa", "ok"] });
  await cadastrar(b);
  await b.api("POST", "/api/conversa/central", { texto: "mescla o 112" });
  await esperarEvento(b, (e) => e.t === "resultado" && e.pedidoSim);
  ouvido("Sim.");
  nota(0.99);
  const id = (await ouvir(b)).json.enviado;
  assert.ok(id);
  assert.equal(registro(caixa).find((a) => a.id === id).origem, "voz");
  const c = conferir(caixa, b, id, "mesclar o PR 112 do projeto alfa");
  assert.equal(c.code, 1); assert.match(c.out, /SIM por voz não vale/);
  await esperarEvento(b, () => conversas(caixa).length >= 2);
  const msg = conversas(caixa).at(-1).msg;
  assert.match(msg, /FALADA/);
  assert.doesNotMatch(msg, /reconhecid|impress|confirmad|nota/i);
  // Não existe campo de "voz do dono" em aprovações
  assert.doesNotMatch(readFileSync(join(caixa.board, "data", "aprovacoes.jsonl"), "utf8"), /impressao|quem|nota/);
  const fonte = readFileSync(new URL("../servidor/voz-quem.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(fonte, /^import .*aprovacoes/m, "o filtro não fala com aprovações");
});

test("Motor quebrado com cadastro: a fala passa e a tela é avisada; sem o motor instalado, idem; impressão ilegível também avisa", async () => {
  const { b, ouvido, caixa, nota } = await comQuem();
  await cadastrar(b);
  ouvido("Primeira", "Segunda");
  nota("quebrado");
  const r = await ouvir(b);
  assert.equal(r.json.texto, "Primeira"); assert.match(r.json.filtroFora, /motor/);
  assert.match(registroVoz(caixa), /"quem":"fora"/);
  writeFileSync(arquivo(caixa), "{ quebrado");
  assert.match((await ouvir(b)).json.filtroFora, /ilegível/);
  assert.match((await estado(b)).aviso, /ilegível/);
});

test("Sem o motor instalado: a tela diz, o cadastro é 503, e o modo voz segue como hoje", async () => {
  const { b, ouvido } = await preparar();
  const e = await estado(b);
  assert.equal(e.motor.ok, false); assert.match(e.motor.motivo, /instalar-voz-quem/);
  assert.equal((await pedirQuem(b, "POST", "/api/voz/impressao", CADASTRO)).status, 503);
  ouvido("Tudo certo?");
  assert.ok((await ouvir(b)).json.enviado);
});

test("O ↻ espera o motor, e o board parando não deixa o motor vivo com o áudio", async () => {
  const { b, caixa, nota } = await comQuem();
  await cadastrar(b);
  nota(0.9); writeFileSync(join(caixa.home, "quem-demora"), "5");
  const fala = ouvir(b).catch((e) => e);
  await esperar(500);
  const pid = Number(readFileSync(join(caixa.home, "quem-pid"), "utf8"));
  await b.api("POST", "/api/reiniciar", {});
  await esperar(2500); // o runner olha a cada 1,5 s
  assert.equal((await b.api("GET", "/api/voz/estado")).status, 200, "o reinício esperou");
  process.kill(pid, 0);
  await b.fim();
  await esperar(200);
  assert.throws(() => process.kill(pid, 0), "morreu junto com o board");
  await fala;
});
