// 🎙 Modo voz da Central (#286): o áudio vira mensagem SÓ pela rota da tela, com a origem "voz" que `board aprovacao` recusa.
// Whisper e Piper são falsos (o texto "ouvido" vem de um arquivo); o áudio é um WAV de amostra. Nada de microfone real.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { connect } from "node:net";
import { criarCaixa, criarProjeto, subirBoard, limparCaixa, esperar, envDaCaixa } from "./ajuda.mjs";
import { CHROME } from "./navegador.mjs";
import { AUDIO, conferir, conversas, esperarArquivo, esperarEvento, esperarNaTela, eventos, limparVoz, ouvir, preparar, registro, soar, tela, wavDeAmostra } from "./voz-ajuda.mjs";
import { comandoDeVoz, ehEco, ehInvencaoDoWhisper, pareceFrase, podeSerComando, trechoCurto, textoDaFala } from "../servidor/voz-texto.mjs";

afterEach(limparVoz);

test("Voz, rotas: sem o Origin da tela nada é ouvido nem falado; só a tela e só POST", async () => {
  const { b, ouvido, caixa } = await preparar();
  ouvido("isto não pode chegar");
  for (const origem of [null, "http://evil.example"]) {
    assert.equal((await ouvir(b, "modo=conversa", { origem })).status, 403, `Origin ${origem}`);
    const r = await fetch(b.url + "/api/voz/fala", { method: "POST", headers: { "content-type": "application/json", ...(origem ? { origin: origem } : {}) }, body: JSON.stringify({ amostra: true }) });
    assert.equal(r.status, 403);
  }
  assert.ok(!existsSync(join(caixa.home, "whisper.log")), "áudio recusado nem chega ao whisper");
  assert.equal((await ouvir(b, "modo=outro")).status, 400);
  assert.equal((await ouvir(b, "modo=conversa", { audio: Buffer.alloc(0) })).status, 400);
  const est = (await b.api("GET", "/api/voz/estado")).json;
  assert.equal(est.whisper.ok, true); assert.equal(est.whisper.modelo, "ggml-small-q5_1.bin");
  assert.deepEqual(est.piper.vozes, ["faber", "jeff"], "a voz padrão vem primeiro");
});

test("Voz: a fala vira mensagem da Central marcada como falada, com whisper na CPU, sem sobrar áudio nem texto no registro", async () => {
  const { b, ouvido, caixa } = await preparar();
  ouvido("Abre uma tarefa no CRM.");
  const r = await ouvir(b);
  assert.equal(r.status, 200);
  assert.equal(r.json.texto, "Abre uma tarefa no CRM.");
  assert.match(r.json.enviado, /^[0-9a-f]{12}$/);
  const evs = await esperarEvento(b, (e) => e.t === "resultado" && e.n === 1);
  const dono = evs.find((e) => e.t === "dono");
  assert.equal(dono.voz, true); assert.equal(dono.texto, "Abre uma tarefa no CRM.", "o log guarda o que foi dito, sem a marca");
  assert.equal(dono.aprovacao, undefined, "a tela não mostra selo de aprovação em mensagem falada");
  assert.match(conversas(caixa).at(-1).msg, /\[board: mensagem FALADA pelo dono/);
  const args = readFileSync(join(caixa.home, "whisper.log"), "utf8");
  assert.match(args, /-l pt/); assert.match(args, /ggml-small-q5_1\.bin/); if (process.platform === "linux") assert.match(args, /-ng/);
  const wav = readFileSync(join(caixa.home, "whisper-audios.log"), "utf8").trim();
  assert.ok(!existsSync(wav), "o áudio foi apagado depois de transcrever");
  assert.ok(!existsSync(dirname(wav)), "nem a pasta temporária fica"); // a DESTE áudio: os outros arquivos de teste rodam em paralelo no mesmo tmp
  const log = readFileSync(join(caixa.board, "data", "logs", "voz.jsonl"), "utf8");
  assert.match(log, /"acao":"ouviu"/); assert.doesNotMatch(log, /CRM/, "o registro mede; não guarda o que foi dito");
});

test("Voz 🔴: SIM falado NÃO aprova — board aprovacao recusa dizendo por quê, o ✓ Aprovar digitado vale, e tirar a marca não adianta", async () => {
  const { b, ouvido, caixa } = await preparar({ conversa: ["Posso?\n\nPEDIDO DE SIM: mesclar o PR #112 do alfa", "repita no botão", "ok"] });
  await b.api("POST", "/api/conversa/central", { texto: "o alfa pode mesclar?" });
  await esperarEvento(b, (e) => e.t === "resultado" && e.n === 1);
  ouvido("Sim");
  const r = await ouvir(b);
  await esperarEvento(b, (e) => e.t === "resultado" && e.n === 2);
  const ap = registro(caixa).find((x) => x.id === r.json.enviado);
  assert.equal(ap.origem, "voz"); assert.equal(ap.refere.pedido, "mesclar o PR #112 do alfa", "mesmo com o pedido certo");
  const nao = conferir(caixa, b, r.json.enviado, "mesclar o PR #112 do alfa");
  assert.equal(nao.code, 1, nao.out);
  assert.match(nao.out, /✗ NÃO VALE — SIM por voz não vale: use o ✓ Aprovar/);
  // Tirar a marca da linha quebra a assinatura
  appendFileSync(join(caixa.board, "data", "aprovacoes.jsonl"), JSON.stringify({ ...ap, origem: undefined }) + "\n");
  const forjada = conferir(caixa, b, r.json.enviado, "mesclar o PR #112 do alfa");
  assert.equal(forjada.code, 1); assert.match(forjada.out, /assinatura não confere/);
  // O POST de texto não aceita voz nem esconde a origem: o botão Aprovar segue sendo a mensagem digitada
  const sim = await (await fetch(b.url + "/api/conversa/central", { method: "POST", headers: { "content-type": "application/json", origin: b.url }, body: JSON.stringify({ texto: "SIM", cita: 1 }) })).json();
  assert.equal(conferir(caixa, b, sim.aprovacao, "mesclar o PR #112 do alfa").code, 0);
});

test("Voz, comandos: só a frase inteira é comando; no modo espera só 'modo voz' passa e nada chega à Central", async () => {
  const { b, ouvido, caixa } = await preparar();
  ouvido("Modo texto.", "Para de falar!", "Espera", "Vamos conversar.", "Modo voz", "qual o saldo do cliente", "para", "");
  assert.equal((await ouvir(b)).json.comando, "desligar");
  assert.equal((await ouvir(b)).json.comando, "desligar");
  assert.equal((await ouvir(b)).json.comando, "cortar");
  assert.equal((await ouvir(b, "modo=espera")).json.comando, "ligar");
  assert.equal((await ouvir(b, "modo=espera")).json.comando, "ligar");
  const descartado = await ouvir(b, "modo=espera");
  assert.deepEqual(Object.keys(descartado.json).sort(), ["ms", "nada"], "no modo espera o texto não volta nem à tela");
  assert.equal((await ouvir(b, "modo=espera")).json.nada, true, "'para' não liga nada");
  assert.equal((await ouvir(b)).json.nada, true, "silêncio não vira mensagem");
  assert.equal(registro(caixa).length, 0, "nada virou mensagem");
  assert.equal((await eventos(b)).length, 0);
});

test("Voz, falando: o eco da própria fala é descartado; o dono falando por cima vira mensagem", async () => {
  const { b, ouvido, caixa } = await preparar({ conversa: ["O backup da madrugada rodou certinho no servidor.", "certo"] });
  await b.api("POST", "/api/conversa/central", { texto: "e o backup?" });
  await esperarEvento(b, (e) => e.t === "resultado" && e.n === 1);
  ouvido("o backup da madrugada rodou certinho", "Quanto tempo levou?");
  assert.equal((await ouvir(b, "modo=falando&n=1")).json.eco, true);
  assert.equal(registro(caixa).length, 0);
  assert.match((await ouvir(b, "modo=falando&n=1")).json.enviado, /^[0-9a-f]{12}$/);
});

test("Voz, fala: resposta vira WAV pelo Piper com o texto resumido; sem Piper (ou com ele quebrado) a tela recebe o texto", async () => {
  const { b, caixa } = await preparar({ conversa: ["Deu certo no PR #112.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconsole.log(1)\n```\n\nVeja [o log](https://x.y/z)."] });
  await b.api("POST", "/api/conversa/central", { texto: "e aí?" });
  await esperarEvento(b, (e) => e.t === "resultado" && e.n === 1);
  const fala = (corpo, origem = b.url) => fetch(b.url + "/api/voz/fala", { method: "POST", headers: { "content-type": "application/json", origin: origem }, body: JSON.stringify(corpo) });
  const r = await fala({ n: 1, voz: "jeff" });
  assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "audio/wav");
  assert.equal((await r.arrayBuffer()).byteLength, 44 + 22050 * 2);
  const texto = decodeURIComponent(r.headers.get("x-voz-texto"));
  assert.equal(texto, "Deu certo no PR 112. Veja o log.");
  const [p] = readFileSync(join(caixa.home, "piper.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.match(p.texto, /pê erre 112/, "a sigla vai com a pronúncia");
  assert.match(p.modelo, /jeff/); assert.equal(p.cuda, "-1", "fora da placa de vídeo");
  assert.equal((await fala({ n: 99 })).status, 404);
  writeFileSync(join(caixa.home, "piper-quebrado"), "1");
  const q = await (await fala({ n: 1 })).json();
  assert.equal(q.voz, null); assert.equal(q.texto, texto); assert.match(q.motivo, /código 3/);
});

test("Voz, sem Piper: a rota responde o texto e o estado diz que a voz é a do navegador", async () => {
  const { b } = await preparar({ piper: false });
  await b.api("POST", "/api/conversa/central", { texto: "oi" });
  await esperarEvento(b, (e) => e.t === "resultado" && e.n === 1);
  const r = await (await fetch(b.url + "/api/voz/fala", { method: "POST", headers: { "content-type": "application/json", origin: b.url }, body: JSON.stringify({ n: 1 }) })).json();
  assert.equal(r.voz, null); assert.equal(r.texto, "Tudo certo por aqui.");
  assert.match((await b.api("GET", "/api/voz/estado")).json.piper.motivo, /voz é a do navegador/);
});

test("Voz, texto da fala: sem tabela, código, link, hash nem lista de tarefas; o PEDIDO DE SIM vai inteiro e diz que é no botão", () => {
  const md = `## Resumo
**Três** tarefas subiram: #206, #207 e #208. Veja \`servidor/voz.mjs\` e https://exemplo.com/a.
- Commit 4cb1c77a pronto ✅
- Protocolo 123456789 enviado

| a | b |
|---|---|
| 1 | 2 |
`;
  assert.equal(textoDaFala(md), "Três tarefas subiram. Commit pronto. Protocolo enviado.", "título não se lê (#313)");
  assert.equal(textoDaFala("Tudo certo. Sem mais."), "Tudo certo. Sem mais.", "resposta curta vai inteira");
  assert.equal(textoDaFala("```\nsó código\n```"), "A resposta está na tela.");
  const longa = Array.from({ length: 30 }, (_, i) => `Frase número ${i} com bastante conteúdo para encher.`).join(" ");
  const f = textoDaFala(longa);
  assert.ok(f.length < 480, `resumida: ${f.length}`); assert.match(f, /^Frase número 0 .*encher\.$/, "termina no fim do resumo, sem aviso");
  const s = textoDaFala("Pronto para subir.\n\nPEDIDO DE SIM: mesclar o PR #112 do alfa", "mesclar o PR #112 do alfa");
  assert.equal(s, "Pronto para subir. Preciso do seu sim para: mesclar o PR 112 do alfa. Aprove no botão Aprovar da tela: sim falado não vale.");
});

test("Voz: frase do dono que fala em legenda vira mensagem; só a fórmula inteira do whisper é descartada", async () => {
  const frases = ["muda a legenda da tabela de fretes no ERP", "coloca legenda de preço no gráfico", "a legenda por cliente sumiu da tela", "o site amara.org caiu", "obrigado por assistir a reunião comigo"];
  for (const f of frases) assert.equal(ehInvencaoDoWhisper(f), false, f);
  for (const f of ["Legendas pela comunidade Amara.org", "Legendas pela comunidade do Amara.org.", "Obrigado por assistir!", "Obrigado por assistir. Inscreva-se no canal.", "[Risos]", "(música) ♪"]) assert.equal(ehInvencaoDoWhisper(f), true, f);
  const { b, ouvido, caixa } = await preparar({ conversa: ["ok"] });
  ouvido(...frases.slice(0, 3));
  for (const f of frases.slice(0, 3)) {
    const r = await ouvir(b);
    assert.equal(r.json.texto, f); assert.match(r.json.enviado, /^[0-9a-f]{12}$/, "vai à Central");
  }
  assert.equal(registro(caixa).length, 3);
});

test("Voz: pedido de SIM com link ou código não leva caractere de controle à fala e diz que a ação completa está na tela", async () => {
  const f = textoDaFala("Pronto.", "publicar em https://x.com/a");
  assert.doesNotMatch(f, /[\u0000-\u001f]/);
  assert.equal(f, "Pronto. Preciso do seu sim para: publicar em. A ação completa está na tela. Aprove no botão Aprovar da tela: sim falado não vale.");
  assert.match(textoDaFala("Pronto.", "rodar `node /a/b.mjs` no alfa"), /sim para: rodar no alfa\. A ação completa está na tela\./);
  assert.equal(textoDaFala("", "https://x.com/a"), "Preciso do seu sim. A ação completa está na tela. Aprove no botão Aprovar da tela: sim falado não vale.");
  assert.doesNotMatch(textoDaFala("Pronto.", "mesclar o PR #112"), /ação completa/, "sem nada cortado, não avisa");
  const { b } = await preparar({ conversa: ["Pronto.\n\nPEDIDO DE SIM: publicar em https://x.com/a"] });
  await b.api("POST", "/api/conversa/central", { texto: "e aí?" });
  await esperarEvento(b, (e) => e.t === "resultado" && e.n === 1);
  const r = await fetch(b.url + "/api/voz/fala", { method: "POST", headers: { "content-type": "application/json", origin: b.url }, body: JSON.stringify({ n: 1 }) });
  assert.doesNotMatch(r.headers.get("x-voz-texto"), /%01/, "nem no cabeçalho");
  assert.match(decodeURIComponent(r.headers.get("x-voz-texto")), /A ação completa está na tela\./);
});

test("Voz, texto da fala: ponto de milhar, versão e arquivo não partem a frase nem somem com o valor", () => {
  for (const f of ["O frete custou R$ 1.500,00 hoje.", "Temos 1.234 CT-e parados no ERP.", "São 12 tarefas e 3.480 linhas no total.", "Atualizei para a versão 2.4.0 ontem. Tudo certo.", "Mudei o board.env e reiniciei."])
    assert.equal(textoDaFala(f), f);
  assert.equal(textoDaFala("Sem ponto final 1.500"), "Sem ponto final 1.500.", "frase sem ponto no fim também não perde o começo");
  assert.equal(textoDaFala("Feito... Pronto? Sim!"), "Feito... Pronto? Sim!", "reticências e outra pontuação continuam terminando frase");
  const corte = textoDaFala("Primeira frase com 1.500 reais. " + "Outra frase bem comprida sobre o assunto do dia. ".repeat(20));
  assert.match(corte, /^Primeira frase com 1\.500 reais\. /); assert.match(corte, /assunto do dia\.$/, "o corte termina na frase, sem aviso");
});

test("Voz, comandos curtos: só com o board falando 'Espero.' e 'Paz.' cortam; a 2ª passada só salva comando do que a 1ª ouviu", async () => {
  for (const t of ["Espero.", "Eu espero.", "Está aí.", "Paz.", "Pai, pai."]) {
    assert.equal(comandoDeVoz(t, { falando: true }), "cortar", t);
    assert.equal(comandoDeVoz(t), null, `fora da fala "${t}" é mensagem`);
  }
  assert.equal(comandoDeVoz("Paz na terra.", { falando: true }), null, "frase inteira, também falando");
  assert.equal(comandoDeVoz("para o deploy", { falando: true }), null);
  const trecho = (s) => 44 + s * 32000;
  assert.ok(trechoCurto(trecho(4.5))); assert.ok(!trechoCurto(trecho(4.6)));
  assert.ok(podeSerComando("Para aí de falar.")); assert.ok(!podeSerComando("Abre uma tarefa no CRM."));
  const { b, ouvido, caixa } = await preparar();
  const comando = (...l) => writeFileSync(join(caixa.home, "ouvido-comando.txt"), l.join("\n") + "\n");
  const pedidos = () => readFileSync(join(caixa.home, "whisper.log"), "utf8").trim().split("\n");
  const central = () => conversas(caixa).map((c) => c.msg).join("\n");
  // Comando mal ouvido pelo vocabulário geral: a 2ª passada salva
  ouvido("Malovos."); comando("Modo voz.");
  assert.equal((await ouvir(b)).json.comando, "ligar");
  assert.match(pedidos().at(-2), /CT-e/, "a 1ª passada é a do vocabulário de sempre"); assert.match(pedidos().at(-1), /Modo voz\. Modo texto\./);
  // No modo espera também
  ouvido("Malovos."); comando("Modo voz.");
  assert.equal((await ouvir(b, "modo=espera")).json.comando, "ligar");
  // Comando já ouvido na 1ª não gasta a 2ª
  let antes = pedidos().length; ouvido("Espera.");
  assert.equal((await ouvir(b, "modo=falando&n=1")).json.comando, "cortar");
  assert.equal(pedidos().length, antes + 1, "uma passada só");
  // 🔴 Ruído (achado da QA): a 1ª passada vazia encerra; o prompt devolvido pela 2ª nunca vira mensagem nem comando
  for (const q of ["modo=conversa", "modo=falando&n=1"]) {
    antes = pedidos().length; ouvido(""); comando("Vamos conversar. Espera.");
    assert.equal((await ouvir(b, q)).json.nada, true, q);
    assert.equal(pedidos().length, antes + 1, "ruído nem chega ao prompt dos comandos");
    writeFileSync(join(caixa.home, "ouvido-comando.txt"), "");
  }
  // O prompt devolvido por cima de uma fala de verdade: vale o texto da 1ª passada, nunca o eco dele
  ouvido("Pode mandar."); comando("Vamos conversar. Espera.");
  const msg = await ouvir(b);
  assert.equal(msg.json.texto, "Pode mandar."); assert.equal(msg.json.comando, undefined);
  await esperarEvento(b, (e) => e.t === "resultado" && e.n === 1);
  assert.doesNotMatch(central(), /Vamos conversar/, "o prompt não chega à Central");
  // 🔴 Frase legível de outra coisa (achado da QA): a 2ª puxou para um comando, vale a 1ª, e ela vai à Central como mensagem
  let cortes = 0;
  for (const [primeira, segunda] of [["Pode falar.", "Para de falar."], ["Mais texto.", "Modo texto."], ["Vai conversar.", "Vamos conversar."], ["Chega de falar.", "Para de falar."], ["Um.", "Para."]]) {
    ouvido(primeira); comando(segunda);
    const r = await ouvir(b, "modo=falando&n=1");
    assert.equal(r.json.comando, undefined, primeira); assert.equal(r.json.texto, primeira);
    await esperarEvento(b, () => conversas(caixa).some((c) => c.msg.includes(primeira)));
    cortes++;
  }
  assert.equal(cortes, 5);
  // Mal ouvido de verdade continua salvo
  ouvido("Mal o texto."); comando("Modo texto.");
  assert.equal((await ouvir(b)).json.comando, "desligar");
  // Fala longa não vai à 2ª passada
  antes = pedidos().length; ouvido("Pode.");
  await ouvir(b, "modo=conversa", { audio: wavDeAmostra([[220, 6000]]) });
  assert.equal(pedidos().length, antes + 1);
});

test("Voz, ↻ no meio da transcrição: espera, a mensagem chega e nenhum áudio fica", async () => {
  const { b, ouvido, caixa } = await preparar({ env: { HOME_ATRASO: "2" } });
  ouvido("Abre uma tarefa no CRM.");
  const fala = ouvir(b);
  await esperarArquivo(join(caixa.home, "whisper-audios.log"));
  const pedido = await b.api("POST", "/api/reiniciar", {});
  assert.equal(pedido.json.agora, false, "não promete reiniciar agora");
  await esperar(1000);
  assert.equal(b.cp.exitCode, null, "com a transcrição no meio, não sai");
  const r = await fala;
  assert.equal(r.json.texto, "Abre uma tarefa no CRM.", "o trecho falado não se perde");
  for (let i = 0; i < 100 && b.cp.exitCode === null; i++) await esperar(100);
  assert.equal(b.cp.exitCode, 75, "depois da transcrição (e da resposta), o ↻ acontece");
  const wav = readFileSync(join(caixa.home, "whisper-audios.log"), "utf8").trim();
  assert.ok(!existsSync(dirname(wav)), "nenhum áudio ficou");
});

test("Voz, board parado no meio da transcrição: apaga o áudio e não deixa whisper órfão", async () => {
  const { b, ouvido, caixa } = await preparar({ env: { HOME_ATRASO: "30" } });
  ouvido("Isto nunca chega.");
  ouvir(b).catch(() => {});
  await esperarArquivo(join(caixa.home, "whisper-pids"));
  const wav = readFileSync(join(caixa.home, "whisper-audios.log"), "utf8").trim();
  assert.ok(existsSync(wav), "o áudio estava lá");
  const pid = Number(readFileSync(join(caixa.home, "whisper-pids"), "utf8").trim());
  b.cp.kill("SIGTERM");
  for (let i = 0; i < 50 && b.cp.exitCode === null; i++) await esperar(100);
  assert.notEqual(b.cp.exitCode, null, "o board saiu");
  assert.ok(!existsSync(dirname(wav)), "nenhum áudio ficou");
  assert.throws(() => process.kill(pid, 0), "o whisper não ficou órfão");
});

test("Voz: ao subir, some o áudio deixado por um board morto à força; pasta recente pode ser de outro board", async () => {
  const velha = mkdtempSync(join(tmpdir(), "board-ditado-")), nova = mkdtempSync(join(tmpdir(), "board-ditado-"));
  writeFileSync(join(velha, "a.wav"), "audio"); writeFileSync(join(nova, "a.wav"), "audio");
  const hora = new Date(Date.now() - 3600000); utimesSync(velha, hora, hora);
  try {
    await preparar();
    assert.ok(!existsSync(velha), "a sobra sumiu"); assert.ok(existsSync(nova), "a recente fica");
  } finally { rmSync(velha, { recursive: true, force: true }); rmSync(nova, { recursive: true, force: true }); }
});

test("Voz, parecida com o comando: palavra por palavra, sem sobrar nada", () => {
  for (const [o, f] of [["Malovos.", "Modo voz."], ["Mal o texto.", "Modo texto."], ["Nolo texto.", "Modo texto."], ["Modo Pesto.", "Modo texto."], ["ESP.", "Espera."], ["Estare.", "Espera."], ["Pai.", "Para."], ["Hora de falar.", "Para de falar."]]) assert.ok(pareceFrase(o, f), `${o} ~ ${f}`);
  for (const [o, f] of [["Pode falar.", "Para de falar."], ["Mais texto.", "Modo texto."], ["Vai conversar.", "Vamos conversar."], ["Chega de falar.", "Para de falar."], ["Um.", "Para."], ["Sim.", "Para."], ["Maluvoz.", "Modo voz."], ["Pode mandar.", "Vamos conversar. Espera."], ["", "Para."]]) assert.ok(!pareceFrase(o, f), `${o} ≁ ${f}`);
});

test("Voz, fala: resposta longa com bandeira bem no corte é falada, sem URI malformada", async () => {
  for (let n = 415; n <= 422; n++) {
    const t = textoDaFala("z".repeat(n) + "🇧🇷🇧🇷🇧🇷 fim da frase.");
    assert.doesNotThrow(() => encodeURIComponent(t), `corte em ${n}`);
  }
  const { b } = await preparar({ conversa: ["z".repeat(419) + "🇧🇷🇧🇷 fim da frase."] });
  await b.api("POST", "/api/conversa/central", { texto: "oi" });
  await esperarEvento(b, (e) => e.t === "resultado" && e.n === 1);
  const r = await fetch(b.url + "/api/voz/fala", { method: "POST", headers: { "content-type": "application/json", origin: b.url }, body: JSON.stringify({ n: 1 }) });
  assert.equal(r.status, 200, await r.clone().text().catch(() => ""));
  assert.match(r.headers.get("content-type"), /audio/);
});

test("Voz, reconhecer: comando é frase inteira; invenção do whisper e eco não viram mensagem", () => {
  for (const [t, c] of [["Modo voz.", "ligar"], ["vamos conversar", "ligar"], ["Ok, modo texto!", "desligar"], ["para de falar", "desligar"], ["Espera.", "cortar"], ["Para!", "cortar"],
    ["Espera, espera.", "cortar"], ["Para, para.", "cortar"], ["Basta.", "cortar"], ["Para aí de falar.", "desligar"], ["Modo vos.", "ligar"],
    ["explica o modo voz", null], ["para o deploy", null], ["espera o QA terminar", null], ["modo texto do relatório", null]]) assert.equal(comandoDeVoz(t), c, t);
  for (const t of ["", "...", "♪ ♪", "[Música]", "Legendas pela comunidade Amara.org", "Board, Loja, ERP, CRM"]) assert.equal(ehInvencaoDoWhisper(t), true, t);
  for (const t of ["sim", "Obrigado", "O board caiu no Atena"]) assert.equal(ehInvencaoDoWhisper(t), false, t);
  assert.equal(ehEco("o backup rodou", "O backup rodou certinho."), true);
  assert.equal(ehEco("quanto tempo levou", "O backup rodou certinho."), false);
  assert.equal(ehEco("para", "para o deploy"), false, "palavra solta não é eco");
});

test("Tela: desligado nada ouve; o botão liga, a fala do microfone vira mensagem, a resposta fala sozinha, e o estado fica no aparelho", { skip: !CHROME }, async () => {
  const { b, ouvido, caixa } = await preparar();
  ouvido("Como está a fila?");
  // Um tom logo no começo do microfone falso: é a "fala" que a VAD tem de perceber sem ninguém clicar em mais nada.
  const nav = await tela(caixa, [[0, 1200], [220, 900], [0, 6000]]);
  try {
    await nav.carregar(b.url + "/#/central");
    await nav.avaliar(`(()=>{window.__mic=0;const g=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=(c)=>{window.__mic++;return g(c)}})()`);
    await esperarNaTela(nav, `!!$("#vozFaixa")`);
    await esperar(600);
    assert.equal(await nav.avaliar(`window.__mic + (VOZ.stream ? 1 : 0)`), 0, "com o modo desligado, ninguém abre o microfone");
    assert.match(await nav.avaliar(`$("#vozFaixa").textContent`), /nada fica ouvindo/); // Cockpit (#364): a frase mora no painel do ⚙, ao lado do trilho
    await nav.avaliar(`document.querySelector(".voz-botao").click()`);
    await esperarNaTela(nav, `!!VOZ.stream`);
    assert.equal(await nav.avaliar(`localStorage.getItem("board.vozLigado")`), "true");
    assert.match(await nav.avaliar(`$("#vozFaixa").textContent`), /SIM por voz não vale/);
    assert.match(await nav.avaliar(`$("#vozFaixa").textContent`), /Tela do aparelho bloqueada fecha o microfone/, "os limites ficam no painel, recolhidos (#307)");
    await esperarNaTela(nav, `document.querySelector(".ev.dono .voz-selo") !== null`, 15000);
    await esperarNaTela(nav, `VOZ.falas >= 1`);
    assert.match(await nav.avaliar(`$("#timeline").innerText`), /Como está a fila\?/);
    assert.match(await nav.avaliar(`$("#vozFora").innerText`), /falando/);
    await esperarNaTela(nav, `VOZ.fase === "ouvindo" && !VOZ.fala`);
    // Volta à tela: o modo guardado no aparelho reabre o microfone
    await nav.carregar(b.url + "/#/central");
    await esperarNaTela(nav, `!!VOZ.stream`);
    await nav.avaliar(`document.querySelector(".voz-botao").click()`);
    await esperarNaTela(nav, `VOZ.stream === null && !VOZ.ligado()`);
    assert.deepEqual(nav.erros, []);
  } finally { await nav.fechar(); }
});

test("Tela: falar por cima pausa a voz; 'espera' corta, eco retoma, e o microfone não ouve a própria fala nos primeiros instantes", { skip: !CHROME }, async () => {
  const { b, ouvido, caixa } = await preparar({ conversa: ["O backup rodou certinho no servidor.", "ok"] });
  writeFileSync(join(caixa.home, "fala-ms"), "20000");
  const nav = await tela(caixa, [[0, 30000]]);
  try {
    await nav.carregar(b.url + "/#/central");
    await esperarNaTela(nav, `!!$("#vozFaixa")`);
    await nav.avaliar(`store.set("vozLigado", true); vozAplicar()`);
    await esperarNaTela(nav, `!!VOZ.stream`);
    await b.api("POST", "/api/conversa/central", { texto: "e o backup?" });
    await esperarNaTela(nav, `VOZ.fase === "falando"`);
    await nav.avaliar(soar(0.3, 300)); // o som entrando logo que a voz começa é ela mesma: não interrompe
    assert.equal(await nav.avaliar(`VOZ.fala.pausada`), false, "nos primeiros 500 ms não há interrupção");
    await nav.avaliar(soar(0, 100));
    await esperar(600);
    // Eco que sobrou: passou do limiar, foi transcrito e era a própria fala → a voz continua de onde parou
    ouvido("o backup rodou certinho");
    await nav.avaliar(soar(0.9, 500)); // acima do eco medido no começo da fala
    assert.equal(await nav.avaliar(`VOZ.fala.pausada`), true, "falou por cima: a voz para na hora");
    const pos = await nav.avaliar(`VOZ.fala.pos`);
    assert.ok(pos > 0.3);
    await nav.avaliar(soar(0, 1700));
    await esperarNaTela(nav, `VOZ.fala && !VOZ.fala.pausada && VOZ.fase === "falando"`);
    // Agora é o dono: "espera" corta de vez e não vira mensagem
    await esperar(100);
    ouvido("Espera.");
    await nav.avaliar(soar(0.9, 500));
    await nav.avaliar(soar(0, 1700));
    await esperarNaTela(nav, `!VOZ.fala && VOZ.fase === "ouvindo"`);
    assert.equal((await eventos(b)).filter((e) => e.t === "dono").length, 1, "só a mensagem original");
    assert.equal(await nav.avaliar(`VOZ.falas`), 1);
    // ⏹ na tela: comando por voz para desligar
    ouvido("Modo texto.");
    await nav.avaliar(soar(0.3, 500));
    await nav.avaliar(soar(0, 1700));
    await esperarNaTela(nav, `!VOZ.ligado() && VOZ.stream === null`);
  } finally { await nav.fechar(); }
});

test("Tela: sem cancelamento de eco o microfone fica mudo durante a fala; pedido de SIM é lido e o Aprovar continua no botão", { skip: !CHROME }, async () => {
  const { b, ouvido, caixa } = await preparar({ conversa: ["Pronto.\n\nPEDIDO DE SIM: mesclar o PR #112 do alfa", "ok"] });
  writeFileSync(join(caixa.home, "fala-ms"), "6000");
  const nav = await tela(caixa, [[0, 30000]]);
  try {
    await nav.carregar(b.url + "/#/central");
    await esperarNaTela(nav, `!!$("#vozFaixa")`);
    await nav.avaliar(`VOZ.testeSemEco = true; store.set("vozLigado", true); vozAplicar()`);
    await esperarNaTela(nav, `!!VOZ.stream`);
    await esperarNaTela(nav, `/não cancelou o eco/.test($("#vozFaixa").textContent)`);
    // Cockpit (#364): com o painel fechado, o ⚙ do trilho mostra que há aviso
    assert.equal(await nav.avaliar(`getComputedStyle($(".voz-abrir"), "::after").content`), '"!"', "o ⚙ avisa que há aviso no painel");
    await b.api("POST", "/api/conversa/central", { texto: "posso mesclar?" });
    await esperarNaTela(nav, `VOZ.fase === "falando"`);
    assert.match(await nav.avaliar(`VOZ.fala.texto`), /Preciso do seu sim para: mesclar o PR 112 do alfa\. Aprove no botão/);
    await esperar(600);
    await nav.avaliar(soar(0.3, 600)); await nav.avaliar(soar(0, 1700));
    assert.equal(await nav.avaliar(`VOZ.fala.pausada`), false, "o som não interrompe");
    assert.equal(await nav.avaliar(`VOZ.ouvidas`), 0, "nem vai para o whisper");
    assert.equal(await nav.avaliar(`!!document.querySelector(".pedido-sim button")`), true, "o botão Aprovar segue na tela");
    await nav.avaliar(`document.querySelector("#vozForaParar").click()`);
    await esperarNaTela(nav, `!VOZ.fala`);
    ouvido("Sim");
    await nav.avaliar(soar(0.3, 500)); await nav.avaliar(soar(0, 1700));
    await esperarNaTela(nav, `document.querySelector(".ev.dono .voz-selo") !== null`);
    const ap = registro(caixa).at(-1);
    assert.equal(ap.origem, "voz");
    assert.equal(conferir(caixa, b, ap.id, "mesclar o PR #112 do alfa").code, 1);
  } finally { await nav.fechar(); }
});

test("Tela: com a escuta do comando ligada só 'modo voz' liga; sem o Piper a fala cai na voz do navegador", { skip: !CHROME }, async () => {
  const { b, ouvido, caixa } = await preparar({ piper: false });
  const nav = await tela(caixa, [[0, 30000]], { largura: 390, altura: 800 });
  try {
    await nav.carregar(b.url + "/#/central");
    await esperarNaTela(nav, `!!$("#vozComando")`);
    assert.equal(await nav.avaliar(`document.documentElement.scrollWidth <= innerWidth`), true, "cabe no celular");
    await nav.avaliar(`window.__falado=[];speechSynthesis.speak=(u)=>{window.__falado.push(u);setTimeout(()=>u.onend&&u.onend(),50)}`);
    await nav.avaliar(`$("#vozComando").click()`);
    await esperarNaTela(nav, `!!VOZ.stream`);
    assert.match(await nav.avaliar(`$("#vozFaixa").textContent`), /só à espera do comando/);
    ouvido("qual o saldo do cliente");
    await nav.avaliar(soar(0.3, 500)); await nav.avaliar(soar(0, 1700));
    await esperarNaTela(nav, `VOZ.ultima && VOZ.ultima.nada`);
    assert.equal(await nav.avaliar(`VOZ.ligado()`), false);
    assert.equal((await eventos(b)).length, 0, "nada foi para a Central");
    ouvido("Modo voz.");
    await nav.avaliar(soar(0.3, 500)); await nav.avaliar(soar(0, 1700));
    await esperarNaTela(nav, `VOZ.ligado()`);
    await esperarNaTela(nav, `/voz é a do navegador/.test($("#vozFaixa").textContent)`);
    assert.equal(await nav.avaliar(`$("#vozFaixa").getBoundingClientRect().bottom <= $(".chatbox").getBoundingClientRect().top + 1`), true, "a faixa não fica atrás da caixa de escrever");
    await b.api("POST", "/api/conversa/central", { texto: "oi" });
    await esperarNaTela(nav, `window.__falado.length === 1`);
    assert.equal(await nav.avaliar(`window.__falado[0].text`), "Tudo certo por aqui.");
    assert.equal(await nav.avaliar(`window.__falado[0].lang`), "pt-BR");
    await esperarNaTela(nav, `!VOZ.fala`);
    assert.equal(await nav.avaliar(`document.documentElement.scrollWidth <= innerWidth`), true, "a faixa ligada cabe no celular");
  } finally { await nav.fechar(); }
});

test("Tela: microfone recusado volta ao texto e diz por quê; nada fica ligado", { skip: !CHROME }, async () => {
  const { b, caixa } = await preparar();
  const nav = await tela(caixa, [[0, 1000]]);
  try {
    await nav.carregar(b.url + "/#/central");
    await esperarNaTela(nav, `!!$("#vozFaixa")`);
    await nav.avaliar(`navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error("Permission denied"))`);
    await nav.avaliar(`document.querySelector(".voz-botao").click()`);
    await esperarNaTela(nav, `!VOZ.ligado() && /Permission denied/.test(document.body.innerText)`);
    assert.equal(await nav.avaliar(`document.querySelector(".voz-botao").getAttribute("aria-pressed")`), "false");
    assert.equal(await nav.avaliar(`VOZ.stream`), null);
  } finally { await nav.fechar(); }
});

test("Tela: microfone que falha depois de aberto é solto, e aba escondida com o módulo carregando não deixa ouvindo", { skip: !CHROME }, async () => {
  const { b, caixa } = await preparar();
  const nav = await tela(caixa, [[0, 30000]]);
  // Guarda as trilhas que a tela recebeu: VOZ.stream pode não saber delas, que é o defeito.
  const espiar = `window.__trilhas=[];{const g=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async(c)=>{const s=await g(c);window.__trilhas.push(...s.getTracks());return s}}`;
  const soltas = `window.__trilhas.length>0&&window.__trilhas.every((t)=>t.readyState==="ended")`;
  try {
    await nav.carregar(b.url + "/#/central");
    await esperarNaTela(nav, `!!$("#vozFaixa")`);
    await nav.avaliar(espiar);
    await nav.avaliar(`window.__addModule=AudioWorklet.prototype.addModule;AudioWorklet.prototype.addModule=()=>Promise.reject(new Error("módulo quebrado"))`);
    await nav.avaliar(`document.querySelector(".voz-botao").click()`);
    await esperarNaTela(nav, `!VOZ.ligado() && /módulo quebrado/.test(document.body.innerText)`);
    assert.equal(await nav.avaliar(soltas), true, "addModule falhou: o microfone tem de estar fechado");
    // Agora o módulo demora, e a aba some da vista no meio
    await nav.avaliar(`window.__trilhas=[];window.__solta=null;AudioWorklet.prototype.addModule=function(u){const p=new Promise((r)=>{window.__solta=r});return p.then(()=>window.__addModule.call(this,u))}`);
    await nav.avaliar(`document.querySelector(".voz-botao").click()`);
    await esperarNaTela(nav, `!!window.__solta`);
    await nav.avaliar(`Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange"))`);
    await esperar(200);
    await nav.avaliar(`window.__solta()`);
    await esperarNaTela(nav, soltas);
    assert.equal(await nav.avaliar(`VOZ.stream`), null);
    assert.equal(await nav.avaliar(`VOZ.abrindo`), false);
  } finally { await nav.fechar(); }
});

test("Tela: resposta que chega durante um som curto é falada quando ele é descartado; 'espera' cala o que estava na vez", { skip: !CHROME }, async () => {
  const { b, ouvido, caixa } = await preparar({ conversa: ["Primeira resposta.", "Segunda resposta."] });
  const nav = await tela(caixa, [[0, 60000]]);
  const prender = `VOZ.vad.pausaMs = 60000`, soltar = `VOZ.vad.pausaMs = 1500`; // o silêncio do microfone falso não encerra o trecho antes da hora
  try {
    await nav.carregar(b.url + "/#/central");
    await esperarNaTela(nav, `!!$("#vozFaixa")`);
    await nav.avaliar(`store.set("vozLigado", true); vozAplicar()`);
    await esperarNaTela(nav, `!!VOZ.stream`);
    // Tosse de 200 ms (o tamanho de um "para"): grava, a resposta chega no meio, e o whisper não ouve nada nela
    await nav.avaliar(prender);
    await nav.avaliar(soar(0.3, 200));
    await esperarNaTela(nav, `VOZ.fase === "gravando"`);
    await b.api("POST", "/api/conversa/central", { texto: "primeira" });
    await esperarNaTela(nav, `VOZ.fila.length === 1`);
    assert.equal(await nav.avaliar(`VOZ.falas`), 0, "não fala por cima de quem pode estar falando");
    await nav.avaliar(soltar);
    await nav.avaliar(soar(0, 1700));
    await esperarNaTela(nav, `VOZ.falas === 1`);
    await esperarNaTela(nav, `!VOZ.fala`);
    assert.equal(await nav.avaliar(`VOZ.ouvidas`), 1, "só a tosse foi ao whisper, e a resposta saiu mesmo assim");
    // Agora ele fala de verdade, "espera", com a resposta seguinte na vez: ela é calada de propósito
    await nav.avaliar(prender);
    await nav.avaliar(soar(0.3, 500));
    await b.api("POST", "/api/conversa/central", { texto: "segunda" });
    await esperarNaTela(nav, `VOZ.fila.length === 1`);
    ouvido("Espera.");
    await nav.avaliar(soltar);
    await nav.avaliar(soar(0, 1700));
    await esperarNaTela(nav, `VOZ.ultima?.comando === "cortar"`);
    await esperar(400);
    assert.deepEqual(await nav.avaliar(`[VOZ.fila.length, VOZ.falas, VOZ.fase]`), [0, 1, "ouvindo"]);
    assert.match(await nav.avaliar(`$("#timeline").innerText`), /Segunda resposta\./, "o texto continua na tela");
  } finally { await nav.fechar(); }
});

test("Voz, envio quebrado: upload cortado, JSON inválido e áudio grande demais recebem erro e o board segue no ar", async () => {
  const { b } = await preparar();
  const vivo = async (caso) => { await esperar(300); assert.equal(b.cp.exitCode, null, `${caso}: o board caiu`); assert.equal((await b.api("GET", "/api/state")).status, 200, caso); };
  await new Promise((pronto) => {
    const s = connect(b.porta, "127.0.0.1", () => {
      s.write(`POST /api/voz/ouvir?modo=conversa HTTP/1.1\r\nHost: 127.0.0.1:${b.porta}\r\nOrigin: ${b.url}\r\nContent-Type: audio/wav\r\nContent-Length: 100000\r\n\r\nRIFF`);
      setTimeout(() => { s.destroy(); pronto(); }, 200);
    });
  });
  await vivo("upload cortado");
  const r = await fetch(b.url + "/api/voz/fala", { method: "POST", headers: { "content-type": "application/json", origin: b.url }, body: "{isto não é json" });
  assert.equal(r.status, 400);
  await vivo("JSON inválido");
  const grande = await ouvir(b, "modo=conversa", { audio: Buffer.alloc(13 * 1024 * 1024) });
  assert.equal(grande.status, 413);
  await vivo("áudio grande demais");
});

test("Tela: sem Piper e sem voz no navegador a resposta fica só escrita, sem erro", { skip: !CHROME }, async () => {
  const { b, caixa } = await preparar({ piper: false });
  const nav = await tela(caixa, [[0, 30000]]);
  try {
    await nav.carregar(b.url + "/#/central");
    await esperarNaTela(nav, `!!$("#vozFaixa")`);
    // Só os avisos contam: o rótulo do botão ("🎙 Modo voz: ligado") também diz "Modo voz:" (a QA pegou o teste caindo nele)
    await nav.avaliar(`window.avisos = []; { const original = toast; toast = (m, ...r) => { avisos.push(String(m)); return original(m, ...r); }; }`);
    await nav.avaliar(`Object.defineProperty(window, "speechSynthesis", { value: undefined, configurable: true }); store.set("vozLigado", true); vozAplicar()`);
    await esperarNaTela(nav, `!!VOZ.stream`);
    await b.api("POST", "/api/conversa/central", { texto: "oi" });
    await esperarNaTela(nav, `VOZ.falas === 1 && !VOZ.fala && VOZ.fase === "ouvindo"`);
    assert.deepEqual((await nav.avaliar(`avisos`)).filter((m) => /Cannot set|Modo voz:/.test(m)), [], "nenhum aviso de erro");
    assert.match(await nav.avaliar(`$("#timeline").innerText`), /Tudo certo por aqui\./);
  } finally { await nav.fechar(); }
});

test("Tela: resposta que esperava a vez é falada mesmo quando o trecho do dono vira mensagem", { skip: !CHROME }, async () => {
  const { b, ouvido, caixa } = await preparar({ conversa: ["Primeira resposta.", "Segunda resposta."] });
  writeFileSync(join(caixa.home, "fala-ms"), "2500");
  const nav = await tela(caixa, [[0, 60000]]);
  try {
    await nav.carregar(b.url + "/#/central");
    await esperarNaTela(nav, `!!$("#vozFaixa")`);
    await nav.avaliar(`store.set("vozLigado", true); vozAplicar()`);
    await esperarNaTela(nav, `!!VOZ.stream`);
    await nav.avaliar(`VOZ.vad.pausaMs = 60000`);
    await nav.avaliar(soar(0.3, 500));
    await b.api("POST", "/api/conversa/central", { texto: "primeira" });
    await esperarNaTela(nav, `VOZ.fila.length === 1`);
    ouvido("E a segunda pergunta?");
    await nav.avaliar(`VOZ.vad.pausaMs = 1500`);
    await nav.avaliar(soar(0, 1700));
    await esperarNaTela(nav, `VOZ.fala && VOZ.fala.n === 1`);
    await esperarNaTela(nav, `VOZ.fala && VOZ.fala.n === 2`);
    assert.equal(await nav.avaliar(`document.querySelectorAll(".ev.dono .voz-selo").length`), 1, "o trecho virou mensagem");
  } finally { await nav.fechar(); }
});

test("Tela: a amostra da voz fecha o ouvido: a voz dela no microfone não vai ao whisper nem à Central", { skip: !CHROME }, async () => {
  const { b, caixa } = await preparar();
  writeFileSync(join(caixa.home, "fala-ms"), "4000");
  const nav = await tela(caixa, [[0, 30000]]);
  try {
    await nav.carregar(b.url + "/#/central");
    await esperarNaTela(nav, `!!$("#vozFaixa")`);
    await nav.avaliar(`store.set("vozLigado", true); vozAplicar()`);
    await esperarNaTela(nav, `!!VOZ.stream && !!$("#vozVozes button")`);
    for (const semEco of [false, true]) { // com eco cancelado, e sem ele (o caso em que a caixa de som entra inteira no microfone)
      await nav.avaliar(`VOZ.semEco = ${semEco}; $("#vozVozes button").click()`);
      await esperarNaTela(nav, `VOZ.fala?.amostra === true && VOZ.fase === "falando"`);
      assert.equal(await nav.avaliar(`$("#vozForaParar").hidden`), false, "dá para cortar pelo botão");
      await esperar(600); // passou da janela de 500 ms em que o microfone já é ignorado em qualquer fala
      await nav.avaliar(soar(0.9, 600)); await nav.avaliar(soar(0, 1700));
      assert.deepEqual(await nav.avaliar(`[VOZ.ouvidas, VOZ.falas, !!VOZ.fala?.pausada]`), [0, 0, false], `semEco=${semEco}: a amostra não conta como fala nem pausa`);
      await nav.avaliar(`$("#vozForaParar").click()`);
      await esperarNaTela(nav, `!VOZ.fala && VOZ.fase === "ouvindo"`);
    }
    assert.ok(!existsSync(join(caixa.home, "whisper.log")), "nada foi transcrito");
    assert.equal((await eventos(b)).length, 0, "nada chegou à Central");
  } finally { await nav.fechar(); }
});

test("Tela: com ruído constante a VAD aprende o piso, não manda ruído ao whisper e a fala acima dele termina na pausa", { skip: !CHROME }, async () => {
  const { b, caixa } = await preparar();
  const nav = await tela(caixa, [[0, 1000]]);
  try {
    await nav.carregar(b.url + "/#/central");
    await esperarNaTela(nav, `typeof VadVoz === "function"`);
    const deCara = await nav.avaliar(`(()=>{ let t=0; const v=new VadVoz({taxa:48000,pausaMs:1500,aoTerminar:()=>t++}); const n=(x)=>new Float32Array(2400).fill(x);
      for(let i=0;i<30;i++)v.quadro(n(0.2)); for(let i=0;i<32;i++)v.quadro(n(0.001)); return t; })()`);
    assert.equal(deCara, 1, "microfone recém-aberto: quem fala logo de cara é ouvido");
    for (const ruido of [0.012, 0.03]) {
      const r = await nav.avaliar(`(()=>{
        let trechos=[], comecos=0, i=0;
        const v=new VadVoz({taxa:48000,pausaMs:1500,aoComecar:()=>comecos++,aoTerminar:(p)=>trechos.push(p.length*50),aoDescartar:()=>{}});
        const nivel=(x)=>new Float32Array(2400).fill(x);
        const som=(x,ms)=>{for(let k=0;k<ms/50;k++)v.quadro(nivel(x*(1+0.1*Math.sin(i++/7))));}; // ruído de verdade oscila um pouco
        som(0.001,5000);                             // sala em silêncio
        som(${ruido},600000);                        // liga o ventilador: 10 min
        const soRuido=[comecos,trechos.length,v.emFala];
        const pisoAntes=v.piso;
        som(0.2,2000); const durante=v.emFala;       // o dono fala 2 s
        som(${ruido},1400); const antesDaPausa=trechos.length;
        som(${ruido},300);  const depoisDaPausa=trechos.length;
        const c1=trechos[0];
        for(let k=0;k<20;k++){som(0.2,300);som(${ruido},150);}  // 9 s de fala com vales entre as sílabas
        const longa=[v.emFala,v.piso<${ruido}*1.5];
        som(${ruido},1700);
        return {soRuido,pisoAntes,durante,antesDaPausa,depoisDaPausa,c1,longa,fim:trechos.length,ultimo:trechos.at(-1)};
      })()`);
      assert.equal(r.soRuido[0], 1, `ruído ${r.soRuido}: dispara uma vez, quando o ruído começa`);
      assert.equal(r.soRuido[1], 0, "ruído constante não vai ao whisper");
      assert.equal(r.soRuido[2], false, "e a VAD não fica presa em fala");
      assert.ok(Math.abs(r.pisoAntes - ruido) < ruido * 0.2, `aprendeu o piso: ${r.pisoAntes}`);
      assert.equal(r.durante, true, "a fala acima do ruído é percebida");
      assert.deepEqual([r.antesDaPausa, r.depoisDaPausa], [0, 1], "a fala termina na pausa, com o ruído ainda ligado");
      assert.ok(r.c1 < 5000, `sem levar o ruído junto: ${r.c1} ms`);
      assert.deepEqual(r.longa, [true, true], "fala longa com vales não sobe o piso nem é cortada");
      assert.equal(r.fim, 2); assert.ok(r.ultimo >= 9000 && r.ultimo < 12000, `um trecho só: ${r.ultimo} ms`);
    }
    void b;
  } finally { await nav.fechar(); }
});

test("Tela: a VAD espera a pausa escolhida, ignora estalo de 100 ms, aceita um para de 200 ms e leva o começo da fala junto", { skip: !CHROME }, async () => {
  const { b, caixa } = await preparar();
  const nav = await tela(caixa, [[0, 1000]]);
  try {
    await nav.carregar(b.url + "/#/central");
    await esperarNaTela(nav, `typeof VadVoz === "function"`);
    const r = await nav.avaliar(`(()=>{
      const blocos=[]; let fim=[], comecos=0, desc=0;
      const v=new VadVoz({taxa:48000,pausaMs:1500,aoComecar:()=>comecos++,aoTerminar:(p)=>fim.push(p.length),aoDescartar:()=>desc++});
      const b=(rms)=>new Float32Array(2400).fill(rms);
      for(let i=0;i<40;i++)v.quadro(b(0.002));                // ambiente
      for(let i=0;i<2;i++)v.quadro(b(0.2));                   // 100 ms: não começa
      for(let i=0;i<10;i++)v.quadro(b(0.002));
      const estalo=comecos;
      for(let i=0;i<4;i++)v.quadro(b(0.2));                   // 200 ms: um "para" dito solto
      for(let i=0;i<31;i++)v.quadro(b(0.002));
      const curto=[comecos,desc,fim.length];
      for(let i=0;i<30;i++)v.quadro(b(0.2));                  // 1,5 s de fala
      for(let i=0;i<29;i++)v.quadro(b(0.002));                // 1,45 s de silêncio: ainda não acabou
      const antes=fim.length;
      for(let i=0;i<2;i++)v.quadro(b(0.002));
      const w=wavDeVoz([new Float32Array(48000).fill(0.5)],48000);
      return {estalo,curto,antes,fim,bytes:w.size};
    })()`);
    assert.equal(r.estalo, 0, "estalo de 100 ms não é fala");
    assert.deepEqual(r.curto, [1, 0, 1], "200 ms bastam: é o tamanho de um 'para' (achado da QA)");
    assert.equal(r.antes, 1, "antes da pausa de 1,5 s não manda");
    assert.equal(r.fim.length, 2);
    assert.ok(r.fim[1] >= 30 + 30, `leva o que veio antes de disparar e o silêncio: ${r.fim[1]} blocos`);
    assert.equal(r.bytes, 44 + 32000, "1 s vira WAV de 16 kHz");
    void b;
  } finally { await nav.fechar(); }
});
