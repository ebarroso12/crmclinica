'use strict';

const {
  decidirResposta, montarPromptEfetivo, validarPrompt, validarRegra, ErroDaSerena, CATEGORIAS,
} = require('./serena');

// Serviço da Serena: o interruptor global, o prompt versionado e as regras.
//
// Três garantias atravessam este arquivo:
//
//   1. **Desligar é imediato e auditado.** Não há cache do estado: cada decisão
//      de responder relê a configuração. Um cache de 30 segundos significaria
//      meio minuto de respostas automáticas depois de a equipe mandar parar —
//      justamente no meio do incidente que motivou o desligamento.
//
//   2. **O que foi publicado não se reescreve.** Editar só vale para rascunho.
//      A versão no ar é registro do que a clínica decidiu dizer, e registro que
//      se altera não serve para explicar o que foi dito ontem.
//
//   3. **Toda mudança tem autor, data e motivo.** Desligar sem explicação vira
//      mistério na semana seguinte, quando ninguém lembra se foi incidente,
//      manutenção ou engano.

function criarServicoDaSerena({ repositorio, agora = () => new Date() } = {}) {
  if (!repositorio) throw new Error('serviço da Serena exige um repositório');

  async function auditar(acao, entidadeId, detalhe = null, usuarioId = null) {
    try {
      await repositorio.registrarAuditoria({
        entidade: 'serena', entidadeId, acao, detalhe, usuarioId,
      });
    } catch (erro) {
      console.error(`[serena] falha ao auditar "${acao}": ${erro.message}`);
    }
  }

  // ---------------------------------------------------------------- interruptor

  async function obterConfiguracao() {
    return repositorio.obterConfiguracaoDaSerena();
  }

  /**
   * Liga ou desliga a Serena para toda a clínica.
   *
   * Desligar exige motivo. Ligar não: voltar ao normal é o estado esperado, e
   * exigir justificativa para normalizar só faria alguém escrever "ok".
   */
  async function definirAtiva(ativa, { motivo = null, usuarioId = null } = {}) {
    if (typeof ativa !== 'boolean') {
      throw new ErroDaSerena('informe se a Serena deve ficar ativa (true) ou não (false)', 'ativa_invalida');
    }

    const motivoLimpo = motivo ? String(motivo).trim().slice(0, 300) : null;
    if (!ativa && !motivoLimpo) {
      throw new ErroDaSerena('desligar a Serena exige um motivo', 'motivo_obrigatorio');
    }

    const anterior = await obterConfiguracao();
    const configuracao = await repositorio.definirConfiguracaoDaSerena({
      ativa, motivo: motivoLimpo, usuarioId,
    });

    await auditar(ativa ? 'serena_ligada' : 'serena_desligada', 1, {
      de: anterior.ativa, para: ativa, motivo: motivoLimpo,
    }, usuarioId);

    return configuracao;
  }

  /**
   * A decisão que o atendimento consulta antes de responder.
   *
   * Relê a configuração a cada chamada, de propósito — ver a garantia (1) no
   * topo do arquivo.
   */
  async function podeResponder(conversa) {
    const configuracao = await obterConfiguracao();
    return decidirResposta(conversa, configuracao, agora());
  }

  // ---------------------------------------------------------------- prompt

  async function listarPrompts({ limite = 50 } = {}) {
    return repositorio.listarPromptsDaSerena({ limite });
  }

  async function obterPromptAtivo() {
    const [publicado, regras] = await Promise.all([
      repositorio.obterPromptPublicadoDaSerena(),
      repositorio.listarRegrasDaSerena({ apenasAtivas: true }),
    ]);

    return {
      prompt: publicado,
      regras,
      // O texto como o agente o receberia: publicado + regras ligadas, na ordem.
      efetivo: montarPromptEfetivo(publicado, regras),
    };
  }

  async function criarPrompt({ titulo, conteudo, usuarioId = null }) {
    const validado = validarPrompt({ titulo, conteudo });
    const prompt = await repositorio.criarPromptDaSerena({ ...validado, criadoPor: usuarioId });

    await auditar('serena_prompt_criado', prompt.id, { versao: prompt.versao, titulo: prompt.titulo }, usuarioId);
    return prompt;
  }

  async function editarPrompt(id, { titulo, conteudo, usuarioId = null }) {
    const atual = await repositorio.obterPromptDaSerena(id);
    if (!atual) throw new ErroDaSerena('prompt não encontrado', 'prompt_ausente', 404);
    if (atual.publicado) {
      throw new ErroDaSerena(
        'o prompt publicado não pode ser editado; crie uma versão nova',
        'prompt_publicado',
        409,
      );
    }

    const validado = validarPrompt({ titulo, conteudo });
    const prompt = await repositorio.atualizarPromptDaSerena(id, validado);
    if (!prompt) throw new ErroDaSerena('prompt não encontrado', 'prompt_ausente', 404);

    await auditar('serena_prompt_editado', prompt.id, { versao: prompt.versao }, usuarioId);
    return prompt;
  }

  /** Publica uma versão. A anterior sai do ar na mesma transação. */
  async function publicarPrompt(id, { usuarioId = null } = {}) {
    const alvo = await repositorio.obterPromptDaSerena(id);
    if (!alvo) throw new ErroDaSerena('prompt não encontrado', 'prompt_ausente', 404);

    const anterior = await repositorio.obterPromptPublicadoDaSerena();
    const prompt = await repositorio.publicarPromptDaSerena(id, { usuarioId });

    await auditar('serena_prompt_publicado', prompt.id, {
      versao: prompt.versao,
      substituiu: anterior?.versao ?? null,
    }, usuarioId);

    return prompt;
  }

  // ---------------------------------------------------------------- regras

  async function listarRegras({ apenasAtivas = false } = {}) {
    return repositorio.listarRegrasDaSerena({ apenasAtivas });
  }

  async function criarRegra({ nome, conteudo, categoria = 'geral', descricao = null, ordem = 100, usuarioId = null }) {
    const validada = validarRegra({ nome, conteudo, categoria, descricao, ordem });

    let regra;
    try {
      regra = await repositorio.criarRegraDaSerena({ ...validada, criadoPor: usuarioId });
    } catch (erro) {
      // Nome repetido é conflito, não erro interno: a equipe precisa saber que
      // já existe uma regra com esse nome, não ver "falha interna".
      if (erro.code === '23505') {
        throw new ErroDaSerena(`já existe uma regra chamada "${validada.nome}"`, 'nome_duplicado', 409);
      }
      throw erro;
    }

    await auditar('serena_regra_criada', regra.id, { nome: regra.nome, categoria: regra.categoria }, usuarioId);
    return regra;
  }

  async function editarRegra(id, campos, { usuarioId = null } = {}) {
    const atual = await repositorio.obterRegraDaSerena(id);
    if (!atual) throw new ErroDaSerena('regra não encontrada', 'regra_ausente', 404);

    const validada = validarRegra({
      nome: campos.nome ?? atual.nome,
      conteudo: campos.conteudo ?? atual.conteudo,
      categoria: campos.categoria ?? atual.categoria,
      descricao: campos.descricao ?? atual.descricao,
      ordem: campos.ordem ?? atual.ordem,
    });

    const regra = await repositorio.atualizarRegraDaSerena(id, validada);
    await auditar('serena_regra_editada', id, { nome: regra.nome }, usuarioId);
    return regra;
  }

  /** Liga ou desliga uma regra. Desligada, ela some do prompt efetivo na hora. */
  async function definirRegraAtiva(id, ativa, { usuarioId = null } = {}) {
    const atual = await repositorio.obterRegraDaSerena(id);
    if (!atual) throw new ErroDaSerena('regra não encontrada', 'regra_ausente', 404);

    const regra = await repositorio.atualizarRegraDaSerena(id, { ativa: ativa === true });
    await auditar(ativa ? 'serena_regra_ativada' : 'serena_regra_desativada', id, { nome: regra.nome }, usuarioId);
    return regra;
  }

  async function removerRegra(id, { usuarioId = null } = {}) {
    const atual = await repositorio.obterRegraDaSerena(id);
    if (!atual) throw new ErroDaSerena('regra não encontrada', 'regra_ausente', 404);

    // A auditoria guarda o conteúdo: a regra sai da tabela, mas o que ela dizia
    // continua recuperável — apagar sem rastro é o que impede explicar depois
    // por que a Serena mudou de comportamento.
    await auditar('serena_regra_removida', id, {
      nome: atual.nome, categoria: atual.categoria, conteudo: atual.conteudo,
    }, usuarioId);

    await repositorio.removerRegraDaSerena(id);
    return { removida: true, nome: atual.nome };
  }

  return {
    CATEGORIAS,
    obterConfiguracao,
    definirAtiva,
    podeResponder,
    listarPrompts,
    obterPromptAtivo,
    criarPrompt,
    editarPrompt,
    publicarPrompt,
    listarRegras,
    criarRegra,
    editarRegra,
    definirRegraAtiva,
    removerRegra,
  };
}

module.exports = { criarServicoDaSerena };
