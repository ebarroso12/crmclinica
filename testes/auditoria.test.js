'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Auditoria executável: transforma as regras de arquitetura e de segredo em teste.
// Se alguém reintroduzir um orquestrador visual, o nome fundido do provedor ou uma
// chave real, o `npm test` quebra antes do commit.

const RAIZ = path.join(__dirname, '..');

// `documentos/` guarda o material de referência entregue pelo cliente (PRD, roadmap, schema).
// Não é código do produto e tem regra própria mais abaixo: lá os termos proibidos só podem
// aparecer em forma de proibição, nunca de uso.
const PASTA_REFERENCIA = 'documentos';
const PASTAS_IGNORADAS = new Set([
  'node_modules', '.git', '.vercel', 'dist', 'coverage', '.claude', PASTA_REFERENCIA,
]);
const EXTENSOES = new Set(['.js', '.json', '.md', '.html', '.css', '.sql', '.yml', '.yaml', '.exemplo']);

// Termos montados em pedaços de propósito: uma busca literal no repositório
// não deve encontrar ocorrência nem dentro deste arquivo de auditoria.
const ORQUESTRADOR_VISUAL_PROIBIDO = `n${'8'}n`;
const NOME_FUNDIDO_PROIBIDO = `Kimi${'Claw'}`;
// O inbox é o próprio produto: nenhum serviço externo de conversas no código.
const INBOX_EXTERNO_PROIBIDO = `Chat${'woot'}`;

function listarArquivos(diretorio = RAIZ, acumulado = []) {
  for (const entrada of fs.readdirSync(diretorio, { withFileTypes: true })) {
    if (PASTAS_IGNORADAS.has(entrada.name)) continue;
    // O .env local contém a conexão real e é protegido pelo .gitignore.
    // Apenas o modelo vazio .env.exemplo pode entrar na auditoria versionável.
    if (entrada.name === '.env' || (entrada.name.startsWith('.env.') && entrada.name !== '.env.exemplo')) continue;
    // Mesma razão: a identidade do dispositivo no gateway OpenClaw guarda uma
    // chave privada Ed25519 e é coberta pelo .gitignore. O teste logo abaixo
    // confere essa proteção — que é o que realmente importa auditar.
    if (entrada.name === '.openclaw-identidade.json') continue;
    const caminho = path.join(diretorio, entrada.name);

    if (entrada.isDirectory()) {
      listarArquivos(caminho, acumulado);
      continue;
    }
    if (EXTENSOES.has(path.extname(entrada.name)) || entrada.name.startsWith('.env')) {
      acumulado.push(caminho);
    }
  }
  return acumulado;
}

const ARQUIVOS = listarArquivos().filter((caminho) => caminho !== __filename);
const relativo = (caminho) => path.relative(RAIZ, caminho).replace(/\\/g, '/');

test('a auditoria encontra os arquivos do projeto', () => {
  assert.ok(ARQUIVOS.length >= 10, `poucos arquivos varridos: ${ARQUIVOS.length}`);
});

test('nenhum orquestrador visual externo aparece no código, na documentação ou na interface', () => {
  const padrao = new RegExp(ORQUESTRADOR_VISUAL_PROIBIDO, 'i');
  const encontrados = ARQUIVOS.filter((caminho) => padrao.test(fs.readFileSync(caminho, 'utf8')));
  assert.deepEqual(encontrados.map(relativo), []);
});

test('o nome fundido do provedor com o orquestrador não existe', () => {
  const padrao = new RegExp(NOME_FUNDIDO_PROIBIDO, 'i');
  const encontrados = ARQUIVOS.filter((caminho) => padrao.test(fs.readFileSync(caminho, 'utf8')));
  assert.deepEqual(encontrados.map(relativo), []);
});

test('nenhum serviço externo de conversas aparece no código, na documentação ou na interface', () => {
  const padrao = new RegExp(INBOX_EXTERNO_PROIBIDO, 'i');
  const encontrados = ARQUIVOS.filter((caminho) => padrao.test(fs.readFileSync(caminho, 'utf8')));
  assert.deepEqual(encontrados.map(relativo), [], 'o inbox é o próprio produto');
});

test('não existe variável de ambiente de inbox externo', () => {
  const padrao = new RegExp(`${INBOX_EXTERNO_PROIBIDO.toUpperCase()}_[A-Z_]+`, 'i');
  const encontrados = ARQUIVOS.filter((caminho) => padrao.test(fs.readFileSync(caminho, 'utf8')));
  assert.deepEqual(encontrados.map(relativo), []);
});

test('nenhuma dependência de terceiros além do driver do banco', () => {
  const pacote = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pacote.dependencies || {}), ['pg']);
  assert.deepEqual(Object.keys(pacote.devDependencies || {}), []);
});

test('no material de referência, os termos proibidos só aparecem como proibição', () => {
  const pastaReferencia = path.join(RAIZ, PASTA_REFERENCIA);
  if (!fs.existsSync(pastaReferencia)) return;

  // O inbox externo fica de fora aqui: no material do cliente ele é citado como
  // referência visual, o que é legítimo. O que não pode é chegar ao código.
  const padrao = new RegExp(`${ORQUESTRADOR_VISUAL_PROIBIDO}|${NOME_FUNDIDO_PROIBIDO}`, 'i');
  // Uma linha só é aceita se negar o termo ("não existe", "sem", "nunca")
  // ou se for instrução de auditoria sobre ele ("procurar", "remover", "conferir").
  const usoLegitimo = /\b(n[ãa]o|sem|nem|nunca|proibid|procurar|buscar|conferir|verificar|validar|auditar|remover|eliminar|grep)/i;

  const violacoes = [];
  const percorrer = (diretorio) => {
    for (const entrada of fs.readdirSync(diretorio, { withFileTypes: true })) {
      const caminho = path.join(diretorio, entrada.name);
      if (entrada.isDirectory()) { percorrer(caminho); continue; }

      const linhas = fs.readFileSync(caminho, 'utf8').split(/\r?\n/);
      linhas.forEach((linha, indice) => {
        if (!padrao.test(linha)) return;

        // O termo pode ser item de uma lista cujo cabeçalho é que carrega a
        // negação ("## Proibido importar: … - o termo;"). Olhar só a linha acusaria
        // a lista inteira, então o bloco acima também conta. Oito linhas cobrem
        // um cabeçalho de seção mais os itens até ele.
        const contexto = linhas.slice(Math.max(0, indice - 8), indice + 1).join(' ');
        if (!usoLegitimo.test(contexto)) violacoes.push(`${relativo(caminho)}:${indice + 1}`);
      });
    }
  };
  percorrer(pastaReferencia);

  assert.deepEqual(violacoes, [], 'o material de referência usa um termo proibido fora de negação');
});

test('Kimi nunca é descrito como controlador ou orquestrador', () => {
  const proibidos = [
    /kimi[^.\n]{0,40}\b(orquestrador|controlador|controla)\b/i,
    /\b(orquestrador|controlador)\b[^.\n]{0,20}\bkimi\b/i,
  ];

  const violacoes = [];
  for (const caminho of ARQUIVOS) {
    const conteudo = fs.readFileSync(caminho, 'utf8');
    for (const padrao of proibidos) {
      if (padrao.test(conteudo)) violacoes.push(relativo(caminho));
    }
  }
  assert.deepEqual(violacoes, []);
});

test('README e arquitetura declaram o OpenClaw como orquestrador', () => {
  for (const documento of ['README.md', 'docs/ARQUITETURA_OPENCLAW.md']) {
    const conteudo = fs.readFileSync(path.join(RAIZ, documento), 'utf8');
    assert.match(conteudo, /OpenClaw/, `${documento} não cita o OpenClaw`);
    assert.match(conteudo, /orquestrador/i, `${documento} não descreve o papel de orquestrador`);
    assert.match(conteudo, /Kimi/, `${documento} não posiciona o provedor de modelo`);
    assert.match(conteudo, /opcional/i, `${documento} não marca o provedor como opcional`);
  }
});

test('nenhuma chave real está versionada', () => {
  // Formatos de credencial que não podem existir em arquivo versionado.
  const assinaturasDeSegredo = [
    { nome: 'chave de API sk-', padrao: /\bsk-[A-Za-z0-9_-]{16,}/ },
    { nome: 'token do GitHub', padrao: /\bgh[pousr]_[A-Za-z0-9]{16,}/ },
    { nome: 'JWT', padrao: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
    { nome: 'senha em URL de banco', padrao: /postgres(?:ql)?:\/\/[^\s:@/]+:[^\s:@/]+@/ },
    { nome: 'chave privada', padrao: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  ];

  const violacoes = [];
  for (const caminho of ARQUIVOS) {
    const conteudo = fs.readFileSync(caminho, 'utf8');
    for (const { nome, padrao } of assinaturasDeSegredo) {
      if (padrao.test(conteudo)) violacoes.push(`${relativo(caminho)}: ${nome}`);
    }
  }
  assert.deepEqual(violacoes, []);
});

test('o modelo de ambiente tem todas as variáveis vazias', () => {
  const linhas = fs.readFileSync(path.join(RAIZ, '.env.exemplo'), 'utf8')
    .split(/\r?\n/)
    .filter((linha) => linha.trim() && !linha.trim().startsWith('#'));

  assert.ok(linhas.length > 0, '.env.exemplo está vazio');

  // Segredos ficam sempre em branco; só valores de configuração pública podem vir preenchidos.
  const chavesSensiveis = /(TOKEN|SECRET|KEY|PASSWORD|SENHA|DATABASE_URL|SESSION)/i;
  for (const linha of linhas) {
    const [chave, ...resto] = linha.split('=');
    if (chavesSensiveis.test(chave)) {
      assert.equal(resto.join('=').trim(), '', `${chave.trim()} deveria estar vazia em .env.exemplo`);
    }
  }
});

test('o .gitignore protege o arquivo .env', () => {
  const conteudo = fs.readFileSync(path.join(RAIZ, '.gitignore'), 'utf8');
  assert.match(conteudo, /^\.env$/m);
  assert.match(conteudo, /^!\.env\.exemplo$/m);
});

test('o .gitignore protege a identidade do dispositivo no gateway', () => {
  // A chave privada Ed25519 é o que prova ao OpenClaw que quem fala é o
  // crmclinica. Versioná-la daria a qualquer pessoa com acesso ao repositório o
  // poder de mandar mensagem pelo WhatsApp da clínica.
  const conteudo = fs.readFileSync(path.join(RAIZ, '.gitignore'), 'utf8');
  assert.match(conteudo, /^\.openclaw-identidade\.json$/m);
});

test('a interface não embute script nem estilo inline', () => {
  const html = fs.readFileSync(path.join(RAIZ, 'public', 'index.html'), 'utf8');

  assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(html), 'há script inline no HTML');
  assert.ok(!/\sstyle="/i.test(html), 'há estilo inline no HTML');
  assert.ok(!/\son[a-z]+="(?!return false)/i.test(html), 'há manipulador de evento inline no HTML');
});
