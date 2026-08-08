'use strict';

// P1-01 a P1-08: gestão completa de usuários — edição estruturada, proteção
// de CPF/RG, suspensão que revoga sessão, exclusão lógica, WhatsApp
// particular autorizado, termo versionado e 2FA obrigatório.

const test = require('node:test');
const assert = require('node:assert/strict');

const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarRepositorioClinicaEmMemoria } = require('../src/dados/repositorio-clinica-memoria');
const { criarServicoDeUsuarios } = require('../src/dominio/usuarios-servico');
const sensiveis = require('../src/seguranca/dados-sensiveis');
const { subirServidor, configuracaoDeTeste, autenticar, SENHA_DE_TESTE } = require('./auxiliar');

const SEGREDO = 'segredo-sintetico-de-teste-com-mais-de-32-caracteres';
const CPF_VALIDO = '52998224725'; // dígitos verificadores corretos

async function montar() {
  const repositorio = criarRepositorioEmMemoria();
  const repositorioClinica = criarRepositorioClinicaEmMemoria({ repositorio });
  const servico = criarServicoDeUsuarios({ repositorio, repositorioClinica, segredo: SEGREDO });

  const admin = await repositorio.criarUsuario({
    nome: 'Admin', email: 'admin@teste.local', papel: 'admin', situacao: 'ativo',
  });
  const alvo = await repositorio.criarUsuario({
    nome: 'Atendente', email: 'atendente@teste.local', papel: 'atendente', situacao: 'ativo',
  });
  return { repositorio, repositorioClinica, servico, admin, alvo };
}

// ------------------------------------------------------------------ P1-01/P1-05

test('edição completa grava cadastro estruturado e cifra o CPF', async () => {
  const { repositorio, servico, admin, alvo } = await montar();

  await servico.editarUsuarioCompleto(admin, alvo.id, {
    nomeCompleto: 'Atendente da Silva',
    nascimento: '1990-05-10',
    cpf: CPF_VALIDO,
    rg: '123456789',
    whatsapp: { ddd: '16', numero: '999999999' },
  });

  const ficha = await repositorio.obterUsuarioPorId(alvo.id);
  assert.equal(ficha.nome_completo, 'Atendente da Silva');
  assert.equal(ficha.nascimento, '1990-05-10');
  assert.equal(ficha.whatsapp_ddd, '16');
  // A leitura comum não expõe documento — nem cifrado, nem hash.
  assert.equal(ficha.cpf_cifrado, undefined);
  assert.equal(ficha.cpf_busca_hash, undefined);

  // O documento existe, cifrado, e decifra de volta ao original.
  const documentos = await repositorio.obterDocumentosDoUsuario(alvo.id);
  assert.ok(documentos.cpfCifrado.startsWith('v1.'));
  assert.equal(sensiveis.decifrar(SEGREDO, documentos.cpfCifrado), CPF_VALIDO);
  assert.ok(documentos.cpfBuscaHash);
});

test('CPF com dígito errado é recusado antes de tocar o banco', async () => {
  const { servico, admin, alvo } = await montar();

  await assert.rejects(
    () => servico.editarUsuarioCompleto(admin, alvo.id, { cpf: '52998224726' }),
    (erro) => erro.codigo === 'cpf_invalido' && erro.status === 422,
  );
});

test('decifrar CPF é só do admin e cada leitura vira auditoria', async () => {
  const { repositorio, servico, admin, alvo } = await montar();
  await servico.editarUsuarioCompleto(admin, alvo.id, { cpf: CPF_VALIDO });

  const cpf = await servico.revelarCpfDoUsuario(admin, alvo.id);
  assert.equal(cpf, CPF_VALIDO);
  assert.ok(repositorio._auditoria.some((l) => l.acao === 'usuario.cpf_revelado'));

  const atendente = await repositorio.criarUsuario({
    nome: 'Outro', email: 'outro@teste.local', papel: 'atendente', situacao: 'ativo',
  });
  await assert.rejects(
    () => servico.revelarCpfDoUsuario(atendente, alvo.id),
    (erro) => erro.status === 403,
  );
});

// ------------------------------------------------------------------ papel auditado

test('mudança de papel é auditada com antes e depois', async () => {
  const { repositorio, servico, admin, alvo } = await montar();

  await servico.editarUsuarioCompleto(admin, alvo.id, { papel: 'gestor' });

  const registro = repositorio._auditoria.find((l) => l.acao === 'usuario.papel_alterado');
  assert.ok(registro, 'a auditoria deveria ter a mudança de papel');
  assert.deepEqual(registro.detalhe, { de: 'atendente', para: 'gestor' });
});

test('master não perde o papel e ninguém muda o próprio', async () => {
  const { repositorio, servico, admin } = await montar();
  const master = await repositorio.criarUsuario({
    nome: 'Master', email: 'master@teste.local', papel: 'admin', situacao: 'ativo', master: true,
  });

  await assert.rejects(
    () => servico.editarUsuarioCompleto(admin, master.id, { papel: 'atendente' }),
    (erro) => erro.codigo === 'master_imutavel',
  );
  await assert.rejects(
    () => servico.editarUsuarioCompleto(admin, admin.id, { papel: 'gestor' }),
    (erro) => erro.codigo === 'papel_proprio',
  );
});

// ------------------------------------------------------------------ P1-02

test('suspender desativa e revoga as sessões no mesmo gesto', async () => {
  const { repositorio, servico, admin, alvo } = await montar();
  await repositorio.criarSessao({
    usuarioId: alvo.id, hashRefresh: 'hash-1', expiraEm: new Date(Date.now() + 86400_000).toISOString(),
  });

  await servico.suspenderUsuario(admin, alvo.id, { motivo: 'afastamento' });

  const suspenso = await repositorio.obterUsuarioPorId(alvo.id);
  assert.equal(suspenso.ativo, false);
  assert.equal(suspenso.situacao, 'suspenso');

  const sessao = [...repositorio._interno.sessoes.values()][0];
  assert.ok(sessao.revogada_em, 'a sessão viva foi revogada junto');

  const registro = repositorio._auditoria.find((l) => l.acao === 'usuario.suspenso');
  assert.equal(registro.detalhe.sessoes_revogadas, 1);
});

test('excluir é lógico: a linha fica, as sessões morrem, a autoria permanece', async () => {
  const { repositorio, servico, admin, alvo } = await montar();
  await repositorio.criarSessao({
    usuarioId: alvo.id, hashRefresh: 'hash-1', expiraEm: new Date(Date.now() + 86400_000).toISOString(),
  });

  await servico.excluirUsuario(admin, alvo.id, { motivo: 'desligamento' });

  // A linha continua lá — é ela que assina o histórico.
  const excluido = await repositorio.obterUsuarioPorId(alvo.id);
  assert.ok(excluido, 'exclusão física teria apagado a autoria histórica');
  assert.ok(excluido.excluido_em);
  assert.equal(excluido.excluido_por, admin.id);
  assert.equal(excluido.ativo, false);
  assert.ok([...repositorio._interno.sessoes.values()][0].revogada_em);

  // E não se exclui o master nem a si mesmo.
  await assert.rejects(
    () => servico.excluirUsuario(admin, admin.id),
    (erro) => erro.codigo === 'exclusao_propria',
  );
});

// ------------------------------------------------------------------ P1-03

test('painel de sessões lista e revoga uma sessão específica', async () => {
  const { repositorio, repositorioClinica, servico, admin, alvo } = await montar();
  await repositorio.criarSessao({
    usuarioId: alvo.id, hashRefresh: 'hash-1',
    expiraEm: new Date(Date.now() + 86400_000).toISOString(), agente: 'Firefox', ip: '200.1.2.3',
  });
  await repositorio.criarSessao({
    usuarioId: alvo.id, hashRefresh: 'hash-2', expiraEm: new Date(Date.now() + 86400_000).toISOString(),
  });

  const sessoes = await servico.listarSessoes(admin, alvo.id);
  assert.equal(sessoes.length, 2);
  assert.equal(sessoes[0].agente === 'Firefox' || sessoes[1].agente === 'Firefox', true);

  const revogada = await servico.revogarSessao(admin, alvo.id, sessoes[0].id);
  assert.equal(revogada, true);

  const depois = await repositorioClinica.listarSessoesDoUsuario(alvo.id);
  assert.equal(depois.filter((s) => !s.revogada_em).length, 1);
});

// ------------------------------------------------------------------ P1-06

test('autorização de WhatsApp particular registra quem e quando', async () => {
  const { repositorio, servico, admin, alvo } = await montar();

  await servico.autorizarWhatsappParticular(admin, alvo.id, { autorizado: true });

  const autorizado = await repositorio.obterUsuarioPorId(alvo.id);
  assert.equal(autorizado.whatsapp_particular_autorizado, true);
  assert.equal(autorizado.whatsapp_particular_autorizado_por, admin.id);
  assert.ok(autorizado.whatsapp_particular_autorizado_em);

  await servico.autorizarWhatsappParticular(admin, alvo.id, { autorizado: false });
  const revogado = await repositorio.obterUsuarioPorId(alvo.id);
  assert.equal(revogado.whatsapp_particular_autorizado, false);
  assert.equal(revogado.whatsapp_particular_autorizado_em, null);
});

// ------------------------------------------------------------------ P1-07

test('termo é versionado: publicar a v2 tira a v1 do ar', async () => {
  const { servico, admin } = await montar();

  const v1 = await servico.criarVersaoDeTermo(admin, {
    escopo: 'equipe', titulo: 'Termo de uso', texto: 'TEMPLATE v1 — sujeito a revisão jurídica', publicar: true,
  });
  const v2 = await servico.criarVersaoDeTermo(admin, {
    escopo: 'equipe', titulo: 'Termo de uso', texto: 'TEMPLATE v2 — sujeito a revisão jurídica', publicar: true,
  });

  assert.equal(v2.versao, 2);
  const vigente = await servico.obterTermoVigente('equipe');
  assert.equal(vigente.id, v2.id);

  const termos = await servico.listarTermos(admin, 'equipe');
  assert.equal(termos.find((t) => t.id === v1.id).publicado, false);
});

test('assinatura exige referência externa e não se repete por versão', async () => {
  const { servico, admin, alvo } = await montar();

  const termo = await servico.criarVersaoDeTermo(admin, {
    escopo: 'equipe', titulo: 'Termo', texto: 'TEMPLATE', publicar: true,
  });

  await assert.rejects(
    () => servico.registrarAssinatura(admin, { termoId: termo.id, usuarioId: alvo.id }),
    (erro) => erro.codigo === 'assinatura_sem_referencia',
  );

  const assinatura = await servico.registrarAssinatura(admin, {
    termoId: termo.id, usuarioId: alvo.id, assinaturaExternaId: 'clique-abc123', provedor: 'registro-de-clique',
  });
  assert.equal(assinatura.assinatura_externa_id, 'clique-abc123');

  // A mesma pessoa, na mesma versão: o índice único (aqui simulado) barra.
  await assert.rejects(
    () => servico.registrarAssinatura(admin, {
      termoId: termo.id, usuarioId: alvo.id, assinaturaExternaId: 'clique-de-novo',
    }),
    (erro) => erro.code === '23505',
  );
});

// ------------------------------------------------------------------ P1-08

test('responsável legal grava consentimento com canal, data e CPF cifrado', async () => {
  const { repositorio, servico, admin } = await montar();
  const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516988887777', nome: 'Menor Paciente' });

  await servico.registrarResponsavel(admin, contato.id, {
    nome: 'Mãe da Paciente',
    cpf: CPF_VALIDO,
    parentesco: 'mae',
    consentimentoCanal: 'whatsapp',
    consentimentoTermoId: null,
  });

  const ficha = await repositorio.obterContato(contato.id);
  assert.equal(ficha.responsavel_nome, 'Mãe da Paciente');
  assert.equal(ficha.responsavel_parentesco, 'mae');
  assert.equal(ficha.consentimento_canal, 'whatsapp');
  assert.ok(ficha.consentimento_responsavel_em);

  // O CPF do responsável também não aparece na ficha: só cifrado, via canal próprio.
  const documentos = await repositorio.obterDocumentosDoContato(contato.id);
  assert.equal(sensiveis.decifrar(SEGREDO, documentos.responsavelCpfCifrado), CPF_VALIDO);
});

// ------------------------------------------------------------------ HTTP

test('HTTP: gestão de usuários exige admin e responde a ficha sem documentos', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  try {
    const { usuarios } = await (await ambiente.pedir('/api/usuarios/gestao')).json();
    assert.ok(usuarios.length >= 1);

    const ficha = await (await ambiente.pedir(`/api/usuarios/${ambiente.sessao.usuario.id}`)).json();
    assert.ok(ficha.usuario);
    assert.equal(ficha.usuario.cpf_cifrado, undefined, 'documento não sai pela API');

    // Atendente não entra na gestão.
    const atendente = await ambiente.entrarComo('atendente');
    const recusa = await fetch(`${ambiente.base}/api/usuarios/gestao`, {
      headers: { authorization: `Bearer ${atendente.access_token}` },
    });
    assert.equal(recusa.status, 403);
  } finally {
    await ambiente.encerrar();
  }
});

test('HTTP: suspender pela API revoga o acesso do suspenso', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  try {
    const colega = await ambiente.entrarComo('atendente');
    const alvoId = colega.usuario?.id ?? JSON.parse(
      Buffer.from(colega.access_token.split('.')[1], 'base64url').toString(),
    ).sub;

    const resposta = await ambiente.pedir(`/api/usuarios/${alvoId}/suspender`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ motivo: 'teste' }),
    });
    assert.equal(resposta.status, 200);

    const corpo = await resposta.json();
    assert.equal(corpo.usuario.situacao, 'suspenso');
    assert.equal(corpo.usuario.ativo, false);
  } finally {
    await ambiente.encerrar();
  }
});

// ------------------------------------------------------------------ P1-04

test('2FA obrigatório: admin sem TOTP só alcança as rotas de autenticação', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const configuracao = configuracaoDeTeste({ CRMCLINICA_2FA_OBRIGATORIO: 'sim' });
  const ambiente = await subirServidor({ repositorio, configuracao });
  try {
    // O token do admin sem TOTP vem marcado: a API inteira responde 403.
    const bloqueada = await ambiente.pedir('/api/conversas');
    assert.equal(bloqueada.status, 403);
    const corpo = await bloqueada.json();
    assert.equal(corpo.codigo, 'segundo_fator_pendente');

    // Menos as rotas de autenticação, onde o segundo fator se ativa.
    const preparacao = await ambiente.pedir('/api/auth/segundo-fator', { method: 'POST' });
    assert.equal(preparacao.status, 200);

    // E o atendente sem TOTP passa normal: a obrigação é de master e admin.
    const atendente = await ambiente.entrarComo('atendente');
    const livre = await fetch(`${ambiente.base}/api/conversas`, {
      headers: { authorization: `Bearer ${atendente.access_token}` },
    });
    assert.equal(livre.status, 200);
  } finally {
    await ambiente.encerrar();
  }
});

test('2FA obrigatório desligado na config não marca token nenhum', async () => {
  const repositorio = criarRepositorioEmMemoria();
  // 'nao' é o padrão da suíte — este teste trava a regressão do flag.
  const ambiente = await subirServidor({ repositorio });
  try {
    const livre = await ambiente.pedir('/api/conversas');
    assert.equal(livre.status, 200);
  } finally {
    await ambiente.encerrar();
  }
});
