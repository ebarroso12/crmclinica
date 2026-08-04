'use strict';

const { dentroDoHorario } = require('./serena');

// Leva a decisão do admin até o agente que responde ao paciente.
//
// O painel tem três controles — interruptor, pausa e grade de horário — e até
// agora nenhum deles alcançava a Serena do OpenClaw, que responde direto no
// WhatsApp. A tela dizia "desligada" e o paciente continuava recebendo resposta
// automática. Este módulo é o que fecha essa distância.
//
// ------------------------------------------------------ quem decide, e quem executa
//
// Este arquivo **não decide nada**. Quem liga, desliga, pausa e define horário é
// um administrador, e a escolha dele está gravada no banco com autor e data.
// Aqui só se lê essa escolha e se faz o canal obedecer.
//
// A distinção não é retórica. Uma grade "das 18h às 7h" é uma ordem permanente
// que alguém deu uma vez — executá-la às 18h em ponto é cumprir a ordem, não
// tomar iniciativa. O que este módulo nunca faz é criar, alterar ou revogar a
// configuração por conta própria: nem por segurança, nem como reserva quando
// algo falha. Diante de dúvida, não mexe — porque "abrir por segurança"
// reabriria o atendimento que um humano acabou de fechar.
//
// Roda em laço porque a hora passa sozinha: às 18h a grade abre, e ninguém vai
// estar no painel naquele minuto para clicar em nada.

/**
 * O que o agente deveria estar fazendo agora, e por quê.
 *
 * A precedência é a mesma do resto do sistema — interruptor > pausa > plantão >
 * horário — e é repetida aqui de propósito: quem lê este arquivo precisa
 * entender a decisão sem abrir outro. O motivo acompanha a resposta porque
 * "calada" sem explicação é o que faz a equipe reiniciar servidor quando
 * bastava esperar dar 18h.
 */
function decidirAtendimento(configuracao = {}, agora = new Date()) {
  const vigente = (instante) => Boolean(instante) && new Date(instante) > agora;

  if (configuracao.ativa === false) {
    return { atender: false, motivo: 'interruptor', detalhe: 'a Serena foi desligada pela equipe' };
  }

  if (vigente(configuracao.pausada_ate)) {
    return {
      atender: false,
      motivo: 'pausa',
      detalhe: `pausada até ${new Date(configuracao.pausada_ate).toISOString()}`,
    };
  }

  if (vigente(configuracao.ligada_ate)) {
    return {
      atender: true,
      motivo: 'plantao',
      detalhe: `plantão até ${new Date(configuracao.ligada_ate).toISOString()}`,
    };
  }

  if (dentroDoHorario(configuracao.agenda, agora)) {
    return { atender: true, motivo: 'horario', detalhe: 'dentro da grade de atendimento' };
  }

  return { atender: false, motivo: 'horario', detalhe: 'fora da grade — a equipe atende agora' };
}

/**
 * Compara a decisão com o que o canal está fazendo e corrige a diferença.
 *
 * Falha do gateway não derruba quem chamou: este sincronizador roda dentro do
 * worker de lembretes, e um gateway momentaneamente fora do ar não pode parar a
 * fila de mensagens que já estavam prontas para sair.
 */
function criarSincronizadorDaSerena({ serena, politica, registrar = null, agora = () => new Date() }) {
  if (!serena) throw new Error('sincronizador exige o serviço da Serena');

  let ultimoEstado = null;

  return {
    async sincronizar() {
      if (!politica) return { aplicado: false, motivo: 'canal não configurado' };

      let decisao;
      try {
        const configuracao = await serena.obterConfiguracao();
        decisao = {
          ...decidirAtendimento(configuracao, agora()),
          autor: configuracao.alterado_por_nome ?? null,
        };
      } catch (erro) {
        // Sem saber o que o CRM decidiu, mudar a política do canal seria chutar
        // — e chutar "atender" reabre o atendimento que alguém acabou de fechar.
        return { aplicado: false, erro: `configuração ilegível: ${erro.message}` };
      }

      try {
        const resultado = await politica.definir(decisao.atender);

        if (resultado.alterado) {
          const texto = decisao.atender
            ? `Serena voltou a atender (${decisao.motivo}: ${decisao.detalhe})`
            : `Serena calada no WhatsApp (${decisao.motivo}: ${decisao.detalhe})`;
          console.log(`[serena] ${texto}`);

          // A auditoria diz "executado", não "decidido", e carrega de quem é a
          // regra sendo cumprida. Sem isso, quem ler o histórico daqui a um mês
          // veria o sistema mudando o canal sozinho e não saberia a mando de quem.
          await registrar?.({
            acao: decisao.atender ? 'serena_canal_ligado' : 'serena_canal_calado',
            detalhe: { ...decisao, executado_por: 'worker', regra_de: decisao.autor ?? null },
          });
        }

        ultimoEstado = decisao.atender;
        return { aplicado: true, ...resultado, decisao };
      } catch (erro) {
        return { aplicado: false, decisao, erro: erro.message };
      }
    },

    /** Último estado aplicado com sucesso, para o painel dizer a verdade. */
    ultimoEstadoAplicado() {
      return ultimoEstado;
    },
  };
}

module.exports = { criarSincronizadorDaSerena, decidirAtendimento };
