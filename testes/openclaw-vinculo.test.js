'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { criarVinculoDeCanal, extrairQr } = require('../src/integracoes/openclaw-vinculo');
const { ErroDeGateway } = require('../src/integracoes/openclaw-gateway');

// A vinculação do canal é lida por uma tela que repete a chamada a cada 5s. O
// que se testa aqui é sobretudo o que ela NÃO pode fazer: alterar estado no
// gateway, e confundir "não consegui perguntar" com "perguntei, e não há QR".
//
// Essa distinção já esteve errada uma vez, e o sintoma era silencioso: a tela
// mostrava "gateway não respondeu" justamente quando o gateway tinha respondido,
// escondendo a instrução manual — que é o caminho que funciona hoje.

const QR = 'data:image/png;base64,iVBORw0KGgo=';

/** Cliente de gateway falso: registra o que foi chamado e devolve o combinado. */
function clienteFalso(respostas = {}) {
  const chamadas = [];
  return {
    chamadas,
    async chamar(metodo, parametros) {
      chamadas.push({ metodo, parametros });
      const resposta = respostas[metodo];
      if (typeof resposta === 'function') return resposta();
      if (resposta instanceof Error) throw resposta;
      return resposta ?? {};
    },
  };
}

const canalDesvinculado = { channels: { whatsapp: { linked: false, connected: false } } };
const canalVinculado = {
  channels: { whatsapp: { linked: true, connected: true, self: { e164: '+5516993120938' } } },
};

test('estado traduz a resposta do gateway para o vocabulário da tela', async () => {
  const cliente = clienteFalso({ 'channels.status': canalVinculado });
  const vinculo = criarVinculoDeCanal({}, { cliente });

  assert.deepEqual(await vinculo.estado(), {
    vinculado: true,
    conectado: true,
    numero: '+5516993120938',
    estado: 'desconhecido',
  });
});

test('canal já vinculado não abre assistente nenhum', async () => {
  // Abrir o wizard aqui derrubaria a sessão existente — o oposto do que quem
  // clicou em "reconectar" espera que aconteça antes de ele ter escaneado nada.
  const cliente = clienteFalso({ 'channels.status': canalVinculado });
  const vinculo = criarVinculoDeCanal({}, { cliente });

  const resultado = await vinculo.obterQr();

  assert.equal(resultado.vinculado, true);
  assert.equal(resultado.qr, null);
  assert.deepEqual(cliente.chamadas.map((c) => c.metodo), ['channels.status']);
});

test('obter o QR é só leitura: nunca inicia nem avança o assistente', async () => {
  // O contrato que importa. `wizard.start` reiniciaria o assistente e trocaria o
  // QR que a pessoa está no meio de escanear; `wizard.next` empurraria um
  // assistente de configuração geral às cegas, sem resposta nenhuma preenchida.
  // A cada 5 segundos, dezenas de vezes por vinculação.
  const cliente = clienteFalso({
    'channels.status': canalDesvinculado,
    'wizard.status': { step: { id: 'scanQr' }, qr: QR },
  });
  const vinculo = criarVinculoDeCanal({}, { cliente });

  const resultado = await vinculo.obterQr();

  assert.equal(resultado.qr, QR);
  assert.equal(resultado.vinculado, false);
  const metodos = cliente.chamadas.map((c) => c.metodo);
  assert.deepEqual(metodos, ['channels.status', 'wizard.status']);
  assert.ok(!metodos.includes('wizard.start'), 'wizard.start altera estado e não pode ser chamado');
  assert.ok(!metodos.includes('wizard.next'), 'wizard.next altera estado e não pode ser chamado');
});

test('recusa do gateway vira "sem QR", não falha — é o que libera a instrução manual', async () => {
  // O gateway respondeu: não há assistente aberto, ou o método nem existe. Isso
  // é informação, não indisponibilidade. Tratar como falha faria a rota devolver
  // 503 e a tela esconderia o passo a passo do `vincular-whatsapp`.
  for (const codigo of ['gateway_wizard_not_found', 'gateway_method_not_found', 'gateway_erro']) {
    const cliente = clienteFalso({
      'channels.status': canalDesvinculado,
      'wizard.status': new ErroDeGateway('nenhum assistente aberto', codigo),
    });
    const vinculo = criarVinculoDeCanal({}, { cliente });

    const resultado = await vinculo.obterQr();
    assert.deepEqual(resultado, { vinculado: false, qr: null }, `${codigo} deveria virar "sem QR"`);
  }
});

test('falha de transporte propaga — a tela precisa saber que a pergunta não chegou', async () => {
  for (const codigo of ['gateway_timeout', 'gateway_desconectado', 'gateway_indisponivel']) {
    const cliente = clienteFalso({
      'channels.status': canalDesvinculado,
      'wizard.status': new ErroDeGateway('sem resposta', codigo),
    });
    const vinculo = criarVinculoDeCanal({}, { cliente });

    await assert.rejects(() => vinculo.obterQr(), (erro) => erro.codigo === codigo,
      `${codigo} não pode ser engolido como "sem QR"`);
  }
});

test('gateway inalcançável no status sobe direto, sem virar "sem QR"', async () => {
  const cliente = clienteFalso({
    'channels.status': new ErroDeGateway('conexão encerrada', 'gateway_desconectado'),
  });
  const vinculo = criarVinculoDeCanal({}, { cliente });

  await assert.rejects(() => vinculo.obterQr(), (erro) => erro.codigo === 'gateway_desconectado');
});

test('não existe cancelar: o painel não abre assistente, e não pode fechar o dos outros', () => {
  // O único assistente que poderia estar aberto é o do admin rodando
  // `vincular-whatsapp` no terminal. Um `wizard.cancel` disparado ao fechar a
  // janela do navegador mataria o QR dele no meio do escaneamento.
  const vinculo = criarVinculoDeCanal({}, { cliente: clienteFalso() });
  assert.equal(vinculo.cancelar, undefined);
});

test('sem URL configurada, falha permanente antes de tentar rede', async () => {
  const vinculo = criarVinculoDeCanal({});
  await assert.rejects(() => vinculo.estado(), (erro) => erro.codigo === 'gateway_sem_url');
});

test('extrairQr acha o código onde quer que a versão do gateway o coloque', () => {
  assert.equal(extrairQr({ qr: QR }), QR);
  assert.equal(extrairQr({ data: { qrDataUrl: QR } }), QR);
  assert.equal(extrairQr({ step: { id: 'scanQr', qr: QR } }), QR);
  assert.equal(extrairQr({ fundo: { mais: { fundo: { imagem: QR } } } }), QR);
});

test('extrairQr não confunde texto qualquer com imagem', () => {
  assert.equal(extrairQr({ qr: 'ainda não gerado' }), null);
  assert.equal(extrairQr({ step: { id: 'aguardando' } }), null);
  assert.equal(extrairQr(null), null);
  assert.equal(extrairQr('data:image/png;base64,xxx'), null, 'só objeto é passo de wizard');
});
