#!/usr/bin/env bash
# Instala o motor da impressão de voz (#298) ao lado do Piper: sherpa-onnx num ambiente Python próprio + o modelo TitaNet small.
# Fica fora do board de propósito: o board segue sem dependência npm, e sem isto o modo voz funciona como antes (sem filtro).
#   scripts/instalar-voz-quem.sh            instala em ~/.local/share/board-voz/quem (ou em $BOARD_VOZ_PASTA/quem)
set -euo pipefail
VERSAO=2.0.1
MODELO=nemo_en_titanet_small.onnx
URL=https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models
PASTA="${BOARD_VOZ_PASTA:-$HOME/.local/share/board-voz}/quem"

mkdir -p "$PASTA"
if command -v uv >/dev/null; then
  uv venv -q --allow-existing --python 3.12 "$PASTA/env"
  uv pip install -q --python "$PASTA/env/bin/python" "sherpa-onnx==$VERSAO" numpy
else
  python3 -m venv "$PASTA/env"
  "$PASTA/env/bin/pip" install -q "sherpa-onnx==$VERSAO" numpy
fi

if [ ! -s "$PASTA/$MODELO" ]; then
  # O checksum publicado no mesmo release: modelo baixado pela metade ou trocado não entra.
  esperado=$(curl -fsSL "$URL/checksum.txt" | awk -v m="$MODELO" '$1 == m { print $2 }')
  [ -n "$esperado" ] || { echo "✗ o checksum de $MODELO não veio" >&2; exit 1; }
  curl -fsSL -o "$PASTA/$MODELO.baixando" "$URL/$MODELO"
  echo "$esperado  $PASTA/$MODELO.baixando" | sha256sum -c --quiet -
  mv "$PASTA/$MODELO.baixando" "$PASTA/$MODELO"
fi
"$PASTA/env/bin/python" -I -c "import sherpa_onnx; print('✓ sherpa-onnx', sherpa_onnx.__version__)"
echo "✓ modelo em $PASTA/$MODELO. Reinicie o board (↻)."
