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

const { carregarConfiguracao, avisosDeConfiguracao, validarConfiguracao } = require('../src/config');
const { criarAplicacao } = require('../src/servidor/http');

const configuracao = carregarConfiguracao();

for (const aviso of avisosDeConfiguracao(configuracao)) {
  console.warn(`[crmclinica] Aviso: ${aviso}`);
}

// ------------------------------------------------- configuração insegura não sobe
//
// `src/index.js` já fazia isto e ESTE arquivo não fazia — e este é o que
// atende a produção. Ou seja: a validação de segurança que impede a subida
// existia só onde a aposta é menor (o servidor local e o VPS), e a Vercel
// subia com qualquer configuração. Um `OPENCLAW_BASE_URL` em http, um
// `WHATSAPP_WEBHOOK_SECRET` curto demais ou um transporte de WhatsApp ambíguo
// passavam sem nada acender.
//
// Duas etapas, de propósito, e a ordem é a parte importante.
//
// RELATAR sempre (agora): todo problema vira `error` no log do deploy, e
// `/health` passa a devolver a CONTAGEM de problemas. É o que torna
// verificável, de fora, se esta produção passaria — coisa que hoje não se sabe.
//
// DERRUBAR quando `CRMCLINICA_CONFIG_ESTRITA=sim` (depois): aí sim a função nem
// chega a responder, o deploy aparece quebrado no painel e alguém conserta.
//
// Por que não já derrubando: ninguém verificou se a configuração REAL desta
// produção passa nesta validação, e ela cobre seis condições. Ligar o portão
// junto com o código que o criou troca um risco silencioso por uma queda certa
// — a clínica inteira fora do ar por uma variável de ambiente que talvez já
// estivesse faltando há meses. Confere-se em `/health`, liga-se depois.
const problemas = validarConfiguracao(configuracao);
if (problemas.length > 0) {
  for (const problema of problemas) {
    console.error(`[crmclinica] Configuração inválida: ${problema}`);
  }
  if (configuracao.producao && configuracao.configEstrita) {
    // Sem `process.exit` — numa função serverless isso derrubaria a invocação
    // sem mensagem útil. Lançar na carga do módulo é o que a plataforma sabe
    // relatar.
    throw new Error(
      `configuração insegura em produção: ${problemas.length} problema(s) — ver os detalhes no log acima`,
    );
  }
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
  const pool = obterPool(configuracao.banco);
  return { repositorio: criarRepositorio(pool), pool };
}

const banco = montarRepositorio();

module.exports = criarAplicacao({
  configuracao,
  ...(banco ? { repositorio: banco.repositorio, pool: banco.pool } : {}),
});
