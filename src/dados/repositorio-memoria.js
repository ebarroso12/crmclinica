'use strict';

// Repositório em memória com a mesma interface do PostgreSQL.
// Serve aos testes e ao desenvolvimento local sem banco: o resto do sistema
// não distingue um do outro. Não persiste nada entre reinícios, de propósito.

const crypto = require('node:crypto');
const { redigirAuditoria } = require('../seguranca/redator-auditoria');
const { podeAcessarConversaAoVivo } = require('../seguranca/rbac');

const ETIQUETAS_INICIAIS = [
  { nome: 'lead_quente', descricao: 'Lead quente', cor: '#dc2626', do_sistema: true },
  { nome: 'lead_morno', descricao: 'Lead morno', cor: '#d97706', do_sistema: true },
  { nome: 'lead_frio', descricao: 'Lead frio', cor: '#0891b2', do_sistema: true },
  { nome: 'pagou_sinal', descricao: 'Pagou o sinal da consulta', cor: '#059669', do_sistema: false },
  { nome: 'falta_pagar', descricao: 'Ainda não efetuou o pagamento', cor: '#d97706', do_sistema: false },
  { nome: 'em_protocolo', descricao: 'Em protocolo de tratamento', cor: '#7c3aed', do_sistema: false },
  { nome: 'pos_consulta', descricao: 'Já passou pela consulta', cor: '#1d4ed8', do_sistema: false },
  { nome: 'avaliacao', descricao: 'Em avaliação de satisfação', cor: '#64748b', do_sistema: false },
  { nome: 'positiva', descricao: 'Avaliação positiva', cor: '#059669', do_sistema: false },
  { nome: 'negativa', descricao: 'Avaliação negativa', cor: '#dc2626', do_sistema: false },
  { nome: 'pacientes_antigos', descricao: 'Paciente antigo', cor: '#0891b2', do_sistema: false },
];

function criarRepositorioEmMemoria({ agora = () => new Date(), batimentos: batimentosIniciais = null } = {}) {
  const contatos = new Map();
  const conversas = new Map();
  const mensagens = [];
  const etiquetas = new Map();
  const etiquetasDaConversa = new Map();
  const notas = [];
  const leads = new Map();
  const eventos = new Map();
  // Log durável do chat ao vivo (migration 037) — array append-only, `id`
  // (1-based, contador próprio) faz o papel do `bigserial` do Postgres.
  const conversasEventos = [];
  let proximoIdDeEventoDeConversa = 1;
  const conversasEventosTickets = new Map();
  const auditoria = [];
  // Espelha `system_heartbeats` do Postgres: componente → { status, atualizadoEm }.
  // Sem escritor próprio (quem grava, no banco real, é um worker externo ao
  // repositório), então testes que precisam do caminho "operacional" semeiam
  // aqui pelo construtor.
  const batimentosDoSistema = new Map(
    Object.entries(batimentosIniciais || {}).map(([componente, valor]) => [componente, {
      status: valor.status || 'ok',
      atualizadoEm: valor.atualizadoEm || agora().toISOString(),
    }]),
  );
  const heartbeats = new Map();
  const usuarios = new Map();
  const sessoes = new Map();
  const recuperacoes = new Map();
  const tentativas = [];
  const leadEventos = [];
  const profissionais = new Map();
  const disponibilidades = [];
  const bloqueios = [];
  const agendamentos = [];
  const lembretes = [];
  const serenaPrompts = [];
  const serenaRegras = [];
  const serenaVozSessoes = new Map();
  const serenaVozTurnos = [];
  const tarefas = [];
  const formularios = [];
  const eventosAnaliticos = [];
  const iaChamadas = [];
  const iaAvaliacoes = [];
  const notificacoes = [];
  const serenaAtivacaoContatos = new Set();
  // A outbox durável da automação — ver db/031_automacao_outbox.sql e
  // src/dominio/automacao-outbox.js. Um Map, não um array: reivindicar e
  // concluir mexem numa linha por id, e Map é O(1) para isso.
  const automacaoOutbox = new Map();
  // O catálogo em memória espelha o seed da migration 027.
  const iaModelos = [
    { id: 1, provedor: 'openai', modelo: 'gpt-4o-mini', rotulo: 'GPT-4o Mini', ativo: true, padrao: false, custo_entrada_usd_mi: 0.15, custo_saida_usd_mi: 0.6 },
    { id: 2, provedor: 'openai', modelo: 'gpt-4o', rotulo: 'GPT-4o', ativo: true, padrao: false, custo_entrada_usd_mi: 2.5, custo_saida_usd_mi: 10 },
    { id: 3, provedor: 'anthropic', modelo: 'claude-haiku-4-5-20251001', rotulo: 'Claude Haiku 4.5', ativo: true, padrao: true, custo_entrada_usd_mi: 1, custo_saida_usd_mi: 5 },
    { id: 4, provedor: 'anthropic', modelo: 'claude-sonnet-5', rotulo: 'Claude Sonnet 5', ativo: true, padrao: false, custo_entrada_usd_mi: 3, custo_saida_usd_mi: 15 },
    { id: 5, provedor: 'google', modelo: 'gemini-2.5-flash', rotulo: 'Gemini 2.5 Flash', ativo: true, padrao: false, custo_entrada_usd_mi: 0.3, custo_saida_usd_mi: 2.5 },
    { id: 6, provedor: 'deepseek', modelo: 'deepseek-chat', rotulo: 'DeepSeek Chat', ativo: true, padrao: false, custo_entrada_usd_mi: 0.27, custo_saida_usd_mi: 1.1 },
    { id: 7, provedor: 'kimi', modelo: 'kimi-latest', rotulo: 'Kimi (Moonshot)', ativo: true, padrao: false, custo_entrada_usd_mi: 0.6, custo_saida_usd_mi: 2.5 },
  ];

  // --- helpers da analítica: espelham as conversões de fuso das views ---

  const FORMATO_DIA_SP = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const FORMATO_MOMENTO_SP = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo', hour12: false, weekday: 'short', hour: '2-digit',
  });

  /** 'YYYY-MM-DD' no fuso da clínica — como o ::date das views. */
  function diaSp(instante) {
    return FORMATO_DIA_SP.format(new Date(instante));
  }

  /** Dia da semana (0=domingo) e hora no fuso da clínica. */
  function momentoSp(instante) {
    const partes = FORMATO_MOMENTO_SP.formatToParts(new Date(instante));
    const valor = (tipo) => partes.find((parte) => parte.type === tipo)?.value ?? '';
    const dias = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return { diaSemana: dias[valor('weekday')] ?? 0, hora: Number(valor('hour')) % 24 };
  }

  /** Dado sintético (faixa de ensaio) fica fora de toda métrica agregada. */
  function telefoneSintetico(contatoId) {
    const telefone = contatos.get(Number(contatoId))?.telefone ?? '';
    return telefone.startsWith('5516900000');
  }
  // Uma linha só, como a constraint do PostgreSQL garante lá.
  const serenaConfiguracao = {
    id: 1, ativa: true, alterado_por: null, alterado_em: null, motivo: null,
    // Nasce sem limite de horário: quem não configurou grade não pediu silêncio.
    agenda: null, pausada_ate: null, ligada_ate: null,
    // Ativação gradual (migration 028): nasce atendendo todos.
    modo_ativacao: 'todos', ativacao_percentual: 100,
  };

  /** Espelha o que o PostgreSQL devolve nas junções da agenda. */
  function enriquecerAgendamento(agendamento) {
    const profissional = profissionais.get(agendamento.profissional_id);
    const contato = contatos.get(agendamento.contato_id);

    return {
      ...agendamento,
      profissional_nome: profissional?.nome ?? null,
      profissional_cor: profissional?.cor ?? null,
      contato_nome: contato?.nome ?? null,
      contato_telefone: contato?.telefone ?? null,
    };
  }

  /** Espelha o que o PostgreSQL devolve: dados do contato e a última mensagem. */
  function enriquecerLead(lead) {
    const contato = contatos.get(lead.contato_id);
    const daConversa = mensagens
      .filter((mensagem) => mensagem.conversa_id === lead.conversa_id)
      .map((mensagem) => mensagem.criado_em)
      .sort();

    return {
      ...lead,
      nome: contato?.nome ?? null,
      telefone: contato?.telefone ?? null,
      ultima_msg_em: daConversa.at(-1) ?? null,
    };
  }

  const proximoId = {
    contato: 1, conversa: 1, mensagem: 1, nota: 1,
    lead: 1, usuario: 1, etiqueta: 1, sessao: 1, recuperacao: 1, leadEvento: 1,
    profissional: 1, disponibilidade: 1, bloqueio: 1, agendamento: 1, lembrete: 1,
    serenaPrompt: 1, serenaRegra: 1, tarefa: 1, formulario: 1, automacaoOutbox: 1,
  };

  /** Espelha o que o PostgreSQL devolve nas junções da fila de lembretes. */
  function enriquecerLembrete(lembrete) {
    if (!lembrete) return null;
    const agendamento = agendamentos.find((item) => item.id === lembrete.agendamento_id);
    const contato = contatos.get(lembrete.contato_id);

    return {
      ...lembrete,
      agendamento: agendamento
        ? {
          id: agendamento.id,
          status: agendamento.status,
          inicio: agendamento.inicio,
          fim: agendamento.fim,
          contato_id: agendamento.contato_id,
        }
        : null,
      contato: contato
        ? {
          id: contato.id,
          nome: contato.nome,
          telefone: contato.telefone,
          lembretes_optout: contato.lembretes_optout === true,
        }
        : null,
    };
  }

  // Espelha o que o PostgreSQL devolve: o hash da senha e o segredo do segundo
  // fator só saem pelas consultas que os pedem explicitamente.
  function semSegredos(usuario) {
    const {
      senha_hash: _senha,
      totp_segredo_cifrado: _totp,
      // Documentos cifrados e o hash de busca tampouco saem nas leituras comuns:
      // decifrar é decisão explícita, auditada e restrita a admin (P1-05).
      cpf_cifrado: _cpf, cpf_busca_hash: _cpfHash, rg_cifrado: _rg,
      ...resto
    } = usuario;
    return resto;
  }

  for (const etiqueta of ETIQUETAS_INICIAIS) {
    etiquetas.set(etiqueta.nome, { id: proximoId.etiqueta++, ativa: true, ...etiqueta });
  }

  function montarConversa(conversa) {
    if (!conversa) return null;
    const contato = contatos.get(conversa.contato_id);
    const lead = [...leads.values()].find((registro) => registro.contato_id === conversa.contato_id);
    const daConversa = mensagens.filter((mensagem) => mensagem.conversa_id === conversa.id && !mensagem.privada);
    const responsavel = conversa.atribuido_a ? usuarios.get(conversa.atribuido_a) : null;

    return {
      ...conversa,
      responsavel_nome: responsavel?.nome ?? null,
      previa: daConversa.at(-1)?.conteudo ?? null,
      lead_id: lead?.id ?? null,
      temperatura: lead?.temperatura ?? null,
      estagio: lead?.estagio ?? null,
      score: lead?.score ?? null,
      // Só os campos que a lista usa para calcular a próxima ação.
      interesse: lead?.interesse ?? null,
      primeira_consulta: lead?.primeira_consulta ?? null,
      pagamento: lead?.pagamento ?? null,
      urgencia: lead?.urgencia ?? null,
      disponibilidade: lead?.disponibilidade ?? null,
      perdido_motivo: lead?.perdido_motivo ?? null,
      etiquetas: [...(etiquetasDaConversa.get(conversa.id) ?? [])].sort(),
      contato: {
        id: contato.id,
        nome: contato.nome,
        telefone: contato.telefone,
        email: contato.email,
        identificador: contato.identificador,
      },
    };
  }

  const repositorio = {
    tipo: 'memoria',

    /**
     * Mesma interface do PostgreSQL, sem transação nem identidade no banco.
     *
     * Aqui não há policy para ler `app.usuario_id`, e um Map não tem rollback.
     * Fingir uma transação — copiando os Maps e restaurando em caso de erro —
     * daria a impressão de que os testes cobrem atomicidade, e eles não cobrem:
     * o que garante isso é o PostgreSQL. O contrato existe para as rotas
     * poderem chamar `comUsuario` sem saber quem está por trás.
     */
    async comUsuario(usuarioId, acao) {
      return acao(repositorio);
    },

    /** Sem banco não há papel a declarar; a resposta diz isso em vez de fingir. */
    async consultarSaudeDaConexao() {
      return { rows: [{ usuario: 'memoria', papel: 'memoria' }] };
    },

    async verificarSaude() {
      return { estado: 'operacional' };
    },

    /**
     * Espelha `repositorio.js`: mesma regra de frescor (até 90s operacional,
     * até 5min degradado, acima disso indisponível), lida do mapa em memória
     * em vez da tabela `system_heartbeats`. Componente nunca semeado fica de
     * fora do mapa — o chamador assume "indisponível", igual ao banco real
     * sem linha nenhuma.
     */
    async lerBatimentos() {
      const mapa = {};
      for (const [componente, { status, atualizadoEm }] of batimentosDoSistema) {
        const idade = (agora().getTime() - new Date(atualizadoEm).getTime()) / 1000;
        let estado;
        if (status && status !== 'ok') estado = 'degradado';
        else if (idade < 90) estado = 'operacional';
        else if (idade < 300) estado = 'degradado';
        else estado = 'indisponivel';
        mapa[componente] = estado;
      }
      return mapa;
    },

    /**
     * Grava (upsert) o batimento de um componente, com detalhe livre em jsonb
     * no banco real — aqui, o objeto tal como veio. É como o worker da outbox
     * publica versão, última execução e contagem da fila (ver
     * `bin/worker-outbox.js`), no mesmo mecanismo que `bin/worker-heartbeat.js`
     * já usa para `system_heartbeats`.
     */
    async registrarBatimentoDoSistema(componente, { status = 'ok', detalhe = null } = {}) {
      batimentosDoSistema.set(componente, { status, detalhe, atualizadoEm: agora().toISOString() });
    },

    /** Leitura de um único componente, detalhe incluso — para telas e testes. */
    async obterBatimentoDoSistema(componente) {
      const registro = batimentosDoSistema.get(componente);
      if (!registro) return null;
      return { componente, status: registro.status, detalhe: registro.detalhe ?? null, atualizado_em: registro.atualizadoEm };
    },

    // ---------------------------------------------------------------- conversas

    async listarConversas({
      status = null, busca = null, contatoId = null, limite = 50,
      dataInicio = null, dataFim = null, ordenacao = 'desc',
    } = {}) {
      let lista = [...conversas.values()];

      if (status) lista = lista.filter((conversa) => conversa.status === status);
      if (contatoId) lista = lista.filter((conversa) => conversa.contato_id === Number(contatoId));
      if (busca) {
        const termo = busca.toLowerCase();
        lista = lista.filter((conversa) => {
          const contato = contatos.get(conversa.contato_id);
          return (contato.nome || '').toLowerCase().includes(termo)
            || (contato.telefone || '').includes(busca);
        });
      }
      if (dataInicio) {
        const limite = new Date(dataInicio).getTime();
        lista = lista.filter((conversa) => (
          conversa.ultima_msg_em && new Date(conversa.ultima_msg_em).getTime() >= limite
        ));
      }
      if (dataFim) {
        const limite = new Date(dataFim).getTime();
        lista = lista.filter((conversa) => (
          conversa.ultima_msg_em && new Date(conversa.ultima_msg_em).getTime() <= limite
        ));
      }

      // O mesmo sinal governa o desempate por data e por id, para casar com
      // `ORDER BY ultima_msg_em ${direcao}, id ${direcao}` do repositório real.
      // Datas ausentes vão sempre por último, nas duas direções — é o que
      // `NULLS LAST` faz lá no SQL.
      const sinal = ordenacao === 'asc' ? 1 : -1;
      return lista
        .sort((a, b) => {
          const tempoA = a.ultima_msg_em ? new Date(a.ultima_msg_em).getTime() : null;
          const tempoB = b.ultima_msg_em ? new Date(b.ultima_msg_em).getTime() : null;
          if (tempoA === null || tempoB === null) {
            if (tempoA === null && tempoB === null) return (a.id - b.id) * sinal;
            return tempoA === null ? 1 : -1;
          }
          return (tempoA - tempoB) * sinal || (a.id - b.id) * sinal;
        })
        .slice(0, limite)
        .map(montarConversa);
    },

    async obterConversa(id) {
      return montarConversa(conversas.get(Number(id)));
    },

    async atualizarConversa(id, campos) {
      const conversa = conversas.get(Number(id));
      if (!conversa) return null;

      const permitidos = ['status', 'prioridade', 'atribuido_a', 'assumida_por_humano', 'ia_pausada_ate'];
      for (const [campo, valor] of Object.entries(campos)) {
        if (permitidos.includes(campo)) conversa[campo] = valor;
      }
      conversa.atualizado_em = agora().toISOString();
      return montarConversa(conversa);
    },

    // Migration 038/Bug B — paridade com repositorio.js. Ver os comentários lá.
    async assumirConversaSeNecessario(id, { usuarioId = null, pausaAte = null } = {}) {
      const conversa = conversas.get(Number(id));
      if (!conversa) return null;
      const jaEraDestaPessoa = conversa.assumida_por_humano === true && conversa.atribuido_a === usuarioId;
      if (jaEraDestaPessoa) return null;

      conversa.assumida_por_humano = true;
      conversa.atribuido_a = usuarioId;
      conversa.ia_pausada_ate = pausaAte;
      conversa.status = 'aberta';
      conversa.atualizado_em = agora().toISOString();
      return montarConversa(conversa);
    },

    async liberarConversaSeNecessario(id) {
      const conversa = conversas.get(Number(id));
      if (!conversa) return null;
      if (conversa.assumida_por_humano !== true) return null;

      conversa.assumida_por_humano = false;
      conversa.atribuido_a = null;
      conversa.ia_pausada_ate = null;
      conversa.atualizado_em = agora().toISOString();
      return montarConversa(conversa);
    },

    // Paridade com repositorio.js — ver os comentários lá.
    async definirStatusSeNecessario(id, status) {
      const conversa = conversas.get(Number(id));
      if (!conversa) return null;
      if (conversa.status === status) return null;

      conversa.status = status;
      conversa.atualizado_em = agora().toISOString();
      return montarConversa(conversa);
    },

    // ---------------------------------------------------------------- mensagens

    async listarMensagens(conversaId, { incluirPrivadas = true } = {}) {
      return mensagens
        .filter((mensagem) => mensagem.conversa_id === Number(conversaId))
        .filter((mensagem) => incluirPrivadas || !mensagem.privada)
        .sort((a, b) => new Date(a.criado_em) - new Date(b.criado_em) || a.id - b.id);
    },

    async registrarMensagem(conversaId, dados) {
      if (dados.id_externo) {
        const existente = mensagens.find((mensagem) => mensagem.id_externo === dados.id_externo);
        if (existente) return { mensagem: existente, duplicada: true };
      }

      const mensagem = {
        id: proximoId.mensagem++,
        conversa_id: Number(conversaId),
        direcao: dados.direcao,
        tipo: dados.tipo || 'texto',
        conteudo: dados.conteudo ?? null,
        media_url: dados.media_url ?? null,
        autor_tipo: dados.autor_tipo || 'contato',
        autor_nome: dados.autor_nome ?? null,
        privada: Boolean(dados.privada),
        id_externo: dados.id_externo ?? null,
        criado_em: agora().toISOString(),
        // Comando 7, achado A-3: toda mensagem nasce como entregue até prova
        // em contrário — a barreira final marca o oposto quando bloqueia.
        entrega_falhou: false,
        entrega_falhou_motivo: null,
        // Migration 038 — paridade com repositorio.js.
        entregue_em: null,
        entrega_indeterminada: false,
      };
      mensagens.push(mensagem);

      const conversa = conversas.get(Number(conversaId));
      if (conversa && !mensagem.privada) {
        conversa.ultima_msg_em = mensagem.criado_em;
        // Espelha o SLA do PostgreSQL: entrada abre a espera (preservando o
        // início), saída visível encerra.
        if (mensagem.direcao === 'entrada') {
          conversa.aguardando_resposta_desde = conversa.aguardando_resposta_desde ?? mensagem.criado_em;
        } else {
          conversa.aguardando_resposta_desde = null;
        }
      }

      return { mensagem, duplicada: false };
    },

    /**
     * Marca que uma entrega específica (desta mensagem já gravada) não
     * aconteceu — Comando 7, achado A-3. Não mexe no conteúdo: a resposta
     * que a automação gerou continua visível, só a marca de entrega muda.
     */
    async marcarEntregaFalhou(mensagemId, motivo) {
      const mensagem = mensagens.find((item) => item.id === Number(mensagemId));
      if (!mensagem) return null;
      mensagem.entrega_falhou = true;
      mensagem.entrega_falhou_motivo = motivo ?? null;
      return { ...mensagem };
    },

    // Migration 038 — paridade com repositorio.js. Ver os comentários lá.
    async marcarEntregaConfirmada(mensagemId) {
      const mensagem = mensagens.find((item) => item.id === Number(mensagemId));
      if (!mensagem) return null;
      mensagem.entregue_em = agora().toISOString();
      return { ...mensagem };
    },

    async marcarEntregaIndeterminada(mensagemId, motivo) {
      const mensagem = mensagens.find((item) => item.id === Number(mensagemId));
      if (!mensagem) return null;
      mensagem.entrega_indeterminada = true;
      mensagem.entrega_falhou_motivo = motivo ?? null;
      return { ...mensagem };
    },

    // ---------------------------------------------------------------- contatos

    async obterContato(id) {
      return contatos.get(Number(id)) ?? null;
    },

    /**
     * Busca por nome ou telefone, para escolher o paciente ao marcar.
     *
     * O termo é comparado contra o telefone só pelos dígitos: quem atende digita
     * "(11) 99999" olhando para a tela do paciente, e isso precisa achar o mesmo
     * contato que "11999990000" acha.
     */
    async buscarContatos({ termo, limite = 10 }) {
      const alvo = String(termo ?? '').trim().toLowerCase();
      if (!alvo) return [];

      const digitos = alvo.replace(/\D/g, '');
      return [...contatos.values()]
        .filter((contato) => !contato.excluido_em)
        .filter((contato) => {
          const nome = (contato.nome ?? '').toLowerCase();
          const telefone = (contato.telefone ?? '').replace(/\D/g, '');
          return nome.includes(alvo) || (digitos.length >= 3 && telefone.includes(digitos));
        })
        .sort((a, b) => (a.nome ?? '').localeCompare(b.nome ?? '', 'pt-BR'))
        .slice(0, Number(limite))
        .map((contato) => ({
          id: contato.id,
          nome: contato.nome,
          telefone: contato.telefone,
        }));
    },

    async atualizarContato(id, campos) {
      const contato = contatos.get(Number(id));
      if (!contato) return null;

      // Mesmo mapa do PostgreSQL: documentos chegam cifrados/hash, nunca abertos.
      const permitidos = new Map([
        ['nome', 'nome'], ['telefone', 'telefone'], ['email', 'email'],
        ['identificador', 'identificador'], ['observacoes', 'observacoes'],
        ['atributos', 'atributos'],
        ['nomeCompleto', 'nome_completo'], ['nascimento', 'nascimento'],
        ['cpfCifrado', 'cpf_cifrado'], ['cpfBuscaHash', 'cpf_busca_hash'],
        ['rgCifrado', 'rg_cifrado'],
        ['whatsappDdi', 'whatsapp_ddi'], ['whatsappDdd', 'whatsapp_ddd'],
        ['whatsappNumero', 'whatsapp_numero'],
        ['responsavelNome', 'responsavel_nome'],
        ['responsavelCpfCifrado', 'responsavel_cpf_cifrado'],
        ['responsavelParentesco', 'responsavel_parentesco'],
        ['consentimentoResponsavelEm', 'consentimento_responsavel_em'],
        ['consentimentoCanal', 'consentimento_canal'],
        ['consentimentoTermoId', 'consentimento_termo_id'],
      ]);
      for (const [campo, valor] of Object.entries(campos)) {
        const coluna = permitidos.get(campo);
        if (coluna) contato[coluna] = valor;
      }
      return contato;
    },

    /**
     * Documentos cifrados do contato, separados da ficha pública de propósito.
     * Quem chama (deduplicação, consentimento do responsável) precisa comparar
     * hashes ou decifrar — e isso nunca acontece pela rota comum de leitura.
     */
    async obterDocumentosDoContato(id) {
      const contato = contatos.get(Number(id));
      if (!contato) return null;
      return {
        cpfCifrado: contato.cpf_cifrado ?? null,
        cpfBuscaHash: contato.cpf_busca_hash ?? null,
        rgCifrado: contato.rg_cifrado ?? null,
        responsavelCpfCifrado: contato.responsavel_cpf_cifrado ?? null,
      };
    },

    /**
     * Lista para a tela de gestão. Excluídos ficam de fora por padrão; a própria
     * tela pede os excluídos quando quer oferecer a restauração.
     */
    async listarContatos({ termo = null, incluirExcluidos = false, limite = 100 } = {}) {
      const alvo = String(termo ?? '').trim().toLowerCase();
      const digitos = alvo.replace(/\D/g, '');

      return [...contatos.values()]
        .filter((contato) => incluirExcluidos || !contato.excluido_em)
        .filter((contato) => {
          if (!alvo) return true;
          const nome = (contato.nome ?? '').toLowerCase();
          const telefone = (contato.telefone ?? '').replace(/\D/g, '');
          return nome.includes(alvo) || (digitos.length >= 3 && telefone.includes(digitos));
        })
        .sort((a, b) => Number(Boolean(a.excluido_em)) - Number(Boolean(b.excluido_em))
          || (a.nome ?? '').localeCompare(b.nome ?? '', 'pt-BR'))
        .slice(0, Number(limite))
        .map((contato) => ({
          ...contato,
          conversas: [...conversas.values()].filter((c) => c.contato_id === contato.id).length,
          agendamentos: agendamentos.filter((a) => a.contato_id === contato.id).length,
        }));
    },

    /** O contato de um telefone, mesmo excluído — é como o duplicado é impedido. */
    async obterContatoPorTelefone(telefone) {
      if (!telefone) return null;
      return [...contatos.values()].find((contato) => contato.telefone === telefone) ?? null;
    },

    async criarContato({ nome, telefone, email = null, identificador = null, origem = 'manual', observacoes = null }) {
      if (telefone && [...contatos.values()].some((contato) => contato.telefone === telefone)) {
        const erro = new Error('duplicate key value violates unique constraint');
        erro.code = '23505';
        erro.constraint = 'contatos_telefone_uk';
        throw erro;
      }

      const contato = {
        id: proximoId.contato++,
        nome,
        telefone,
        email,
        identificador,
        origem,
        atributos: {},
        observacoes,
        lembretes_optout: false,
        lembretes_optout_em: null,
        lembretes_optout_motivo: null,
        excluido_em: null,
        excluido_por: null,
        excluido_motivo: null,
        criado_em: agora().toISOString(),
      };
      contatos.set(contato.id, contato);
      return contato;
    },

    /** Soft delete: o contato sai das listas, o histórico fica de pé. */
    async excluirContato(id, { motivo = null, usuarioId = null } = {}) {
      const contato = contatos.get(Number(id));
      if (!contato || contato.excluido_em) return null;

      contato.excluido_em = agora().toISOString();
      contato.excluido_por = usuarioId;
      contato.excluido_motivo = motivo;
      return contato;
    },

    async restaurarContato(id) {
      const contato = contatos.get(Number(id));
      if (!contato || !contato.excluido_em) return null;

      contato.excluido_em = null;
      contato.excluido_por = null;
      contato.excluido_motivo = null;
      return contato;
    },

    async encontrarOuCriarContato({ telefone, nome = null, canal = 'whatsapp', identificador = null }) {
      const existente = [...contatos.values()].find((contato) => contato.telefone === telefone);
      if (existente) {
        if (!existente.nome && nome) existente.nome = nome;
        // Excluído que volta a escrever é reativado, não duplicado.
        existente.excluido_em = null;
        existente.excluido_por = null;
        existente.excluido_motivo = null;
        return existente;
      }

      const contato = {
        id: proximoId.contato++,
        nome,
        telefone,
        email: null,
        identificador,
        origem: canal,
        atributos: {},
        observacoes: null,
        lembretes_optout: false,
        lembretes_optout_em: null,
        lembretes_optout_motivo: null,
        excluido_em: null,
        excluido_por: null,
        excluido_motivo: null,
        criado_em: agora().toISOString(),
      };
      contatos.set(contato.id, contato);
      return contato;
    },

    /** Fora de `atualizarContato` pelo mesmo motivo do PostgreSQL: não é campo de ficha. */
    async definirOptOutDeLembretes(id, { optout = true, motivo = null, agora: instante = null }) {
      const contato = contatos.get(Number(id));
      if (!contato) return null;

      contato.lembretes_optout = optout === true;
      contato.lembretes_optout_em = optout ? (instante ?? agora().toISOString()) : null;
      contato.lembretes_optout_motivo = optout ? motivo : null;
      return contato;
    },

    async encontrarOuCriarConversaAberta(contatoId, canal = 'whatsapp') {
      const aberta = [...conversas.values()]
        .filter((conversa) => conversa.contato_id === Number(contatoId) && conversa.status !== 'resolvida')
        .sort((a, b) => b.id - a.id)[0];
      if (aberta) return montarConversa(aberta);

      const conversa = {
        id: proximoId.conversa++,
        contato_id: Number(contatoId),
        canal,
        status: 'aberta',
        prioridade: null,
        atribuido_a: null,
        assumida_por_humano: false,
        ia_pausada_ate: null,
        ultima_msg_em: null,
        aguardando_resposta_desde: null,
        resumo_interno: null,
        resumo_interno_em: null,
        criado_em: agora().toISOString(),
      };
      conversas.set(conversa.id, conversa);
      etiquetasDaConversa.set(conversa.id, new Set());
      return montarConversa(conversa);
    },

    // ---------------------------------------------------------------- etiquetas

    async listarEtiquetas() {
      return [...etiquetas.values()].sort((a, b) => a.nome.localeCompare(b.nome));
    },

    async listarEtiquetasDaConversa(conversaId) {
      return [...(etiquetasDaConversa.get(Number(conversaId)) ?? [])].sort();
    },

    async definirEtiquetasDaConversa(conversaId, nomes) {
      // Nome desconhecido é ignorado: não se cria etiqueta por digitação errada.
      const validas = nomes.filter((nome) => etiquetas.has(nome));
      etiquetasDaConversa.set(Number(conversaId), new Set(validas));
      return validas.sort();
    },

    // ---------------------------------------------------------------- notas

    async listarNotas(contatoId) {
      return notas
        .filter((nota) => nota.contato_id === Number(contatoId))
        .sort((a, b) => new Date(b.criado_em) - new Date(a.criado_em));
    },

    async criarNota(contatoId, texto, usuarioId = null) {
      const nota = {
        id: proximoId.nota++,
        contato_id: Number(contatoId),
        texto,
        usuario_id: usuarioId,
        autor: usuarioId ? usuarios.get(usuarioId)?.nome ?? null : null,
        criado_em: agora().toISOString(),
      };
      notas.push(nota);
      return nota;
    },

    // ---------------------------------------------------------------- leads

    async listarLeads() {
      return [...leads.values()]
        .map(enriquecerLead)
        // Score maior primeiro: é quem a equipe deve olhar antes.
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0)
          || new Date(b.atualizado_em) - new Date(a.atualizado_em));
    },

    async obterLead(id) {
      const lead = leads.get(Number(id));
      return lead ? enriquecerLead(lead) : null;
    },

    async obterLeadPorContato(contatoId) {
      const lead = [...leads.values()].find((item) => item.contato_id === Number(contatoId));
      return lead ? enriquecerLead(lead) : null;
    },

    async atualizarLead(id, campos) {
      const lead = leads.get(Number(id));
      if (!lead) return null;

      const permitidos = new Map([
        ['interesse', 'interesse'], ['especialidade', 'especialidade'],
        ['primeira_consulta', 'primeira_consulta'], ['pagamento', 'pagamento'],
        ['convenio_nome', 'convenio_nome'], ['urgencia', 'urgencia'],
        ['disponibilidade', 'disponibilidade'], ['origem_detalhe', 'origem_detalhe'],
        ['utm_source', 'utm_source'], ['utm_medium', 'utm_medium'],
        ['utm_campaign', 'utm_campaign'], ['utm_term', 'utm_term'], ['utm_content', 'utm_content'],
        ['estagio', 'estagio'], ['temperatura', 'temperatura'],
        ['temperaturaManual', 'temperatura_manual'], ['score', 'score'],
        ['scoreMotivos', 'score_motivos'], ['scoreCalculadoEm', 'score_calculado_em'],
        ['qualificadoEm', 'qualificado_em'], ['perdidoMotivo', 'perdido_motivo'],
        ['proximoPasso', 'proximo_passo'], ['conversaId', 'conversa_id'],
        ['proprietarioId', 'proprietario_id'], ['proximoPassoEm', 'proximo_passo_em'],
        ['estagioDesde', 'estagio_desde'],
      ]);

      for (const [campo, valor] of Object.entries(campos)) {
        const coluna = permitidos.get(campo);
        if (coluna) lead[coluna] = valor;
      }
      lead.atualizado_em = agora().toISOString();
      return enriquecerLead(lead);
    },

    // ---------------------------------------------------------------- jornada

    async registrarEventoDeLead(evento) {
      const registro = {
        id: proximoId.leadEvento++,
        lead_id: Number(evento.lead_id),
        conversa_id: evento.conversa_id ? Number(evento.conversa_id) : null,
        tipo: evento.tipo,
        de: evento.de ?? null,
        para: evento.para ?? null,
        detalhe: evento.detalhe ?? null,
        origem: evento.origem ?? 'sistema',
        usuario_id: evento.usuario_id ?? null,
        usuario_nome: evento.usuario_id ? usuarios.get(evento.usuario_id)?.nome ?? null : null,
        criado_em: agora().toISOString(),
      };
      leadEventos.push(registro);
      return registro;
    },

    async listarEventosDoLead(leadId, { tipo = null, limite = 100 } = {}) {
      return leadEventos
        .filter((evento) => evento.lead_id === Number(leadId))
        .filter((evento) => !tipo || evento.tipo === tipo)
        .sort((a, b) => new Date(b.criado_em) - new Date(a.criado_em) || b.id - a.id)
        .slice(0, limite);
    },

    async salvarLead(contatoId, { conversaId = null, temperatura = null, estagio = null, origem = null } = {}) {
      const existente = [...leads.values()].find((lead) => lead.contato_id === Number(contatoId));

      if (existente) {
        if (conversaId) existente.conversa_id = Number(conversaId);
        // Temperatura fixada pela equipe não é sobrescrita pela sincronização.
        if (temperatura && !existente.temperatura_manual) existente.temperatura = temperatura;
        if (estagio) existente.estagio = estagio;
        existente.atualizado_em = agora().toISOString();
        return enriquecerLead(existente);
      }

      const lead = {
        id: proximoId.lead++,
        contato_id: Number(contatoId),
        conversa_id: conversaId ? Number(conversaId) : null,
        temperatura: temperatura || 'frio',
        temperatura_manual: false,
        estagio: estagio || 'novo',
        origem: origem || 'WHATSAPP',
        proximo_passo: null,
        // Campos de qualificação começam vazios: `null` é "não perguntado",
        // que é diferente de "respondeu que não".
        interesse: null,
        especialidade: null,
        primeira_consulta: null,
        pagamento: null,
        convenio_nome: null,
        urgencia: null,
        disponibilidade: null,
        origem_detalhe: null,
        utm_source: null,
        utm_medium: null,
        utm_campaign: null,
        utm_term: null,
        utm_content: null,
        score: 0,
        score_motivos: [],
        score_calculado_em: null,
        qualificado_em: null,
        perdido_motivo: null,
        proprietario_id: null,
        proximo_passo_em: null,
        estagio_desde: agora().toISOString(),
        // ATENÇÃO: `leads` NÃO tem `criado_em` no esquema real. O espelho já
        // expôs essa coluna fantasma uma vez, a suíte passou nela, e a view da
        // migration 026 quebrou em produção. O nascimento do lead vem da
        // jornada (lead_eventos) — como no banco de verdade.
        atualizado_em: agora().toISOString(),
      };
      leads.set(lead.id, lead);
      return enriquecerLead(lead);
    },

    /** Leads sem atividade há N dias — espelha a consulta do sino. */
    async listarLeadsInativos({ dias = 15, limite = 200 } = {}) {
      const limite_instante = agora().getTime() - dias * 24 * 3_600_000;
      return [...leads.values()]
        .filter((lead) => !['convertido', 'perdido'].includes(lead.estagio))
        .filter((lead) => !contatos.get(lead.contato_id)?.excluido_em)
        .map(enriquecerLead)
        .filter((lead) => new Date(lead.ultima_msg_em ?? lead.atualizado_em).getTime() < limite_instante)
        .sort((a, b) => new Date(a.atualizado_em) - new Date(b.atualizado_em))
        .slice(0, limite);
    },

    // ---------------------------------------------------------------- tarefas (sino)

    async criarTarefa({ chave, tipo, titulo, detalhe = null, leadId = null, conversaId = null, contatoId = null, devidaEm = null }) {
      const existente = tarefas.find((tarefa) => tarefa.chave === chave);
      if (existente) return { tarefa: { ...existente }, duplicada: true };

      const tarefa = {
        id: proximoId.tarefa++,
        chave,
        tipo,
        titulo,
        detalhe,
        lead_id: leadId ? Number(leadId) : null,
        conversa_id: conversaId ? Number(conversaId) : null,
        contato_id: contatoId ? Number(contatoId) : null,
        devida_em: devidaEm ?? agora().toISOString(),
        criado_em: agora().toISOString(),
        concluida_em: null,
        concluida_por: null,
      };
      tarefas.push(tarefa);
      return { tarefa: { ...tarefa }, duplicada: false };
    },

    async listarTarefas({ abertas = true, limite = 100 } = {}) {
      return tarefas
        .filter((tarefa) => !abertas || !tarefa.concluida_em)
        .sort((a, b) => new Date(a.devida_em) - new Date(b.devida_em) || a.id - b.id)
        .slice(0, limite)
        .map((tarefa) => ({
          ...tarefa,
          contato_nome: tarefa.contato_id ? contatos.get(tarefa.contato_id)?.nome ?? null : null,
        }));
    },

    async concluirTarefa(id, { usuarioId = null } = {}) {
      const tarefa = tarefas.find((item) => item.id === Number(id) && !item.concluida_em);
      if (!tarefa) return null;
      tarefa.concluida_em = agora().toISOString();
      tarefa.concluida_por = usuarioId;
      return { ...tarefa };
    },

    // ---------------------------------------------------------------- SLA

    async listarConversasAguardando({ limite = 100 } = {}) {
      return [...conversas.values()]
        .filter((conversa) => conversa.aguardando_resposta_desde && conversa.status !== 'resolvida')
        .sort((a, b) => new Date(a.aguardando_resposta_desde) - new Date(b.aguardando_resposta_desde))
        .slice(0, limite)
        .map((conversa) => ({
          ...montarConversa(conversa),
          contato_nome: contatos.get(conversa.contato_id)?.nome ?? null,
          contato_telefone: contatos.get(conversa.contato_id)?.telefone ?? null,
        }));
    },

    // ------------------------------------------------------ resumo interno

    async definirResumoInterno(conversaId, texto) {
      const conversa = conversas.get(Number(conversaId));
      if (!conversa) return null;
      conversa.resumo_interno = texto;
      conversa.resumo_interno_em = agora().toISOString();
      return { id: conversa.id, resumo_interno: texto, resumo_interno_em: conversa.resumo_interno_em };
    },

    // ------------------------------------------- formulário de pré-consulta

    async criarFormularioPreConsulta({ agendamentoId, contatoId, token }) {
      const existente = formularios.find((formulario) => formulario.agendamento_id === Number(agendamentoId));
      if (existente) return { formulario: { ...existente }, duplicado: true };

      const formulario = {
        id: proximoId.formulario++,
        agendamento_id: Number(agendamentoId),
        contato_id: Number(contatoId),
        token,
        enviado_em: null,
        respondido_em: null,
        respostas: null,
        criado_em: agora().toISOString(),
      };
      formularios.push(formulario);
      return { formulario: { ...formulario }, duplicado: false };
    },

    async obterFormularioPorAgendamento(agendamentoId) {
      const formulario = formularios.find((item) => item.agendamento_id === Number(agendamentoId));
      return formulario ? { ...formulario } : null;
    },

    async marcarFormularioEnviado(id) {
      const formulario = formularios.find((item) => item.id === Number(id));
      if (!formulario) return null;
      formulario.enviado_em = formulario.enviado_em ?? agora().toISOString();
      return { ...formulario };
    },

    async registrarRespostaDeFormulario(token, respostas) {
      const formulario = formularios.find((item) => item.token === token && !item.respondido_em);
      if (!formulario) return null;
      formulario.respondido_em = agora().toISOString();
      formulario.respostas = respostas ?? {};
      return { ...formulario };
    },

    // ---------------------------------------------------------------- IA: catálogo e telemetria

    async listarModelosDeIA({ apenasAtivos = false } = {}) {
      return iaModelos
        .filter((modelo) => !apenasAtivos || modelo.ativo)
        .map((modelo) => ({ ...modelo }))
        .sort((a, b) => a.provedor.localeCompare(b.provedor) || a.modelo.localeCompare(b.modelo));
    },

    async obterChamadaDeIA(chaveIdempotencia) {
      const chamada = iaChamadas.find((item) => item.chave_idempotencia === chaveIdempotencia);
      return chamada ? { ...chamada } : null;
    },

    async registrarChamadaDeIA({
      chaveIdempotencia, finalidade, provedor, modelo, promptVersion = null,
      latenciaMs = null, tokensEntrada = null, tokensSaida = null,
      custoEstimadoUsd = null, resposta = null, erro = null, fallbackDe = null,
    }) {
      if (iaChamadas.some((item) => item.chave_idempotencia === chaveIdempotencia)) {
        return { registrado: false };
      }
      iaChamadas.push({
        id: iaChamadas.length + 1,
        chave_idempotencia: chaveIdempotencia,
        finalidade,
        provedor,
        modelo,
        prompt_version: promptVersion,
        latencia_ms: latenciaMs,
        tokens_entrada: tokensEntrada,
        tokens_saida: tokensSaida,
        custo_estimado_usd: custoEstimadoUsd,
        resposta,
        erro,
        fallback_de: fallbackDe,
        criado_em: agora().toISOString(),
      });
      return { registrado: true };
    },

    async listarChamadasDeIA({ limite = 100 } = {}) {
      return [...iaChamadas]
        .sort((a, b) => b.id - a.id)
        .slice(0, limite)
        .map(({ resposta: _resposta, ...resto }) => ({ ...resto }));
    },

    async limparRespostasDeIA({ retencaoDias = 30 } = {}) {
      const limite = agora().getTime() - retencaoDias * 24 * 3_600_000;
      let anuladas = 0;
      for (const chamada of iaChamadas) {
        if (chamada.resposta !== null && new Date(chamada.criado_em).getTime() < limite) {
          chamada.resposta = null;
          anuladas += 1;
        }
      }
      return { anuladas };
    },

    // ---------------------------------------------------------------- IA: avaliações

    async registrarAvaliacaoDeIA({
      conversaId = null, mensagemId, avaliador, empatia, seguranca, aderencia, veredito, motivos = [],
    }) {
      const existente = iaAvaliacoes.find(
        (item) => item.mensagem_id === Number(mensagemId) && item.avaliador === avaliador,
      );
      if (existente) return { avaliacao: { ...existente }, duplicada: true };

      const avaliacao = {
        id: iaAvaliacoes.length + 1,
        conversa_id: conversaId ? Number(conversaId) : null,
        mensagem_id: Number(mensagemId),
        avaliador,
        empatia,
        seguranca,
        aderencia,
        veredito,
        motivos,
        criado_em: agora().toISOString(),
      };
      iaAvaliacoes.push(avaliacao);
      return { avaliacao: { ...avaliacao }, duplicada: false };
    },

    async listarAvaliacoesDeIA({ veredito = null, limite = 100 } = {}) {
      return iaAvaliacoes
        .filter((item) => !veredito || item.veredito === veredito)
        .sort((a, b) => b.id - a.id)
        .slice(0, limite)
        .map((item) => ({ ...item }));
    },

    async listarRespostasSemAvaliacao({ avaliador = 'heuristica', limite = 50 } = {}) {
      const avaliadas = new Set(iaAvaliacoes
        .filter((item) => item.avaliador === avaliador)
        .map((item) => item.mensagem_id));
      return mensagens
        .filter((mensagem) => mensagem.autor_tipo === 'automacao' && mensagem.direcao === 'saida')
        .filter((mensagem) => !avaliadas.has(mensagem.id))
        .sort((a, b) => b.id - a.id)
        .slice(0, limite)
        .map((mensagem) => ({ ...mensagem }));
    },

    // ---------------------------------------------------------------- notificações

    async criarNotificacao({ chave, tipo, titulo, corpo = null, usuarioId = null }) {
      const existente = notificacoes.find((item) => item.chave === chave);
      if (existente) return { notificacao: { ...existente }, duplicada: true };

      const notificacao = {
        id: notificacoes.length + 1,
        chave,
        tipo,
        titulo,
        corpo,
        usuario_id: usuarioId,
        lida_em: null,
        criado_em: agora().toISOString(),
      };
      notificacoes.push(notificacao);
      return { notificacao: { ...notificacao }, duplicada: false };
    },

    async listarNotificacoes({ usuarioId = null, apenasNaoLidas = true, limite = 50 } = {}) {
      return notificacoes
        .filter((item) => item.usuario_id === null || item.usuario_id === usuarioId)
        .filter((item) => !apenasNaoLidas || !item.lida_em)
        .sort((a, b) => b.id - a.id)
        .slice(0, limite)
        .map((item) => ({ ...item }));
    },

    async marcarNotificacaoLida(id) {
      const notificacao = notificacoes.find((item) => item.id === Number(id) && !item.lida_em);
      if (!notificacao) return null;
      notificacao.lida_em = agora().toISOString();
      return { ...notificacao };
    },

    // ------------------------------------------------- Serena: ativação gradual

    async definirAtivacaoGradual({ modo, percentual = null, usuarioId = null }) {
      serenaConfiguracao.modo_ativacao = modo;
      if (percentual !== null) serenaConfiguracao.ativacao_percentual = percentual;
      serenaConfiguracao.alterado_por = usuarioId;
      serenaConfiguracao.alterado_em = agora().toISOString();
      return { ...serenaConfiguracao };
    },

    async listarContatosDeAtivacao() {
      return [...serenaAtivacaoContatos];
    },

    async definirContatoDeAtivacao(contatoId, incluido) {
      if (incluido) serenaAtivacaoContatos.add(Number(contatoId));
      else serenaAtivacaoContatos.delete(Number(contatoId));
      return { contato_id: Number(contatoId), incluido };
    },

    // ------------------------------------------------- automação: outbox durável
    //
    // Substitui o `setImmediate` como garantia de processamento. Duas operações
    // carregam as garantias inteiras — `enfileirarTrabalhoDeOutbox` (idempotência,
    // mesmo espírito de `enfileirarLembrete`) e `reivindicarTrabalhosDeOutbox`
    // (exclusão entre workers, mesmo espírito de `reivindicarLembretes`).

    /** Enfileira um trabalho. Repetir com a mesma chave não cria segunda linha. */
    async enfileirarTrabalhoDeOutbox({
      conversaId, mensagemEntradaId = null, chaveIdempotencia, maxTentativas = 5,
    }) {
      const existente = [...automacaoOutbox.values()]
        .find((trabalho) => trabalho.chave_idempotencia === chaveIdempotencia);
      if (existente) return { trabalho: { ...existente }, criado: false };

      const agoraIso = agora().toISOString();
      const trabalho = {
        id: proximoId.automacaoOutbox++,
        conversa_id: Number(conversaId),
        mensagem_entrada_id: mensagemEntradaId ? Number(mensagemEntradaId) : null,
        chave_idempotencia: chaveIdempotencia,
        status: 'pendente',
        tentativas: 0,
        max_tentativas: maxTentativas,
        disponivel_em: agoraIso,
        reivindicado_por: null,
        reivindicado_em: null,
        ultimo_erro: null,
        criado_em: agoraIso,
        atualizado_em: agoraIso,
        concluido_em: null,
      };
      automacaoOutbox.set(trabalho.id, trabalho);
      return { trabalho: { ...trabalho }, criado: true };
    },

    async obterTrabalhoDeOutbox(id) {
      const trabalho = automacaoOutbox.get(Number(id));
      return trabalho ? { ...trabalho } : null;
    },

    /**
     * Reivindica trabalhos pendentes cuja hora chegou. No banco real isto é
     * `FOR UPDATE SKIP LOCKED` numa única instrução — aqui, sem concorrência
     * real dentro do processo Node, a exclusão entre "workers" simulados nos
     * testes vem de cada chamada já marcar 'processando' antes de devolver,
     * síncrono dentro do laço: duas chamadas seguidas nunca reivindicam a
     * mesma linha, que é a garantia que importa provar.
     */
    async reivindicarTrabalhosDeOutbox({ agora: instante, limite = 20, worker = 'worker' }) {
      const candidatos = [...automacaoOutbox.values()]
        .filter((trabalho) => trabalho.status === 'pendente' && trabalho.disponivel_em <= instante)
        .sort((a, b) => new Date(a.disponivel_em) - new Date(b.disponivel_em) || a.id - b.id)
        .slice(0, Number(limite));

      for (const trabalho of candidatos) {
        trabalho.status = 'processando';
        trabalho.reivindicado_por = String(worker).slice(0, 100);
        trabalho.reivindicado_em = instante;
        trabalho.atualizado_em = instante;
      }
      return candidatos.map((trabalho) => ({ ...trabalho }));
    },

    /**
     * Renova o lease de UM trabalho específico — Comando 7, segunda
     * auditoria, achado N-9. Espelha `repositorio.js`: só grava se o
     * trabalho ainda está 'processando' e ainda é deste worker; senão,
     * devolve `null` (outro worker já retomou este trabalho).
     */
    async renovarReivindicacaoDeOutbox(id, { worker, agora: instante }) {
      const trabalho = automacaoOutbox.get(Number(id));
      if (!trabalho) return null;
      if (trabalho.status !== 'processando' || trabalho.reivindicado_por !== String(worker).slice(0, 100)) return null;
      trabalho.reivindicado_em = instante;
      trabalho.atualizado_em = instante;
      return { ...trabalho };
    },

    /** Grava o desfecho de um trabalho: concluído, de volta à fila, morto ou incerto. */
    async concluirTrabalhoDeOutbox(id, {
      status, ultimoErro = undefined, tentativas = undefined, disponivelEm = undefined,
    }) {
      const trabalho = automacaoOutbox.get(Number(id));
      if (!trabalho) return null;

      trabalho.status = status;
      if (ultimoErro !== undefined) trabalho.ultimo_erro = ultimoErro;
      if (tentativas !== undefined) trabalho.tentativas = tentativas;
      if (disponivelEm !== undefined) trabalho.disponivel_em = disponivelEm;
      // Sair de 'processando' devolve o trabalho limpo: um lease velho faria a
      // recuperação achar que ainda há alguém trabalhando nele.
      if (status !== 'processando') { trabalho.reivindicado_por = null; trabalho.reivindicado_em = null; }
      if (['concluido', 'morto', 'incerto'].includes(status)) trabalho.concluido_em = agora().toISOString();
      trabalho.atualizado_em = agora().toISOString();
      return { ...trabalho };
    },

    /**
     * Devolve à fila o que ficou preso em 'processando' — o worker que morreu
     * no meio de um envio deixa a linha reservada para sempre, sem isto.
     * Conta como tentativa, para que um trabalho que derruba o worker toda vez
     * termine em 'morto' (dead-letter) em vez de circular eterno.
     */
    async liberarTrabalhosDeOutboxPresos({ antesDe, agora: instante }) {
      const liberados = [];
      for (const trabalho of automacaoOutbox.values()) {
        if (trabalho.status !== 'processando' || !trabalho.reivindicado_em) continue;
        if (trabalho.reivindicado_em >= antesDe) continue;

        const tentativas = trabalho.tentativas + 1;
        trabalho.tentativas = tentativas;
        trabalho.status = tentativas >= trabalho.max_tentativas ? 'morto' : 'pendente';
        trabalho.disponivel_em = instante;
        trabalho.ultimo_erro = 'processamento abandonado por worker inativo';
        trabalho.reivindicado_por = null;
        trabalho.reivindicado_em = null;
        if (trabalho.status === 'morto') trabalho.concluido_em = instante;
        trabalho.atualizado_em = instante;
        liberados.push({ ...trabalho });
      }
      return liberados;
    },

    /**
     * Para o diagnóstico (achado A-1 da auditoria do Comando 7): quantos
     * trabalhos pendentes já passaram de `disponivel_em` há mais do que o
     * atraso tolerado. Espelha `repositorio.js`: mesma comparação lexicográfica
     * de ISO 8601 que `reivindicarTrabalhosDeOutbox` já usa acima.
     */
    async contarTrabalhosDeOutboxVencidos({ antesDe }) {
      let total = 0;
      for (const trabalho of automacaoOutbox.values()) {
        if (trabalho.status === 'pendente' && trabalho.disponivel_em < antesDe) total += 1;
      }
      return total;
    },

    /** Para o heartbeat do worker: quantos trabalhos em cada estado agora. */
    async contarTrabalhosDeOutboxPorEstado() {
      const total = { pendente: 0, processando: 0, concluido: 0, morto: 0, incerto: 0 };
      for (const trabalho of automacaoOutbox.values()) {
        total[trabalho.status] = (total[trabalho.status] ?? 0) + 1;
      }
      return total;
    },

    // ---------------------------------------------------------------- analítica

    async registrarEventoAnalitico({ nome, entidade = null, entidadeId = null, propriedades = null, chave = null }) {
      if (chave && eventosAnaliticos.some((evento) => evento.chave === chave)) {
        return { registrado: false };
      }
      eventosAnaliticos.push({
        id: eventosAnaliticos.length + 1,
        nome,
        entidade,
        entidade_id: entidadeId,
        propriedades,
        chave,
        ocorrido_em: agora().toISOString(),
      });
      return { registrado: true };
    },

    async metricasLeadsPorDia({ de, ate }) {
      // Espelha a vw_leads_por_dia corrigida: o dia vem do PRIMEIRO evento da
      // jornada do lead; sem evento, o fallback declarado é atualizado_em.
      const primeiroEvento = new Map();
      for (const evento of leadEventos) {
        const atual = primeiroEvento.get(evento.lead_id);
        if (!atual || evento.criado_em < atual) primeiroEvento.set(evento.lead_id, evento.criado_em);
      }

      const grupos = new Map();
      for (const lead of leads.values()) {
        if (telefoneSintetico(lead.contato_id)) continue;
        const nascimento = primeiroEvento.get(lead.id) ?? lead.atualizado_em;
        const dia = diaSp(nascimento);
        if (dia < de || dia >= ate) continue;
        const grupo = `${dia}|${lead.origem}`;
        grupos.set(grupo, (grupos.get(grupo) ?? 0) + 1);
      }
      return [...grupos.entries()]
        .map(([grupo, total]) => {
          const [dia, origem] = grupo.split('|');
          return { dia, origem, total };
        })
        .sort((a, b) => a.dia.localeCompare(b.dia) || a.origem.localeCompare(b.origem));
    },

    async metricasFunil() {
      const grupos = new Map();
      for (const lead of leads.values()) {
        if (telefoneSintetico(lead.contato_id)) continue;
        grupos.set(lead.estagio, (grupos.get(lead.estagio) ?? 0) + 1);
      }
      return [...grupos.entries()]
        .map(([estagio, total]) => ({ estagio, total }))
        .sort((a, b) => a.estagio.localeCompare(b.estagio));
    },

    async metricasMotivosPerda({ de, ate }) {
      const grupos = new Map();
      for (const evento of leadEventos) {
        if (evento.tipo !== 'estagio' || evento.para !== 'perdido') continue;
        const dia = diaSp(evento.criado_em);
        if (dia < de || dia >= ate) continue;
        const lead = leads.get(evento.lead_id);
        if (!lead || telefoneSintetico(lead.contato_id)) continue;
        const motivo = (lead.perdido_motivo ?? '').trim() || 'sem motivo registrado';
        grupos.set(motivo, (grupos.get(motivo) ?? 0) + 1);
      }
      return [...grupos.entries()]
        .map(([motivo, total]) => ({ motivo, total }))
        .sort((a, b) => b.total - a.total);
    },

    async metricasPrimeiraResposta({ de, ate }) {
      const resultado = [];
      for (const conversa of conversas.values()) {
        if (telefoneSintetico(conversa.contato_id)) continue;
        const daConversa = mensagens.filter((m) => m.conversa_id === conversa.id && !m.privada);
        const entradas = daConversa.filter((m) => m.direcao === 'entrada');
        if (entradas.length === 0) continue;

        const primeiroInbound = entradas
          .map((m) => m.criado_em).sort()[0];
        const dia = diaSp(primeiroInbound);
        if (dia < de || dia >= ate) continue;

        const resposta = daConversa
          .filter((m) => m.direcao === 'saida' && m.tipo !== 'sistema' && m.criado_em > primeiroInbound)
          .map((m) => m.criado_em).sort()[0] ?? null;

        resultado.push({
          conversa_id: conversa.id,
          dia,
          minutos: resposta
            ? (new Date(resposta) - new Date(primeiroInbound)) / 60_000
            : null,
        });
      }
      return resultado;
    },

    async metricasPicos({ de, ate }) {
      const grupos = new Map();
      for (const mensagem of mensagens) {
        if (mensagem.direcao !== 'entrada' || mensagem.privada) continue;
        const conversa = conversas.get(mensagem.conversa_id);
        if (!conversa || telefoneSintetico(conversa.contato_id)) continue;
        const dia = diaSp(mensagem.criado_em);
        if (dia < de || dia >= ate) continue;

        const { diaSemana, hora } = momentoSp(mensagem.criado_em);
        const grupo = `${diaSemana}|${hora}`;
        grupos.set(grupo, (grupos.get(grupo) ?? 0) + 1);
      }
      return [...grupos.entries()]
        .map(([grupo, entradas]) => {
          const [diaSemana, hora] = grupo.split('|').map(Number);
          return { dia_semana: diaSemana, hora, entradas };
        })
        .sort((a, b) => a.dia_semana - b.dia_semana || a.hora - b.hora);
    },

    async metricasAgenda({ de, ate }) {
      const grupos = new Map();
      for (const agendamento of agendamentos) {
        if (telefoneSintetico(agendamento.contato_id)) continue;
        const dia = diaSp(agendamento.inicio);
        if (dia < de || dia >= ate) continue;
        grupos.set(agendamento.status, (grupos.get(agendamento.status) ?? 0) + 1);
      }
      return [...grupos.entries()]
        .map(([status, total]) => ({ status, total }))
        .sort((a, b) => a.status.localeCompare(b.status));
    },

    async metricasSerena({ de, ate }) {
      const ACOES = ['assumida_por_humano', 'escalonada', 'automacao_silenciada',
        'respondida_pela_automacao', 'resposta_nao_entregue'];
      const grupos = new Map();
      for (const registro of auditoria) {
        if (registro.entidade !== 'conversa' || !ACOES.includes(registro.acao)) continue;
        const dia = diaSp(registro.criado_em);
        if (dia < de || dia >= ate) continue;
        const motivo = registro.detalhe?.motivo ?? '—';
        const grupo = `${registro.acao}|${motivo}`;
        grupos.set(grupo, (grupos.get(grupo) ?? 0) + 1);
      }
      return [...grupos.entries()]
        .map(([grupo, total]) => {
          const [acao, motivo] = grupo.split('|');
          return { acao, motivo, total };
        })
        .sort((a, b) => a.acao.localeCompare(b.acao) || b.total - a.total);
    },

    // ---------------------------------------------------------------- idempotência e auditoria

    async consultarEvento(chave) {
      return eventos.get(chave) ?? null;
    },

    async registrarEvento(chave, recibo) {
      if (eventos.has(chave)) return eventos.get(chave);
      eventos.set(chave, recibo);
      return recibo;
    },

    async registrarAuditoria(registro) {
      // Mesmo contrato do repositório real: o detalhe é redigido na entrada.
      const detalhe = registro?.detalhe ? redigirAuditoria(registro.detalhe) : registro?.detalhe ?? null;
      auditoria.push({ ...registro, detalhe, criado_em: agora().toISOString() });
    },

    async listarAuditoria({ limite = 50, antesDeId = null, entidade = null, acao = null } = {}) {
      const itens = auditoria
        .map((item, indice) => ({ ...item, id: item.id ?? indice + 1 }))
        .filter((item) => !antesDeId || item.id < antesDeId)
        .filter((item) => !entidade || item.entidade === entidade)
        .filter((item) => !acao || item.acao === acao)
        .sort((a, b) => b.id - a.id)
        .slice(0, limite);
      return { itens, proximoCursor: itens.length === limite ? itens.at(-1).id : null };
    },

    async registrarHeartbeat(componente, instancia, versao = null) {
      heartbeats.set(componente, { componente, instancia, versao, visto_em: agora().toISOString() });
    },

    async obterHeartbeat(componente) {
      return heartbeats.get(componente) ?? null;
    },

    // ---------------------------------------------------------------- usuários e sessões

    async obterUsuarioPorEmail(email) {
      if (!email) return null;
      const alvo = String(email).toLowerCase();
      const usuario = [...usuarios.values()].find((item) => (item.email || '').toLowerCase() === alvo);
      return usuario ? { ...usuario } : null;
    },

    async obterUsuarioPorId(id) {
      const usuario = usuarios.get(Number(id));
      return usuario ? semSegredos(usuario) : null;
    },

    /**
     * Documentos cifrados do usuário, fora da leitura comum de propósito:
     * decifrar exige rota própria, restrita e auditada (P1-05).
     */
    async obterDocumentosDoUsuario(id) {
      const usuario = usuarios.get(Number(id));
      if (!usuario) return null;
      return {
        cpfCifrado: usuario.cpf_cifrado ?? null,
        cpfBuscaHash: usuario.cpf_busca_hash ?? null,
        rgCifrado: usuario.rg_cifrado ?? null,
      };
    },

    async obterUsuarioPorGoogleSub(sub) {
      if (!sub) return null;
      const usuario = [...usuarios.values()].find((item) => item.google_sub === sub);
      return usuario ? semSegredos(usuario) : null;
    },

    async criarUsuario({
      nome, email, senhaHash = null, papel = 'atendente',
      situacao = 'pendente', master = false, precisaTrocarSenha = false,
      googleSub = null, telefone = null,
    }) {
      if (await this.obterUsuarioPorEmail(email)) {
        const erro = new Error('e-mail já cadastrado');
        erro.codigo = 'usuario_duplicado';
        throw erro;
      }

      const usuario = {
        id: proximoId.usuario++,
        nome,
        email,
        senha_hash: senhaHash,
        papel,
        ativo: true,
        situacao,
        master,
        precisa_trocar_senha: precisaTrocarSenha,
        telefone,
        avatar_url: null,
        google_sub: googleSub,
        totp_segredo_cifrado: null,
        totp_ativo: false,
        totp_confirmado_em: null,
        aprovado_por: null,
        aprovado_em: null,
        ultimo_login_em: null,
        // Cadastro estruturado e dados sensíveis (P1-05): nascem vazios e só
        // são preenchidos pela edição completa, que cifra antes de gravar.
        nome_completo: null,
        nascimento: null,
        cpf_cifrado: null,
        cpf_busca_hash: null,
        rg_cifrado: null,
        whatsapp_ddi: null,
        whatsapp_ddd: null,
        whatsapp_numero: null,
        whatsapp_particular_autorizado: false,
        whatsapp_particular_autorizado_em: null,
        whatsapp_particular_autorizado_por: null,
        // Exclusão lógica (P1-02): autoria histórica nunca é apagada.
        excluido_em: null,
        excluido_por: null,
        excluido_motivo: null,
        criado_em: agora().toISOString(),
      };
      usuarios.set(usuario.id, usuario);
      return semSegredos(usuario);
    },

    async atualizarUsuario(id, campos) {
      const usuario = usuarios.get(Number(id));
      if (!usuario) return null;

      const permitidos = new Map([
        ['nome', 'nome'], ['telefone', 'telefone'], ['papel', 'papel'],
        // `master` só é escrito pela semeadura do administrador: nenhuma rota HTTP
        // passa este campo, e promover a si mesmo não é um caminho existente.
        ['master', 'master'],
        ['situacao', 'situacao'], ['ativo', 'ativo'], ['senhaHash', 'senha_hash'],
        ['precisaTrocarSenha', 'precisa_trocar_senha'], ['googleSub', 'google_sub'],
        ['totpSegredoCifrado', 'totp_segredo_cifrado'], ['totpAtivo', 'totp_ativo'],
        ['totpConfirmadoEm', 'totp_confirmado_em'], ['aprovadoPor', 'aprovado_por'],
        ['aprovadoEm', 'aprovado_em'], ['ultimoLoginEm', 'ultimo_login_em'],
        ['avatarUrl', 'avatar_url'],
        // Cadastro estruturado e documentos — sempre cifrados/hash (P1-05).
        ['nomeCompleto', 'nome_completo'], ['nascimento', 'nascimento'],
        ['cpfCifrado', 'cpf_cifrado'], ['cpfBuscaHash', 'cpf_busca_hash'],
        ['rgCifrado', 'rg_cifrado'],
        ['whatsappDdi', 'whatsapp_ddi'], ['whatsappDdd', 'whatsapp_ddd'],
        ['whatsappNumero', 'whatsapp_numero'],
        ['whatsappParticularAutorizado', 'whatsapp_particular_autorizado'],
        ['whatsappParticularAutorizadoEm', 'whatsapp_particular_autorizado_em'],
        ['whatsappParticularAutorizadoPor', 'whatsapp_particular_autorizado_por'],
        // Exclusão lógica (P1-02).
        ['excluidoEm', 'excluido_em'], ['excluidoPor', 'excluido_por'],
        ['excluidoMotivo', 'excluido_motivo'],
      ]);

      for (const [campo, valor] of Object.entries(campos)) {
        const coluna = permitidos.get(campo);
        if (coluna) usuario[coluna] = valor;
      }
      return semSegredos(usuario);
    },

    async listarUsuarios({ situacao = null } = {}) {
      return [...usuarios.values()]
        .filter((usuario) => !situacao || usuario.situacao === situacao)
        .map(semSegredos)
        // Pendentes primeiro: é quem espera uma decisão do master.
        .sort((a, b) => {
          const pesoA = a.situacao === 'pendente' ? 0 : 1;
          const pesoB = b.situacao === 'pendente' ? 0 : 1;
          return pesoA - pesoB || a.nome.localeCompare(b.nome);
        });
    },

    async obterSegredoTotp(id) {
      return usuarios.get(Number(id))?.totp_segredo_cifrado ?? null;
    },

    // ---------------------------------------------------------------- recuperação de senha

    async criarRecuperacao({ usuarioId, hashToken, expiraEm, ip = null }) {
      const recuperacao = {
        id: proximoId.recuperacao++,
        usuario_id: Number(usuarioId),
        hash_token: hashToken,
        expira_em: expiraEm,
        usado_em: null,
        solicitado_ip: ip,
        criado_em: agora().toISOString(),
      };
      recuperacoes.set(recuperacao.id, recuperacao);
      return { id: recuperacao.id };
    },

    async obterRecuperacaoPorHash(hashToken) {
      const encontrada = [...recuperacoes.values()].find((item) => item.hash_token === hashToken);
      return encontrada ? { ...encontrada } : null;
    },

    async marcarRecuperacaoUsada(id) {
      const recuperacao = recuperacoes.get(Number(id));
      if (recuperacao && !recuperacao.usado_em) recuperacao.usado_em = agora().toISOString();
    },

    async invalidarRecuperacoesDoUsuario(usuarioId) {
      let total = 0;
      for (const recuperacao of recuperacoes.values()) {
        if (recuperacao.usuario_id === Number(usuarioId) && !recuperacao.usado_em) {
          recuperacao.usado_em = agora().toISOString();
          total += 1;
        }
      }
      return total;
    },

    // ------------------------------------------------- chat ao vivo durável
    // Paridade com repositorio.js — ver os comentários lá para o raciocínio.

    async registrarEventoDeConversa({ conversaId, tipo, payload = {} }) {
      const linha = {
        id: proximoIdDeEventoDeConversa,
        conversa_id: Number(conversaId),
        tipo,
        payload: payload ?? {},
        criado_em: agora().toISOString(),
      };
      proximoIdDeEventoDeConversa += 1;
      conversasEventos.push(linha);
      return { ...linha };
    },

    // Mesmo escopo do repositorio.js (BLOQUEADOR 1, auditoria PR #34):
    // `papel` é obrigatório (fail-closed) e o filtro usa a MESMA
    // `podeAcessarConversaAoVivo` que o broadcast ao vivo usa. Sem SQL aqui,
    // então não há "filtrar no WHERE" — só a passada em JS, que já é a
    // única fonte de verdade nesta implementação.
    async listarEventosDeConversasDesde({ cursor = null, limite = 500, usuarioId = null, papel } = {}) {
      if (!papel) {
        throw new Error('listarEventosDeConversasDesde exige "papel" — replay sem escopo declarado é uma falha de autorização silenciosa');
      }
      const usuarioIdNumerico = usuarioId === null || usuarioId === undefined ? null : Number(usuarioId);
      const visivel = (linha) => {
        const conversa = conversas.get(linha.conversa_id);
        // Conversa inexistente NEGA — paridade exata com o SQL de
        // repositorio.js, que usa `JOIN conversas` e por construção nunca
        // devolve evento órfão. Antes, o `null` de "não achei a conversa"
        // caía no mesmo ramo de "conversa livre" e o evento passava: a
        // mesma confusão de estados que o gate final do PR #34 provou no
        // caminho ao vivo, aqui no replay.
        if (!conversa) return false;
        const atribuidoA = conversa.atribuido_a !== null && conversa.atribuido_a !== undefined
          ? Number(conversa.atribuido_a) : null;
        return podeAcessarConversaAoVivo(papel, usuarioIdNumerico, atribuidoA);
      };

      // Filtra ANTES de limitar — mesma ordem de operações do SQL em
      // repositorio.js (o `WHERE` de autorização entra antes do `LIMIT`):
      // "os últimos N que este papel pode ver", não "dos últimos N no log
      // geral, os que este papel pode ver" (que devolveria menos que N
      // quando a conversa alheia domina a cauda do log).
      const autorizados = (cursor === null ? conversasEventos : conversasEventos.filter((linha) => linha.id > Number(cursor)))
        .filter(visivel);
      const pagina = cursor === null ? autorizados.slice(-limite) : autorizados.slice(0, limite);
      return pagina.map((linha) => ({ ...linha }));
    },

    /**
     * Paridade com repositorio.js — ver os comentários lá para os três
     * estados (existe / inexistente / erro) e por que `null` não podia mais
     * significar as duas primeiras coisas ao mesmo tempo.
     */
    async obterEscopoDaConversa(conversaId) {
      const conversa = conversas.get(Number(conversaId));
      if (!conversa) return { estado: 'inexistente' };
      return {
        estado: 'existe',
        atribuidoA: conversa.atribuido_a === null || conversa.atribuido_a === undefined
          ? null : Number(conversa.atribuido_a),
      };
    },

    // Bug B, item 2 ("chat completo") — paridade com repositorio.js. Ver os
    // comentários lá para o raciocínio de por que só estes dois tipos.
    async listarEventosOperacionaisDaConversa(conversaId) {
      const TIPOS = new Set(['conversa_devolvida', 'conversa_resolvida']);
      return conversasEventos
        .filter((linha) => linha.conversa_id === Number(conversaId) && TIPOS.has(linha.tipo))
        .map((linha) => ({ ...linha }));
    },

    async criarTicketDeEventos({ usuarioId, papel, ttlMs = 30_000 }) {
      const bruto = crypto.randomBytes(32).toString('base64url');
      conversasEventosTickets.set(bruto, {
        usuarioId: Number(usuarioId),
        papel,
        expiraEm: new Date(agora().getTime() + ttlMs),
        usadoEm: null,
      });
      return bruto;
    },

    async resgatarTicketDeEventos(bruto) {
      const ticket = conversasEventosTickets.get(bruto);
      if (!ticket) return null;
      if (ticket.usadoEm) return null;
      if (ticket.expiraEm.getTime() <= agora().getTime()) return null;
      ticket.usadoEm = agora();
      return { usuarioId: ticket.usuarioId, papel: ticket.papel };
    },

    // ---------------------------------------------------------------- agenda

    async listarProfissionais({ apenasAtivos = true } = {}) {
      return [...profissionais.values()]
        .filter((profissional) => !apenasAtivos || profissional.ativo)
        .sort((a, b) => a.nome.localeCompare(b.nome));
    },

    async obterProfissional(id) {
      return profissionais.get(Number(id)) ?? null;
    },

    async criarProfissional({ nome, especialidade = null, registro = null, cor = null, duracaoMin = 30, usuarioId = null }) {
      const profissional = {
        id: proximoId.profissional++,
        nome,
        especialidade,
        registro,
        cor: cor || '#0e8fa1',
        duracao_min: duracaoMin,
        usuario_id: usuarioId,
        ativo: true,
      };
      profissionais.set(profissional.id, profissional);
      return profissional;
    },

    async definirDisponibilidades(profissionalId, janelas) {
      for (let indice = disponibilidades.length - 1; indice >= 0; indice -= 1) {
        if (disponibilidades[indice].profissional_id === Number(profissionalId)) disponibilidades.splice(indice, 1);
      }
      for (const janela of janelas) {
        disponibilidades.push({
          id: proximoId.disponibilidade++,
          profissional_id: Number(profissionalId),
          dia_semana: janela.dia_semana,
          hora_inicio: janela.hora_inicio,
          hora_fim: janela.hora_fim,
        });
      }
      return this.listarDisponibilidades(profissionalId);
    },

    async listarDisponibilidades(profissionalId) {
      return disponibilidades
        .filter((janela) => janela.profissional_id === Number(profissionalId))
        .sort((a, b) => a.dia_semana - b.dia_semana || a.hora_inicio.localeCompare(b.hora_inicio));
    },

    async criarBloqueio({ profissionalId = null, inicio, fim, motivo = null, criadoPor = null }) {
      const bloqueio = {
        id: proximoId.bloqueio++,
        profissional_id: profissionalId ? Number(profissionalId) : null,
        inicio,
        fim,
        motivo,
        criado_por: criadoPor,
      };
      bloqueios.push(bloqueio);
      return bloqueio;
    },

    async listarBloqueios({ profissionalId = null, inicio, fim }) {
      const de = new Date(inicio).getTime();
      const ate = new Date(fim).getTime();

      return bloqueios
        .filter((bloqueio) => bloqueio.profissional_id === null
          || bloqueio.profissional_id === Number(profissionalId))
        .filter((bloqueio) => new Date(bloqueio.inicio).getTime() < ate
          && new Date(bloqueio.fim).getTime() > de)
        .sort((a, b) => new Date(a.inicio) - new Date(b.inicio));
    },

    async removerBloqueio(id) {
      const indice = bloqueios.findIndex((bloqueio) => bloqueio.id === Number(id));
      if (indice === -1) return 0;
      bloqueios.splice(indice, 1);
      return 1;
    },

    /**
     * Cria o agendamento imitando a constraint de exclusão do PostgreSQL.
     *
     * A verificação e a inserção acontecem **sem `await` entre elas**: como o
     * JavaScript é de thread única, isso as torna atômicas — o mesmo que a
     * constraint garante no banco. Sem esse cuidado, o teste de concorrência
     * passaria aqui e falharia em produção, que é o pior dos mundos.
     */
    async criarAgendamento({
      profissionalId, contatoId, leadId = null, conversaId = null,
      inicio, fim, tipo = 'consulta', observacoes = null, local = null, criadoPor = null,
    }) {
      const de = new Date(inicio).getTime();
      const ate = new Date(fim).getTime();

      const conflito = agendamentos.find((existente) => existente.profissional_id === Number(profissionalId)
        && existente.status !== 'cancelado'
        && de < new Date(existente.fim).getTime()
        && new Date(existente.inicio).getTime() < ate);

      if (conflito) {
        // Mesmos sinais do PostgreSQL, para o tratamento ser o mesmo dos dois lados.
        const erro = new Error('conflicting key value violates exclusion constraint');
        erro.code = '23P01';
        erro.constraint = 'agendamentos_sem_conflito';
        throw erro;
      }

      const agendamento = {
        id: proximoId.agendamento++,
        profissional_id: Number(profissionalId),
        contato_id: Number(contatoId),
        lead_id: leadId ? Number(leadId) : null,
        conversa_id: conversaId ? Number(conversaId) : null,
        inicio,
        fim,
        status: 'agendado',
        tipo,
        observacoes,
        local,
        confirmado_em: null,
        cancelado_em: null,
        cancelado_motivo: null,
        criado_por: criadoPor,
        // Vínculo e estado de sincronia com o Google (P0-09 a P0-12). Nasce
        // pendente: espelhar no Google é trabalho do outbox, não do request.
        google_evento_id: null,
        google_calendar_id: null,
        google_etag: null,
        sync_status: 'pendente',
        sync_version: 0,
        last_synced_at: null,
        last_sync_error: null,
        origem_alteracao: 'crm',
        criado_em: agora().toISOString(),
        atualizado_em: agora().toISOString(),
      };
      agendamentos.push(agendamento);
      return enriquecerAgendamento(agendamento);
    },

    async obterAgendamento(id) {
      const agendamento = agendamentos.find((item) => item.id === Number(id));
      return agendamento ? enriquecerAgendamento(agendamento) : null;
    },

    async listarAgendamentos({ profissionalId = null, contatoId = null, conversaId = null, inicio, fim, incluirCancelados = false } = {}) {
      let lista = [...agendamentos];

      if (profissionalId) lista = lista.filter((item) => item.profissional_id === Number(profissionalId));
      if (contatoId) lista = lista.filter((item) => item.contato_id === Number(contatoId));
      if (conversaId) lista = lista.filter((item) => item.conversa_id === Number(conversaId));
      if (inicio && fim) {
        const de = new Date(inicio).getTime();
        const ate = new Date(fim).getTime();
        lista = lista.filter((item) => new Date(item.inicio).getTime() < ate
          && new Date(item.fim).getTime() > de);
      }
      if (!incluirCancelados) lista = lista.filter((item) => item.status !== 'cancelado');

      return lista
        .sort((a, b) => new Date(a.inicio) - new Date(b.inicio))
        .map(enriquecerAgendamento);
    },

    async atualizarAgendamento(id, campos) {
      const agendamento = agendamentos.find((item) => item.id === Number(id));
      if (!agendamento) return null;

      const permitidos = new Map([
        ['inicio', 'inicio'], ['fim', 'fim'], ['status', 'status'], ['tipo', 'tipo'],
        ['observacoes', 'observacoes'], ['local', 'local'],
        ['confirmadoEm', 'confirmado_em'], ['canceladoEm', 'cancelado_em'],
        ['canceladoMotivo', 'cancelado_motivo'], ['profissionalId', 'profissional_id'],
        // O PostgreSQL aceita também o snake direto; aqui os dois coexistem.
        ['google_evento_id', 'google_evento_id'],
        ['googleCalendarId', 'google_calendar_id'], ['googleEtag', 'google_etag'],
        ['syncStatus', 'sync_status'], ['syncVersion', 'sync_version'],
        ['lastSyncedAt', 'last_synced_at'], ['lastSyncError', 'last_sync_error'],
        ['origemAlteracao', 'origem_alteracao'],
      ]);

      // Mudar o horário passa pela mesma regra de conflito do insert.
      const novoInicio = campos.inicio ?? agendamento.inicio;
      const novoFim = campos.fim ?? agendamento.fim;
      const novoStatus = campos.status ?? agendamento.status;

      if ((campos.inicio || campos.fim) && novoStatus !== 'cancelado') {
        const de = new Date(novoInicio).getTime();
        const ate = new Date(novoFim).getTime();

        const conflito = agendamentos.find((existente) => existente.id !== agendamento.id
          && existente.profissional_id === agendamento.profissional_id
          && existente.status !== 'cancelado'
          && de < new Date(existente.fim).getTime()
          && new Date(existente.inicio).getTime() < ate);

        if (conflito) {
          const erro = new Error('conflicting key value violates exclusion constraint');
          erro.code = '23P01';
          erro.constraint = 'agendamentos_sem_conflito';
          throw erro;
        }
      }

      for (const [campo, valor] of Object.entries(campos)) {
        const coluna = permitidos.get(campo);
        if (coluna) agendamento[coluna] = valor;
      }
      agendamento.atualizado_em = agora().toISOString();
      return enriquecerAgendamento(agendamento);
    },

    // ---------------------------------------------------------------- Serena

    async obterConfiguracaoDaSerena() {
      const responsavel = serenaConfiguracao.alterado_por ? usuarios.get(serenaConfiguracao.alterado_por) : null;
      return { ...serenaConfiguracao, alterado_por_nome: responsavel?.nome ?? null };
    },

    async definirConfiguracaoDaSerena({ ativa, motivo = null, usuarioId = null }) {
      serenaConfiguracao.ativa = ativa === true;
      serenaConfiguracao.motivo = motivo;
      serenaConfiguracao.alterado_por = usuarioId;
      serenaConfiguracao.alterado_em = agora().toISOString();
      return { ...serenaConfiguracao };
    },

    // `undefined` é "não mexa"; `null` é "apague". Despausar é gravar `null`.
    async definirHorarioDaSerena({ agenda, pausadaAte, ligadaAte, usuarioId = null }) {
      if (agenda !== undefined) serenaConfiguracao.agenda = agenda;
      if (pausadaAte !== undefined) serenaConfiguracao.pausada_ate = pausadaAte;
      if (ligadaAte !== undefined) serenaConfiguracao.ligada_ate = ligadaAte;
      serenaConfiguracao.alterado_por = usuarioId;
      serenaConfiguracao.alterado_em = agora().toISOString();
      return { ...serenaConfiguracao };
    },

    async listarPromptsDaSerena({ limite = 50 } = {}) {
      return [...serenaPrompts]
        .sort((a, b) => b.versao - a.versao)
        .slice(0, Number(limite))
        .map((prompt) => ({
          ...prompt,
          criado_por_nome: prompt.criado_por ? usuarios.get(prompt.criado_por)?.nome ?? null : null,
          publicado_por_nome: prompt.publicado_por ? usuarios.get(prompt.publicado_por)?.nome ?? null : null,
        }));
    },

    async obterPromptDaSerena(id) {
      return serenaPrompts.find((prompt) => prompt.id === Number(id)) ?? null;
    },

    async obterPromptPublicadoDaSerena() {
      return serenaPrompts.find((prompt) => prompt.publicado) ?? null;
    },

    async criarPromptDaSerena({ titulo, conteudo, criadoPor = null }) {
      // A versão sai do maior existente, como o `max(versao) + 1` do PostgreSQL.
      const versao = serenaPrompts.reduce((maior, prompt) => Math.max(maior, prompt.versao), 0) + 1;
      const prompt = {
        id: proximoId.serenaPrompt++,
        versao,
        titulo,
        conteudo,
        publicado: false,
        publicado_em: null,
        publicado_por: null,
        criado_por: criadoPor,
        criado_em: agora().toISOString(),
        atualizado_em: agora().toISOString(),
      };
      serenaPrompts.push(prompt);
      return prompt;
    },

    async atualizarPromptDaSerena(id, { titulo, conteudo }) {
      const prompt = serenaPrompts.find((item) => item.id === Number(id));
      // Publicado não se reescreve: a versão no ar é registro do que foi decidido.
      if (!prompt || prompt.publicado) return null;

      prompt.titulo = titulo;
      prompt.conteudo = conteudo;
      prompt.atualizado_em = agora().toISOString();
      return prompt;
    },

    async publicarPromptDaSerena(id, { usuarioId = null } = {}) {
      const prompt = serenaPrompts.find((item) => item.id === Number(id));
      if (!prompt) return null;

      // Sem `await` entre despublicar e publicar: em thread única isso é
      // atômico, como a transação do PostgreSQL. Nunca há duas publicadas.
      for (const outro of serenaPrompts) {
        if (outro.id !== prompt.id && outro.publicado) {
          outro.publicado = false;
          outro.publicado_em = null;
          outro.publicado_por = null;
        }
      }
      prompt.publicado = true;
      prompt.publicado_em = agora().toISOString();
      prompt.publicado_por = usuarioId;
      return prompt;
    },

    async listarRegrasDaSerena({ apenasAtivas = false } = {}) {
      return serenaRegras
        .filter((regra) => !apenasAtivas || regra.ativa)
        .sort((a, b) => a.categoria.localeCompare(b.categoria)
          || a.ordem - b.ordem
          || a.nome.localeCompare(b.nome, 'pt-BR'))
        .map((regra) => ({
          ...regra,
          criado_por_nome: regra.criado_por ? usuarios.get(regra.criado_por)?.nome ?? null : null,
        }));
    },

    async obterRegraDaSerena(id) {
      return serenaRegras.find((regra) => regra.id === Number(id)) ?? null;
    },

    async criarRegraDaSerena({ nome, conteudo, categoria, descricao = null, ordem = 100, criadoPor = null }) {
      if (serenaRegras.some((regra) => regra.nome === nome)) {
        // Mesmos sinais do PostgreSQL, para o tratamento ser o mesmo dos dois lados.
        const erro = new Error('duplicate key value violates unique constraint');
        erro.code = '23505';
        erro.constraint = 'serena_regras_nome_key';
        throw erro;
      }

      const regra = {
        id: proximoId.serenaRegra++,
        nome,
        conteudo,
        categoria,
        descricao,
        ordem: Number(ordem),
        ativa: true,
        criado_por: criadoPor,
        criado_em: agora().toISOString(),
        atualizado_em: agora().toISOString(),
      };
      serenaRegras.push(regra);
      return regra;
    },

    async atualizarRegraDaSerena(id, campos) {
      const regra = serenaRegras.find((item) => item.id === Number(id));
      if (!regra) return null;

      const permitidos = ['nome', 'conteudo', 'categoria', 'descricao', 'ordem', 'ativa'];
      for (const [campo, valor] of Object.entries(campos)) {
        if (permitidos.includes(campo)) regra[campo] = valor;
      }
      regra.atualizado_em = agora().toISOString();
      return regra;
    },

    async removerRegraDaSerena(id) {
      const indice = serenaRegras.findIndex((regra) => regra.id === Number(id));
      if (indice === -1) return 0;
      serenaRegras.splice(indice, 1);
      return 1;
    },

    // --------------------------------------------------------- Serena — voz

    async criarSessaoDeVoz({ id, usuarioId, conversaId = null, perfil, consentimentoEm, expiraEm }) {
      const sessao = {
        id, usuario_id: Number(usuarioId), conversa_id: conversaId ? Number(conversaId) : null,
        perfil, estado: 'ativa', consentimento_em: consentimentoEm.toISOString(),
        expira_em: expiraEm.toISOString(), encerrado_em: null, criado_em: agora().toISOString(),
      };
      serenaVozSessoes.set(id, sessao);
      return { ...sessao };
    },

    async obterSessaoDeVoz(id) {
      const sessao = serenaVozSessoes.get(String(id));
      return sessao ? { ...sessao } : null;
    },

    async encerrarSessaoDeVoz(id) {
      const sessao = serenaVozSessoes.get(String(id));
      if (!sessao) return null;
      if (sessao.estado === 'ativa') {
        sessao.estado = 'encerrada';
        sessao.encerrado_em = agora().toISOString();
      }
      return { ...sessao };
    },

    async listarTurnosDeVoz(sessaoId) {
      return serenaVozTurnos.filter((turno) => turno.sessao_id === String(sessaoId)).map((turno) => ({ ...turno }));
    },

    async registrarTurnoDeVoz({ chaveIdempotencia, sessaoId, papel, transcricao, ocorridoEm }) {
      const existente = serenaVozTurnos.find((turno) => turno.chave_idempotencia === chaveIdempotencia);
      if (existente) return { turno: { ...existente }, criado: false };
      const turno = {
        id: serenaVozTurnos.length + 1, chave_idempotencia: chaveIdempotencia,
        sessao_id: sessaoId, papel, transcricao,
        ocorrido_em: ocorridoEm.toISOString(), criado_em: agora().toISOString(),
      };
      serenaVozTurnos.push(turno);
      return { turno: { ...turno }, criado: true };
    },

    // ---------------------------------------------------------------- lembretes

    /**
     * Enfileira imitando a constraint `lembretes_unicos` do PostgreSQL.
     *
     * A busca pelo existente e a inserção acontecem **sem `await` entre elas**:
     * em thread única isso é atômico, e o mesmo par (agendamento, tipo, janela)
     * não vira duas linhas nem sob chamadas concorrentes. Sem esse cuidado, o
     * teste de idempotência passaria aqui e falharia no banco.
     */
    async enfileirarLembrete({
      agendamentoId, contatoId, tipo, janela, agendarPara,
      estado = 'pendente', ignoradoMotivo = null, maxTentativas = 5,
    }) {
      const existente = lembretes.find((item) => item.agendamento_id === Number(agendamentoId)
        && item.tipo === tipo
        && new Date(item.janela).getTime() === new Date(janela).getTime());

      if (existente) return { lembrete: enriquecerLembrete(existente), criado: false };

      const lembrete = {
        id: proximoId.lembrete++,
        agendamento_id: Number(agendamentoId),
        contato_id: Number(contatoId),
        tipo,
        janela,
        agendar_para: agendarPara,
        estado,
        tentativas: 0,
        max_tentativas: Number(maxTentativas),
        tentar_em: agendarPara,
        processando_por: null,
        processando_desde: null,
        modo_entrega: null,
        entrega_referencia: null,
        enviado_em: null,
        ignorado_motivo: ignoradoMotivo,
        ultimo_erro: null,
        criado_em: agora().toISOString(),
        atualizado_em: agora().toISOString(),
      };
      lembretes.push(lembrete);
      return { lembrete: enriquecerLembrete(lembrete), criado: true };
    },

    async obterLembrete(id) {
      return enriquecerLembrete(lembretes.find((item) => item.id === Number(id)) ?? null);
    },

    async listarLembretes({ estado = null, tipo = null, agendamentoId = null, contatoId = null, limite = 50 } = {}) {
      return lembretes
        .filter((item) => (!estado || item.estado === estado)
          && (!tipo || item.tipo === tipo)
          && (!agendamentoId || item.agendamento_id === Number(agendamentoId))
          && (!contatoId || item.contato_id === Number(contatoId)))
        .sort((a, b) => new Date(b.agendar_para) - new Date(a.agendar_para) || b.id - a.id)
        .slice(0, Number(limite))
        .map(enriquecerLembrete);
    },

    async contarLembretesPorEstado() {
      const vazio = () => ({ pendente: 0, processando: 0, enviado: 0, ignorado: 0, falhou: 0 });
      const porEstado = vazio();
      const porTipo = {};
      const entregas = { dry_run: 0, real: 0 };

      for (const lembrete of lembretes) {
        porEstado[lembrete.estado] += 1;
        porTipo[lembrete.tipo] = porTipo[lembrete.tipo] ?? vazio();
        porTipo[lembrete.tipo][lembrete.estado] += 1;
        if (lembrete.modo_entrega === 'dry_run') entregas.dry_run += 1;
        if (lembrete.modo_entrega === 'real') entregas.real += 1;
      }

      return { por_estado: porEstado, por_tipo: porTipo, entregas };
    },

    /**
     * Reivindica imitando `FOR UPDATE SKIP LOCKED`.
     *
     * Seleção e marcação sem `await` no meio: dois "workers" chamando isto em
     * paralelo recebem conjuntos disjuntos, como no PostgreSQL. É o que faz o
     * teste de concorrência significar alguma coisa nas duas implementações.
     */
    async reivindicarLembretes({ agora: instante, limite = 20, worker = 'worker' }) {
      const momento = new Date(instante).getTime();

      const candidatos = lembretes
        .filter((item) => item.estado === 'pendente'
          && new Date(item.agendar_para).getTime() <= momento
          && new Date(item.tentar_em).getTime() <= momento)
        .sort((a, b) => new Date(a.agendar_para) - new Date(b.agendar_para) || a.id - b.id)
        .slice(0, Number(limite));

      for (const lembrete of candidatos) {
        lembrete.estado = 'processando';
        lembrete.processando_por = String(worker).slice(0, 100);
        lembrete.processando_desde = instante;
        lembrete.atualizado_em = instante;
      }

      return candidatos.map(enriquecerLembrete);
    },

    async concluirLembrete(id, {
      estado, modoEntrega = undefined, entregaReferencia = undefined, enviadoEm = undefined,
      ignoradoMotivo = undefined, ultimoErro = undefined, tentativas = undefined, tentarEm = undefined,
    }) {
      const lembrete = lembretes.find((item) => item.id === Number(id));
      if (!lembrete) return null;

      lembrete.estado = estado;
      if (modoEntrega !== undefined) lembrete.modo_entrega = modoEntrega;
      if (entregaReferencia !== undefined) lembrete.entrega_referencia = entregaReferencia;
      if (enviadoEm !== undefined) lembrete.enviado_em = enviadoEm;
      if (ignoradoMotivo !== undefined) lembrete.ignorado_motivo = ignoradoMotivo;
      if (ultimoErro !== undefined) lembrete.ultimo_erro = ultimoErro;
      if (tentativas !== undefined) lembrete.tentativas = Number(tentativas);
      if (tentarEm !== undefined) lembrete.tentar_em = tentarEm ?? agora().toISOString();

      if (estado !== 'processando') {
        lembrete.processando_por = null;
        lembrete.processando_desde = null;
      }
      lembrete.atualizado_em = agora().toISOString();
      return enriquecerLembrete(lembrete);
    },

    async liberarLembretesPresos({ antesDe, agora: instante }) {
      const limite = new Date(antesDe).getTime();
      const liberados = lembretes.filter((item) => item.estado === 'processando'
        && item.processando_desde
        && new Date(item.processando_desde).getTime() < limite);

      for (const lembrete of liberados) {
        lembrete.tentativas += 1;
        lembrete.estado = lembrete.tentativas >= lembrete.max_tentativas ? 'falhou' : 'pendente';
        lembrete.tentar_em = instante;
        lembrete.ultimo_erro = 'processamento abandonado por worker inativo';
        lembrete.processando_por = null;
        lembrete.processando_desde = null;
        lembrete.atualizado_em = instante;
      }

      return liberados.map(enriquecerLembrete);
    },

    async cancelarLembretesDoAgendamento(agendamentoId, { motivo = 'cancelado', exceto = null } = {}) {
      const preservar = exceto ? new Date(exceto).getTime() : null;

      const alvo = lembretes.filter((item) => item.agendamento_id === Number(agendamentoId)
        && ['pendente', 'processando'].includes(item.estado)
        && (preservar === null || new Date(item.janela).getTime() !== preservar));

      for (const lembrete of alvo) {
        lembrete.estado = 'ignorado';
        lembrete.ignorado_motivo = motivo;
        lembrete.processando_por = null;
        lembrete.processando_desde = null;
        lembrete.atualizado_em = agora().toISOString();
      }

      return alvo.map(enriquecerLembrete);
    },

    async cancelarLembretesDoContato(contatoId, { motivo = 'optout' } = {}) {
      const alvo = lembretes.filter((item) => item.contato_id === Number(contatoId)
        && ['pendente', 'processando'].includes(item.estado));

      for (const lembrete of alvo) {
        lembrete.estado = 'ignorado';
        lembrete.ignorado_motivo = motivo;
        lembrete.processando_por = null;
        lembrete.processando_desde = null;
        lembrete.atualizado_em = agora().toISOString();
      }

      return alvo.map(enriquecerLembrete);
    },

    // ---------------------------------------------------------------- tentativas de autenticação

    async registrarTentativa({ ip = null, hashConta = null, acao = 'login', sucesso = false }) {
      tentativas.push({ ip, hash_conta: hashConta, acao, sucesso, criado_em: agora().toISOString() });
    },

    async contarFalhas({ ip = null, hashConta = null, acao = 'login', desde }) {
      const chave = hashConta ? 'hash_conta' : 'ip';
      const valor = hashConta ?? ip;
      if (valor === null || valor === undefined) return { total: 0, maisAntigaEm: null };

      const limite = new Date(desde).getTime();
      const daJanela = tentativas.filter((tentativa) => tentativa[chave] === valor
        && tentativa.acao === acao
        && !tentativa.sucesso
        && new Date(tentativa.criado_em).getTime() > limite);

      if (daJanela.length === 0) return { total: 0, maisAntigaEm: null };

      const maisAntiga = daJanela.reduce(
        (menor, atual) => (new Date(atual.criado_em) < new Date(menor.criado_em) ? atual : menor),
      );
      return { total: daJanela.length, maisAntigaEm: maisAntiga.criado_em };
    },

    async limparFalhasDaConta(hashConta, acao = 'login') {
      if (!hashConta) return 0;

      let removidas = 0;
      for (let indice = tentativas.length - 1; indice >= 0; indice -= 1) {
        const tentativa = tentativas[indice];
        if (tentativa.hash_conta === hashConta && tentativa.acao === acao && !tentativa.sucesso) {
          tentativas.splice(indice, 1);
          removidas += 1;
        }
      }
      return removidas;
    },

    async limparTentativasVencidas(anteriorA) {
      const limite = new Date(anteriorA).getTime();

      let removidas = 0;
      for (let indice = tentativas.length - 1; indice >= 0; indice -= 1) {
        if (new Date(tentativas[indice].criado_em).getTime() < limite) {
          tentativas.splice(indice, 1);
          removidas += 1;
        }
      }
      return removidas;
    },

    async criarSessao({ usuarioId, hashRefresh, expiraEm, agente = null, ip = null }) {
      const sessao = {
        id: proximoId.sessao++,
        usuario_id: Number(usuarioId),
        hash_refresh: hashRefresh,
        expira_em: expiraEm,
        revogada_em: null,
        agente,
        ip,
        criado_em: agora().toISOString(),
      };
      sessoes.set(sessao.id, sessao);
      return { id: sessao.id };
    },

    async obterSessaoPorHash(hashRefresh) {
      return [...sessoes.values()].find((sessao) => sessao.hash_refresh === hashRefresh) ?? null;
    },

    async revogarSessao(id) {
      const sessao = sessoes.get(Number(id));
      if (sessao && !sessao.revogada_em) sessao.revogada_em = agora().toISOString();
    },

    async revogarSessoesDoUsuario(usuarioId) {
      let total = 0;
      for (const sessao of sessoes.values()) {
        if (sessao.usuario_id === Number(usuarioId) && !sessao.revogada_em) {
          sessao.revogada_em = agora().toISOString();
          total += 1;
        }
      }
      return total;
    },

    // ---------------------------------------------------------------- apoio aos testes

    _auditoria: auditoria,
    // Acesso direto aos armazéns, para os repositórios satélite em memória
    // (google, clínica) e para os testes montarem cenários sem rodeios.
    _interno: { usuarios, sessoes, contatos, conversas, leads, agendamentos },
  };

  return repositorio;
}

module.exports = { criarRepositorioEmMemoria, ETIQUETAS_INICIAIS };
