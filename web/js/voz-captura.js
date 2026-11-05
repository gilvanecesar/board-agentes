// Modo voz (#286): pega o microfone num AudioWorklet (fora da thread da tela, sem o freio dos timers em aba escondida) e
// entrega blocos de ~50 ms. Não é carregado pelo index.html: o voz.js abre com audioWorklet.addModule.
class VozCaptura extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(Math.round(sampleRate / 20)); this.n = 0; }
  process(entradas) {
    const canal = entradas[0] && entradas[0][0];
    if (!canal) return true;
    for (let i = 0; i < canal.length; i++) {
      this.buf[this.n++] = canal[i];
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice()); this.n = 0; }
    }
    return true;
  }
}
registerProcessor("voz-captura", VozCaptura);
