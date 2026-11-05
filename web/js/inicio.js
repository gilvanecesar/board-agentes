// A partida da tela: rota, canal ao vivo, uso e modelos.
route();
connect();
vozPartida();
carregarUso();
carregarModelos();
setInterval(() => carregarUso(), 5 * 60000);
