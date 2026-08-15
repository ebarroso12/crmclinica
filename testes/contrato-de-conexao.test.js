'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Guarda estrutural do contrato de conexão do repositório.
//
// A regra: um método que grava não pode abrir conexão própria sem antes
// perguntar se já existe transação em volta. Quem abre `pool.connect()` e
// emite `BEGIN` dentro de uma transação alheia cria uma segunda transação que
// não enxerga o que a primeira ainda não commitou — e uma linha recém-criada
// vira violação de chave estrangeira.
//
// Foi assim que o webhook do WhatsApp passou a devolver HTTP 500 para todo
// contato novo, em dois lugares diferentes do mesmo fluxo. Corrigir os dois não
// impede o terceiro: por isso o contrato virou teste.
//
// O teste é estático de propósito. O teste de comportamento
// (`ingresso-transacao-pg.test.js`) prova o defeito contra PostgreSQL real, mas
// só cobre os caminhos que alguém lembrou de exercitar. Este aqui cobre o
// arquivo inteiro e falha no dia em que um método novo repetir o padrão.

const CAMINHO = path.join(__dirname, '..', 'src', 'dados', 'repositorio.js');

/**
 * Lista as ocorrências de `pool.connect()` com o nome da função que as contém.
 * Varredura simples de texto: o arquivo segue um padrão estável de
 * `async nomeDoMetodo(...) {`, e um analisador de sintaxe completo seria mais
 * frágil de manter do que o problema que resolve.
 */
// Palavras que abrem parêntese sem serem nome de função. Sem esta lista, um
// `if (...)` no meio do método seria lido como declaração e o teste apontaria
// "if (linha 280)" em vez do método real — diagnóstico inútil.
const PALAVRAS_RESERVADAS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'await', 'typeof', 'do', 'else',
]);

function ocorrenciasDeConexaoPropria(conteudo) {
  const linhas = conteudo.split('\n');
  const encontradas = [];
  let funcaoAtual = '(topo do arquivo)';

  for (let indice = 0; indice < linhas.length; indice += 1) {
    const linha = linhas[indice];

    // Comentário não é código. Sem esta guarda, a própria explicação do defeito
    // (que cita `pool.connect()` no texto) seria contada como ocorrência.
    const ehComentario = /^\s*(\/\/|\*|\/\*)/.test(linha);

    const declaracao = linha.match(/^\s*(?:async\s+)?(?:function\s+)?([a-zA-Z_$][\w$]*)\s*\(/);
    if (!ehComentario && declaracao && !PALAVRAS_RESERVADAS.has(declaracao[1])) {
      funcaoAtual = declaracao[1];
    }

    if (!ehComentario && /pool\.connect\(\)/.test(linha)) {
      encontradas.push({ funcao: funcaoAtual, linha: indice + 1 });
    }
  }

  return encontradas;
}

// Métodos autorizados a abrir conexão própria, com o motivo de cada um.
// Acrescentar nome a esta lista é uma decisão consciente, não um ajuste para
// o teste ficar verde.
const AUTORIZADOS = new Map([
  ['comUsuario', 'é quem ABRE a transação ambiente — a conexão dele é a transação'],
  ['executarNaTransacao', 'é o auxiliar que IMPLEMENTA o contrato: só abre conexão quando não há transação ambiente'],
  ['publicarPromptDaSerena', 'publicação atômica de prompt; roda fora do fluxo transacional do webhook'],
]);

test('nenhum método novo abre conexão própria sem tratar a transação ambiente', () => {
  const conteudo = fs.readFileSync(CAMINHO, 'utf8');
  const ocorrencias = ocorrenciasDeConexaoPropria(conteudo);

  assert.ok(ocorrencias.length > 0, 'a varredura precisa achar algo — se zerou, o padrão do arquivo mudou');

  const naoAutorizadas = ocorrencias.filter(({ funcao }) => !AUTORIZADOS.has(funcao));

  assert.deepEqual(
    naoAutorizadas.map(({ funcao, linha }) => `${funcao} (linha ${linha})`),
    [],
    'estes métodos abrem pool.connect() e não estão na lista de autorizados: '
    + 'ou passam a reusar contexto.atual()?.client quando existe transação ambiente, '
    + 'ou entram em AUTORIZADOS com a justificativa',
  );
});

test('todo método que abre conexão própria consulta o contexto antes', () => {
  const conteudo = fs.readFileSync(CAMINHO, 'utf8');
  const ocorrencias = ocorrenciasDeConexaoPropria(conteudo);

  // Para cada ocorrência autorizada que NÃO é o `comUsuario`, exigir que o
  // trecho ao redor pergunte pelo contexto. `comUsuario` é a exceção legítima:
  // ele não pode consultar o contexto porque é ele quem o cria.
  const semChecagem = [];
  const linhas = conteudo.split('\n');

  for (const { funcao, linha } of ocorrencias) {
    if (funcao === 'comUsuario') continue;

    // Janela generosa antes da abertura da conexão: a checagem costuma vir
    // logo acima, mas pode estar separada por comentário longo.
    const inicio = Math.max(0, linha - 40);
    const trecho = linhas.slice(inicio, linha).join('\n');

    if (!/contexto\.atual\(\)/.test(trecho)) {
      semChecagem.push(`${funcao} (linha ${linha})`);
    }
  }

  assert.deepEqual(
    semChecagem, [],
    'estes métodos abrem conexão própria sem consultar contexto.atual() antes',
  );
});
