# Motor de voz Kokoro (#314): hexgrad/Kokoro-82M, SÓ na CPU. Roda no ambiente próprio (~/.local/share/board-voz/kokoro/env),
# fica vivo enquanto o board quiser (carregar leva ~3,6 s) e conversa pela entrada/saída:
#   entrada: uma linha JSON por pedido  {"texto": "...", "voz": "pf_dora", "velocidade": 1.0, "pausa": 0.4}
#   saída:   uma linha JSON {"ok": true, "bytes": N, "ms": ..., "seg": ...} seguida de N bytes de WAV (16 bits, 24 kHz, mono)
#            ou {"ok": false, "erro": "..."}
# O áudio nunca vai a disco. Sem rede: os pesos e as vozes estão na pasta (HF_HUB_OFFLINE).
import io, json, os, sys, time, wave

os.environ["CUDA_VISIBLE_DEVICES"] = "-1"  # a placa anda travando (#270): nada de CUDA
os.environ["HF_HUB_OFFLINE"] = "1"
saida = os.fdopen(os.dup(sys.stdout.fileno()), "wb")
sys.stdout = sys.stderr  # qualquer print de biblioteca vai para o stderr: a saída é só do protocolo

import numpy as np
import torch
torch.set_num_threads(int(os.environ.get("KOKORO_THREADS", "8")))
from kokoro import KModel, KPipeline

PESOS = sys.argv[1]
modelo = KModel(config=os.path.join(PESOS, "config.json"), model=os.path.join(PESOS, "kokoro-v1_0.pth"), repo_id="hexgrad/Kokoro-82M").eval()
pipe = KPipeline(lang_code="p", model=modelo, repo_id="hexgrad/Kokoro-82M")  # "p" = português do Brasil, fonemas pelo espeak-ng do pip
TAXA = 24000


def responder(cab, dados=b""):
    saida.write((json.dumps(cab) + "\n").encode())
    if dados:
        saida.write(dados)
    saida.flush()


def wav(amostras):
    pcm = (np.clip(amostras, -1, 1) * 32767).astype("<i2").tobytes()
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(TAXA); w.writeframes(pcm)
    return b.getvalue()


responder({"pronto": True})
for linha in sys.stdin:
    try:
        p = json.loads(linha)
        comeco = time.time()
        voz = os.path.join(PESOS, "voices", os.path.basename(str(p["voz"])) + ".pt")
        if not os.path.exists(voz):
            raise ValueError("voz não instalada: " + str(p["voz"]))
        partes = []
        silencio = np.zeros(int(TAXA * max(0.0, min(1.0, float(p.get("pausa", 0.4))))), dtype=np.float32)
        with torch.inference_mode():
            for r in pipe(str(p["texto"]), voice=voz, speed=float(p.get("velocidade", 1.0))):
                if r.audio is not None:
                    partes += [r.audio.numpy(), silencio]
        if not partes:
            raise ValueError("nada para falar")
        tudo = np.concatenate(partes)
        dados = wav(tudo)
        responder({"ok": True, "bytes": len(dados), "ms": round((time.time() - comeco) * 1000), "seg": round(len(tudo) / TAXA, 2)}, dados)
    except Exception as e:  # um pedido ruim não derruba o motor
        responder({"ok": False, "erro": str(e)[:300]})
