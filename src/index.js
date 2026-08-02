'use strict';

const http = require('node:http');

const porta = Number(process.env.PORT || 4100);

const servidor = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ produto: 'crmclinica', status: 'ok' }));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ erro: 'Rota não encontrada' }));
});

if (require.main === module) {
  servidor.listen(porta, '127.0.0.1', () => {
    console.log(`crmclinica ouvindo na porta ${porta}`);
  });
}

module.exports = { servidor };
