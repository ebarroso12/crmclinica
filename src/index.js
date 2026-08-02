'use strict';

const { carregarConfiguracao, validarConfiguracao, descreverConfiguracao } = require('./config');
const { criarAplicacao, criarServidor } = require('./servidor/http');

const configuracao = carregarConfiguracao();

function iniciar() {
  const problemas = validarConfiguracao(configuracao);
  if (problemas.length > 0) {
    // Em produção, configuração insegura impede a subida; fora dela, apenas avisa.
    const prefixo = configuracao.producao ? 'Configuração inválida' : 'Aviso de configuração';
    for (const problema of problemas) console.error(`[crmclinica] ${prefixo}: ${problema}`);
    if (configuracao.producao) process.exit(1);
  }

  const servidor = criarServidor({ configuracao });
  servidor.listen(configuracao.porta, configuracao.endereco, () => {
    console.log(`[crmclinica] ouvindo em http://${configuracao.endereco}:${configuracao.porta}`);
    console.log('[crmclinica] plataforma:', JSON.stringify(descreverConfiguracao(configuracao)));
  });

  const encerrar = () => servidor.close(() => process.exit(0));
  process.on('SIGINT', encerrar);
  process.on('SIGTERM', encerrar);

  return servidor;
}

if (require.main === module) iniciar();

module.exports = { iniciar, criarAplicacao, criarServidor, configuracao };
