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
    // Os motivos reais dos falhados, para o achado já chegar com o "porquê" —
    // sem isso o texto manda o admin olhar o ultimo_erro e ele precisa ir ao
    // banco caçar.
    const errosFalhados = (await repositorio.ultimosErrosDeLembretes?.()) ?? [];
    return {
      presos: Number(resumo?.presos ?? 0),
      falhados: Number(resumo?.falhados ?? 0),
      atrasados: Number(resumo?.atrasados ?? 0),
      pendentes: Number(resumo?.pendentes ?? 0),
      errosFalhados,
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
 * Saúde da Evolution API — o canal PRIMÁRIO de entrega desde os PRs #30/#31
 * (Comando 1 e 3). Comando 4 / frente 9: até aqui só `sondaDoCanal` (o
 * gateway do OpenClaw) existia, e o diagnóstico não sabia dizer nada sobre o
 * canal que realmente entrega as mensagens hoje.
 *
 * `alcancavel` é uma checagem de rede mínima e deliberadamente honesta: só
 * confirma que alguma coisa responde no host configurado (`EVOLUTION_API_URL`).
 * Não presume uma rota específica da API da Evolution para "consultar
 * status" — o contrato exato dos endpoints dela não está documentado neste
 * repositório (conferido: nenhum lugar em `docs/` descreve um endpoint de
 * saúde/status da Evolution), e inventar um caminho aqui seria inventar
 * comportamento, não verificá-lo.
 *
 * `fila`, quando o repositório está disponível, reaproveita a contagem por
 * estado da outbox (Comando 3) como sinal real de entrega recente — sem
 * inventar um campo de "última entrega" que a tabela não guarda hoje.
 */
function sondaDaEvolution(configuracaoEvolution, { fetchImpl = globalThis.fetch, repositorio = null } = {}) {
  const configurada = Boolean(configuracaoEvolution?.apiUrl && configuracaoEvolution?.apiKey);
  if (!configurada) {
    return async () => ({ configurada: false, instancia: null, alcancavel: null, instanciaExiste: null, fila: null });
  }

  return async () => {
    let alcancavel = null;
    try {
      const resposta = await fetchImpl(configuracaoEvolution.apiUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(configuracaoEvolution.timeoutMs ?? 5000),
      });
      // Qualquer resposta HTTP — mesmo 401/404 — prova que o host está de pé.
      // Validar a rota exata exigiria conhecer o contrato da API, que este
      // repositório não documenta.
      alcancavel = Boolean(resposta);
    } catch {
      alcancavel = false;
    }

    // Achado do incidente de 22/08: `alcancavel` sozinho NÃO prova que há
    // atendimento — a raiz de `EVOLUTION_API_URL` devolve 200 "Welcome"
    // mesmo com ZERO instância cadastrada (aconteceu de verdade: a
    // instância sumiu inteira, sem erro visível em lugar nenhum, e esta
    // sonda, do jeito que estava, teria dito "alcançável" e nada mais).
    // `instanciaExiste` confere só isso — se `/instance/fetchInstances`
    // devolve pelo menos um item — e fica `null` (não `false`) em qualquer
    // ambiguidade (host inalcançável, resposta não-2xx, corpo que não é a
    // lista esperada). Deliberadamente NÃO tenta ler o estado de conexão de
    // cada instância: o formato exato dessa parte da resposta não foi
    // confirmado contra uma resposta real da API, e inventar o parsing
    // seria inventar comportamento — o mesmo erro que esta sonda já evita
    // ao não validar uma rota de status específica acima.
    let instanciaExiste = null;
    if (alcancavel) {
      try {
        const base = configuracaoEvolution.apiUrl.replace(/\/+$/, '');
        const respostaInstancias = await fetchImpl(`${base}/instance/fetchInstances`, {
          method: 'GET',
          headers: { apikey: configuracaoEvolution.apiKey },
          signal: AbortSignal.timeout(configuracaoEvolution.timeoutMs ?? 5000),
        });
        if (respostaInstancias.ok) {
          const lista = await respostaInstancias.json().catch(() => null);
          instanciaExiste = Array.isArray(lista) ? lista.length > 0 : null;
        }
      } catch {
        instanciaExiste = null;
      }
    }

    const fila = repositorio?.contarTrabalhosDeOutboxPorEstado
      ? await repositorio.contarTrabalhosDeOutboxPorEstado().catch(() => null)
      : null;

    return {
      configurada: true,
      instancia: configuracaoEvolution.instancia ?? null,
      alcancavel,
      instanciaExiste,
      fila,
    };
  };
}

/** Estado da integração de Instagram: credencial configurada e conta alcançável. */
function sondaDoInstagram(configuracaoInstagram, { fetchImpl = globalThis.fetch } = {}) {
  const configurada = Boolean(configuracaoInstagram?.accessToken && configuracaoInstagram?.contaComercialId);
  if (!configurada) {
    return async () => ({ configurada: false, alcancavel: null, contaValida: null });
  }

  return async () => {
    let alcancavel = null;
    let contaValida = null;
    try {
      const apiVersion = configuracaoInstagram.apiVersion || 'v23.0';
      const resposta = await fetchImpl(
        `https://graph.instagram.com/${apiVersion}/${configuracaoInstagram.contaComercialId}?fields=id`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${configuracaoInstagram.accessToken}` },
          signal: AbortSignal.timeout(configuracaoInstagram.timeoutMs ?? 5000),
        },
      );
      // Mesmo raciocínio da sonda da Evolution: qualquer resposta HTTP prova
      // que o host está de pé, mesmo 401/403 (token inválido) — isso não é a
      // mesma coisa que "não alcançável".
      alcancavel = Boolean(resposta);
      if (resposta.ok) {
        const corpo = await resposta.json().catch(() => null);
        // Ambíguo (corpo inesperado, sem `id`) fica `null`, nunca `false` —
        // não afirma "token inválido" sem ter certeza do formato da resposta.
        contaValida = corpo && typeof corpo === 'object' ? Boolean(corpo.id) : null;
      } else {
        // Não-2xx com o host respondendo: token/conta quase certamente
        // inválidos, mas sem parsear o corpo de erro (formato de plataforma,
        // não confirmado contra uma resposta real) para não inventar.
        contaValida = false;
      }
    } catch {
      alcancavel = false;
      contaValida = null;
    }

    return { configurada: true, alcancavel, contaValida };
  };
}

/**
 * Falhas de entrega recentes da automação — achado do incidente de 22/08.
 *
 * É o sinal de mais alto nível que existe: não importa ONDE a cadeia
 * quebrou (webhook sem configurar na instância nova, instância que sumiu,
 * credencial que só existe na Vercel e falta no `.env` do worker do VPS —
 * um blind spot que NENHUMA outra sonda deste arquivo alcança, porque cada
 * processo só enxerga o próprio ambiente). Se a Serena gera resposta e ela
 * não sai, este número sobe. Foi exatamente o que aconteceu: fila, worker,
 * canal e Evolution reportavam "ok" cada um isoladamente, e mesmo assim
 * nada chegava ao paciente — só o resultado fim-a-fim provava o contrário.
 */
function sondaDeEntregasFalhadas(repositorio, { janelaMs = 24 * 60 * 60 * 1000 } = {}) {
  return async () => {
    const desde = new Date(Date.now() - janelaMs).toISOString();
    const total = (await repositorio.contarEntregasFalhadasDaAutomacao?.({ desde })) ?? 0;
    return { total, janelaMs };
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

/**
 * Saúde do worker da automação (outbox) — Comando 7, achado A-1 da auditoria
 * independente: até aqui essa fila não tinha sonda nenhuma. `bin/worker-outbox.js`
 * grava seu próprio heartbeat em `system_heartbeats`, componente
 * `automacao_outbox_worker` (mecanismo novo, distinto de `sondaDoWorker`
 * acima, que só cobre `lembretes_worker` via `operacao_heartbeats`).
 *
 * Além do heartbeat, a sonda conta trabalho pendente vencido — passou de
 * `disponivel_em` há mais do que `atrasoVencidoMs` — que é o sinal direto de
 * fila parada mesmo quando o processo do worker nunca chegou a cair (preso
 * em erro antes de gravar o próprio batimento, por exemplo).
 */
function sondaDaOutbox(repositorio, { limiteMs = 3 * 60 * 1000, atrasoVencidoMs = 5 * 60 * 1000 } = {}) {
  return async () => {
    const heartbeat = await repositorio.obterBatimentoDoSistema?.('automacao_outbox_worker');
    const agoraMs = Date.now();
    const idadeMs = heartbeat?.atualizado_em
      ? agoraMs - new Date(heartbeat.atualizado_em).getTime()
      : null;
    const ativo = idadeMs !== null && Number.isFinite(idadeMs) && idadeMs <= limiteMs;

    const antesDe = new Date(agoraMs - atrasoVencidoMs).toISOString();
    const fila = (await repositorio.contarTrabalhosDeOutboxPorEstado?.()) ?? null;
    const vencidos = (await repositorio.contarTrabalhosDeOutboxVencidos?.({ antesDe })) ?? 0;
    // Os motivos reais dos mortos/incertos: o achado de fila morta sem o
    // ultimo_erro manda o admin caçar no banco; com ele, a varredura já
    // responde "por que desistiram".
    const erros = (await repositorio.ultimosErrosDaOutbox?.()) ?? [];

    return {
      ativo,
      detalhe: heartbeat?.detalhe ?? null,
      idade_ms: idadeMs,
      fila,
      vencidos,
      erros,
    };
  };
}

module.exports = {
  sondaDoBanco, sondaDaFila, sondaDoCanal, sondaDaEvolution, sondaDaSerena, sondaDoGoogle, sondaDoWorker, sondaDaOutbox,
  sondaDeEntregasFalhadas, sondaDoInstagram,
};
