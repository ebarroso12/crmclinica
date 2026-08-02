'use strict';

// Ponte para a Vercel: a mesma aplicação usada localmente responde como função serverless.
// Os arquivos de `public/` continuam sendo servidos pela própria plataforma.
const { criarAplicacao } = require('../src/servidor/http');

module.exports = criarAplicacao();
