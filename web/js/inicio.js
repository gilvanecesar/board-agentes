// A partida da tela: rota, canal ao vivo, uso e modelos.
route();
connect();
carregarUso();
carregarModelos();
setInterval(() => carregarUso(), 5 * 60000);
setInterval(() => { if (view.name === "list" && store.get("tab", "ativas") === "consumo") renderPlano(); }, 60000); // "lido há N min" e "em Xh" andam
