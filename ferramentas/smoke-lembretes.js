'use strict';

// Smoke test dos lembretes **contra o PostgreSQL real**.
//
//   npm run smoke-lembretes
//
// A suíte de testes roda contra o repositório em memória e prova a lógica. O que
// ela não prova é o que só o banco garante: a constraint de unicidade, o
// `FOR UPDATE SKIP LOCKED` entre duas conexões de verdade, o RLS avaliado para
// `crmclinica_app`. É isso que este arquivo exercita.
//
// Sobre os dados: o smoke cria um profissional, um contato e um agendamento
// marcados com o prefixo `[SMOKE]` e **apaga tudo ao final**, inclusive se algum
// passo falhar. O que fica é o rastro em `audit_log` — de propósito: a aplicação
// não tem privilégio de apagar auditoria, e não deveria ter.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const CAMINHO_ENV = path.join(__dirname, '..', '.env');
if (fs.existsSync(CAMINHO_ENV) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(CAMINHO_ENV);
}

const { carregarConfiguracao } = require('../src/config');
const { criarServicoDeLembretes } = require('../src/dominio/lembretes-servico');
const { criarServicoDeAgenda } = require('../src/dominio/agenda-servico');
const { criarAdaptadorDeLembretes } = require('../src/integracoes/openclaw-lembretes');
const { conferirConexao } = require('../src/dados/conferir-conexao');

const MARCA = '[SMOKE]';
const TELEFONE = '5516900000099'; // número sintético, não é de ninguém

const passos = [];
function verificar(descricao, condicao, detalhe = '') {
  const ok = Boolean(condicao);
  passos.push({ descricao, ok });
  console.log(`  ${ok ? '\x1b[32mOK   \x1b[0m' : '\x1b[31mFALHA\x1b[0m'} ${descricao}${detalhe ? ` — ${detalhe}` : ''}`);
}

const HORA = 60 * 60 * 1000;

async function main() {
  const configuracao = carregarConfiguracao();
  if (!configuracao.banco.configurado) {
    console.error('CRMCLINICA_DATABASE_URL não está definida: este smoke exige o banco real.');
    process.exit(1);
  }

  const { criarPool, encerrarPool } = require('../src/dados/pool');
  const { criarRepositorio } = require('../src/dados/repositorio');

  const pool = criarPool(configuracao.banco);
  const repositorio = criarRepositorio(pool);

  // Entrega própria do smoke: conta o que passaria pelo OpenClaw sem nenhuma
  // chamada de rede. O adaptador de verdade é exercitado logo abaixo, à parte.
  const entregues = [];
  const entrega = {
    modo: 'dry_run',
    descrever: () => ({ orquestrador: 'OpenClaw', modo: 'dry_run', significado: 'smoke' }),
    async enviar(envelope) {
      await new Promise((resolve) => setImmediate(resolve));
      entregues.push(envelope);
      return { entregue: false, modo: 'dry_run', referencia: `dry-run:${envelope.referencia}` };
    },
  };

  const criados = { lembretes: [], agendamentos: [], profissionais: [], contatos: [] };

  try {
    // ---------------------------------------------------------------- 1. conexão
    const conexao = await conferirConexao(pool);
    console.log(`\nConexão: ${conexao.usuario}\n`);
    verificar('conecta como crmclinica_app', conexao.usuario === 'crmclinica_app', conexao.usuario);
    verificar('o RLS é avaliado para esta conexão', conexao.seguro === true);

    // ---------------------------------------------------------------- 2. schema
    const { rows: [tabela] } = await pool.query(
      "SELECT to_regclass('public.lembretes') IS NOT NULL AS existe",
    );
    verificar('a tabela lembretes existe', tabela.existe === true);

    const { rows: [constraint] } = await pool.query(`
      SELECT count(*)::int AS n FROM pg_constraint
       WHERE conname = 'lembretes_unicos' AND conrelid = 'public.lembretes'::regclass
    `);
    verificar('a constraint lembretes_unicos está aplicada', constraint.n === 1);

    const { rows: [optout] } = await pool.query(`
      SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_name = 'contatos' AND column_name = 'lembretes_optout'
    `);
    verificar('o opt-out existe no contato', optout.n === 1);

    // ---------------------------------------------------------------- 3. cenário
    const agora = () => new Date();
    const lembretes = criarServicoDeLembretes({
      repositorio, entrega, clinica: configuracao.lembretes.clinica, agora,
    });
    const agenda = criarServicoDeAgenda({ repositorio, agora, lembretes });

    const profissional = await repositorio.criarProfissional({
      nome: `${MARCA} Profissional`, duracaoMin: 30,
    });
    criados.profissionais.push(profissional.id);

    const contato = await repositorio.encontrarOuCriarContato({
      telefone: TELEFONE, nome: `${MARCA} Paciente`,
    });
    criados.contatos.push(contato.id);

    // Consulta daqui a 25 horas: o lembrete de 24h vence em uma hora, o de 2h
    // só depois. Vamos forçar o vencimento no banco para não esperar.
    const inicio = new Date(Date.now() + 25 * HORA);
    const agendamento = await agenda.gravar({
      profissionalId: profissional.id,
      contatoId: contato.id,
      inicio: inicio.toISOString(),
      fim: new Date(inicio.getTime() + 30 * 60_000).toISOString(),
    });
    criados.agendamentos.push(agendamento.id);

    const naFila = await repositorio.listarLembretes({ agendamentoId: agendamento.id });
    criados.lembretes.push(...naFila.map((item) => item.id));
    verificar('marcar a consulta enfileirou os dois lembretes', naFila.length === 2,
      naFila.map((item) => `${item.tipo}:${item.estado}`).join(', '));

    // ---------------------------------------------------------------- 4. idempotência
    const repetido = await lembretes.enfileirarPara(agendamento);
    verificar('enfileirar de novo não cria linha nova',
      repetido.criados.length === 0 && repetido.repetidos.length === 2);

    // A constraint respondendo diretamente, sem passar pelo serviço.
    const forcado = await repositorio.enfileirarLembrete({
      agendamentoId: agendamento.id,
      contatoId: contato.id,
      tipo: 'confirmacao_24h',
      janela: inicio.toISOString(),
      agendarPara: new Date(inicio.getTime() - 24 * HORA).toISOString(),
    });
    verificar('a constraint recusa o duplicado no banco', forcado.criado === false);

    // ---------------------------------------------------------------- 5. concorrência
    //
    // Vence a fila inteira e solta dois "workers" ao mesmo tempo, cada um com
    // sua conexão do pool. É o teste que o `SKIP LOCKED` existe para passar.
    await pool.query(
      "UPDATE lembretes SET agendar_para = now() - interval '5 minutes', tentar_em = now() - interval '5 minutes' WHERE agendamento_id = $1",
      [agendamento.id],
    );

    const workerA = criarServicoDeLembretes({ repositorio, entrega, agora });
    const workerB = criarServicoDeLembretes({ repositorio, entrega, agora });

    const [loteA, loteB] = await Promise.all([
      workerA.processarLote({ limite: 10, worker: `${os.hostname()}:a` }),
      workerB.processarLote({ limite: 10, worker: `${os.hostname()}:b` }),
    ]);

    const referencias = entregues.map((envelope) => envelope.referencia);
    const unicas = new Set(referencias);
    verificar('dois workers simultâneos não repetem nenhum lembrete',
      referencias.length === unicas.size, `${referencias.length} entrega(s)`);
    verificar('os dois lembretes saíram, uma vez cada',
      loteA.enviados + loteB.enviados === 2, `A:${loteA.enviados} B:${loteB.enviados}`);

    const depois = await repositorio.listarLembretes({ agendamentoId: agendamento.id });
    verificar('nenhuma linha ficou presa em processando',
      depois.every((item) => item.estado !== 'processando'));
    verificar('a fila registra a entrega como dry-run',
      depois.filter((item) => item.estado === 'enviado').every((item) => item.modo_entrega === 'dry_run'));

    // ---------------------------------------------------------------- 6. cancelamento
    const outroInicio = new Date(Date.now() + 30 * HORA);
    const outro = await agenda.gravar({
      profissionalId: profissional.id,
      contatoId: contato.id,
      inicio: outroInicio.toISOString(),
      fim: new Date(outroInicio.getTime() + 30 * 60_000).toISOString(),
    });
    criados.agendamentos.push(outro.id);
    criados.lembretes.push(...(await repositorio.listarLembretes({ agendamentoId: outro.id })).map((i) => i.id));

    await agenda.cancelar(outro.id, { motivo: `${MARCA} cancelamento` });
    const aposCancelar = await repositorio.listarLembretes({ agendamentoId: outro.id });
    verificar('cancelar o agendamento tira os lembretes da fila',
      aposCancelar.length > 0 && aposCancelar.every((item) => item.estado === 'ignorado'));

    // Vence a fila do cancelado e confirma que nada sai.
    await pool.query(
      "UPDATE lembretes SET agendar_para = now() - interval '5 minutes', tentar_em = now() - interval '5 minutes' WHERE agendamento_id = $1",
      [outro.id],
    );
    const entreguesAntes = entregues.length;
    await workerA.processarLote({ limite: 10, worker: 'smoke' });
    verificar('cancelado não vira mensagem', entregues.length === entreguesAntes);

    // ---------------------------------------------------------------- 7. opt-out
    const terceiroInicio = new Date(Date.now() + 40 * HORA);
    const terceiro = await agenda.gravar({
      profissionalId: profissional.id,
      contatoId: contato.id,
      inicio: terceiroInicio.toISOString(),
      fim: new Date(terceiroInicio.getTime() + 30 * 60_000).toISOString(),
    });
    criados.agendamentos.push(terceiro.id);
    criados.lembretes.push(...(await repositorio.listarLembretes({ agendamentoId: terceiro.id })).map((i) => i.id));

    const { cancelados } = await lembretes.definirOptOut(contato.id, {
      optout: true, motivo: `${MARCA} pediu para parar`,
    });
    verificar('opt-out tira da fila o que ainda não saiu', cancelados.length > 0, `${cancelados.length} lembrete(s)`);

    const contatoDesligado = await repositorio.obterContato(contato.id);
    verificar('o opt-out fica gravado no contato', contatoDesligado.lembretes_optout === true);

    await repositorio.definirOptOutDeLembretes(contato.id, { optout: false });
    verificar('opt-in devolve o contato à régua',
      (await repositorio.obterContato(contato.id)).lembretes_optout === false);

    // ---------------------------------------------------------------- 8. auditoria
    const { rows: auditoria } = await pool.query(`
      SELECT acao, count(*)::int AS total FROM audit_log
       WHERE entidade IN ('lembrete', 'contato')
         AND criado_em > now() - interval '10 minutes'
       GROUP BY acao ORDER BY acao
    `);
    const acoes = new Map(auditoria.map((linha) => [linha.acao, linha.total]));
    verificar('a criação dos lembretes foi auditada', (acoes.get('lembrete_criado') ?? 0) >= 2);
    verificar('a simulação foi auditada como simulada, não como envio',
      (acoes.get('lembrete_simulado') ?? 0) >= 2 && !acoes.has('lembrete_enviado'));
    verificar('o cancelamento foi auditado', (acoes.get('lembrete_cancelado') ?? 0) >= 1);
    verificar('o opt-out foi auditado', (acoes.get('lembretes_optout') ?? 0) >= 1);

    // ---------------------------------------------------------------- 9. adaptador
    const adaptador = criarAdaptadorDeLembretes(
      { ...configuracao.openclaw, modoEntrega: configuracao.lembretes.modoEntrega },
      { registrar: () => {} },
    );
    const descricao = adaptador.descrever();
    console.log(`\nEntrega: modo ${descricao.modo}, método ${descricao.metodo}`);

    verificar('o modo de entrega é declarado sem ambiguidade',
      ['real', 'dry_run'].includes(descricao.modo), descricao.modo);
    verificar('o método é o oficial do gateway', descricao.metodo === 'gateway.send');
    verificar('nenhum segredo aparece na descrição',
      !JSON.stringify(descricao).includes(configuracao.openclaw.gateway.token || 'sem-token'));

    // Em modo real o canal é consultado de verdade — mas **nada é enviado**:
    // `channels.status` é leitura. Um smoke que mandasse WhatsApp mandaria uma
    // mensagem a alguém toda vez que alguém roda os testes.
    if (descricao.modo === 'real') {
      const canal = await adaptador.verificarCanal();
      verificar('o canal do OpenClaw está conectado', canal.conectado === true,
        canal.numero ? `${canal.canal} em ${canal.numero}` : (canal.motivo ?? ''));
      verificar('o dispositivo do crmclinica está pareado', Boolean(descricao.dispositivo));
    } else {
      verificar('em dry-run, o motivo está dito', Boolean(descricao.motivo), descricao.motivo);
    }
    await adaptador.encerrar?.();

    // ---------------------------------------------------------------- 10. resumo
    const resumo = await lembretes.resumo();
    verificar('o resumo avisa que dry-run não envia nada', /dry-run/.test(resumo.observacao ?? ''));
    verificar('o resumo conta a fila', Number.isInteger(resumo.fila.por_estado.enviado));
  } finally {
    // ---------------------------------------------------------------- limpeza
    //
    // Roda mesmo se algo acima falhar: o banco é o de verdade, e deixar lixo
    // marcado como `[SMOKE]` é dívida que alguém encontra num relatório.
    console.log('\nLimpando o que o smoke criou…');
    try {
      for (const id of criados.agendamentos) {
        await pool.query('DELETE FROM lembretes WHERE agendamento_id = $1', [id]);
      }
      for (const id of criados.agendamentos) {
        await pool.query('DELETE FROM agendamentos WHERE id = $1', [id]);
      }
      for (const id of criados.contatos) {
        await pool.query('DELETE FROM contatos WHERE id = $1 AND telefone = $2', [id, TELEFONE]);
      }
      for (const id of criados.profissionais) {
        await pool.query('DELETE FROM profissionais WHERE id = $1 AND nome LIKE $2', [id, `${MARCA}%`]);
      }
      console.log('  removido: '
        + `${criados.agendamentos.length} agendamento(s), `
        + `${criados.contatos.length} contato(s), `
        + `${criados.profissionais.length} profissional(is)`);
      console.log('  mantido: o rastro em audit_log — a aplicação não apaga auditoria, e não deve.');
    } catch (erro) {
      console.error(`  ATENÇÃO: falha ao limpar (${erro.message}). `
        + `Procure por linhas com "${MARCA}" e pelo telefone ${TELEFONE}.`);
    }
    await encerrarPool();
  }

  const falhas = passos.filter((passo) => !passo.ok);
  console.log(`\n${passos.length - falhas.length}/${passos.length} verificações passaram`);
  process.exit(falhas.length === 0 ? 0 : 1);
}

main().catch((erro) => {
  console.error('erro no smoke de lembretes:', erro.message);
  console.error(erro.stack);
  process.exit(1);
});
