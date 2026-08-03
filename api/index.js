'use strict';

// Ponte para a Vercel: a mesma aplicação usada localmente responde como função
// serverless. Os arquivos de `public/` continuam sendo servidos pela plataforma.
//
// ------------------------------------------------------------------ o repositório
//
// Este arquivo já foi só `module.exports = criarAplicacao()`. Parecia certo, e
// não era: sem repositório informado, `criarAplicacao` monta o **de memória** —
// o padrão que existe para desenvolver sem banco. Em produção isso significava
// uma clínica inteira rodando sobre Maps que morriam a cada invocação.
//
// O sintoma não apontava para lá: o login respondia "credenciais inválidas",
// porque o usuário realmente não existia naquele repositório vazio. O banco
// estava configurado, alcançável e correto — e nunca era consultado.
//
// A regra aqui é a mesma do `src/index.js`: com `CRMCLINICA_DATABASE_URL`, o
// PostgreSQL; sem ela, memória — e o `/health` diz qual dos dois está no ar.

const { carregarConfiguracao, avisosDeConfiguracao } = require('../src/config');
const { criarAplicacao } = require('../src/servidor/http');

const configuracao = carregarConfiguracao();

for (const aviso of avisosDeConfiguracao(configuracao)) {
  console.warn(`[crmclinica] Aviso: ${aviso}`);
}

function montarRepositorio() {
  if (!configuracao.banco.configurado) {
    console.warn('[crmclinica] sem CRMCLINICA_DATABASE_URL: a função roda em memória e não persiste.');
    return null;
  }

  const { obterPool } = require('../src/dados/pool');
  const { criarRepositorio } = require('../src/dados/repositorio');

  // `obterPool` guarda o pool no módulo. Numa função serverless o processo é
  // reaproveitado entre invocações, então isso evita abrir um pool novo — e
  // esgotar o limite de conexões do banco — a cada requisição.
  return criarRepositorio(obterPool(configuracao.banco));
}

const repositorio = montarRepositorio();

module.exports = criarAplicacao({
  configuracao,
  ...(repositorio ? { repositorio } : {}),
});
