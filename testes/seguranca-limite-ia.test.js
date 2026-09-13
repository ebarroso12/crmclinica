'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { subirServidor } = require('./auxiliar');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarLimiteDeIA, LIMITES_DE_IA, ErroDeOrcamentoDeIA } = require('../src/seguranca/limite-ia');

// Limite das rotas que gastam modelo de linguagem.
//
// O custo de abuso aqui é diferente do de autenticação: uma tentativa de login
// a mais gasta CPU nossa; uma chamada de LLM a mais gasta DINHEIRO, por token,
// num provedor de terceiro, sem teto natural.
//
// E não é só conta: limitar frequência é o que transforma extração sistemática
// (`model inversion` — milhares de perguntas em sequência para reconstruir o
// prompt ou o contexto de atendimento) de "algumas horas" em "meses". A
// barreira de saída avalia uma resposta por vez; este ataque vive no volume.

test('a rota de orientação para de responder quando a cota estoura', async () => {
  // O teste que importa: pela rota HTTP de verdade, com o limitador montado
  // como em produção. Recurso de segurança que existe e não está ligado é o
  // defeito mais caro deste repositório — já aconteceu.
  const repositorio = criarRepositorioEmMemoria();
  const contato = await repositorio.encontrarOuCriarContato({
    telefone: '5511999990000', nome: 'P', canal: 'whatsapp', identificador: null,
  });
  const conversa = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');

  // Cota mínima, para o teste não precisar de 20 requisições.
  const limiteDeIA = criarLimiteDeIA({
    repositorio,
    limitador: {
      async exigirDentroDoLimite({ acao }) {
        if (chamadas[acao] >= 2) {
          const erro = new Error('tentativas demais; tente novamente mais tarde');
          erro.status = 429;
          erro.retryAfter = 60;
          throw erro;
        }
      },
      async registrar({ acao }) { chamadas[acao] = (chamadas[acao] ?? 0) + 1; },
    },
  });
  const chamadas = {};

  const ambiente = await subirServidor({ repositorio, limiteDeIA });
  try {
    const pedir = () => ambiente.pedir(`/api/conversas/${conversa.id}/orientacao`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orientacao: 'pode dar 300' }),
    });

    // As duas primeiras passam da cota (404 porque não há dúvida pendente —
    // o que interessa aqui é que NÃO foi 429).
    const primeira = await pedir();
    const segunda = await pedir();
    assert.notEqual(primeira.status, 429);
    assert.notEqual(segunda.status, 429);

    const terceira = await pedir();
    assert.equal(terceira.status, 429, 'a terceira tem de bater no limite');
    assert.ok(terceira.headers.get('retry-after'), 'cliente educado precisa saber quando voltar');
  } finally {
    await ambiente.encerrar();
  }
});

test('a cota é cobrada mesmo quando a rota falha depois', async () => {
  // Se só o sucesso contasse, um laço da interface batendo em erro passaria
  // por baixo do limite para sempre — e é justamente o laço que queima
  // dinheiro sem ninguém perceber.
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'src', 'servidor', 'http.js'), 'utf8');
  const bloco = fonte.slice(fonte.indexOf('async function exigirCotaDeIA'));
  const corpo = bloco.slice(0, bloco.indexOf('\n    }'));

  assert.match(corpo, /await limiteDeIA\.exigirCota/);
  assert.match(corpo, /await limiteDeIA\.registrarUso/);
  // O registro vem na mesma passagem, antes de a rota rodar.
  assert.ok(
    corpo.indexOf('registrarUso') > corpo.indexOf('exigirCota'),
    'exige primeiro, registra em seguida — as duas antes do despacho',
  );
});

test('toda rota que gasta LLM está na tabela de cotas', () => {
  // Cinta contra a regressão mais provável: criar uma rota de IA nova e
  // esquecer de limitá-la. A tabela é o lugar único que responde "o que neste
  // sistema custa dinheiro por clique?".
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'src', 'servidor', 'http.js'), 'utf8');
  const tabela = fonte.slice(fonte.indexOf('const ACOES_DE_IA'), fonte.indexOf('function acaoDeIADaRota'));
  // As rotas vivem como regex, com as barras escapadas — comparar contra o
  // caminho literal exigiria escapar aqui também, e escape perdido em edição é
  // uma armadilha conhecida deste repositório. Tirar as contrabarras é mais
  // simples e não tem como sair errado.
  const semEscape = tabela.replace(/\\/g, '');

  for (const rota of ['/api/ia/relatorio', '/api/ia/assistente', '/api/serena/teste', '/api/conversas', 'teste$', 'treinamentos']) {
    assert.ok(semEscape.includes(rota), `a rota ${rota} não está na tabela de cotas de IA`);
  }
  // E as cotas citadas existem de fato.
  for (const regra of tabela.matchAll(/acao: '([a-z_]+)'/g)) {
    assert.ok(Object.hasOwn(LIMITES_DE_IA, regra[1]), `cota "${regra[1]}" não existe em LIMITES_DE_IA`);
  }
});

test('o webhook do paciente NÃO entra na cota', () => {
  // Limitar por IP ali puniria o provedor do canal, não o abusador — e quem
  // pagaria seria o paciente, sem resposta. A defesa daquele caminho é a
  // assinatura do webhook, não a cota.
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'src', 'servidor', 'http.js'), 'utf8');
  const tabela = fonte.slice(fonte.indexOf('const ACOES_DE_IA'), fonte.indexOf('function acaoDeIADaRota'));

  assert.ok(!tabela.includes('webhook'), 'webhook de canal não pode estar sob cota por IP');
});

// ------------------------------------------------------------- o orçamento

test('o teto diário barra mesmo quem está dentro da própria cota', async () => {
  // A rede que pega o que os limites por pessoa não pegam: dez contas
  // legítimas somando muito num dia atípico.
  const limite = criarLimiteDeIA({
    repositorio: { async somarCustoDeIADesde() { return 30; } },
    limitador: { async exigirDentroDoLimite() {}, async registrar() {} },
    tetoDiarioUsd: 25,
  });

  await assert.rejects(
    () => limite.exigirCota({ acao: 'ia_assistente', email: 'a@b.c', ip: '1.2.3.4' }),
    (erro) => {
      assert.ok(erro instanceof ErroDeOrcamentoDeIA);
      assert.equal(erro.status, 429);
      assert.equal(erro.codigo, 'ia_orcamento_diario');
      // Sem isto o cabeçalho `retry-after` sairia como "undefined", e
      // `retry-after` inválido faz cliente educado repetir na hora.
      assert.ok(Number.isInteger(erro.retryAfter) && erro.retryAfter > 0);
      return true;
    },
  );
});

test('dentro do teto, a chamada passa', async () => {
  const limite = criarLimiteDeIA({
    repositorio: { async somarCustoDeIADesde() { return 3; } },
    limitador: { async exigirDentroDoLimite() {}, async registrar() {} },
    tetoDiarioUsd: 25,
  });
  await limite.exigirCota({ acao: 'ia_assistente', email: 'a@b.c', ip: '1.2.3.4' });
});

test('o orçamento é consultado DEPOIS da cota por pessoa', async () => {
  // Ordem importa por custo: quem já estourou a própria cota não deve nem
  // pagar a consulta de soma no banco.
  let somou = false;
  const limite = criarLimiteDeIA({
    repositorio: { async somarCustoDeIADesde() { somou = true; return 0; } },
    limitador: {
      async exigirDentroDoLimite() { throw Object.assign(new Error('cheio'), { status: 429, retryAfter: 10 }); },
      async registrar() {},
    },
  });

  await assert.rejects(() => limite.exigirCota({ acao: 'ia_teste', email: 'a@b.c' }));
  assert.equal(somou, false, 'não consulta o orçamento de quem já estourou a cota');
});

test('sem o método de soma no repositório, o limite por pessoa continua valendo', async () => {
  // Degradação graciosa: repositório antigo (ou em memória de um teste) não
  // pode derrubar a rota — só perde a rede do orçamento.
  const limite = criarLimiteDeIA({
    repositorio: {},
    limitador: { async exigirDentroDoLimite() {}, async registrar() {} },
  });
  await limite.exigirCota({ acao: 'ia_teste', email: 'a@b.c' });
});
