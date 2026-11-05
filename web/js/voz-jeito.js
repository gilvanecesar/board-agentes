// 🎙 O jeito de falar do modo voz (#313): os ajustes do Piper no painel, por aparelho. Script clássico, depois do voz.js.
// O jeito de falar (#313): velocidade, entonação, variação do ritmo e pausa entre frases, por aparelho. ▶ ouvir mostra o resultado.
const VOZ_JEITO = [
  ["ritmo", "velocidade", "Mais rápida ou mais devagar", (a) => `${Math.round(100 / a)}%`],
  ["entonacao", "entonação", "Quanto a voz sobe e desce. Alto demais embola as palavras (medido)", (a) => a.toFixed(2)],
  ["variacao", "variação", "Quanto o ritmo das sílabas varia", (a) => a.toFixed(2)],
  ["pausa", "pausa entre frases", "Silêncio depois de cada frase", (a) => a.toLocaleString("pt-BR", { maximumFractionDigits: 2 }) + " s"],
];
function vozJeitoHtml() {
  const lim = VOZ.servidor?.piper?.ajuste; if (!lim) return "";
  const aj = VOZ.ajusteFala();
  return `<div class="voz-jeito" id="vozJeito">${VOZ_JEITO.map(([k, nome, dica, fmt]) => {
    const l = lim[k], v = Number.isFinite(aj[k]) ? aj[k] : l.padrao;
    // velocidade: o deslizante anda no sentido da fala (para a direita = mais rápida), o Piper recebe o inverso (length_scale)
    const [min, max, val] = k === "ritmo" ? [-l.max, -l.min, -v] : [l.min, l.max, v];
    return `<label title="${esc(dica)}">${nome} <input type="range" data-jeito="${k}" min="${min}" max="${max}" step="0.05" value="${val}" oninput="mudarJeitoVoz('${k}', this.value)"> <span data-jeito-txt="${k}">${fmt(v)}</span></label>`;
  }).join("")}<button class="btn" type="button" onclick="jeitoPadraoVoz()" title="Volta ao padrão medido">↺ padrão</button></div>`;
}
function mudarJeitoVoz(k, v) {
  const aj = { ...VOZ.ajusteFala(), [k]: k === "ritmo" ? -Number(v) : Number(v) };
  store.set("vozAjuste", aj);
  const item = VOZ_JEITO.find((j) => j[0] === k), t = document.querySelector(`[data-jeito-txt="${k}"]`);
  if (item && t) t.textContent = item[3](aj[k]);
}
function jeitoPadraoVoz() {
  store.set("vozAjuste", {});
  const el = $("#vozJeito"); if (el) el.outerHTML = vozJeitoHtml();
}
