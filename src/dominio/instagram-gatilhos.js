'use strict';

const { comentarioContemGatilho } = require('./texto-normalizado');
const { origemDoCanal } = require('./leads');

// Serviço de gatilhos de palavra do Instagram: CRUD das regras
// (`instagram_regras_gatilho`) e o processamento de um comentário do webhook
// contra elas (`instagram_comentarios_processados` é a idempotência).
//
// Pedido do Dr. Edson (ver db/045_instagram_gatilhos.sql): quando a palavra
// bate, as DUAS ações disparam sempre — resposta pública ao comentário e DM
// privada — e a DM inicia o fluxo de qualificação de lead do consultório
// (contato + conversa + lead).

/**
 * Erro de validação/estado do serviço de gatilhos, mesmo estilo de
 * `ErroDaSerena` (src/dominio/serena.js) e `ErroDoGoogle`
 * (src/integracoes/google-calendario.js): `.codigo` estável para o chamador
 * decidir sem comparar mensagem (que muda de idioma/redação), `.status` HTTP
 * pronto para a rota devolver sem reinterpretar.
 */
class ErroDoInstagram extends Error {
  constructor(mensagem, codigo = 'instagram_invalido', status = 400) {
    super(mensagem);
    this.name = 'ErroDoInstagram';
    this.codigo = codigo;
    this.status = status;
  }
}

/**
 * Valida e normaliza os campos de uma regra de gatilho. Mesmos limites do
 * CHECK do banco (db/045_instagram_gatilhos.sql) — validar aqui evita que a
 * exceção genérica do Postgres chegue crua ao usuário.
 */
function validarRegraDeGatilho({
  nome, palavraGatilho, mensagemDm, mensagemPublica, ctaWhatsapp = true,
}) {
  const nomeLimpo = String(nome ?? '').trim();
  const palavraLimpa = String(palavraGatilho ?? '').trim();
  const dmLimpa = String(mensagemDm ?? '').trim();
  const publicaLimpa = String(mensagemPublica ?? '').trim();

  if (!nomeLimpo) throw new ErroDoInstagram('a regra precisa de um nome', 'nome_obrigatorio');
  if (nomeLimpo.length > 80) throw new ErroDoInstagram('o nome da regra é longo demais (máx. 80)', 'nome_longo');

  if (palavraLimpa.length < 2 || palavraLimpa.length > 100) {
    throw new ErroDoInstagram('a palavra-gatilho deve ter entre 2 e 100 caracteres', 'palavra_gatilho_invalida');
  }
  if (dmLimpa.length < 3 || dmLimpa.length > 2000) {
    throw new ErroDoInstagram('a mensagem de DM deve ter entre 3 e 2000 caracteres', 'mensagem_dm_invalida');
  }
  if (publicaLimpa.length < 3 || publicaLimpa.length > 500) {
    throw new ErroDoInstagram('a mensagem pública deve ter entre 3 e 500 caracteres', 'mensagem_publica_invalida');
  }

  return {
    nome: nomeLimpo,
    palavraGatilho: palavraLimpa,
    mensagemDm: dmLimpa,
    mensagemPublica: publicaLimpa,
    ctaWhatsapp: ctaWhatsapp !== false,
  };
}

// `repositorio.atualizarRegraDeGatilho` (ao contrário de `criarRegraDeGatilho`)
// espera as CHAVES em snake_case — mesmo nome de coluna do banco — porque
// filtra `campos` contra um mapa de colunas permitidas antes do UPDATE (ver
// src/dados/repositorio.js e repositorio-memoria.js, função
// `atualizarRegraDeGatilho`). Este serviço fala camelCase para fora (mesmo
// padrão de `criarRegraDeGatilho`); esta função é só a ponte para a exceção
// de `atualizarRegraDeGatilho`.
function paraColunas(validada) {
  return {
    nome: validada.nome,
    palavra_gatilho: validada.palavraGatilho,
    mensagem_dm: validada.mensagemDm,
    mensagem_publica: validada.mensagemPublica,
    cta_whatsapp: validada.ctaWhatsapp,
  };
}

function criarServicoDeGatilhos({ repositorio, instagramEnvio = null, atendimento = null } = {}) {
  if (!repositorio) throw new Error('serviço de gatilhos do Instagram exige um repositório');
  // `atendimento` não é usado ainda por este serviço — reservado para quando o
  // fluxo de qualificação de lead precisar do orquestrador de conversa em vez
  // de só gravar contato/conversa/lead diretamente (ver `processarComentario`
  // abaixo). Aceito no construtor desde já para não mudar a assinatura da
  // fábrica quando isso for implementado.

  // ------------------------------------------------------------------ CRUD

  async function listarRegras({ apenasAtivas = false } = {}) {
    return repositorio.listarRegrasDeGatilho({ apenasAtivas });
  }

  async function obterRegra(id) {
    return repositorio.obterRegraDeGatilho(id);
  }

  async function criarRegra({
    nome, palavraGatilho, mensagemDm, mensagemPublica, ctaWhatsapp = true, usuarioId = null,
  }) {
    const validada = validarRegraDeGatilho({
      nome, palavraGatilho, mensagemDm, mensagemPublica, ctaWhatsapp,
    });

    try {
      return await repositorio.criarRegraDeGatilho({ ...validada, criadoPor: usuarioId });
    } catch (erro) {
      // Nome repetido é conflito, não erro interno — `nome` é UNIQUE
      // (db/045_instagram_gatilhos.sql).
      if (erro.code === '23505') {
        throw new ErroDoInstagram(`já existe uma regra chamada "${validada.nome}"`, 'nome_duplicado', 409);
      }
      throw erro;
    }
  }

  async function editarRegra(id, campos = {}) {
    const atual = await repositorio.obterRegraDeGatilho(id);
    if (!atual) throw new ErroDoInstagram('regra não encontrada', 'regra_ausente', 404);

    const validada = validarRegraDeGatilho({
      nome: campos.nome ?? atual.nome,
      palavraGatilho: campos.palavraGatilho ?? atual.palavra_gatilho,
      mensagemDm: campos.mensagemDm ?? atual.mensagem_dm,
      mensagemPublica: campos.mensagemPublica ?? atual.mensagem_publica,
      ctaWhatsapp: campos.ctaWhatsapp ?? atual.cta_whatsapp,
    });

    try {
      return await repositorio.atualizarRegraDeGatilho(id, paraColunas(validada));
    } catch (erro) {
      if (erro.code === '23505') {
        throw new ErroDoInstagram(`já existe uma regra chamada "${validada.nome}"`, 'nome_duplicado', 409);
      }
      throw erro;
    }
  }

  /** Liga ou desliga uma regra — ação separada da edição (mesmo raciocínio de `serena.definirRegraAtiva`). */
  async function definirRegraAtiva(id, ativa) {
    const atual = await repositorio.obterRegraDeGatilho(id);
    if (!atual) throw new ErroDoInstagram('regra não encontrada', 'regra_ausente', 404);

    return repositorio.atualizarRegraDeGatilho(id, { ativa: ativa === true });
  }

  async function removerRegra(id) {
    const atual = await repositorio.obterRegraDeGatilho(id);
    if (!atual) throw new ErroDoInstagram('regra não encontrada', 'regra_ausente', 404);

    await repositorio.removerRegraDeGatilho(id);
    return { removida: true, nome: atual.nome };
  }

  // ------------------------------------------------------- comentário → gatilho

  /**
   * Processa UM comentário já normalizado (ver `normalizarComentarioInstagram`
   * em src/integracoes/instagram-webhook.js) contra as regras ativas.
   *
   * Idempotente por `comentarioIdExterno`: reentrega do mesmo comentário pelo
   * provedor (webhook duplicado) não processa nem responde de novo.
   */
  async function processarComentario({
    comentarioIdExterno, postId = null, autorIgId, autorUsername = null, texto,
  }) {
    const jaProcessado = await repositorio.obterComentarioProcessado(comentarioIdExterno);
    if (jaProcessado) return { ja_processado: true };

    const regrasAtivas = await repositorio.listarRegrasDeGatilho({ apenasAtivas: true });
    const regra = regrasAtivas.find((candidata) => comentarioContemGatilho(texto, candidata.palavra_gatilho)) ?? null;

    if (!regra) {
      await repositorio.registrarComentarioProcessado({
        comentarioIdExterno, postId, autorIgId, regraId: null, respostaPublicaEnviada: false, dmEnviada: false,
      });
      return { regra: null };
    }

    // Resposta pública ao comentário — endpoint `/{comment-id}/replies` da
    // Graph API, implementado em `instagram-envio.js` em 23/08 (achado
    // A1.9-B: não verificado contra chamada real, sem credencial disponível
    // — validar antes de confiar em produção). Mantém a checagem defensiva
    // por `typeof` para o caso de um `instagramEnvio` de teste/futuro que
    // não implemente o método — nesse caso o campo devolvido ao chamador
    // (`resposta_publica_enviada`) fica `false` e o fluxo segue para a DM,
    // sem quebrar.
    let respostaPublicaEnviada = false;
    if (instagramEnvio && typeof instagramEnvio.responderComentarioPublicamente === 'function') {
      try {
        await instagramEnvio.responderComentarioPublicamente({
          comentarioIdExterno, texto: regra.mensagem_publica,
        });
        respostaPublicaEnviada = true;
      } catch (erro) {
        console.error('[instagram] falha ao responder publicamente ao comentário-gatilho:', erro.message);
      }
    }

    // DM privada. Endereça por `comment_id` (não pelo `autorIgId`/PSID) —
    // achado de 23/08 (ver instagram-envio.js): é a primeira mensagem depois
    // de um comentário, sem conversa aberta ainda, e a Graph API só libera
    // esse envio quando o destinatário é referenciado pelo comentário que
    // originou o gatilho. Best-effort — mesmo raciocínio de
    // `entregarAoPaciente` em src/dominio/atendimento.js: falha de rede no
    // envio não pode derrubar o processamento do comentário (o registro de
    // idempotência abaixo precisa acontecer de qualquer jeito);
    // `dm_enviada:false` no retorno é o que sobra para alguém perceber que a
    // mensagem não saiu.
    let dmEnviada = false;
    if (instagramEnvio && typeof instagramEnvio.responderComentarioPrivadamente === 'function') {
      try {
        await instagramEnvio.responderComentarioPrivadamente({
          comentarioIdExterno, texto: regra.mensagem_dm,
        });
        dmEnviada = true;
      } catch (erro) {
        console.error('[instagram] falha ao enviar DM do gatilho:', erro.message);
      }
    }

    // Contato, conversa e lead — início do fluxo de qualificação pedido pelo
    // Dr. Edson. Ao contrário do envio acima, isto não é chamada de rede
    // externa: uma falha aqui é uma falha real do CRM (banco fora do ar,
    // etc.), não uma incerteza de entrega — deixa propagar em vez de engolir,
    // para não marcar como processado um comentário que na verdade não gerou
    // contato/lead nenhum.
    const contato = await repositorio.encontrarOuCriarContato({
      telefone: null, identificador: autorIgId, nome: autorUsername ?? null, canal: 'instagram',
    });
    const conversa = await repositorio.encontrarOuCriarConversaAberta(contato.id, 'instagram');
    await repositorio.registrarMensagem(conversa.id, {
      direcao: 'saida', conteudo: regra.mensagem_dm, autor_tipo: 'automacao',
    });
    // origemDetalhe marca que este lead nasceu de um comentário-gatilho (e
    // qual regra bateu) — é o que diferencia, na tela de Leads, um lead que
    // veio de "avaliação" no comentário de um DM comum do Instagram. Ver
    // pedido do Dr. Edson (23/08): "as que tiver o gatilho, diferencia".
    await repositorio.salvarLead(contato.id, {
      conversaId: conversa.id,
      origem: origemDoCanal('instagram'),
      origemDetalhe: `Comentário-gatilho: ${regra.nome}`,
    });

    await repositorio.registrarComentarioProcessado({
      comentarioIdExterno, postId, autorIgId, regraId: regra.id, respostaPublicaEnviada, dmEnviada,
    });

    return { regra, resposta_publica_enviada: respostaPublicaEnviada, dm_enviada: dmEnviada };
  }

  async function metricas() {
    return repositorio.metricasInstagram();
  }

  return {
    listarRegras,
    obterRegra,
    criarRegra,
    editarRegra,
    definirRegraAtiva,
    removerRegra,
    processarComentario,
    metricas,
  };
}

module.exports = { criarServicoDeGatilhos, ErroDoInstagram, validarRegraDeGatilho };
