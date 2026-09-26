#!/usr/bin/env bash
# Sobe o board e o mantém no ar: se o servidor sair (reinício pedido pela tela, ou queda),
# volta em 1 segundo. Com isto, "reiniciar quando a fila esvaziar" é o próprio board saindo
# no momento certo — sem ninguém derrubar tarefa no meio pra carregar código novo.
#
#   ./board.sh            → http://localhost:4488
#
cd "$(dirname "$0")" || exit 1
while true; do
  node board.mjs
  code=$?
  # 75 = "reinicie-me" (pedido pela tela/CLI). Qualquer outro código também volta, mas avisa.
  if [ "$code" != "75" ]; then echo "board saiu com código $code — voltando em 3s (Ctrl+C pra parar de vez)"; sleep 3; else sleep 1; fi
done
