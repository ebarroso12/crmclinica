'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { criarSincronizadorDaSerena, decidirAtendimento } = require('../src/dominio/sincronia-serena');
const { aplicarPoliticaNoTexto, lerPoliticaDoTexto } = require('../src/integracoes/openclaw-politica');

const AGORA = new Date('2026-08-04T20:00:00-03:00'); // terça, 20h — dentro da grade noturna
const DIA = new Date('2026-08-04T10:00:00-03:00');   // terça, 10h — expediente da equipe

const GRADE = Object.freeze({
  ativa: true,
  fuso: 'America/Sao_Paulo',
  dias: {
    0: [['00:00', '23:59']],
    1: [['18:00', '07:00']], 2: [['18:00', '07:00']], 3: [['18:00', '07:00']],
    4: [['18:00', '07:00']], 5: [['18:00', '07:00']],
    6: [['00:00', '23:59']],
  },
});

// ------------------------------------------------------------------- a decisão

test('dentro da grade noturna, a Serena atende', () => {
  const d = decidirAtendimento({ ativa: true, agenda: GRADE }, AGORA);
  assert.equal(d.atender, true);
  assert.equal(d.motivo, 'horario');
});

test('no expediente da equipe, a Serena cala', () => {
  const d = decidirAtendimento({ ativa: true, agenda: GRADE }, DIA);
  assert.equal(d.atender, false);
  assert.equal(d.motivo, 'horario');
});

test('o interruptor vence a grade — desligada é desligada', () => {
  // Sem esta precedência, desligar a Serena às 20h não teria efeito nenhum, e a
  // equipe descobriria isso com paciente recebendo resposta.
  const d = decidirAtendimento({ ativa: false, agenda: GRADE }, AGORA);
  assert.equal(d.atender, false);
  assert.equal(d.motivo, 'interruptor');
});

test('a pausa vence a grade e o plantão', () => {
  const daquiUmaHora = new Date(AGORA.getTime() + 3600_000).toISOString();
  const d = decidirAtendimento(
    { ativa: true, agenda: GRADE, pausada_ate: daquiUmaHora, ligada_ate: daquiUmaHora },
    AGORA,
  );
  assert.equal(d.atender, false);
  assert.equal(d.motivo, 'pausa');
});

test('pausa vencida deixa de valer sozinha', () => {
  const ontem = new Date(AGORA.getTime() - 86_400_000).toISOString();
  const d = decidirAtendimento({ ativa: true, agenda: GRADE, pausada_ate: ontem }, AGORA);
  assert.equal(d.atender, true);
});

test('o plantão faz atender fora da grade, sem mexer nela', () => {
  const daquiUmaHora = new Date(DIA.getTime() + 3600_000).toISOString();
  const d = decidirAtendimento({ ativa: true, agenda: GRADE, ligada_ate: daquiUmaHora }, DIA);
  assert.equal(d.atender, true);
  assert.equal(d.motivo, 'plantao');
});

test('sem grade, atende sempre — ausência de configuração não vira silêncio', () => {
  assert.equal(decidirAtendimento({ ativa: true }, DIA).atender, true);
});

// ------------------------------------------------------- a escrita da política

test('calar não desvincula o telefone', () => {
  // Desligar o canal exigiria escanear o QR de novo a cada turno de folga da
  // Serena — o que na prática faria ninguém usar o horário.
  const antes = JSON.stringify({
    gateway: { auth: { token: 'x' } },
    channels: { whatsapp: { enabled: true, dmPolicy: 'open', allowFrom: ['*'], debounceMs: 1500 } },
  });

  const depois = JSON.parse(aplicarPoliticaNoTexto(antes, false));
  assert.equal(depois.channels.whatsapp.enabled, true);
  assert.equal(depois.channels.whatsapp.dmPolicy, 'allowlist');
  assert.deepEqual(depois.channels.whatsapp.allowFrom, []);
});

test('o resto da configuração do gateway não é tocado', () => {
  const antes = JSON.stringify({
    gateway: { auth: { token: 'segredo' }, porta: 18790 },
    models: { padrao: 'x' },
    channels: { whatsapp: { dmPolicy: 'open', allowFrom: ['*'], debounceMs: 1500, mediaMaxMb: 50 } },
  });

  const depois = JSON.parse(aplicarPoliticaNoTexto(antes, false));
  assert.equal(depois.gateway.auth.token, 'segredo');
  assert.equal(depois.gateway.porta, 18790);
  assert.equal(depois.models.padrao, 'x');
  assert.equal(depois.channels.whatsapp.debounceMs, 1500);
  assert.equal(depois.channels.whatsapp.mediaMaxMb, 50);
});

test('a leitura reconhece os dois jeitos de estar atendendo', () => {
  assert.equal(lerPoliticaDoTexto(JSON.stringify({ channels: { whatsapp: { dmPolicy: 'open' } } })).atendendo, true);
  assert.equal(
    lerPoliticaDoTexto(JSON.stringify({ channels: { whatsapp: { dmPolicy: 'allowlist', allowFrom: ['*'] } } })).atendendo,
    true,
  );
  assert.equal(
    lerPoliticaDoTexto(JSON.stringify({ channels: { whatsapp: { dmPolicy: 'allowlist', allowFrom: [] } } })).atendendo,
    false,
  );
});

// ------------------------------------------------------------- o sincronizador

function politicaFalsa(estadoInicial) {
  let atendendo = estadoInicial;
  const escritas = [];
  return {
    escritas,
    async definir(novo) {
      if (atendendo === novo) return { alterado: false, atendendo };
      const de = atendendo;
      atendendo = novo;
      escritas.push(novo);
      return { alterado: true, atendendo, de };
    },
  };
}

test('só escreve quando o estado muda de verdade', async () => {
  // O worker chama isto a cada minuto. Sem esta guarda, seriam 1.440 reescritas
  // por dia do arquivo de configuração para não mudar nada.
  const politica = politicaFalsa(true);
  const sincronizador = criarSincronizadorDaSerena({
    serena: { async obterConfiguracao() { return { ativa: true, agenda: GRADE }; } },
    politica,
    agora: () => AGORA,
  });

  await sincronizador.sincronizar();
  await sincronizador.sincronizar();
  await sincronizador.sincronizar();

  assert.deepEqual(politica.escritas, []);
});

test('cala o canal quando a grade fecha', async () => {
  const politica = politicaFalsa(true);
  const sincronizador = criarSincronizadorDaSerena({
    serena: { async obterConfiguracao() { return { ativa: true, agenda: GRADE }; } },
    politica,
    agora: () => DIA,
  });

  const r = await sincronizador.sincronizar();
  assert.equal(r.aplicado, true);
  assert.equal(r.decisao.atender, false);
  assert.deepEqual(politica.escritas, [false]);
});

test('banco fora do ar não reabre o atendimento', async () => {
  // O risco real: falhar e "abrir por segurança" reabriria o canal que alguém
  // acabou de fechar durante um incidente. Diante da dúvida, não mexe.
  const politica = politicaFalsa(false);
  const sincronizador = criarSincronizadorDaSerena({
    serena: { async obterConfiguracao() { throw new Error('conexão perdida'); } },
    politica,
    agora: () => AGORA,
  });

  const r = await sincronizador.sincronizar();
  assert.equal(r.aplicado, false);
  assert.deepEqual(politica.escritas, []);
});

test('gateway fora do ar não derruba o worker', async () => {
  const sincronizador = criarSincronizadorDaSerena({
    serena: { async obterConfiguracao() { return { ativa: true, agenda: GRADE }; } },
    politica: { async definir() { throw new Error('gateway indisponível'); } },
    agora: () => AGORA,
  });

  const r = await sincronizador.sincronizar();
  assert.equal(r.aplicado, false);
  assert.match(r.erro, /indisponível/);
});
