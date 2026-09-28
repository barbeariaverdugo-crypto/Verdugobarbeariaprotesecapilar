// Arquivo de entrada para o cPanel ("Application startup file" em Setup Node.js App).
// O Passenger carrega este arquivo; o app em si é módulo ES, então é carregado com import().
import('./server/start.js')
  .then(({ start }) => start())
  .catch((err) => {
    console.error('Falha ao iniciar o Verdugo:', err);
    process.exit(1);
  });
