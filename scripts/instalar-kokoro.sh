#!/usr/bin/env bash
# Instala o Kokoro (#314), a 2ª voz do modo voz, ao lado do Piper: hexgrad/Kokoro-82M (Apache-2.0, código e pesos) num ambiente
# Python próprio, SÓ na CPU (torch do índice cpu: nada de CUDA, a placa do Atena anda travando). Os fonemas do português vêm do
# espeak-ng EMPACOTADO no pip (espeakng-loader, GPL-3.0, um processo à parte): nenhum pacote do sistema. Fica fora do board (zero
# dependência npm), e sem isto o modo voz segue só com o Piper.
#   scripts/instalar-kokoro.sh            instala em ~/.local/share/board-voz/kokoro (ou em $BOARD_VOZ_PASTA/kokoro)
set -euo pipefail
VERSAO=0.9.4
REPO=https://huggingface.co/hexgrad/Kokoro-82M/resolve/main
PASTA="${BOARD_VOZ_KOKORO:-${BOARD_VOZ_PASTA:-$HOME/.local/share/board-voz}/kokoro}"

mkdir -p "$PASTA/pesos/voices"
command -v uv >/dev/null || { echo "✗ precisa do uv (https://docs.astral.sh/uv/)" >&2; exit 1; }
uv venv -q --allow-existing --python 3.12 "$PASTA/env"
uv pip install -q --python "$PASTA/env/bin/python" --index-url https://download.pytorch.org/whl/cpu torch
uv pip install -q --python "$PASTA/env/bin/python" "kokoro==$VERSAO" soundfile

# Os pesos: o sha256 que o próprio Hugging Face publica (LFS) tem de bater; baixado pela metade ou trocado não entra.
esperado=$(curl -fsSL https://huggingface.co/api/models/hexgrad/Kokoro-82M/tree/main | "$PASTA/env/bin/python" -I -c 'import json,sys; print(next(f["lfs"]["oid"] for f in json.load(sys.stdin) if f["path"] == "kokoro-v1_0.pth"))')
if [ ! -s "$PASTA/pesos/kokoro-v1_0.pth" ] || ! echo "$esperado  $PASTA/pesos/kokoro-v1_0.pth" | sha256sum -c --quiet - 2>/dev/null; then
  curl -fsSL -o "$PASTA/pesos/kokoro-v1_0.pth.baixando" "$REPO/kokoro-v1_0.pth"
  echo "$esperado  $PASTA/pesos/kokoro-v1_0.pth.baixando" | sha256sum -c --quiet -
  mv "$PASTA/pesos/kokoro-v1_0.pth.baixando" "$PASTA/pesos/kokoro-v1_0.pth"
fi
curl -fsSL -o "$PASTA/pesos/config.json" "$REPO/config.json"
for v in pf_dora pm_alex pm_santa; do curl -fsSL -o "$PASTA/pesos/voices/$v.pt" "$REPO/voices/$v.pt"; done  # as 3 vozes pt-BR do v1.0

"$PASTA/env/bin/python" -I -c "import torch, kokoro; print('✓ kokoro', kokoro.__version__ if hasattr(kokoro,'__version__') else '$VERSAO', '· torch', torch.__version__)"
echo "✓ Kokoro em $PASTA. Reinicie o board (↻): as vozes aparecem no seletor do painel de voz."
