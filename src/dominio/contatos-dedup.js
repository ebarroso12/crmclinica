'use strict';

// Deduplicação segura de contatos (P1-09).
//
// Ficha duplicada é o imposto que a base cobra por cada pressa: o paciente
// que ligou em 2023 e voltou pelo WhatsApp em 2024 vira duas pessoas, e o
// histórico racha no meio. Juntar é delicado — uma fusão errada mistura o
// prontuário de duas pessoas de verdade, que é muito pior que a duplicata.
//
// Por isso o desenho é conservador:
//   - só critérios fortes ligam duas fichas (mesmo CPF pelo hash, mesmo
//     WhatsApp, mesmo telefone) — nome parecido NÃO é evidência;
//   - a fusão nunca apaga: o perdedor vira exclusão lógica com o motivo
//     "fundido no contato N", que é o mapa para desfazer;
//   - toda fusão é auditada com os dois lados e o critério.

const { exigirPermissao } = require('../seguranca/rbac');

function erroDeValidacao(codigo, mensagem) {
  const erro = new Error(mensagem);
  erro.codigo = codigo;
  erro.status = 422;
  return erro;
}

function criarDeduplicacaoDeContatos({ repositorio, repositorioClinica }) {
  /**
   * Pares suspeitos com a evidência visível. A tela decide; o sistema só
   * aponta. Enriquecer com nome/telefone é o que permite ao gestor decidir
   * sem abrir duas fichas em paralelo.
   */
  async function buscarDuplicatas(ator, { limite = 20 } = {}) {
    exigirPermissao(ator, 'contatos:editar');

    const pares = await repositorioClinica.buscarCandidatosADuplicata({ limite });
    const enriquecidos = [];
    for (const par of pares) {
      const [a, b] = await Promise.all([
        repositorio.obterContato(par.contato_a),
        repositorio.obterContato(par.contato_b),
      ]);
      if (!a || !b) continue;
      const resumir = (c) => ({
        id: c.id,
        nome: c.nome,
        telefone: c.telefone,
        // O PostgreSQL devolve o indicador pronto; a memória expõe o campo
        // cifrado. Os dois respondem a mesma pergunta: tem CPF ou não tem.
        cpf_cadastrado: Boolean(c.cpf_cadastrado ?? c.cpf_cifrado),
      });
      enriquecidos.push({ criterio: par.criterio, contato_a: resumir(a), contato_b: resumir(b) });
    }
    return enriquecidos;
  }

  /**
   * Funde `perdedorId` em `vencedorId`.
   *
   * As travas antes de mexer em qualquer linha: os dois existem, estão
   * ativos e são pessoas-ficha diferentes. Depois disso o repositório move
   * vínculos, completa o vencedor com o que só o perdedor tinha e marca o
   * perdedor como fundido — reversível, auditado, sem DELETE.
   */
  async function fundir(ator, { vencedorId, perdedorId }) {
    exigirPermissao(ator, 'contatos:editar');

    if (Number(vencedorId) === Number(perdedorId)) {
      throw erroDeValidacao('fusao_consigo_mesmo', 'um contato não pode ser fundido consigo mesmo');
    }
    const [vencedor, perdedor] = await Promise.all([
      repositorio.obterContato(vencedorId),
      repositorio.obterContato(perdedorId),
    ]);
    if (!vencedor || vencedor.excluido_em) {
      throw erroDeValidacao('vencedor_invalido', 'o contato vencedor não existe ou está excluído');
    }
    if (!perdedor || perdedor.excluido_em) {
      throw erroDeValidacao('perdedor_invalido', 'o contato fundido não existe ou já foi excluído');
    }

    const movidos = await repositorioClinica.fundirContatos(vencedorId, perdedorId);
    await repositorio.registrarAuditoria({
      entidade: 'contato',
      entidadeId: Number(vencedorId),
      acao: 'contato.fundido',
      detalhe: {
        perdedor_id: Number(perdedorId),
        nome_do_fundido: perdedor.nome ?? null,
        vinculos_movidos: movidos,
      },
      usuarioId: ator.id,
    });

    return { vencedor: await repositorio.obterContato(vencedorId), movidos };
  }

  return { buscarDuplicatas, fundir };
}

module.exports = { criarDeduplicacaoDeContatos };
