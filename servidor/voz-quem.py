"""Impressão da voz (#298): recebe um WAV pela entrada e devolve o vetor da voz em JSON. O áudio nunca toca o disco.

    voz-quem.py <modelo.onnx> trecho    < a.wav   → {"vetor": [...], "seg": 2.1}
    voz-quem.py <modelo.onnx> cadastro  < a.wav   → {"vetor": [...], "seg": 28.4, "janelas": {"curtas": [...], "longas": [...]}}

Código 2: o áudio não é WAV PCM 16 kHz mono de 16 bits. Roda na CPU, pelo sherpa-onnx (scripts/instalar-voz-quem.sh).
Quem compara e decide é servidor/voz-quem.mjs: aqui só se mede.
"""
import io
import json
import sys
import wave

TAXA = 16000
TETO_TRECHO = 20  # segundos de voz: o trecho vai a até 90 s, e 20 s já dizem quem fala
REPETE_ATE = 3  # voz curta repetida até 3 s: abaixo de 0,6 s o erro caiu de 18% para 12% (medido na #298)
JANELA = 3  # cadastro: a média de janelas de 3 s
CURTA = 0.8  # e a conferência com janelas do tamanho de um comando


def ler_wav(dados):
    import numpy as np
    w = wave.open(io.BytesIO(dados))
    if w.getframerate() != TAXA or w.getnchannels() != 1 or w.getsampwidth() != 2:
        raise wave.Error("formato")
    return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768


def so_voz(s):
    """Tira silêncio e pausas (a VAD manda 400 ms antes e a pausa inteira depois): quem fala não está no silêncio."""
    import numpy as np
    q = 320  # 20 ms
    n = len(s) // q
    if n == 0:
        return s
    quadros = s[:n * q].reshape(n, q)
    energia = np.sqrt((quadros ** 2).mean(1))
    limite = max(0.008, float(np.percentile(energia, 20)) * 2.5)
    fica = np.convolve(energia > limite, np.ones(11), "same") > 0  # 100 ms de folga de cada lado
    voz = quadros[fica].reshape(-1)
    return voz if len(voz) >= TAXA // 10 else s  # sem nada acima do limite: fala baixa, mede o trecho todo


def main():
    modelo, modo = sys.argv[1], sys.argv[2]
    dados = sys.stdin.buffer.read()
    try:
        audio = so_voz(ler_wav(dados))
    except (wave.Error, EOFError):
        sys.exit(2)

    import numpy as np
    import sherpa_onnx as so
    ex = so.SpeakerEmbeddingExtractor(so.SpeakerEmbeddingExtractorConfig(model=modelo, num_threads=2))

    def vetor(s):
        if len(s) < REPETE_ATE * TAXA:
            s = np.tile(s, int(np.ceil(REPETE_ATE * TAXA / max(1, len(s)))))[:REPETE_ATE * TAXA]
        st = ex.create_stream()
        st.accept_waveform(TAXA, s)
        st.input_finished()
        v = np.array(ex.compute(st), dtype=np.float64)
        n = np.linalg.norm(v)
        return v / n if n > 0 and np.isfinite(n) else None

    seg = round(len(audio) / TAXA, 2)
    if not np.abs(audio).max(initial=0) > 0:
        return print(json.dumps({"vetor": None, "seg": 0}))
    if modo == "trecho":
        v = vetor(audio[:TETO_TRECHO * TAXA])
        return print(json.dumps({"vetor": None if v is None else [round(float(x), 6) for x in v], "seg": seg}))

    passo = JANELA * TAXA // 2
    pos = list(range(0, max(1, len(audio) - JANELA * TAXA + 1), passo))
    janelas = [(p, vetor(audio[p:p + JANELA * TAXA])) for p in pos]
    janelas = [(p, v) for p, v in janelas if v is not None]
    if not janelas:
        return print(json.dumps({"vetor": None, "seg": 0}))
    media = np.mean([v for _, v in janelas], 0)
    media /= np.linalg.norm(media)
    # O que dá para medir na gravação do próprio dono: cada pedaço contra a média das janelas que NÃO encostam nele.
    curtas, longas = [], []
    for p, v in janelas:
        fora = [x for q, x in janelas if abs(q - p) > 4 * TAXA]
        if not fora:
            continue
        c = np.mean(fora, 0)
        c /= np.linalg.norm(c)
        longas.append(round(float(v @ c), 3))
        k = vetor(audio[p:p + int(CURTA * TAXA)])
        if k is not None:
            curtas.append(round(float(k @ c), 3))
    print(json.dumps({"vetor": [round(float(x), 6) for x in media], "seg": seg, "janelas": {"curtas": curtas, "longas": longas}}))


if __name__ == "__main__":
    main()
