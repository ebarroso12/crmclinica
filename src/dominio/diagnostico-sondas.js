'use strict';

// As sondas do centro operacional: o que vai ao mundo real perguntar.
//
// Ficam separadas das regras de `diagnostico.js` de propósito. A regra "RLS
// desligado é crítico" não muda; a forma de descobrir o usuário da conexão muda
// com o banco, com o pooler, com o provedor. Misturar as duas coisas faria cada
// mudança de infraestrutura reescrever o julgamento junto.

/** Estado do banco: alcance, papel efetivo e migrations aplicadas. */
function sondaDoBanco(repositorio, objetosEsperados = [], conferirConexao = null) {
  return async () => {
    // `seguro` é a resposta que interessa: já reúne "não ignora RLS", "não é
    // superusuário" e "não é dono das tabelas" — as três formas de o RLS deixar
    // de valer sem que nada pare de funcionar.
    const conexao = conferirConexao ? await conferirConexao() : null;

    let faltando = [];
    try {
      faltando = await repositorio.conferirObjetosEsperados?.(objetosEsperados) ?? [];
    } catch (erro) {
      // Não conseguir conferir é diferente de estar tudo certo, e a diferença
      // importa: silenciar aqui faria a varredura dizer "banco ok" sem ter olhado.
      throw new Error(`não foi possível conferir o esquema: ${erro.message}`);
    }

    return {
      // Se a consulta do esquema passou, o banco respondeu — não há como
      // conferir coluna com o banco fora do ar.
      alcancavel: true,
      usuario: conexao?.usuario ?? null,
      rlsEfetivo: conexao ? conexao.seguro === true : true,
      migrationsPendentes: faltando,
    };
  };
}

/**
 * Saúde da fila de lembretes.
 *
 * Três perguntas diferentes, e cada uma denuncia uma falha distinta: preso
 * denuncia worker que morreu no meio, falhado denuncia entrega quebrada, e
 * atrasado denuncia fila que parou de ser processada.
 */
function sondaDaFila(repositorio) {
  return async () => {
    const resumo = await repositorio.resumirFilaDeLembretes?.();
    return {
      presos: Number(resumo?.presos ?? 0),
      falhados: Number(resumo?.falhados ?? 0),
      atrasados: Number(resumo?.atrasados ?? 0),
      pendentes: Number(resumo?.pendentes ?? 0),
    };
  };
}

/** O que o canal do WhatsApp está fazendo agora. */
function sondaDoCanal(vinculo) {
  if (!vinculo) return null;
  return async () => {
    const estado = await vinculo.estado();
    return {
      vinculado: estado.vinculado === true,
      conectado: estado.conectado === true,
      numero: estado.numero ?? null,
    };
  };
}

/**
 * Compara o que o painel decidiu com o que o canal está fazendo.
 *
 * É a verificação que teria pego, sozinha, o defeito que a equipe descobriu com
 * paciente na linha: o painel dizia "desligada" e a Serena respondia.
 */
function sondaDaSerena(serena, politica, decidir) {
  if (!serena || !politica) return null;
  return async () => {
    const [configuracao, canal] = await Promise.all([
      serena.obterConfiguracao(),
      politica.ler(),
    ]);

    return {
      desejado: decidir(configuracao, new Date()).atender,
      aplicado: canal.atendendo,
    };
  };
}

function sondaDoGoogle(agenda) {
  if (!agenda?.verificar) return null;
  return () => agenda.verificar();
}

function sondaDoWorker(repositorio, limiteMs = 3 * 60 * 1000) {
  return async () => {
    const heartbeat = await repositorio.obterHeartbeat?.('lembretes_worker');
    if (!heartbeat?.visto_em) return { ativo: false, detalhe: 'nenhum heartbeat do worker foi registrado' };
    const idadeMs = Date.now() - new Date(heartbeat.visto_em).getTime();
    return { ativo: Number.isFinite(idadeMs) && idadeMs <= limiteMs, detalhe: heartbeat.instancia ?? null, idade_ms: idadeMs };
  };
}

module.exports = { sondaDoBanco, sondaDaFila, sondaDoCanal, sondaDaSerena, sondaDoGoogle, sondaDoWorker };
