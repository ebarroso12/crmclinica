'use strict';

// Versão em memória do repositório clínico — mesma interface, zero banco.
// Trabalha sobre os armazenamentos do repositório em memória principal
// (`_interno`), como a versão PostgreSQL trabalha sobre as mesmas tabelas.

function criarRepositorioClinicaEmMemoria({ repositorio = null, agora = () => new Date() } = {}) {
  const termos = new Map();
  const assinaturas = new Map();
  let proximoTermoId = 1;
  let proximaAssinaturaId = 1;

  return {
    // ------------------------------------------------------------ sessões (P1-03)

    async listarSessoesDoUsuario(usuarioId) {
      const sessoes = repositorio?._interno?.sessoes
        ? [...repositorio._interno.sessoes.values()] : [];
      return sessoes
        .filter((sessao) => sessao.usuario_id === Number(usuarioId))
        .sort((a, b) => String(b.criado_em).localeCompare(String(a.criado_em)))
        .slice(0, 50)
        .map((sessao) => ({
          id: sessao.id,
          criado_em: sessao.criado_em,
          expira_em: sessao.expira_em,
          revogada_em: sessao.revogada_em ?? null,
          agente: sessao.agente ?? null,
          ip: sessao.ip ?? null,
        }));
    },

    async revogarSessaoDoUsuario(usuarioId, sessaoId) {
      if (!repositorio?._interno?.sessoes) return false;
      const sessao = repositorio._interno.sessoes.get(Number(sessaoId));
      if (!sessao || sessao.usuario_id !== Number(usuarioId) || sessao.revogada_em) return false;
      sessao.revogada_em = agora().toISOString();
      return true;
    },

    // ------------------------------------------------------------ termos (P1-07)

    async obterTermoVigente(escopo) {
      return [...termos.values()]
        .filter((t) => t.escopo === escopo && t.publicado)
        .sort((a, b) => b.versao - a.versao)[0] ?? null;
    },

    async listarTermos(escopo = null) {
      return [...termos.values()]
        .filter((t) => !escopo || t.escopo === escopo)
        .sort((a, b) => a.escopo.localeCompare(b.escopo) || b.versao - a.versao)
        .map((t) => ({
          id: t.id, escopo: t.escopo, versao: t.versao, titulo: t.titulo,
          publicado: t.publicado, publicado_em: t.publicado_em, autor_id: t.autor_id,
          criado_em: t.criado_em, resumo: t.texto.slice(0, 200),
        }));
    },

    async criarVersaoDeTermo({ escopo, titulo, texto, autorId = null }) {
      const versoes = [...termos.values()].filter((t) => t.escopo === escopo).map((t) => t.versao);
      const termo = {
        id: proximoTermoId++,
        escopo,
        versao: versoes.length > 0 ? Math.max(...versoes) + 1 : 1,
        titulo,
        texto,
        publicado: false,
        publicado_em: null,
        autor_id: autorId,
        criado_em: agora().toISOString(),
      };
      termos.set(termo.id, termo);
      return termo;
    },

    async publicarTermo(termoId) {
      const termo = termos.get(Number(termoId));
      if (!termo) return null;
      for (const outro of termos.values()) {
        if (outro.escopo === termo.escopo && outro.id !== termo.id) outro.publicado = false;
      }
      termo.publicado = true;
      termo.publicado_em = agora().toISOString();
      return termo;
    },

    async assinarTermo({ termoId, usuarioId = null, contatoId = null, assinaturaExternaId, provedor = null, registradoPor = null }) {
      // Os índices únicos do PostgreSQL viram esta checagem: uma pessoa, uma
      // versão, uma assinatura.
      const duplicata = [...assinaturas.values()].find((a) => a.termo_id === Number(termoId)
        && ((usuarioId && a.usuario_id === Number(usuarioId))
          || (contatoId && a.contato_id === Number(contatoId))));
      if (duplicata) {
        const erro = new Error('duplicate key value violates unique constraint');
        erro.code = '23505';
        throw erro;
      }
      const assinatura = {
        id: proximaAssinaturaId++,
        termo_id: Number(termoId),
        usuario_id: usuarioId ? Number(usuarioId) : null,
        contato_id: contatoId ? Number(contatoId) : null,
        assinatura_externa_id: assinaturaExternaId,
        provedor,
        registrado_por: registradoPor,
        criado_em: agora().toISOString(),
      };
      assinaturas.set(assinatura.id, assinatura);
      return assinatura;
    },

    async obterAssinaturaDoUsuario(termoId, usuarioId) {
      return [...assinaturas.values()]
        .find((a) => a.termo_id === Number(termoId) && a.usuario_id === Number(usuarioId)) ?? null;
    },

    async obterAssinaturaDoContato(termoId, contatoId) {
      return [...assinaturas.values()]
        .find((a) => a.termo_id === Number(termoId) && a.contato_id === Number(contatoId)) ?? null;
    },

    async listarAssinaturas(termoId) {
      return [...assinaturas.values()]
        .filter((a) => a.termo_id === Number(termoId))
        .sort((a, b) => b.criado_em.localeCompare(a.criado_em));
    },

    // ------------------------------------------------------------ deduplicação (P1-09)

    async buscarCandidatosADuplicata({ limite = 20 } = {}) {
      const contatos = repositorio?._interno?.contatos
        ? [...repositorio._interno.contatos.values()].filter((c) => !c.excluido_em) : [];
      const candidatos = [];
      for (let i = 0; i < contatos.length; i += 1) {
        for (let j = i + 1; j < contatos.length; j += 1) {
          const a = contatos[i];
          const b = contatos[j];

          let criterio = null;
          if (a.cpf_busca_hash && a.cpf_busca_hash === b.cpf_busca_hash) criterio = 'cpf';
          else if (a.whatsapp_numero && a.whatsapp_ddd === b.whatsapp_ddd
                   && a.whatsapp_numero === b.whatsapp_numero) criterio = 'whatsapp';
          else if (a.telefone && a.telefone === b.telefone) criterio = 'telefone';

          if (criterio) candidatos.push({ contato_a: a.id, contato_b: b.id, criterio });
          if (candidatos.length >= limite) return candidatos;
        }
      }
      return candidatos;
    },

    async fundirContatos(vencedorId, perdedorId) {
      if (!repositorio?._interno?.contatos) return {};
      const vencedor = repositorio._interno.contatos.get(Number(vencedorId));
      const perdedor = repositorio._interno.contatos.get(Number(perdedorId));
      if (!vencedor || !perdedor) return {};

      const movidos = {};
      const moverDe = (colecao, campo) => {
        let total = 0;
        for (const item of colecao.values()) {
          if (item[campo] === Number(perdedorId)) { item[campo] = Number(vencedorId); total += 1; }
        }
        return total;
      };

      if (repositorio._interno.conversas) movidos.conversas = moverDe(repositorio._interno.conversas, 'contato_id');
      if (repositorio._interno.leads) movidos.leads = moverDe(repositorio._interno.leads, 'contato_id');
      if (repositorio._interno.agendamentos) movidos.agendamentos = moverDe(repositorio._interno.agendamentos, 'contato_id');
      movidos.termo_assinaturas = moverDe(assinaturas, 'contato_id');

      for (const campo of ['nome_completo', 'nascimento', 'email', 'cpf_cifrado', 'cpf_busca_hash',
        'rg_cifrado', 'whatsapp_ddi', 'whatsapp_ddd', 'whatsapp_numero',
        'responsavel_nome', 'responsavel_cpf_cifrado', 'responsavel_parentesco',
        'consentimento_responsavel_em', 'consentimento_canal', 'consentimento_termo_id', 'observacoes']) {
        if (vencedor[campo] == null && perdedor[campo] != null) vencedor[campo] = perdedor[campo];
      }

      perdedor.excluido_em = agora().toISOString();
      perdedor.excluido_motivo = `fundido no contato ${vencedorId}`;
      return movidos;
    },

    async obterContatoPorHashDeCpf(hash) {
      if (!hash || !repositorio?._interno?.contatos) return [];
      return [...repositorio._interno.contatos.values()]
        .filter((c) => c.cpf_busca_hash === hash)
        .slice(0, 5)
        .map((c) => ({ id: c.id, nome: c.nome, telefone: c.telefone, excluido_em: c.excluido_em ?? null }));
    },

    // ------------------------------------------------------------ qualidade (P2-10)

    async medirQualidadeCadastral() {
      const contatos = repositorio?._interno?.contatos
        ? [...repositorio._interno.contatos.values()].filter((c) => !c.excluido_em) : [];
      const porTelefone = new Map();
      for (const c of contatos) {
        if (c.telefone) porTelefone.set(c.telefone, (porTelefone.get(c.telefone) ?? 0) + 1);
      }
      const limite18 = new Date(agora().getTime() - 18 * 365.25 * 86_400_000);
      return {
        ativos: contatos.length,
        sem_telefone: contatos.filter((c) => !c.telefone).length,
        sem_nome: contatos.filter((c) => !c.nome?.trim()).length,
        sem_nome_completo: contatos.filter((c) => !c.nome_completo).length,
        sem_nascimento: contatos.filter((c) => !c.nascimento).length,
        menores_sem_responsavel: contatos.filter((c) => c.nascimento
          && new Date(c.nascimento) > limite18 && !c.responsavel_nome).length,
        grupos_duplicados_por_telefone: [...porTelefone.values()].filter((n) => n > 1).length,
      };
    },

    // Espelhos de teste.
    _termos: termos,
    _assinaturas: assinaturas,
  };
}

module.exports = { criarRepositorioClinicaEmMemoria };
