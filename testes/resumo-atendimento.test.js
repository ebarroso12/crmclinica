'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { validarAgente } = require('../src/dominio/agentes/regras');
const {
  criarResumoDeAtendimento, dividirEmMensagens, LIMITE_POR_MENSAGEM,
} = require('../src/dominio/resumo-atendimento');
const { carregarConfiguracao } = require('../src/config');

// Resumo por equipe (docs/RESUMOS.md). Repositório em memória REAL com relógio
// injetado — o mesmo contrato do PostgreSQL; a consulta, a trava e duas cópias
// no banco real estão em testes/contrato-repositorio.test.js. Canal e IA são
// dublês: nada aqui abre rede.

const INICIO = Date.parse('2026-09-11T12:00:00.000Z');

function criarRelogio() {
  let instante = INICIO;
  return {
    agora: () => new Date(instante),
    avancar(minutos) { instante += minutos * 60_000; },
  };
}

function canalFalso({ falhar = () => false, segurar = null } = {}) {
  const envios = [];
  return {
    envios,
    async enviar(carga) {
      if (segurar) await segurar;
      // A mensagem de erro traz o telefone de propósito: a auditoria não pode repeti-lo.
      if (falhar(carga)) throw new Error(`o gateway não confirmou o envio para ${carga.telefone}`);
      envios.push(carga);
      return { identificador: `wa-${envios.length}` };
    },
  };
}

async function montarCenario() {
  const relogio = criarRelogio();
  const repositorio = criarRepositorioEmMemoria({ agora: relogio.agora });
  const auditoria = [];
  const registrarOriginal = repositorio.registrarAuditoria.bind(repositorio);
  repositorio.registrarAuditoria = async (entrada) => {
    auditoria.push(entrada);
    return registrarOriginal(entrada);
  };

  let sequencia = 0;
  async function pessoa(nome, {
    papel = 'atendente', whatsapp = null, autorizado = true, acessoClinica = true, recebe = true, situacao = 'ativo',
  } = {}) {
    sequencia += 1;
    const usuario = await repositorio.criarUsuario({ nome, email: `pessoa-${sequencia}@teste.local`, papel, situacao });
    await repositorio.atualizarUsuario(usuario.id, {
      acessoClinica,
      recebeResumo: recebe,
      ...(whatsapp ? {
        whatsappDdi: '55', whatsappDdd: whatsapp.slice(0, 2), whatsappNumero: whatsapp.slice(2),
        whatsappParticularAutorizado: autorizado,
      } : {}),
    });
    return usuario;
  }

  async function agente(slug, { ativo = true, equipe = [] } = {}) {
    const criado = await repositorio.criarAgente(validarAgente({ slug, nome: `Agente ${slug}` }), { usuarioId: null });
    await repositorio.definirCanaisDoAgente(criado.id, [{ canal: 'whatsapp', instancia: slug, ativo }]);
    for (const membro of equipe) await repositorio.adicionarMembroDaEquipe(criado.id, membro.id);
    return criado;
  }

  async function conversa(telefone, { agenteId = null, texto = 'tenho 40 anos e dor no joelho há um mês', nome = null } = {}) {
    const contato = await repositorio.encontrarOuCriarContato({ telefone, nome: nome ?? `Contato ${telefone.slice(-4)}` });
    const aberta = agenteId
      ? await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp', { agenteId })
      : await repositorio.encontrarOuCriarConversaAberta(contato.id, 'whatsapp');
    await repositorio.registrarMensagem(aberta.id, { direcao: 'entrada', conteudo: texto, autor_tipo: 'contato' });
    return aberta;
  }

  // Silêncio zero: "o que ainda deve resumo", independente do relógio do resumo.
  const pendentes = async () => (await repositorio.listarConversasSemResumo({ silencioMin: 0, limite: 1000 }))
    .map((item) => item.id);
  const resumo = (opcoes = {}) => criarResumoDeAtendimento({
    repositorio, agora: relogio.agora, silencioMin: 30, intervaloMin: 120, ...opcoes,
  });

  return { repositorio, relogio, auditoria, pessoa, agente, conversa, pendentes, resumo };
}

// ----------------------------------------------------------- o que sai, e para quem

test('um resumo por pessoa com todos os atendimentos pendentes da clínica — cabeçalho por contato, contagem no rodapé', async () => {
  const c = await montarCenario();
  await c.pessoa('Admin', { papel: 'admin', whatsapp: '16992943215' });
  await c.pessoa('Atendente', { whatsapp: '16993624116' });
  for (const final of ['1001', '1002', '1003']) await c.conversa(`551690000${final}`);
  c.relogio.avancar(31);

  const canal = canalFalso();
  const resultado = await c.resumo({ canal }).enviarPendentes();

  assert.equal(resultado.enviados, 3);
  assert.equal(canal.envios.length, 2, 'uma mensagem por pessoa, não uma por atendimento');
  assert.deepEqual(canal.envios.map((envio) => envio.telefone).sort(), ['+5516992943215', '+5516993624116']);
  for (const envio of canal.envios) {
    assert.equal(envio.instancia, undefined, 'resumo da clínica sai pelo número da clínica');
    assert.match(envio.texto, /^RESUMO DA CLÍNICA/);
    assert.equal((envio.texto.match(/RESUMO DE LEAD — /g) ?? []).length, 3, 'cada contato com seu cabeçalho');
    assert.match(envio.texto, /3 atendimento\(s\) neste resumo/);
  }
  assert.deepEqual(await c.pendentes(), [], 'os três marcados');
});

test('clínica só para quem vê a clínica; agente só para a equipe dele e pelo número do agente', async () => {
  const c = await montarCenario();
  await c.pessoa('Admin Fora da Equipe', { papel: 'admin', whatsapp: '16990000001' });
  await c.pessoa('Gestor Clínica', { papel: 'gestor', whatsapp: '16990000002' });
  const loja = await c.pessoa('Colaborador Loja', { acessoClinica: false, whatsapp: '16990000003' });
  const gestorAlpins = await c.pessoa('Gestor Alpins', { papel: 'gestor', whatsapp: '16990000004' });
  const alpins = await c.agente('alpins', { equipe: [loja, gestorAlpins] });
  await c.conversa('5516900002001', { nome: 'Paciente Clínica' });
  await c.conversa('5516900002002', { agenteId: alpins.id, nome: 'Cliente Alpins' });
  c.relogio.avancar(31);

  const canal = canalFalso();
  await c.resumo({ canal }).enviarPendentes();
  const para = (telefone) => canal.envios.filter((envio) => envio.telefone === telefone);

  const doAdmin = para('+5516990000001');
  assert.equal(doAdmin.length, 1, 'admin fora da equipe do agente recebe só a clínica');
  assert.match(doAdmin[0].texto, /Paciente Clínica/);
  assert.ok(!doAdmin[0].texto.includes('Cliente Alpins'));
  assert.equal(para('+5516990000002').length, 1, 'quem vê a clínica recebe a clínica');

  const daLoja = para('+5516990000003');
  assert.equal(daLoja.length, 1, 'colaborador da loja recebe só o do agente');
  assert.equal(daLoja[0].instancia, 'alpins', 'pelo número do agente');
  assert.match(daLoja[0].texto, /^RESUMO — Agente alpins/);
  assert.match(daLoja[0].texto, /ATENDIMENTO — Cliente Alpins/);
  assert.ok(!daLoja[0].texto.includes('Paciente Clínica'), 'paciente nunca chega à loja');
  assert.ok(!daLoja[0].texto.includes('Agendou'), 'agenda e lead são da clínica');

  const doGestorAlpins = para('+5516990000004');
  assert.equal(doGestorAlpins.length, 2, 'vê a clínica e está na equipe: os dois, cada um pelo seu número');
  assert.deepEqual(doGestorAlpins.map((envio) => envio.instancia ?? 'clinica').sort(), ['alpins', 'clinica']);
});

test('agente sem WhatsApp ativo: nada sai e nada é marcado — nunca pelo número da clínica', async () => {
  const c = await montarCenario();
  const membro = await c.pessoa('Loja', { acessoClinica: false, whatsapp: '16990000011' });
  const alpins = await c.agente('alpins', { ativo: false, equipe: [membro] });
  const conversa = await c.conversa('5516900003001', { agenteId: alpins.id });
  c.relogio.avancar(31);

  const canal = canalFalso();
  const resultado = await c.resumo({ canal }).enviarPendentes();

  assert.equal(canal.envios.length, 0);
  assert.equal(resultado.grupos[0].situacao, 'agente_sem_canal');
  assert.deepEqual(await c.pendentes(), [conversa.id]);
});

test('pausado, sem WhatsApp, sem autorização ou conta não liberada não recebem; ninguém apto = nada marcado', async () => {
  const c = await montarCenario();
  await c.pessoa('Pausado', { papel: 'admin', whatsapp: '16990000021', recebe: false });
  await c.pessoa('Sem Autorização', { whatsapp: '16990000022', autorizado: false });
  await c.pessoa('Sem Número');
  await c.pessoa('Pendente', { whatsapp: '16990000023', situacao: 'pendente' });
  const conversa = await c.conversa('5516900004001');
  c.relogio.avancar(31);

  const canal = canalFalso();
  const primeiro = await c.resumo({ canal }).enviarPendentes();
  assert.equal(canal.envios.length, 0);
  assert.equal(primeiro.grupos[0].situacao, 'sem_destinatarios');
  assert.deepEqual(await c.pendentes(), [conversa.id], 'sem ninguém para receber, nada é marcado');

  await c.pessoa('Apta', { whatsapp: '16990000024' });
  await c.resumo({ canal }).enviarPendentes();
  assert.deepEqual(canal.envios.map((envio) => envio.telefone), ['+5516990000024']);
  assert.deepEqual(await c.pendentes(), []);
});

// ----------------------------------------------------------------- ritmo e trava

test('intervalo de 2 h com relógio injetado: o próximo resumo do grupo espera, contado do último envio', async () => {
  const c = await montarCenario();
  await c.pessoa('Admin', { papel: 'admin', whatsapp: '16990000031' });
  await c.conversa('5516900005001');
  c.relogio.avancar(31);
  const canal = canalFalso();
  const resumo = c.resumo({ canal });
  await resumo.enviarPendentes();
  assert.equal(canal.envios.length, 1);

  await c.conversa('5516900005002');
  c.relogio.avancar(60);
  const cedo = await resumo.enviarPendentes();
  assert.equal(canal.envios.length, 1, '1 h depois: nada');
  assert.equal(cedo.grupos[0].situacao, 'aguardando_intervalo');
  assert.equal(cedo.grupos[0].proximo_em, new Date(INICIO + (31 + 120) * 60_000).toISOString());

  c.relogio.avancar(59);
  await resumo.enviarPendentes();
  assert.equal(canal.envios.length, 1, 'um minuto antes das 2 h: nada');

  c.relogio.avancar(1);
  await resumo.enviarPendentes();
  assert.equal(canal.envios.length, 2, 'completou 2 h: sai o segundo, com o atendimento novo');
  assert.match(canal.envios[1].texto, /Contato 5002/);
  assert.ok(!canal.envios[1].texto.includes('Contato 5001'), 'o que já foi não se repete');
});

test('reiniciar o worker não antecipa: a cópia nova lê o último envio do banco', async () => {
  const c = await montarCenario();
  await c.pessoa('Admin', { papel: 'admin', whatsapp: '16990000041' });
  await c.conversa('5516900006001');
  c.relogio.avancar(31);
  const canal = canalFalso();
  await c.resumo({ canal }).enviarPendentes();

  await c.conversa('5516900006002');
  c.relogio.avancar(45);
  // Processo novo: nada guardado em memória do processo.
  await c.resumo({ canal }).enviarPendentes();
  assert.equal(canal.envios.length, 1, 'o incidente das 04:55 era isto: reinício = resumo fora de hora');
});

test('duas cópias ao mesmo tempo: a trava deixa só uma resumir', async () => {
  const c = await montarCenario();
  await c.pessoa('Admin', { papel: 'admin', whatsapp: '16990000051' });
  await c.conversa('5516900007001');
  c.relogio.avancar(31);

  let soltar;
  const canal = canalFalso({ segurar: new Promise((resolver) => { soltar = resolver; }) });
  const primeira = c.resumo({ canal }).enviarPendentes();
  const segunda = await c.resumo({ canal }).enviarPendentes();
  assert.match(segunda.motivo, /outra cópia/);

  soltar();
  assert.equal((await primeira).enviados, 1);
  assert.equal(canal.envios.length, 1);
});

// ------------------------------------------------------------ tamanho e falhas

test('resumo grande sai em partes de até 3.500 caracteres, numeradas; cada atendimento numa parte só', async () => {
  const c = await montarCenario();
  await c.pessoa('Admin', { papel: 'admin', whatsapp: '16990000061' });
  for (let i = 0; i < 12; i += 1) {
    const sufixo = String(i).padStart(2, '0');
    await c.conversa(`55169000080${sufixo}`, { nome: `Pessoa ${sufixo}` });
  }
  c.relogio.avancar(31);
  const gerador = { async gerar({ chaveIdempotencia }) { return `Procura: ${'detalhe da conversa '.repeat(60)}${chaveIdempotencia}`; } };
  const canal = canalFalso();
  await c.resumo({ canal, gerador }).enviarPendentes();

  const total = canal.envios.length;
  assert.ok(total >= 3, `esperava várias partes, vieram ${total}`);
  canal.envios.forEach((envio, indice) => {
    assert.ok(envio.texto.length <= LIMITE_POR_MENSAGEM, `parte ${indice + 1} com ${envio.texto.length} caracteres`);
    assert.ok(envio.texto.startsWith(`RESUMO DA CLÍNICA (${indice + 1}/${total})`), envio.texto.slice(0, 40));
    assert.equal(envio.texto.includes('atendimento(s) neste resumo'), indice === total - 1, 'rodapé só na última');
  });
  const tudo = canal.envios.map((envio) => envio.texto).join('\n');
  for (let i = 0; i < 12; i += 1) {
    const nome = `RESUMO DE LEAD — Pessoa ${String(i).padStart(2, '0')}`;
    assert.equal(tudo.split(nome).length - 1, 1, `${nome} exatamente uma vez`);
  }
});

test('divisão: uma parte só não leva numeração e leva o rodapé', () => {
  const [parte, ...resto] = dividirEmMensagens({
    titulo: 'RESUMO DA CLÍNICA', blocos: [{ conversaId: 1, texto: 'bloco curto' }], rodape: '1 atendimento(s) neste resumo',
  });
  assert.deepEqual(resto, []);
  assert.ok(parte.texto.startsWith('RESUMO DA CLÍNICA\n'));
  assert.ok(parte.texto.endsWith('1 atendimento(s) neste resumo'));
  assert.deepEqual(parte.conversas, [1]);
});

test('parte que não chegou a ninguém não marca os atendimentos dela; a que chegou marca — auditoria sem telefone', async () => {
  const c = await montarCenario();
  await c.pessoa('Admin', { papel: 'admin', whatsapp: '16990000071' });
  await c.pessoa('Gestora', { papel: 'gestor', whatsapp: '16990000072' });
  for (let i = 0; i < 6; i += 1) await c.conversa(`55169000090${String(i).padStart(2, '0')}`, { nome: `Pessoa ${i}` });
  c.relogio.avancar(31);
  const gerador = { async gerar() { return `Procura: ${'x'.repeat(1200)}`; } };
  const canal = canalFalso({ falhar: (carga) => carga.texto.startsWith('RESUMO DA CLÍNICA (2/') });

  const resultado = await c.resumo({ canal, gerador }).enviarPendentes();

  assert.ok(resultado.grupos[0].mensagens >= 3, 'o cenário precisa de pelo menos três partes');
  const pendentes = await c.pendentes();
  assert.equal(pendentes.length, 2, 'os atendimentos da parte 2 continuam na fila');
  assert.equal(resultado.enviados, 4);
  assert.equal(resultado.nao_entregues, 2);

  const falhas = c.auditoria.filter((registro) => registro.acao === 'resumo_nao_entregue');
  assert.deepEqual(falhas.map((registro) => registro.entidadeId).sort(), [...pendentes].sort());
  for (const registro of falhas) {
    assert.equal(registro.entidade, 'conversa');
    assert.equal(registro.detalhe.grupo, 'clinica');
    assert.equal(registro.detalhe.confirmados, 0);
    assert.equal(registro.detalhe.falhados, 2);
    assert.ok(!/990000071|990000072/.test(JSON.stringify(registro.detalhe)), 'telefone de pessoa não entra na auditoria');
  }
});

test('quando NINGUÉM recebe, nada é marcado e o ciclo seguinte tenta de novo — sem esperar as 2 h', async () => {
  const c = await montarCenario();
  await c.pessoa('Admin', { papel: 'admin', whatsapp: '16990000081' });
  const conversa = await c.conversa('5516900010001');
  c.relogio.avancar(31);

  const primeiro = await c.resumo({ canal: canalFalso({ falhar: () => true }) }).enviarPendentes();
  assert.equal(primeiro.nao_entregues, 1);
  assert.deepEqual(await c.pendentes(), [conversa.id]);
  assert.equal(c.auditoria.at(-1).acao, 'resumo_nao_entregue');

  c.relogio.avancar(1);
  const deVolta = canalFalso();
  await c.resumo({ canal: deVolta }).enviarPendentes();
  assert.equal(deVolta.envios.length, 1);
  assert.deepEqual(await c.pendentes(), []);
});

test('entrega parcial marca o atendimento e registra quem ficou de fora', async () => {
  // Reenviar para todos mandaria o resumo duas vezes a quem já leu.
  const c = await montarCenario();
  await c.pessoa('Admin', { papel: 'admin', whatsapp: '16990000091' });
  await c.pessoa('Gestora', { papel: 'gestor', whatsapp: '16990000092' });
  await c.conversa('5516900011001');
  c.relogio.avancar(31);

  const canal = canalFalso({ falhar: (carga) => carga.telefone === '+5516990000092' });
  const resultado = await c.resumo({ canal }).enviarPendentes();

  assert.equal(resultado.enviados, 1);
  assert.deepEqual(await c.pendentes(), []);
  const [registro] = c.auditoria.filter((item) => item.acao === 'resumo_parcialmente_entregue');
  assert.equal(registro.detalhe.confirmados, 1);
  assert.equal(registro.detalhe.destinatarios, 2);
});

// ---------------------------------------------------------- repetição (11/09)

test('entrada nova gera resumo novo (chave pela última entrada); resposta da equipe não gera resumo nenhum', async () => {
  const c = await montarCenario();
  await c.pessoa('Admin', { papel: 'admin', whatsapp: '16990000101' });
  const conversa = await c.conversa('5516900012001', { texto: 'quero marcar consulta' });
  c.relogio.avancar(31);
  const chaves = [];
  const gerador = {
    async gerar({ chaveIdempotencia }) {
      chaves.push(chaveIdempotencia);
      return `Procura: resumo gerado para ${chaveIdempotencia}`;
    },
  };
  const canal = canalFalso();
  const resumo = c.resumo({ canal, gerador });
  await resumo.enviarPendentes();

  await c.repositorio.registrarMensagem(conversa.id, { direcao: 'saida', conteudo: 'claro, qual horário?', autor_tipo: 'equipe' });
  c.relogio.avancar(200);
  await resumo.enviarPendentes();
  assert.equal(canal.envios.length, 1, 'a saída da equipe não reenfileira — era o que repetia o resumo');

  const { mensagem } = await c.repositorio.registrarMensagem(conversa.id, {
    direcao: 'entrada', conteudo: 'pode ser amanhã?', autor_tipo: 'contato',
  });
  c.relogio.avancar(31);
  await resumo.enviarPendentes();

  assert.equal(canal.envios.length, 2);
  assert.equal(chaves[1], `resumo:conversa:${conversa.id}:entrada:${mensagem.id}`);
  assert.notEqual(chaves[0], chaves[1]);
  assert.ok(!canal.envios[1].texto.includes(chaves[0]), 'o segundo resumo não é o texto do primeiro');
});

test('conversa de agente pede à IA o prompt do agente; a da clínica, o de sempre', async () => {
  const c = await montarCenario();
  const membro = await c.pessoa('Gestor Alpins', { papel: 'gestor', whatsapp: '16990000111' });
  const alpins = await c.agente('alpins', { equipe: [membro] });
  await c.conversa('5516900013001');
  await c.conversa('5516900013002', { agenteId: alpins.id });
  c.relogio.avancar(31);
  const contextos = [];
  const gerador = { async gerar(pedido) { contextos.push(pedido.contexto ?? 'clinica'); return null; } };

  await c.resumo({ canal: canalFalso(), gerador }).enviarPendentes();

  assert.deepEqual(contextos.sort(), ['agente', 'clinica']);
});

// ------------------------------------------------------ registro de envios (M2)

test('restart entre a parte 1 e a parte 2: o ciclo seguinte não reenvia a parte que saiu nem a incerta (auditoria M2)', async () => {
  const c = await montarCenario();
  await c.pessoa('Admin', { papel: 'admin', whatsapp: '16990000141' });
  for (let i = 0; i < 6; i += 1) await c.conversa(`55169000150${String(i).padStart(2, '0')}`, { nome: `Pessoa ${i}` });
  c.relogio.avancar(31);
  const gerador = { async gerar() { return `Procura: ${'x'.repeat(1200)}`; } };
  const ehParte = (carga, numero) => carga.texto.startsWith(`RESUMO DA CLÍNICA (${numero}/`);

  // Primeiro processo: a entrega da parte 2 nunca volta — o processo morre ali.
  const primeiros = [];
  c.resumo({
    gerador,
    canal: {
      async enviar(carga) {
        primeiros.push(carga);
        if (ehParte(carga, 2)) return new Promise(() => {});
        return { identificador: 'p' };
      },
    },
  }).enviarPendentes();
  for (let espera = 0; !primeiros.some((carga) => ehParte(carga, 2)) && espera < 2000; espera += 1) {
    await new Promise((seguir) => { setImmediate(seguir); });
  }
  assert.ok(primeiros.some((carga) => ehParte(carga, 1)) && primeiros.some((carga) => ehParte(carga, 2)), 'o primeiro processo chegou à parte 2');

  // Processo novo. A trava do processo morto cai (no PostgreSQL, com a conexão).
  const reiniciado = { ...c.repositorio, executarComTravaDeResumo: async (executar) => ({ obtida: true, resultado: await executar() }) };
  const segundos = [];
  await criarResumoDeAtendimento({
    repositorio: reiniciado, agora: c.relogio.agora, silencioMin: 30, intervaloMin: 120, gerador,
    canal: { async enviar(carga) { segundos.push(carga); return { identificador: 's' }; } },
  }).enviarPendentes();

  assert.equal(segundos.filter((carga) => ehParte(carga, 1)).length, 0, 'a parte 1 não sai de novo');
  assert.equal(segundos.filter((carga) => ehParte(carga, 2)).length, 0, 'a parte 2, incerta, não sai de novo');
  assert.equal(segundos.filter((carga) => ehParte(carga, 3)).length, 1, 'a parte 3, que não tinha saído, sai');
  assert.deepEqual(await c.pendentes(), [], 'as conversas das três partes ficam marcadas');
});

test('envio indeterminado (timeout da Evolution) conta como entregue e não é repetido (auditoria M2)', async () => {
  const c = await montarCenario();
  await c.pessoa('Admin', { papel: 'admin', whatsapp: '16990000151' });
  await c.conversa('5516900016001');
  c.relogio.avancar(31);
  let tentativas = 0;
  const canal = {
    async enviar() {
      tentativas += 1;
      const erro = new Error('falha de rede ao chamar a Evolution API: The operation was aborted due to timeout');
      erro.indeterminado = true;
      throw erro;
    },
  };

  const resultado = await c.resumo({ canal }).enviarPendentes();
  assert.equal(resultado.enviados, 1, 'talvez tenha chegado: não volta para a fila');
  assert.equal(resultado.grupos[0].incertos, 1);
  c.relogio.avancar(1);
  await c.resumo({ canal }).enviarPendentes();
  assert.equal(tentativas, 1, 'não repete o que talvez tenha chegado');
  assert.deepEqual(await c.pendentes(), []);
});

test('SIGTERM espera o resumo em andamento, com teto abaixo do TimeoutStopSec do systemd (auditoria M2)', () => {
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'bin', 'worker-lembretes.js'), 'utf8');
  assert.match(fonte, /resumoEmAndamento = \(async \(\) => \{/, 'o ciclo de resumo fica registrado enquanto roda');
  const encerrar = fonte.slice(fonte.indexOf('const encerrar = async (sinal) => {'), fonte.indexOf("process.on('SIGINT'"));
  assert.match(encerrar, /const ESPERA_MAXIMA_DO_RESUMO_MS = 60_000;/);
  assert.match(encerrar, /if \(resumoEmAndamento\) \{/);
  assert.ok(encerrar.indexOf('resumoEmAndamento') < encerrar.indexOf('await encerrarPool()'), 'espera o resumo antes de fechar o pool');
});

// ------------------------------------------------------------- janela (A1)

test('primeira execução: histórico nunca resumido NÃO sai — só o que teve entrada do contato dentro da janela', async () => {
  // Auditoria de 7f8275b (A1): o código antigo nunca resumia conversa de agente
  // e a fila não tinha corte de data — a primeira autorização de WhatsApp
  // mandava o histórico inteiro, 40 conversas a cada 2 h.
  const c = await montarCenario();
  await c.pessoa('Admin', { papel: 'admin', whatsapp: '16990000121' });
  const loja = await c.pessoa('Loja', { acessoClinica: false, whatsapp: '16990000122' });
  const alpins = await c.agente('alpins', { equipe: [loja] });
  for (let i = 0; i < 30; i += 1) await c.conversa(`55169100${String(i).padStart(5, '0')}`, { nome: `Antiga Clínica ${i}` });
  for (let i = 0; i < 90; i += 1) {
    await c.conversa(`55169200${String(i).padStart(5, '0')}`, { agenteId: alpins.id, nome: `Antiga Loja ${i}` });
  }
  c.relogio.avancar(3 * 24 * 60);
  await c.conversa('5516930000001', { nome: 'Recente Clínica' });
  await c.conversa('5516930000002', { agenteId: alpins.id, nome: 'Recente Loja' });
  c.relogio.avancar(31);

  const canal = canalFalso();
  const resultado = await c.resumo({ canal }).enviarPendentes();

  const tudo = canal.envios.map((envio) => envio.texto).join('\n');
  assert.ok(!tudo.includes('Antiga'), 'nenhuma conversa antiga sai');
  assert.match(tudo, /Recente Clínica/);
  assert.match(tudo, /Recente Loja/);
  assert.equal(canal.envios.length, 2, 'uma mensagem por pessoa, cada uma com o atendimento novo do seu grupo');
  assert.equal(resultado.enviados, 2);
});

test('worker parado 3 dias: entram só as entradas das últimas 24 h, não a fila acumulada', async () => {
  const c = await montarCenario();
  await c.pessoa('Admin', { papel: 'admin', whatsapp: '16990000131' });
  await c.conversa('5516940000001', { nome: 'Antes da Parada' });
  c.relogio.avancar(31);
  const canal = canalFalso();
  await c.resumo({ canal }).enviarPendentes();
  assert.equal(canal.envios.length, 1);

  // Worker parado; as conversas chegam ao longo de 3 dias.
  c.relogio.avancar(12 * 60);
  await c.conversa('5516940000002', { nome: 'Velha Doze Horas' });
  c.relogio.avancar(28 * 60);
  await c.conversa('5516940000003', { nome: 'Velha Quarenta Horas' });
  c.relogio.avancar(20 * 60);
  await c.conversa('5516940000004', { nome: 'Nova Sessenta Horas' });
  c.relogio.avancar(10 * 60);
  await c.conversa('5516940000005', { nome: 'Nova Setenta Horas' });
  c.relogio.avancar(2 * 60);

  await c.resumo({ canal }).enviarPendentes();

  assert.equal(canal.envios.length, 2);
  const texto = canal.envios[1].texto;
  assert.match(texto, /Nova Sessenta Horas/);
  assert.match(texto, /Nova Setenta Horas/);
  assert.ok(!/Velha/.test(texto), 'o que passou de 24 h não vira enxurrada');
});

// ------------------------------------------------------------- ligação no worker

test('sem canal de entrega o resumo fica inativo e nem consulta o banco', async () => {
  let consultou = false;
  const resumo = criarResumoDeAtendimento({
    repositorio: { async listarConversasSemResumo() { consultou = true; return []; } },
    canal: null,
  });
  assert.equal(resumo.ativo, false);
  assert.equal((await resumo.enviarPendentes()).enviados, 0);
  assert.equal(consultou, false);
});

test('o worker passa o intervalo e não usa mais a lista do ambiente para decidir quem recebe', () => {
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'bin', 'worker-lembretes.js'), 'utf8');
  const inicio = fonte.indexOf('criarResumoDeAtendimento({');
  const chamada = fonte.slice(inicio, fonte.indexOf('});', inicio)).replace(/\/\/.*$/gm, '');
  assert.match(chamada, /intervaloMin: configuracao\.resumoDeAtendimento\.intervaloMin/);
  assert.ok(!/destinatarios/.test(chamada), 'destinatários vêm do cadastro, não do ambiente');

  assert.equal(carregarConfiguracao({}).resumoDeAtendimento.intervaloMin, 120);
  assert.equal(carregarConfiguracao({ CRMCLINICA_RESUMO_INTERVALO_MIN: '90' }).resumoDeAtendimento.intervaloMin, 90);
});

test('o worker de lembretes nunca monta o canal sem as vias de entrega', () => {
  // Regressão real: `criarCanalDeConversas(configuracao.openclaw.canalClinica)`
  // sem o segundo argumento deixa o worker preso ao gateway WebSocket da
  // clínica — o mesmo que esteve parado no VPS enquanto a Evolution entregava
  // mensagem a paciente o dia inteiro. `http.js` e `worker-outbox.js` sempre
  // injetaram as vias; só este worker não.
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'bin', 'worker-lembretes.js'), 'utf8');
  const chamadas = fonte.match(/criarCanalDeConversas\([^)]*\)/g) ?? [];

  assert.ok(chamadas.length > 0, 'o worker precisa montar o canal em algum lugar');
  for (const chamada of chamadas) {
    assert.match(chamada, /,\s*viasDeEntrega\s*\)$/, `montagem sem vias de entrega: ${chamada}`);
  }
});
