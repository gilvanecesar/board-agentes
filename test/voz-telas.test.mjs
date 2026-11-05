// 🎙 Modo voz em qualquer tela (#296: "quando eu mudar de tela não pode interromper o que está sendo falado; tem de ser um diálogo").
// Chrome de verdade com microfone falso; whisper e Piper falsos. O que morde: trocar de tela no meio da fala e no meio da escuta.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { esperar } from "./ajuda.mjs";
import { comChrome, conferir, esconder, esperarEvento, esperarNaTela, eventos, ligada, limparVoz, parar, preparar, recarregar, registro, soar, tela } from "./voz-ajuda.mjs";

afterEach(limparVoz);
const TELAS = ["board", "conversa", "sessoes", "busca", "prs", "controle"]; // Navegador, Memória, Consumo e Monitoramento saíram em 04/11


test("Tela: trocar de tela no meio da fala não corta: a mesma voz segue tocando até o fim, com o microfone aberto", comChrome, async () => {
  const { b, caixa } = await preparar({ conversa: ["O backup rodou certinho no servidor."] });
  writeFileSync(join(caixa.home, "fala-ms"), "4000");
  const nav = await tela(caixa, [[0, 30000]]);
  try {
    await ligada(nav, b);
    await nav.avaliar(`window.__s = VOZ.stream; 1`);
    await b.api("POST", "/api/conversa/central", { texto: "e o backup?" });
    await esperarNaTela(nav, `VOZ.fase === "falando"`);
    await nav.avaliar(`window.__f = VOZ.fala; window.__fonte = VOZ.fala.fonte; window.__t0 = performance.now(); 1`);
    for (const t of ["controle", "prs", "sessoes"]) {
      await nav.avaliar(`navigateBoard("${t}")`);
      await esperarNaTela(nav, `!!$("#vozFora")`);
    }
    await nav.avaliar(`location.hash = "#/busca"`);
    await esperar(200);
    assert.equal(await nav.avaliar(`VOZ.fala === window.__f && VOZ.fala.fonte === window.__fonte && !VOZ.fala.pausada`), true, "a mesma fala, sem pausar nem recomeçar");
    assert.equal(await nav.avaliar(`VOZ.stream === window.__s && VOZ.stream.active`), true, "o mesmo microfone, sem reabrir");
    assert.match(await nav.avaliar(`$("#vozFora").innerText`), /falando/);
    assert.equal(await nav.avaliar(`$("#vozForaParar").hidden`), false, "dá para parar a fala daqui");
    await esperarNaTela(nav, `!VOZ.fala`);
    assert.ok(await nav.avaliar(`performance.now() - window.__t0`) > 3000, "tocou até o fim, não foi cortada");
    assert.equal(await nav.avaliar(`VOZ.falas`), 1);
    assert.equal(await nav.avaliar(`VOZ.fase`), "ouvindo", "volta a ouvir, sem voltar à Central");
    assert.match(await nav.avaliar(`$("#vozFora").innerText`), /ouvindo/);
    assert.equal(await nav.avaliar(`$("#vozForaParar").hidden`), true, "sem fala, sem botão de parar");
    assert.deepEqual(nav.erros, []);
  } finally { await nav.fechar(); }
});

test("Tela: trocar de tela no meio da escuta: o trecho segue inteiro, vai à Central, a resposta é falada na tela onde ele está, e SIM falado não vale", comChrome, async () => {
  const { b, ouvido, caixa } = await preparar({ conversa: ["Posso?\n\nPEDIDO DE SIM: mesclar o PR #112 do alfa", "Repita no botão."] });
  const nav = await tela(caixa, [[0, 60000]]);
  try {
    await ligada(nav, b);
    ouvido("Quero mesclar o PR do alfa.");
    await nav.avaliar(soar(0.3, 400));
    await esperarNaTela(nav, `VOZ.fase === "gravando"`);
    await nav.avaliar(`navigateBoard("controle")`);
    await esperarNaTela(nav, `/ouvindo você/.test($("#vozFora")?.innerText || "")`);
    await nav.avaliar(`location.hash = "#/prs"`);
    await nav.avaliar(soar(0.3, 400)); // continua falando na tela nova
    await parar(nav);
    await esperarNaTela(nav, `VOZ.falas === 1`);
    assert.equal(await nav.avaliar(`VOZ.ouvidas`), 1, "um trecho só: trocar de tela não partiu a fala");
    assert.equal(await nav.avaliar(`location.hash`), "#/prs", "não voltou à Central");
    assert.equal(await nav.avaliar(`document.body.classList.contains("com-voz")`), true);
    const evs = await eventos(b);
    assert.equal(evs.find((e) => e.t === "dono").voz, true, "chegou marcada como falada");
    await esperarNaTela(nav, `!VOZ.fala`);
    // 🔴 O "sim" falado fora da Central continua não valendo, e nada de áudio guardado
    ouvido("Sim");
    await nav.avaliar(soar(0.3, 400)); await parar(nav);
    await esperarEvento(b, (e) => e.t === "resultado" && e.n === 2);
    const ap = registro(caixa).at(-1);
    assert.equal(ap.origem, "voz");
    const nao = conferir(caixa, b, ap.id, "mesclar o PR #112 do alfa");
    assert.equal(nao.code, 1); assert.match(nao.out, /SIM por voz não vale/);
    for (const wav of readFileSync(join(caixa.home, "whisper-audios.log"), "utf8").trim().split("\n")) assert.ok(!existsSync(wav), "o áudio foi apagado");
    assert.deepEqual(nav.erros, []);
  } finally { await nav.fechar(); }
});

test("Tela: falar por cima vale fora da Central: 'espera' corta, outra coisa vira mensagem, e a tela onde ele está não rola sozinha", comChrome, async () => {
  const { b, ouvido, caixa } = await preparar({ conversa: ["O backup rodou certinho no servidor.", "Levou dez minutos."] });
  writeFileSync(join(caixa.home, "fala-ms"), "20000");
  const nav = await tela(caixa, [[0, 60000]]);
  try {
    await ligada(nav, b);
    await nav.avaliar(`navigateBoard("controle")`);
    await esperarNaTela(nav, `!!$("#vozFora")`);
    await b.api("POST", "/api/conversa/central", { texto: "e o backup?" });
    await esperarNaTela(nav, `VOZ.fase === "falando"`);
    await esperar(600);
    await nav.avaliar(`window.__rolou = 0; { const r = rolarProFim; rolarProFim = (...a) => { window.__rolou++; return r(...a); }; }`);
    ouvido("Atena, quanto tempo levou?");
    await nav.avaliar(soar(0.9, 500));
    assert.equal(await nav.avaliar(`VOZ.fala.pausada`), true, "falou por cima: a voz para na hora");
    await parar(nav);
    await esperarNaTela(nav, `document.querySelector("#vozFora") && VOZ.falas === 2`);
    assert.equal(await nav.avaliar(`window.__rolou`), 0, "fora da Central não mexe na rolagem");
    await esperar(600);
    ouvido("Espera.");
    await nav.avaliar(soar(0.9, 500)); await parar(nav);
    await esperarNaTela(nav, `!VOZ.fala && VOZ.fase === "ouvindo"`);
    assert.equal(await nav.avaliar(`VOZ.falas`), 2);
    assert.equal((await eventos(b)).filter((e) => e.t === "dono").length, 2, "'espera' não virou mensagem");
  } finally { await nav.fechar(); }
});

test("Tela: em TODA tela o indicador mostra o estado e os botões; ⏹ corta só a fala; Desligar fecha tudo, e só ele", comChrome, async () => {
  for (const [largura, altura] of [[1440, 900], [390, 800]]) {
    const { b, caixa } = await preparar({ conversa: ["Primeira.", "Segunda."] });
    writeFileSync(join(caixa.home, "fala-ms"), "20000");
    const nav = await tela(caixa, [[0, 60000]], { largura, altura });
    try {
      await ligada(nav, b);
      assert.match(await nav.avaliar(`$("#vozFora").innerText`), /ouvindo/, "a barra também na Central");
      assert.equal(await nav.avaliar(`document.querySelectorAll("#vozForaParar, #vozParar").length`), 1, "um ⏹ só");
      assert.match(await nav.avaliar(`$("#vozFaixa").textContent`), /em qualquer tela/); // os limites, recolhidos no painel do menu (#307)
      for (const t of TELAS) {
        await nav.avaliar(`navigateBoard("${t}")`);
        await esperarNaTela(nav, `/ouvindo/.test($("#vozFora")?.innerText || "") && !!VOZ.stream`);
        assert.equal(await nav.avaliar(`$("#vozForaDesligar").offsetHeight > 0`), true, t);
        assert.equal(await nav.avaliar(`document.documentElement.scrollWidth <= innerWidth`), true, `${t} cabe em ${largura}`);
        // Rolada para o alto (a conversa desce sozinha até o fim): o aviso fixo não pode cobrir o começo da tela
        if (largura < 760) assert.equal(await nav.avaliar(`(scrollTo(0, 0), $("#vozFora").getBoundingClientRect().bottom <= $("#navigation").getBoundingClientRect().top + 1)`), true, t);
      }
      for (const h of [`#/t/99999`, `#/c/alfa`, `#/agentes`]) {
        await nav.avaliar(`location.hash = "${h}"`);
        await esperarNaTela(nav, `!!$("#vozFora") && !!VOZ.stream`);
      }
      await b.api("POST", "/api/conversa/central", { texto: "oi" });
      await esperarNaTela(nav, `VOZ.fase === "falando" && !$("#vozForaParar").hidden`);
      await nav.avaliar(`$("#vozForaParar").click()`);
      await esperarNaTela(nav, `!VOZ.fala && VOZ.fase === "ouvindo"`);
      assert.equal(await nav.avaliar(`VOZ.ligado() && !!VOZ.stream`), true, "parar a fala não desliga o modo");
      await nav.avaliar(`$("#vozForaDesligar").click()`);
      await esperarNaTela(nav, `VOZ.stream === null && !VOZ.ligado() && !$("#vozFora")`);
      assert.equal(await nav.avaliar(`document.body.classList.contains("com-voz")`), false);
      assert.deepEqual(nav.erros, []);
    } finally { await nav.fechar(); await limparVoz(); }
  }
});

// A barra não cobre a tela: no menu do computador (#307) fica à esquerda dela; presa no alto do celular, acima do começo.
const FORA_DO_APP = `(() => { const a = $("#vozFora").getBoundingClientRect(), app = $("#app").getBoundingClientRect(); return getComputedStyle($("#vozFora")).position === "fixed" ? a.bottom <= app.top : !!$("#vozFora").closest("#navigation") && a.right <= app.left; })()`;
// Sobrepõe em área? `sel` pode ter vários; só conta o que está desenhado.
const sobrepoe = (sel) => `(() => { const a = $("#vozFora").getBoundingClientRect(); return [...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => { const b = e.getBoundingClientRect(); return b.width && b.height && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom; }).length; })()`;
test("Tela: o aviso nunca tampa a caixa de escrever, o menu nem o cabeçalho preso: com fala, rolado, em cada largura (QA da #296)", comChrome, async () => {
  const { b, caixa } = await preparar({ conversa: ["Resposta da Central."] });
  writeFileSync(join(caixa.home, "fala-ms"), "60000");
  caixa.cenario({ conversa: ["Resposta da Central."] });
  const t = (await b.api("POST", "/api/tasks", { text: "tarefa com histórico", project: "alfa", queue: false })).json.tasks[0];
  for (let i = 0; i < 6; i++) { await b.api("POST", `/api/tasks/${t.id}/chat`, { text: `pergunta ${i}\n\nlinha\n\nlinha\n\nlinha\n\nlinha\n\nlinha` }).catch(() => {}); await esperar(500); }
  const nav = await tela(caixa, [[0, 120000]], { largura: 1280, altura: 720 });
  try {
    await ligada(nav, b);
    await b.api("POST", "/api/conversa/central", { texto: "oi" });
    await esperarNaTela(nav, `VOZ.fase === "falando"`); // com a fala, o ⏹ deixa o aviso no maior tamanho
    for (const [largura, altura] of [[1280, 720], [1024, 768], [810, 1080], [390, 800]]) {
      await nav.tamanho(largura, altura);
      for (const h of [`#/t/${t.id}`, `#/c/alfa`]) {
        await nav.avaliar(`location.hash = "${h}"`);
        await esperarNaTela(nav, `!!$("#vozFora") && !!$(".chatbox textarea")`);
        await esperar(300);
        const onde = `${h} em ${largura}x${altura}`;
        for (const y of [0, 300, 99999]) {
          await nav.avaliar(`scrollTo(0, ${y}); 1`);
          await esperar(100);
          assert.equal(await nav.avaliar(sobrepoe(".chatbox")), 0, `caixa de escrever, ${onde}, y=${y}`);
          if (largura > 760 || y === 0) assert.equal(await nav.avaliar(sobrepoe(".nav-item")), 0, `menu, ${onde}, y=${y}`);
          // No celular o .dtop é static: rola como o resto da tela. Só o preso ficaria atrás do aviso para sempre.
          if (await nav.avaliar(`getComputedStyle($(".dtop")).position === "sticky"`)) assert.equal(await nav.avaliar(sobrepoe(".dtop")), 0, `cabeçalho preso, ${onde}, y=${y}`);
          assert.equal(await nav.avaliar(`(() => { const r = $(".chatbox textarea").getBoundingClientRect(); return !!document.elementFromPoint(r.left + 10, r.top + r.height / 2)?.closest(".chatbox"); })()`), true, `clicar no início da caixa, ${onde}, y=${y}`);
        }
        await nav.avaliar(`scrollTo(0, 0); 1`);
        await esperar(100);
        // #307: no computador a barra é o alto do painel do menu, ao lado da tela; no celular ela se prende no alto, acima do começo.
        assert.equal(await nav.avaliar(FORA_DO_APP), true, `o começo da tela, ${onde}: ` + await nav.avaliar(`JSON.stringify({ barra: $("#vozFora").getBoundingClientRect(), app: $("#app").getBoundingClientRect(), y: scrollY, alt: document.body.style.getPropertyValue("--voz-altura") })`));
      }
    }
    await nav.tamanho(1280, 720);
    await nav.avaliar(`$("#vozForaDesligar").click()`);
    await esperarNaTela(nav, `!$("#vozFora")`);
    assert.equal(await nav.avaliar(`getComputedStyle(document.body).paddingTop === "0px" || !document.body.style.getPropertyValue("--voz-altura")`), true, "desligou: o espaço some");
    assert.deepEqual(nav.erros, []);
  } finally { await nav.fechar(); }
});

test("Tela: na Central rolada para cima a barra continua à vista, com estado e ⏹, também só escutando o comando (2ª reprova da QA da #296)", comChrome, async () => {
  const respostas = Array.from({ length: 8 }, (_, i) => `Resposta ${i}.\n\n` + "linha de histórico longo\n\n".repeat(12));
  const { b, caixa } = await preparar({ conversa: respostas });
  writeFileSync(join(caixa.home, "fala-ms"), "60000");
  const nav = await tela(caixa, [[0, 120000]], { largura: 1280, altura: 720 });
  const naTela = (sel) => `(() => { const e = $(${JSON.stringify(sel)}); if (!e || e.hidden) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.top >= 0 && r.bottom <= innerHeight && !!document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest("#vozFora"); })()`;
  try {
    await nav.carregar(b.url + "/#/central");
    await esperarNaTela(nav, `!!$(".voz-botao") && connected`);
    for (let i = 0; i < 6; i++) { await b.api("POST", "/api/conversa/central", { texto: "pergunta " + i }); await esperarEvento(b, (e) => e.t === "resultado" && e.n === i + 1); }
    await nav.avaliar(`document.querySelector(".voz-botao").click()`);
    await esperarNaTela(nav, `!!VOZ.stream`);
    await b.api("POST", "/api/conversa/central", { texto: "e agora?" });
    await esperarNaTela(nav, `VOZ.fase === "falando"`);
    for (const [largura, altura] of [[1280, 720], [390, 800]]) {
      await nav.tamanho(largura, altura);
      await esperar(200);
      const alto = await nav.avaliar(`document.documentElement.scrollHeight`);
      assert.ok(alto > altura * 2, `há o que rolar: ${alto}`);
      for (const y of [0, 0.4, 1]) {
        await nav.avaliar(`scrollTo(0, ${y} * document.documentElement.scrollHeight); 1`);
        await esperar(100);
        const onde = `${largura}x${altura}, rolagem ${y}`;
        assert.equal(await nav.avaliar(`VOZ.stream !== null && VOZ.fase === "falando"`), true, onde);
        assert.equal(await nav.avaliar(naTela("#vozForaTxt")), true, `estado à vista, ${onde}`);
        assert.equal(await nav.avaliar(naTela("#vozForaParar")), true, `⏹ à vista, ${onde}`);
        assert.equal(await nav.avaliar(naTela("#vozForaDesligar")), true, `Desligar à vista, ${onde}`);
      }
      await nav.avaliar(`scrollTo(0, 0); 1`);
      await esperar(100);
      assert.equal(await nav.avaliar(largura > 760 ? FORA_DO_APP : `$("#vozFora").getBoundingClientRect().bottom <= $(".central-lado, .dtop").getBoundingClientRect().top + 1`), true, `não cobre o começo, ${largura}`);
    }
    await nav.tamanho(1280, 720);
    await nav.avaliar(`$("#vozForaParar").click()`);
    await esperarNaTela(nav, `!VOZ.fala && VOZ.ligado() && !!VOZ.stream`);
    await nav.avaliar(`$("#vozForaDesligar").click()`);
    await esperarNaTela(nav, `!VOZ.ligado() && VOZ.stream === null && !$("#vozFora")`);
    // Só escutando o comando: o microfone também está aberto, e a caixa que o liga pode ter saído da tela
    await nav.avaliar(`alternarComandoVoz(true); scrollTo(0, 0.4 * document.documentElement.scrollHeight)`);
    await esperarNaTela(nav, `!!VOZ.stream && /só o comando/.test($("#vozFora")?.innerText || "")`);
    assert.equal(await nav.avaliar(naTela("#vozForaTxt")), true, "aviso à vista com a escuta do comando");
    await nav.avaliar(`$("#vozForaDesligar").click()`);
    await esperarNaTela(nav, `VOZ.stream === null && !VOZ.comando() && !$("#vozFora")`);
    assert.equal(await nav.avaliar(`$("#vozComando").checked`), false, "a caixa acompanha");
    assert.deepEqual(nav.erros, []);
  } finally { await nav.fechar(); }
});

test("Tela: a Central abre outra tela no meio da fala (#293) e nada corta; só a escuta do comando continua sendo da Central", comChrome, async () => {
  const { b, ouvido, caixa } = await preparar({ conversa: ["Abri o monitoramento."] });
  writeFileSync(join(caixa.home, "fala-ms"), "3000");
  const nav = await tela(caixa, [[0, 60000]]);
  try {
    await ligada(nav, b);
    await nav.avaliar(`window.__s = VOZ.stream; 1`);
    await nav.avaliar(`TELA.usadaEm = 0; TELA.sou = false`); // falar é usar: é este aparelho que tem de mudar
    ouvido("Abre o Controle.");
    await nav.avaliar(soar(0.2, 400)); await nav.avaliar(soar(0.0005, 1800));
    await esperarNaTela(nav, `TELA.usadaEm > 0 && TELA.sou && VOZ.fase === "falando"`);
    await nav.avaliar(`window.__f = VOZ.fala; 1`);
    assert.equal((await b.api("POST", "/api/tela", { destino: "controle" })).status, 200);
    await esperarNaTela(nav, `document.querySelector("header h1").innerText.includes("Controle") && !!$("#vozFora")`);
    assert.equal(await nav.avaliar(`VOZ.fala === window.__f && !VOZ.fala.pausada && VOZ.stream === window.__s`), true, "abrir a aba por comando não corta a fala");
    assert.equal(await nav.avaliar(`location.hash = "#/prs"; VOZ.stream === window.__s`), true, "sair à mão também não");
    await esperarNaTela(nav, `!VOZ.fala`);
    assert.equal(await nav.avaliar(`VOZ.stream === window.__s && VOZ.stream.active`), true);
    assert.equal((await b.api("POST", "/api/tela", { destino: "central" })).status, 200);
    await esperarNaTela(nav, `!!view.central && !!$("#vozFaixa .voz-limites") && !!$("#vozFora") && !!VOZ.stream`);
    await nav.avaliar(`document.querySelector(".voz-botao").click()`);
    await esperarNaTela(nav, `VOZ.stream === null && !VOZ.ligado()`);
    // Modo desligado, só escutando o comando: microfone só na Central e só à vista
    await nav.avaliar(`alternarComandoVoz(true)`); await esperarNaTela(nav, `!!VOZ.stream`);
    await esconder(nav); await esperarNaTela(nav, `VOZ.stream === null`);
    await esconder(nav, false); await esperarNaTela(nav, `!!VOZ.stream`);
    await nav.avaliar(`location.hash = "#/prs"`);
    await esperarNaTela(nav, `VOZ.stream === null && !$("#vozFora")`);
    assert.deepEqual(nav.erros, []);
  } finally { await nav.fechar(); }
});

test("Tela: a Central abre um link no meio da fala (#302): aba aberta ou bloqueada, a mesma voz segue até o fim", comChrome, async () => {
  const { b, ouvido, caixa } = await preparar({ conversa: ["Abri o site."] });
  writeFileSync(join(caixa.home, "fala-ms"), "3000");
  const nav = await tela(caixa, [[0, 60000]]);
  try {
    await ligada(nav, b);
    await nav.avaliar(`window.__s = VOZ.stream; TELA.usadaEm = 0; TELA.sou = false; 1`);
    ouvido("Abre o site.");
    await nav.avaliar(soar(0.2, 400)); await nav.avaliar(soar(0.0005, 1800));
    await esperarNaTela(nav, `TELA.usadaEm > 0 && TELA.sou && VOZ.fase === "falando"`);
    await nav.avaliar(`window.__f = VOZ.fala; 1`);
    const r = await b.api("POST", "/api/tela", { destino: "link https://site.exemplo.test/fala", quem: "Central" });
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.resultado, "abriu");
    assert.equal(await nav.avaliar(`VOZ.fala === window.__f && !VOZ.fala.pausada`), true, "a aba abriu e a fala não parou");
    // A aba nova na frente esconde o board. Sem a permissão de saber do bloqueio o microfone fecha, e a fala termina assim mesmo (com ela, voz-fundo.test.mjs)
    await esconder(nav); await esperarNaTela(nav, `VOZ.stream === null`);
    assert.equal(await nav.avaliar(`VOZ.fala === window.__f && !VOZ.fala.pausada`), true, "escondida, a fala continua");
    await esconder(nav, false); await esperarNaTela(nav, `!!VOZ.stream`);
    await nav.avaliar(`window.open = () => null; 1`); // o bloqueador, sem depender do gesto
    const s = await b.api("POST", "/api/tela", { destino: "link https://site.exemplo.test/bloqueada", quem: "Central" });
    assert.equal(s.json.resultado, "bloqueou");
    await esperarNaTela(nav, `!!$("#telaLink a")`);
    assert.equal(await nav.avaliar(`VOZ.fala === window.__f && !VOZ.fala.pausada`), true, "bloqueada, também não");
    await esperarNaTela(nav, `!VOZ.fala`);
    assert.equal(await nav.avaliar(`VOZ.ligado() && !!VOZ.stream`), true, "o modo segue ligado");
  } finally { await nav.fechar(); }
});
