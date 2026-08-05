-- Espelho da agenda no Google Calendar do médico.
--
-- Guarda só o identificador do evento criado lá. Sem ele, remarcar criaria um
-- evento novo a cada vez e o calendário acumularia consultas fantasmas do mesmo
-- paciente; cancelar não teria o que apagar.
--
-- A coluna é anulável de propósito: agendamento feito antes desta migration, ou
-- criado enquanto o Google está fora do ar, continua válido. O espelho é
-- conveniência, não requisito — a agenda do crmclinica é a fonte de verdade, e
-- é lá que a trava de conflito vive.

BEGIN;

ALTER TABLE agendamentos
  ADD COLUMN IF NOT EXISTS google_evento_id text;

COMMENT ON COLUMN agendamentos.google_evento_id IS
  'Identificador do evento no Google Calendar. Nulo = ainda não espelhado.';

-- Índice parcial: só as linhas espelhadas interessam à busca, e são a minoria
-- enquanto a integração não estiver ligada.
CREATE INDEX IF NOT EXISTS agendamentos_google_evento
  ON agendamentos (google_evento_id)
  WHERE google_evento_id IS NOT NULL;

COMMIT;
