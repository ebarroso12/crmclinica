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

  const proximoId = {
    contato: 1, conversa: 1, mensagem: 1, nota: 1,
    lead: 1, usuario: 1, etiqueta: 1, sessao: 1, recuperacao: 1,
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
      temperatura: lead?.temperatura ?? null,
      estagio: lead?.estagio ?? null,
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
      return [...leads.values()].map((lead) => {
        const contato = contatos.get(lead.contato_id);
        return { ...lead, nome: contato?.nome ?? null, telefone: contato?.telefone ?? null };
      });
    },

    async salvarLead(contatoId, { conversaId = null, temperatura = null, estagio = null, origem = null } = {}) {
      const existente = [...leads.values()].find((lead) => lead.contato_id === Number(contatoId));

      if (existente) {
        if (conversaId) existente.conversa_id = Number(conversaId);
        if (temperatura) existente.temperatura = temperatura;
        if (estagio) existente.estagio = estagio;
        existente.atualizado_em = agora().toISOString();
        return existente;
      }

      const lead = {
        id: proximoId.lead++,
        contato_id: Number(contatoId),
        conversa_id: conversaId ? Number(conversaId) : null,
        temperatura: temperatura || 'frio',
        estagio: estagio || 'novo',
        origem: origem || 'WHATSAPP',
        proximo_passo: null,
        atualizado_em: agora().toISOString(),
      };
      leads.set(lead.id, lead);
      return lead;
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
