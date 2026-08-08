#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${OPENCLAW_SERENA_WORKSPACE:-/root/.openclaw-clinica/workspace-serena}"
SERVICE="${OPENCLAW_SERENA_SERVICE:-openclaw-clinica.service}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="/root/.openclaw-clinica/backups/politica-serena-${STAMP}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "BLOQUEADO: execute como root."
  exit 1
fi

for required in AGENTS.md SOUL.md; do
  if [[ ! -f "${SOURCE_DIR}/${required}" ]]; then
    echo "BLOQUEADO: fonte ausente: ${SOURCE_DIR}/${required}"
    exit 1
  fi
  if [[ ! -f "${TARGET_DIR}/${required}" ]]; then
    echo "BLOQUEADO: destino ausente: ${TARGET_DIR}/${required}"
    exit 1
  fi
done

install -d -m 700 "${BACKUP_DIR}"
cp -a "${TARGET_DIR}/AGENTS.md" "${BACKUP_DIR}/AGENTS.md"
cp -a "${TARGET_DIR}/SOUL.md" "${BACKUP_DIR}/SOUL.md"

aplicar_fragmento() {
  local nome="$1"
  local inicio="<!-- BEGIN SERENA-OFICIAL-V2:${nome} -->"
  local fim="<!-- END SERENA-OFICIAL-V2:${nome} -->"
  local origem="${SOURCE_DIR}/${nome}"
  local destino="${TARGET_DIR}/${nome}"
  local temporario

  temporario="$(mktemp)"
  perl -0pe "s/\\n?\\Q${inicio}\\E.*?\\Q${fim}\\E\\n?//sg" "${destino}" > "${temporario}"

  {
    printf '\n%s\n' "${inicio}"
    cat "${origem}"
    printf '\n%s\n' "${fim}"
  } >> "${temporario}"

  install -m 600 "${temporario}" "${destino}"
  rm -f "${temporario}"
}

aplicar_fragmento AGENTS.md
aplicar_fragmento SOUL.md

systemctl restart "${SERVICE}"
systemctl is-active --quiet "${SERVICE}"

grep -q '<!-- BEGIN SERENA-OFICIAL-V2:AGENTS.md -->' "${TARGET_DIR}/AGENTS.md"
grep -q '<!-- BEGIN SERENA-OFICIAL-V2:SOUL.md -->' "${TARGET_DIR}/SOUL.md"

echo "POLITICA_SERENA_V2_APLICADA"
echo "BACKUP=${BACKUP_DIR}"
