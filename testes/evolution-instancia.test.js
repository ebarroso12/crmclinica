'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { criarClienteEvolucaoInstancia } = require('../src/integracoes/evolution-instancia');

// Cliente de estado e pareamento de uma instância da Evolution, com fetch FALSO.
// Prova: tradução dos estados, código e QR, prazo curto, e que nada devolvido
// (resultado OU erro) carrega a apikey ou a URL da Evolution.
//
// NÃO prova o formato real de cada versão da Evolution API — os campos lidos
// (`instance.state`, `ownerJid`, `profileName`, `pairingCode`, `base64`) são os
// da v2; uma versão que responda diferente cai em "desconhecido"/sem código.

const CONFIG = { apiUrl: 'https://evo.exemplo.test/', apiKey: 'chave-secreta-da-evolution', timeoutMs: 15000 };
const QR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

function resposta(status, corpo) {
  return {
    status,
    json: async () => {
      if (corpo === undefined) throw new SyntaxError('sem json');
      return corpo;
    },
  };
}

function fetchFalso(rotas) {
  const pedidos = [];
  const fetchImpl = async (url, opcoes) => {
    pedidos.push({ url, opcoes });
    const caminho = url.replace('https://evo.exemplo.test', '').split('?')[0];
    const tratador = rotas[caminho];
    if (typeof tratador === 'function') return tratador(url, opcoes);
    return tratador ?? resposta(404, { message: 'Not Found' });
  };
  return { fetchImpl, pedidos };
}

function assertSemSegredo(valor) {
  const texto = `${JSON.stringify(valor)} ${valor?.message ?? ''}`;
  assert.ok(!texto.includes(CONFIG.apiKey), 'a apikey não pode sair do cliente');
  assert.ok(!texto.includes('evo.exemplo.test'), 'a URL da Evolution não pode sair do cliente');
}

async function rejeita(promessa, { status, codigo }) {
  let capturado = null;
  await assert.rejects(promessa, (erro) => {
    capturado = erro;
    assert.equal(erro.status, status, `status: ${erro.message}`);
    if (codigo) assert.equal(erro.codigo, codigo);
    return true;
  });
  assertSemSegredo(capturado);
}

test('sem URL ou sem chave, o cliente não fica disponível e responde 503 sem tentar rede', async () => {
  const { fetchImpl, pedidos } = fetchFalso({});
  for (const configuracao of [{}, { apiUrl: CONFIG.apiUrl }, { apiKey: CONFIG.apiKey }]) {
    const cliente = criarClienteEvolucaoInstancia(configuracao, { fetchImpl });
    assert.equal(cliente.disponivel, false);
    await rejeita(cliente.estado('alpins'), { status: 503, codigo: 'evolution_nao_configurada' });
    await rejeita(cliente.conectar('alpins'), { status: 503, codigo: 'evolution_nao_configurada' });
  }
  assert.equal(pedidos.length, 0);
});

test('conectado traz número e perfil; a chave vai no cabeçalho e o prazo é curto', async () => {
  const { fetchImpl, pedidos } = fetchFalso({
    '/instance/connectionState/alpins': resposta(200, { instance: { instanceName: 'alpins', state: 'open' } }),
    '/instance/fetchInstances': resposta(200, [{ name: 'alpins', ownerJid: '5516991271838@s.whatsapp.net', profileName: 'Loja Alpins' }]),
  });
  const cliente = criarClienteEvolucaoInstancia(CONFIG, { fetchImpl });
  assert.equal(cliente.disponivel, true);

  const estado = await cliente.estado('alpins');
  assert.deepEqual(estado, { estado: 'conectado', numero: '5516991271838', perfil: 'Loja Alpins' });
  assertSemSegredo(estado);

  assert.equal(pedidos[0].url, 'https://evo.exemplo.test/instance/connectionState/alpins', 'barra final da URL não duplica');
  assert.equal(pedidos[0].opcoes.headers.apikey, CONFIG.apiKey);
  assert.ok(pedidos[0].opcoes.signal, 'todo pedido tem prazo');
  assert.equal(pedidos[1].url, 'https://evo.exemplo.test/instance/fetchInstances?instanceName=alpins');
});

test('estados da Evolution viram estados da tela; 404 é instância inexistente', async () => {
  const casos = [
    [resposta(200, { instance: { state: 'close' } }), 'desconectado'],
    [resposta(200, { instance: { state: 'connecting' } }), 'conectando'],
    [resposta(200, { state: 'open' }), 'conectado'],
    [resposta(200, { instance: { state: 'estranho' } }), 'desconhecido'],
    [resposta(200, undefined), 'desconhecido'],
    [resposta(404, { message: 'instance not found' }), 'inexistente'],
  ];
  for (const [respostaDaEvolution, esperado] of casos) {
    const { fetchImpl, pedidos } = fetchFalso({ '/instance/connectionState/alpins': respostaDaEvolution });
    const estado = await criarClienteEvolucaoInstancia(CONFIG, { fetchImpl }).estado('alpins');
    assert.equal(estado.estado, esperado);
    if (esperado !== 'conectado') assert.equal(pedidos.length, 1, `${esperado}: não busca número`);
  }
});

test('falha ao buscar o número não derruba o estado conectado', async () => {
  const { fetchImpl } = fetchFalso({
    '/instance/connectionState/alpins': resposta(200, { instance: { state: 'open' } }),
    '/instance/fetchInstances': async () => { throw new Error('ECONNRESET https://evo.exemplo.test'); },
  });
  const estado = await criarClienteEvolucaoInstancia(CONFIG, { fetchImpl }).estado('alpins');
  assert.deepEqual(estado, { estado: 'conectado', numero: null, perfil: null });
});

test('conectar com número pede código de pareamento só com dígitos e devolve código e QR', async () => {
  const { fetchImpl, pedidos } = fetchFalso({
    '/instance/connect/alpins': resposta(200, { pairingCode: 'KD2ESVLA', code: '2@abc', base64: QR, count: 1 }),
  });
  const resultado = await criarClienteEvolucaoInstancia(CONFIG, { fetchImpl })
    .conectar('alpins', { numero: '+55 (16) 99127-1838' });
  assert.equal(pedidos[0].url, 'https://evo.exemplo.test/instance/connect/alpins?number=5516991271838');
  assert.deepEqual(resultado, { ja_conectado: false, codigo_pareamento: 'KD2ESVLA', qr: QR });
  assertSemSegredo(resultado);
});

test('conectar sem número não manda number; QR e código fora do formato são descartados', async () => {
  const { fetchImpl, pedidos } = fetchFalso({
    '/instance/connect/alpins': resposta(200, { pairingCode: '<script>', base64: 'javascript:alert(1)' }),
  });
  const resultado = await criarClienteEvolucaoInstancia(CONFIG, { fetchImpl }).conectar('alpins');
  assert.equal(pedidos[0].url, 'https://evo.exemplo.test/instance/connect/alpins');
  assert.deepEqual(resultado, { ja_conectado: false, codigo_pareamento: null, qr: null });
});

test('conectar numa instância já aberta diz que já está conectado', async () => {
  const { fetchImpl } = fetchFalso({
    '/instance/connect/alpins': resposta(200, { instance: { instanceName: 'alpins', state: 'open' } }),
  });
  const resultado = await criarClienteEvolucaoInstancia(CONFIG, { fetchImpl }).conectar('alpins');
  assert.equal(resultado.ja_conectado, true);
});

test('erro HTTP, prazo esgotado e rede caída viram 503 sem vazar URL nem chave', async () => {
  const http500 = fetchFalso({ '/instance/connectionState/alpins': resposta(500, { message: `falhou ${CONFIG.apiKey}` }) });
  await rejeita(criarClienteEvolucaoInstancia(CONFIG, http500).estado('alpins'), { status: 503, codigo: 'evolution_http' });

  const lento = fetchFalso({
    '/instance/connectionState/alpins': async () => { const erro = new Error('timeout'); erro.name = 'TimeoutError'; throw erro; },
  });
  await rejeita(criarClienteEvolucaoInstancia(CONFIG, lento).estado('alpins'), { status: 503, codigo: 'evolution_sem_resposta' });

  const caida = fetchFalso({
    '/instance/connect/alpins': async () => { throw new Error('getaddrinfo ENOTFOUND evo.exemplo.test'); },
  });
  await rejeita(criarClienteEvolucaoInstancia(CONFIG, caida).conectar('alpins'), { status: 503, codigo: 'evolution_inacessivel' });

  const inexistente = fetchFalso({ '/instance/connect/alpins': resposta(404, { message: 'not found' }) });
  await rejeita(criarClienteEvolucaoInstancia(CONFIG, inexistente).conectar('alpins'), { status: 404, codigo: 'instancia_inexistente' });
});

test('instância vazia é 422 antes de qualquer rede; nome com caractere especial vai codificado', async () => {
  const { fetchImpl, pedidos } = fetchFalso({});
  const cliente = criarClienteEvolucaoInstancia(CONFIG, { fetchImpl });
  await rejeita(cliente.estado(''), { status: 422, codigo: 'instancia_ausente' });
  await rejeita(cliente.conectar(null), { status: 422, codigo: 'instancia_ausente' });
  assert.equal(pedidos.length, 0);

  await cliente.estado('loja/alpins');
  assert.equal(pedidos[0].url, 'https://evo.exemplo.test/instance/connectionState/loja%2Falpins');
});
