'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { varrer } = require('../bin/verificar-segredos');
const { carregarConfiguracao, validarConfiguracao } = require('../src/config');

// Blindagem do repositório e da configuração.
//
// O `.gitignore` protege o arquivo que alguém LEMBROU de chamar de `.env`. Não
// protege a chave colada num `.js` "só para testar", nem o `.env.producao.bak`
// criado às pressas num incidente — e é assim que credencial vaza na prática.

// Montado em pedaços, nunca escrito inteiro no fonte.
//
// `testes/auditoria.test.js` já tem um portão mais estreito ("nenhuma chave
// real está versionada") que varre o repositório atrás destas assinaturas — e
// ele acusaria ESTE arquivo se o prefixo aparecesse literal aqui. Os dois se
// complementam: aquele é o gate dentro da suíte, este exercita o detector
// completo (mais formatos, todo arquivo versionado, allowlist e saída de CI).
const PREFIXO_OPENAI = ['s', 'k', '-'].join('');

/** Escreve arquivos numa pasta temporária e varre, devolvendo os achados. */
function varrerConteudo(arquivos) {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'crmclinica-segredos-'));
  const nomes = [];
  for (const [nome, conteudo] of Object.entries(arquivos)) {
    const destino = path.join(pasta, nome);
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, conteudo);
    nomes.push(nome);
  }
  // `varrer` resolve os caminhos a partir da raiz do projeto; aqui passamos o
  // caminho relativo da pasta temporária vista de lá.
  const relativa = path.relative(path.join(__dirname, '..'), pasta);
  try {
    return varrer(nomes.map((nome) => path.join(relativa, nome).split(path.sep).join('/')));
  } finally {
    fs.rmSync(pasta, { recursive: true, force: true });
  }
}

test('o repositório versionado não tem credencial', () => {
  // A varredura de verdade, sobre o que está commitado. Este é o teste que
  // importa: os outros provam que o detector funciona; este prova que o
  // repositório está limpo.
  const { execFileSync } = require('node:child_process');
  const raiz = path.join(__dirname, '..');
  const arquivos = execFileSync('git', ['ls-files', '-z'], { cwd: raiz, encoding: 'utf8' })
    .split('\0').filter(Boolean);

  const achados = varrer(arquivos);
  assert.deepEqual(
    achados.map((a) => `${a.arquivo}:${a.linha} ${a.padrao}`), [],
    'credencial commitada: ROTACIONE a chave — tirar do arquivo não basta, o objeto fica no histórico',
  );
});

test('chave de formato conhecido é achada, mesmo em arquivo de teste', () => {
  // Valor sintético só desculpa o padrão GENÉRICO. Uma chave com forma real
  // continua sendo achado em qualquer arquivo: chave colada "só para rodar uma
  // vez" num teste é um dos caminhos mais comuns de vazamento, e o nome do
  // arquivo não a torna falsa.
  const achados = varrerConteudo({
    'testes/exemplo.test.js': `const chave = '${PREFIXO_OPENAI}abcdefghijklmnopqrstuvwxyz0123456789';\n`,
  });
  assert.equal(achados.length, 1);
  assert.equal(achados[0].padrao, 'chave OpenAI');
});

test('os formatos que mais vazam são reconhecidos', () => {
  // Todos montados em pedaços, pela mesma razão do `PREFIXO_OPENAI`: escritos
  // inteiros, o portão de `auditoria.test.js` acusaria este arquivo.
  const casos = {
    // Exatamente 20 caracteres (AKIA + 16), que é o formato real de um access
    // key id da AWS — um a mais e não é chave, é outra coisa.
    'a.js': `AKIA${'IOSFODNN7EXAMPLE'}`,
    'b.js': `${['g', 'h', 'p', '_'].join('')}0123456789012345678901234567890123`,
    'c.env': `DATABASE_URL=${'postgres'}://usuario:umaSenhaQualquer@host:5432/banco`,
    'd.pem': `${'-----BEGIN'} RSA ${'PRIVATE KEY-----'}`,
    'e.json': '{"type": "service_account"}',
  };
  const achados = varrerConteudo(casos);
  const porArquivo = new Set(achados.map((a) => path.basename(a.arquivo)));

  for (const nome of Object.keys(casos)) {
    assert.ok(porArquivo.has(nome), `não achou credencial em ${nome}`);
  }
});

test('o relatório nunca imprime o valor do segredo', () => {
  // Um relatório que imprime a chave a copia para o log do CI — que costuma
  // ser mais fácil de ler que o próprio repositório.
  const segredo = `${PREFIXO_OPENAI}naodeveriaaparecernorelatorio0123456789`;
  const achados = varrerConteudo({ 'a.js': `const k = '${segredo}';\n` });

  assert.equal(achados.length, 1);
  assert.ok(!achados[0].trecho.includes(segredo), 'o trecho não pode conter a chave inteira');
  assert.ok(!JSON.stringify(achados).includes(segredo));
});

test('valor declaradamente sintético não vira alarme', () => {
  // Falso positivo repetido é o que faz alguém desligar a verificação.
  const achados = varrerConteudo({
    'testes/x.test.js': "const TOKEN = 'token-sintetico-para-teste-abcdefghij';\n",
  });
  assert.deepEqual(achados, []);
});

// ------------------------------------------------- configuração fail-closed

test('a configuração de produção é validada também na Vercel', () => {
  // `src/index.js` já fazia isto; `api/index.js` — que é quem atende a
  // produção — não fazia. A validação de segurança existia só onde a aposta é
  // menor, e a Vercel subia com qualquer configuração.
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'api', 'index.js'), 'utf8');
  assert.match(fonte, /validarConfiguracao/);
  assert.match(fonte, /configuracao\.producao && configuracao\.configEstrita/);
});

test('o modo estrito nasce desligado, e é ligável por ambiente', () => {
  // Ligar o portão junto com o código que o criou trocaria um risco silencioso
  // por uma queda certa: ninguém conferiu se a produção de hoje passa nas seis
  // condições que a validação cobre.
  const base = { CRMCLINICA_DATABASE_URL: 'postgres://exemplo' };
  assert.equal(carregarConfiguracao(base).configEstrita, false);
  assert.equal(carregarConfiguracao({ ...base, CRMCLINICA_CONFIG_ESTRITA: 'sim' }).configEstrita, true);
  assert.equal(carregarConfiguracao({ ...base, CRMCLINICA_CONFIG_ESTRITA: 'nao' }).configEstrita, false);
});

test('/health conta os problemas de configuração, sem descrevê-los', () => {
  // A contagem é o que torna verificável, de fora, se é seguro ligar o modo
  // estrito. As MENSAGENS não saem: elas descrevem a forma da configuração, e
  // `/health` responde sem autenticação nenhuma.
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'src', 'servidor', 'http.js'), 'utf8');
  assert.match(fonte, /configuracao: \{ problemas: validarConfiguracao\(configuracao\)\.length \}/);

  const bloco = fonte.slice(fonte.indexOf("produto: 'crmclinica'"), fonte.indexOf("produto: 'crmclinica'") + 2000);
  assert.ok(!/problemas: validarConfiguracao\(configuracao\)(?!\.length)/.test(bloco),
    'só a contagem pode sair do /health');
});

test('uma configuração de produção incompleta é reprovada', () => {
  // Cinto de segurança do próprio validador: se ele parar de acusar, o portão
  // vira decoração.
  const problemas = validarConfiguracao(carregarConfiguracao({
    NODE_ENV: 'production',
    CRMCLINICA_DATABASE_URL: 'postgres://exemplo',
    SERENA_TRANSPORTE_WHATSAPP: 'crm_despacha',
  }));
  assert.ok(problemas.length > 0);
  assert.ok(problemas.some((p) => /WEBHOOK_SECRET/.test(p)));
});
