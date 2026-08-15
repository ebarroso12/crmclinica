'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { URL_FORMULARIO_PRE_CONSULTA } = require('../src/dominio/formulario-pre-consulta');

// TESTE DE SEGURANÇA — a trava que impede a volta do questionário errado.
//
// Ele não testa uma função: varre tudo que pode virar mensagem para um
// paciente (código do servidor, workers, o cérebro da Serena, o app servido ao
// navegador) e falha se aparecer QUALQUER link de pré-consulta que não seja o
// oficial.
//
// Por que uma varredura e não uma asserção de unidade: o questionário infantil
// não entrou por uma função — entrou por um TEXTO, num prompt. Nenhum teste de
// unidade pega isso. Este pega, e pega também o próximo, seja em que arquivo
// for.
//
// `testes/` fica de fora da varredura de propósito: é aqui que os
// contraexemplos precisam existir para provar que a regra funciona, e um teste
// nunca manda mensagem para paciente nenhum.

const RAIZ = path.join(__dirname, '..');

// O que é varrido: tudo que é enviado ao ar ou lido por quem responde.
const PASTAS = ['src', 'bin', 'configuracao', 'public'];

const EXTENSOES = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.html', '.sql', '.txt', '.yaml', '.yml']);

// Hospedeiros de formulário que este projeto NÃO usa. Se um deles aparecer, é
// um formulário paralelo entrando pela porta dos fundos.
const HOSPEDEIROS_PROIBIDOS = [
  'forms.gle',
  'docs.google.com/forms',
  'typeform.com',
  'jotform.com',
  'surveymonkey.com',
  'formulario.edsonbarrosojr.com.br/pre-consulta',
];

const HOST_OFICIAL = 'formulario.edsonbarrosojr.com.br';

function arquivosVarridos() {
  const encontrados = [];

  function percorrer(diretorio) {
    for (const entrada of fs.readdirSync(diretorio, { withFileTypes: true })) {
      if (entrada.name === 'node_modules' || entrada.name.startsWith('.')) continue;
      const completo = path.join(diretorio, entrada.name);
      if (entrada.isDirectory()) percorrer(completo);
      else if (EXTENSOES.has(path.extname(entrada.name))) encontrados.push(completo);
    }
  }

  for (const pasta of PASTAS) {
    const completo = path.join(RAIZ, pasta);
    if (fs.existsSync(completo)) percorrer(completo);
  }
  return encontrados;
}

/** URLs de um texto, sem a pontuação que costuma colar no fim. */
function urlsDe(texto) {
  const bruto = texto.match(/https?:\/\/[^\s"'`<>()[\]{}]+/g) ?? [];
  return bruto.map((url) => url.replace(/[.,;:!?]+$/, ''));
}

test('a varredura enxerga arquivos de verdade (senão ela passaria vazia)', () => {
  const arquivos = arquivosVarridos();
  assert.ok(arquivos.length > 50, `esperava varrer o projeto, varreu ${arquivos.length} arquivos`);
  assert.ok(
    arquivos.some((arquivo) => arquivo.endsWith(path.join('workspace-serena', 'AGENTS.md'))),
    'o cérebro da Serena precisa estar dentro da varredura',
  );
});

test('nenhum link de pré-consulta além do oficial existe no que é enviado', () => {
  const infracoes = [];

  for (const arquivo of arquivosVarridos()) {
    const conteudo = fs.readFileSync(arquivo, 'utf8');
    const relativo = path.relative(RAIZ, arquivo);

    for (const url of urlsDe(conteudo)) {
      // Qualquer endereço no domínio do formulário precisa ser EXATAMENTE o
      // oficial — um caminho a mais já é outro formulário.
      if (url.includes(HOST_OFICIAL) && url !== URL_FORMULARIO_PRE_CONSULTA) {
        infracoes.push(`${relativo}: ${url}`);
      }
    }

    for (const proibido of HOSPEDEIROS_PROIBIDOS) {
      if (conteudo.includes(proibido)) infracoes.push(`${relativo}: hospedeiro proibido "${proibido}"`);
    }
  }

  assert.deepEqual(
    infracoes, [],
    'Link de pré-consulta não oficial encontrado. O único endereço permitido é '
      + `${URL_FORMULARIO_PRE_CONSULTA} — ver src/dominio/formulario-pre-consulta.js.\n`
      + infracoes.join('\n'),
  );
});

test('a URL oficial está declarada em um único lugar do código', () => {
  const declaracoes = [];

  for (const arquivo of arquivosVarridos()) {
    if (path.extname(arquivo) !== '.js') continue;
    const conteudo = fs.readFileSync(arquivo, 'utf8');
    if (conteudo.includes(URL_FORMULARIO_PRE_CONSULTA)) declaracoes.push(path.relative(RAIZ, arquivo));
  }

  assert.deepEqual(
    declaracoes, [path.join('src', 'dominio', 'formulario-pre-consulta.js')],
    'a URL não pode ser repetida em outro arquivo de código: quem precisar dela, importa do módulo canônico',
  );
});

test('nenhum código escolhe formulário por idade ou tipo de consulta', () => {
  // Procura a forma do bug, não a palavra solta: um identificador que junte
  // "formulário/link/questionário" com "infantil/criança/adulto/pediátrico".
  const padrao = /(formulario|formulário|questionario|questionário|link)[A-Za-z_]*(infantil|crianca|criança|adulto|pediatr)|(infantil|crianca|criança|adulto|pediatr)[A-Za-z_]*(formulario|formulário|questionario|questionário)/i;

  const suspeitos = [];
  for (const arquivo of arquivosVarridos()) {
    if (path.extname(arquivo) !== '.js') continue;
    const linhas = fs.readFileSync(arquivo, 'utf8').split('\n');
    linhas.forEach((linha, indice) => {
      if (padrao.test(linha)) suspeitos.push(`${path.relative(RAIZ, arquivo)}:${indice + 1}`);
    });
  }

  assert.deepEqual(suspeitos, [], 'não existe formulário por faixa etária ou tipo de consulta');
});
