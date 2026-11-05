// 🎙 O painel do modo voz no menu lateral (#307, pedido falado do dono: "tem um painelzinho embaixo perto de onde eu digito, sobre
// áudio; colocar do lado esquerdo do Board"). Chrome de verdade com microfone falso; whisper e Piper falsos. O que morde: o painel
// mora no menu em TODA tela (nunca na área de trabalho), uma cópia só de cada botão, a caixa de escrever livre, e o redesenho do
// menu (a cada evento) não arranca o deslizante da mão do dono nem fecha os ajustes.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { esperar } from "./ajuda.mjs";
import { comChrome, esperarNaTela, ligada, limparVoz, preparar, recarregar, tela } from "./voz-ajuda.mjs";

afterEach(limparVoz);
const TELAS = ["board", "conversa", "sessoes", "busca", "prs", "controle"]; // Navegador, Memória, Consumo e Monitoramento saíram em 04/11
// Retângulos que se cruzam (só o que está desenhado).
// Conteúdo de <details> fechado tem posição no Chrome mas não aparece: não conta (#313, os ajustes do jeito de falar).
const cruza = (a, b) => `(() => { const xs = [...document.querySelectorAll(${JSON.stringify(a)})], ys = [...document.querySelectorAll(${JSON.stringify(b)})]; return xs.some((x) => { const r = x.getBoundingClientRect(); return x.checkVisibility() && r.width && r.height && ys.some((y) => { const q = y.getBoundingClientRect(); return q.width && q.height && r.left < q.right && q.left < r.right && r.top < q.bottom && q.top < r.bottom; }); }); })()`;
// O elemento está à vista e é ele que recebe o clique no meio dele.
const clicavel = (sel) => `(() => { const e = $(${JSON.stringify(sel)}); if (!e || e.hidden) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(${JSON.stringify(sel)}) === e; })()`;

test("Painel (#307): desligado, mora no menu em toda tela, com um botão só de ligar e o cadastro da voz; a Central não tem mais faixa nem botão", comChrome, async () => {
  const { b, caixa } = await preparar();
  for (const [largura, altura] of [[1280, 720], [390, 800]]) {
    const nav = await tela(caixa, [[0, 60000]], { largura, altura });
    try {
      await nav.carregar(b.url + "/#/central");
      await esperarNaTela(nav, `connected && !!$("#vozFaixa .voz-botao")`);
      for (const destino of ["central", ...TELAS]) {
        await nav.avaliar(`navigateBoard("${destino}")`);
        await esperar(150);
        const onde = `${destino} em ${largura}`;
        assert.equal(await nav.avaliar(`!!$("#vozFaixa")?.closest("#navigation")`), true, `o painel no menu, ${onde}`);
        assert.equal(await nav.avaliar(`document.querySelectorAll("#app .voz-faixa, #app .voz-botao, #app #vozFora").length`), 0, `nada do modo voz na área de trabalho, ${onde}`);
        assert.equal(await nav.avaliar(`document.querySelectorAll(".voz-botao").length`), 1, `um botão só, ${onde}`);
        if (largura > 760) assert.equal(await nav.avaliar(clicavel("#vozFaixa .voz-botao")), true, `o botão de ligar à vista, ${onde}`);
        assert.equal(await nav.avaliar(`$("#vozMinhaVoz")?.getAttribute("href")`), "#/voz", `o cadastro da voz no painel, ${onde}`);
        assert.equal(await nav.avaliar(`VOZ.stream`), null, "desligado: ninguém ouve");
      }
      await nav.avaliar(`$("#vozMinhaVoz").click()`);
      await esperarNaTela(nav, `view.name === "voz" && !!$("#vozCad")`);
      assert.equal(await nav.avaliar(`!!$("#vozFaixa")?.closest("#navigation")`), true, "na tela do cadastro também");
      assert.deepEqual(nav.erros, []);
    } finally { await nav.fechar(); }
  }
});

test("Painel (#307): ligado, a barra do modo voz é o alto do painel no computador (estado, ⏹, Desligar à vista, sem cobrir menu nem caixa) e presa no alto no celular", comChrome, async () => {
  const { b, caixa } = await preparar({ conversa: ["Resposta da Central, comprida o bastante para a fala ocupar várias linhas no painel estreito do menu."] });
  writeFileSync(join(caixa.home, "fala-ms"), "60000");
  const t = (await b.api("POST", "/api/tasks", { text: "tarefa com conversa", project: "alfa", queue: false })).json.tasks[0];
  const nav = await tela(caixa, [[0, 120000]], { largura: 1280, altura: 720 });
  try {
    await ligada(nav, b);
    await b.api("POST", "/api/conversa/central", { texto: "oi" });
    await esperarNaTela(nav, `VOZ.fase === "falando" && !$("#vozForaParar").hidden`);
    for (const [largura, altura] of [[1280, 720], [1024, 768], [1440, 900], [390, 800]]) {
      await nav.tamanho(largura, altura);
      for (const h of ["#/central", `#/t/${t.id}`, "#/c/alfa", "#/prs"]) {
        await nav.avaliar(`location.hash = "${h}"`);
        await esperarNaTela(nav, `!!$("#vozFora")`);
        await esperar(250);
        const onde = `${h} em ${largura}x${altura}`;
        assert.equal(await nav.avaliar(`document.querySelectorAll("#vozFora, #vozForaParar, #vozForaDesligar, #vozFaixa").length`), 4, `uma barra, um ⏹, um Desligar, uma faixa, ${onde}`);
        assert.equal(await nav.avaliar(`!!$("#vozFora").closest("#vozPainel") && !!$("#vozFaixa").closest("#navigation")`), true, `barra e faixa no painel do menu, ${onde}`);
        assert.equal(await nav.avaliar(cruza("#vozPainel *", ".chatbox")), false, `nada do painel em cima da caixa de escrever, ${onde}`);
        if (largura > 760) {
          assert.equal(await nav.avaliar(`getComputedStyle($("#vozFora")).position === "fixed"`), false, `no computador a barra não flutua, ${onde}`);
          await nav.avaliar(`$("#navigation").scrollTop = 0; 1`); await esperar(50);
          assert.equal(await nav.avaliar(cruza("#vozBarra", ".nav-item")), false, `a barra não cobre item do menu, ${onde}`);
          for (const sel of ["#vozForaTxt", "#vozForaParar", "#vozForaDesligar"]) assert.equal(await nav.avaliar(clicavel(sel)), true, `${sel} à vista, ${onde}`);
          assert.equal(await nav.avaliar(`document.body.style.getPropertyValue("--voz-altura")`), "", `sem espaço reservado no alto, ${onde}`);
        } else {
          assert.equal(await nav.avaliar(`getComputedStyle($("#vozFora")).position`), "fixed", `no celular a barra se prende no alto, ${onde}`);
          for (const y of [0, 99999]) {
            await nav.avaliar(`scrollTo(0, ${y}); 1`); await esperar(100);
            for (const sel of ["#vozForaTxt", "#vozForaParar", "#vozForaDesligar"]) assert.equal(await nav.avaliar(clicavel(sel)), true, `${sel} à vista, ${onde}, y=${y}`);
            assert.equal(await nav.avaliar(cruza("#vozPainel *", ".chatbox")), false, `nada em cima da caixa, ${onde}, y=${y}`);
          }
          await nav.avaliar(`scrollTo(0, 0); 1`); await esperar(100);
          assert.equal(await nav.avaliar(`$("#vozFaixa").getBoundingClientRect().bottom <= $("#app").getBoundingClientRect().top`), true, `a faixa no menu, acima da tela, ${onde}`);
        }
      }
    }
    await nav.tamanho(1280, 720);
    await nav.avaliar(`$("#vozForaParar").click()`);
    await esperarNaTela(nav, `!VOZ.fala && VOZ.ligado() && !!VOZ.stream`);
    await nav.avaliar(`$("#vozForaDesligar").click()`);
    await esperarNaTela(nav, `!VOZ.ligado() && VOZ.stream === null && !$("#vozFora") && !!$("#vozFaixa .voz-botao")`);
    assert.deepEqual(nav.erros, []);
  } finally { await nav.fechar(); }
});

test("Painel (#307): o menu se redesenha a cada evento e o painel fica: o deslizante na mão, os ajustes abertos (também depois de recarregar)", comChrome, async () => {
  const { b, caixa } = await preparar();
  const nav = await tela(caixa, [[0, 60000]], { largura: 1280, altura: 900 });
  try {
    await ligada(nav, b);
    await nav.avaliar(`navigateBoard("prs")`);
    await esperarNaTela(nav, `!!$("#vozPausa")`);
    // Cockpit (#364): no trilho fica o módulo compacto; os ajustes moram no painel que o ⚙ abre ao lado
    await nav.avaliar(`$(".voz-abrir").click(); $("#vozFaixa details[data-bloco=ajustes] summary").click(); $("#vozPausa").focus(); window.__p = $("#vozPausa"); window.__m = $("#navMenu").innerHTML.length; 1`);
    assert.equal(await nav.avaliar(`$("#vozFaixa details[data-bloco=ajustes]").open`), true);
    for (let i = 0; i < 3; i++) await b.api("POST", "/api/tasks", { text: "evento " + i, project: "alfa", queue: false });
    await esperarNaTela(nav, `S.tasks.length >= 3`);
    await nav.avaliar(`renderHeader(); renderNavigation(); 1`);
    await esperar(300);
    assert.equal(await nav.avaliar(`$("#vozPausa") === window.__p && document.activeElement === window.__p`), true, "o mesmo deslizante, com o foco");
    assert.equal(await nav.avaliar(`$("#vozFaixa details[data-bloco=ajustes]").open`), true, "os ajustes continuam abertos");
    assert.equal(await nav.avaliar(`document.querySelectorAll("#navigation .nav-item").length`), 7, "e o menu continua inteiro");
    await recarregar(nav);
    await esperarNaTela(nav, `connected && !!$("#vozFaixa details[data-bloco=ajustes]")`);
    assert.equal(await nav.avaliar(`$("#vozFaixa details[data-bloco=ajustes]").open`), true, "aberto depois de recarregar (por aparelho)");
    assert.equal(await nav.avaliar(`$("#vozFaixa details[data-bloco=limites]").open`), false, "os limites, fechados como ele deixou");
    assert.deepEqual(nav.erros, []);
  } finally { await nav.fechar(); }
});
