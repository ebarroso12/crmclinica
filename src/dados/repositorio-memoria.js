'use strict';

// Repositório em memória com a mesma interface do PostgreSQL.
// Serve aos testes e ao desenvolvimento local sem banco: o resto do sistema
// não distingue um do outro. Não persiste nada entre reinícios, de propósito.

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

function criarRepositorioEmMemoria({ agora = () => new Date() } = {}) {
  const contatos = new Map();
  const conversas = new Map();
  const mensagens = [];
  const etiquetas = new Map();
  const etiquetasDaConversa = new Map();
  const notas = [];
  const leads = new Map();
  const eventos = new Map();
  const auditoria = [];
  const usuarios = new Map();
  const sessoes = new Map();
  const recuperacoes = new Map();
  const tentativas = [];
  const leadEventos = [];
  const profissionais = new Map();
  const disponibilidades = [];
  const bloqueios = [];
  const agendamentos = [];

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
    profissional: 1, disponibilidade: 1, bloqueio: 1, agendamento: 1,
  };

  // Espelha o que o PostgreSQL devolve: o hash da senha e o segredo do segundo
  // fator só saem pelas consultas que os pedem explicitamente.
  function semSegredos(usuario) {
    const { senha_hash: _senha, totp_segredo_cifrado: _totp, ...resto } = usuario;
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

    async verificarSaude() {
      return { estado: 'operacional' };
    },

    // ---------------------------------------------------------------- conversas

    async listarConversas({ status = null, busca = null, contatoId = null, limite = 50 } = {}) {
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

      return lista
        .sort((a, b) => {
          const tempoA = a.ultima_msg_em ? new Date(a.ultima_msg_em).getTime() : 0;
          const tempoB = b.ultima_msg_em ? new Date(b.ultima_msg_em).getTime() : 0;
          return tempoB - tempoA || b.id - a.id;
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
      };
      mensagens.push(mensagem);

      const conversa = conversas.get(Number(conversaId));
      if (conversa && !mensagem.privada) conversa.ultima_msg_em = mensagem.criado_em;

      return { mensagem, duplicada: false };
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

      const permitidos = ['nome', 'telefone', 'email', 'identificador', 'observacoes', 'atributos'];
      for (const [campo, valor] of Object.entries(campos)) {
        if (permitidos.includes(campo)) contato[campo] = valor;
      }
      return contato;
    },

    async encontrarOuCriarContato({ telefone, nome = null, canal = 'whatsapp', identificador = null }) {
      const existente = [...contatos.values()].find((contato) => contato.telefone === telefone);
      if (existente) {
        if (!existente.nome && nome) existente.nome = nome;
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
        criado_em: agora().toISOString(),
      };
      contatos.set(contato.id, contato);
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
        criado_em: agora().toISOString(),
        atualizado_em: agora().toISOString(),
      };
      leads.set(lead.id, lead);
      return enriquecerLead(lead);
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
      auditoria.push({ ...registro, criado_em: agora().toISOString() });
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
  };

  return repositorio;
}

module.exports = { criarRepositorioEmMemoria, ETIQUETAS_INICIAIS };
