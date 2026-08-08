'use strict';

// Centro operacional: a varredura que responde "o sistema está inteiro?".
//
// A clínica depende de sete peças que falham de formas diferentes e silenciosas:
// o banco, o RLS, as migrations, a fila de lembretes, o canal do WhatsApp, a
// automação da Serena e o worker. Nenhuma delas grita quando cai. O WhatsApp
// desconecta e o painel continua abrindo; a fila trava e ninguém percebe até um
// paciente não receber o lembrete; uma migration fica pendente e o painel quebra
// só na tela que usa a coluna nova — como aconteceu.
//
// A varredura junta essas perguntas num lugar só, e responde cada uma com um
// fato verificado, não com um "provavelmente está ok".
//
// ------------------------------------------------------ o que ela não faz
//
// Não conserta nada por conta própria. Cada achado traz o reparo **proposto**, e
// aplicar é decisão de um administrador. Isso não é timidez: um reparo
// automático em produção decide sozinho que entendeu o problema, e quando erra,
// erra de madrugada, sem ninguém olhando, em cima de dado de paciente.
//
// A regra da casa é a mesma do resto do sistema: o sistema executa, o admin
// decide.

/** Gravidade de um achado. A ordem importa: é ela que ordena o relatório. */
const NIVEIS = Object.freeze({ ok: 0, aviso: 1, falha: 2, critico: 3 });

function pior(a, b) {
  return NIVEIS[a] >= NIVEIS[b] ? a : b;
}

/**
 * Um achado da varredura.
 *
 * `reparo` é o que fazer, em português, para quem vai decidir. `comando` é a
 * forma automática quando ela existe — e é `null` de propósito quando o conserto
 * exige julgamento humano, para a tela não oferecer um botão que resolve o
 * problema errado.
 */
function achado({ area, nivel, titulo, detalhe = null, reparo = null, comando = null }) {
  return { area, nivel, titulo, detalhe, reparo, comando };
}

/**
 * Roda a varredura inteira.
 *
 * Cada verificação é isolada: uma que estoura não impede as outras de rodar. Um
 * diagnóstico que morre na primeira falha é justamente o que não serve quando
 * várias coisas quebram juntas.
 *
 * @param {object} sondas  funções que consultam o mundo real; injetadas para
 *                         que o teste rode sem banco, sem rede e sem servidor.
 */
async function executarDiagnostico(sondas = {}) {
  const achados = [];
  const registrar = (...novos) => achados.push(...novos.filter(Boolean));

  async function verificar(nome, sonda) {
    if (typeof sonda !== 'function') return null;
    try {
      return await sonda();
    } catch (erro) {
      registrar(achado({
        area: nome,
        nivel: 'falha',
        titulo: `não foi possível verificar ${nome}`,
        detalhe: erro.message,
        reparo: 'A verificação em si falhou. Confira se o serviço responde antes de concluir que a área está boa.',
      }));
      return null;
    }
  }

  // ------------------------------------------------------------------ banco
  const banco = await verificar('banco', sondas.banco);
  if (banco) {
    if (!banco.alcancavel) {
      registrar(achado({
        area: 'banco',
        nivel: 'critico',
        titulo: 'o banco não responde',
        detalhe: banco.motivo ?? null,
        reparo: 'Sem banco, o painel não abre e a fila de lembretes para. Confira o Supabase e a variável de conexão.',
      }));
    } else if (!banco.rlsEfetivo) {
      // Conectar como dono das tabelas desliga o RLS sem avisar: as consultas
      // continuam funcionando, e a barreira que separa os dados some.
      registrar(achado({
        area: 'banco',
        nivel: 'critico',
        titulo: 'o RLS não está valendo nesta conexão',
        detalhe: `conectado como "${banco.usuario ?? '?'}"`,
        reparo: 'A aplicação precisa conectar como crmclinica_app. Como dono das tabelas, o RLS é ignorado.',
      }));
    }

    if (banco.migrationsPendentes?.length) {
      registrar(achado({
        area: 'banco',
        nivel: 'falha',
        titulo: `${banco.migrationsPendentes.length} migration(s) pendente(s)`,
        detalhe: banco.migrationsPendentes.join(', '),
        // Já aconteceu: o código foi publicado antes da migration, e o painel da
        // Serena quebrou em produção lendo uma coluna que não existia.
        reparo: 'Código publicado que espera coluna inexistente quebra a tela que a usa. Aplique as migrations pendentes.',
        comando: 'aplicar-migrations',
      }));
    }
  }

  // --------------------------------------------------------------- serviços
  const servicos = await verificar('serviços', sondas.servicos);
  for (const servico of servicos ?? []) {
    if (!servico.ativo) {
      registrar(achado({
        area: 'serviços',
        nivel: servico.critico ? 'critico' : 'falha',
        titulo: `${servico.nome} está parado`,
        detalhe: servico.detalhe ?? null,
        reparo: `Reiniciar o serviço ${servico.nome} no servidor.`,
        comando: `reiniciar:${servico.nome}`,
      }));
    }
  }

  // ------------------------------------------------------------------ canal
  const canal = await verificar('canal', sondas.canal);
  if (canal) {
    if (!canal.vinculado) {
      registrar(achado({
        area: 'canal',
        nivel: 'critico',
        titulo: 'nenhum telefone conectado no WhatsApp',
        reparo: 'Os pacientes não são atendidos e os lembretes não saem. Reconecte pelo botão do painel.',
      }));
    } else if (!canal.conectado) {
      registrar(achado({
        area: 'canal',
        nivel: 'falha',
        titulo: 'o WhatsApp está vinculado mas fora do ar',
        detalhe: canal.numero ?? null,
        reparo: 'A sessão caiu. Costuma voltar sozinha; se persistir, reconecte pelo painel.',
      }));
    }
  }

  const google = await verificar('google', sondas.google);
  if (google?.configurada && !google.alcancavel) {
    registrar(achado({ area: 'google', nivel: 'falha', titulo: 'o espelho da agenda Google não responde', detalhe: google.motivo ?? null, reparo: 'Confira a credencial da conta de serviço e o compartilhamento do calendário.' }));
  }

  const worker = await verificar('worker', sondas.worker);
  if (worker && !worker.ativo) {
    registrar(achado({ area: 'worker', nivel: 'critico', titulo: 'o worker de lembretes não confirmou atividade', detalhe: worker.detalhe ?? null, reparo: 'Reinicie o serviço do worker e confira os logs do OpenClaw.', comando: 'reiniciar:crmclinica-lembretes' }));
  }

  // ------------------------------------------------------------------- fila
  const fila = await verificar('lembretes', sondas.fila);
  if (fila) {
    if (fila.presos > 0) {
      registrar(achado({
        area: 'lembretes',
        nivel: 'falha',
        titulo: `${fila.presos} lembrete(s) preso(s) em processamento`,
        detalhe: 'reivindicados por um worker que morreu antes de terminar',
        reparo: 'O worker recupera sozinho depois do prazo do lease. Se não recuperar, o worker não está rodando.',
      }));
    }

    if (fila.falhados > 0) {
      registrar(achado({
        area: 'lembretes',
        nivel: 'aviso',
        titulo: `${fila.falhados} lembrete(s) falharam de vez`,
        reparo: 'Esgotaram as tentativas. Vale ver o motivo antes que vire padrão.',
      }));
    }

    if (fila.atrasados > 0) {
      // Pendente com hora vencida e worker vivo significa que a fila parou de
      // ser processada — é o sintoma mais direto de worker fora do ar.
      registrar(achado({
        area: 'lembretes',
        nivel: 'falha',
        titulo: `${fila.atrasados} lembrete(s) venceram sem sair`,
        reparo: 'A fila não está sendo processada. Confira se o worker está rodando.',
        comando: 'reiniciar:crmclinica-lembretes',
      }));
    }
  }

  // ------------------------------------------------------------------ testes
  const testes = await verificar('testes', sondas.testes);
  if (testes && testes.falhas > 0) {
    registrar(achado({
      area: 'testes',
      nivel: 'falha',
      titulo: `${testes.falhas} teste(s) falhando`,
      detalhe: `${testes.passaram}/${testes.total} passaram`,
      reparo: 'Teste vermelho é regra do sistema que deixou de valer. Corrija antes de publicar qualquer coisa.',
    }));
  }

  // ------------------------------------------------------------- automação
  const serena = await verificar('serena', sondas.serena);
  if (serena) {
    // A tela dizer uma coisa e o canal fazer outra é o defeito mais perigoso
    // aqui, porque some da vista: já aconteceu de o painel mostrar "desligada"
    // com a Serena respondendo paciente.
    if (serena.desejado !== null && serena.aplicado !== null && serena.desejado !== serena.aplicado) {
      registrar(achado({
        area: 'serena',
        nivel: 'critico',
        titulo: 'o painel e o WhatsApp discordam sobre a Serena',
        detalhe: `painel diz ${serena.desejado ? 'atendendo' : 'calada'}, canal está ${serena.aplicado ? 'atendendo' : 'calado'}`,
        reparo: 'A decisão do painel não chegou ao canal. Sincronize para o canal obedecer ao painel.',
        comando: 'sincronizar-serena',
      }));
    }
  }

  const nivel = achados.reduce((maior, item) => pior(maior, item.nivel), 'ok');

  return {
    nivel,
    saudavel: nivel === 'ok',
    achados: achados.sort((a, b) => NIVEIS[b.nivel] - NIVEIS[a.nivel]),
    resumo: resumir(nivel, achados.length),
    verificado_em: new Date().toISOString(),
  };
}

function resumir(nivel, quantos) {
  if (nivel === 'ok') return 'Tudo verificado e no lugar.';
  if (nivel === 'critico') {
    return `${quantos} problema(s), com pelo menos um que impede a clínica de atender.`;
  }
  if (nivel === 'falha') return `${quantos} problema(s) que precisam de conserto.`;
  return `${quantos} ponto(s) de atenção, nada urgente.`;
}

module.exports = { executarDiagnostico, achado, NIVEIS };
