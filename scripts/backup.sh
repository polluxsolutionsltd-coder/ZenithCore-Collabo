#!/usr/bin/env bash
# ZenithCore FMIS – database backup.
# Usage: DATABASE_URL=... [BACKUP_DIR=backups] [BACKUP_KEEP_DAYS=14] [BACKUP_GPG_RECIPIENT=key] scripts/backup.sh
# Writes a pg_dump custom-format archive with a SHA-256 checksum, checks the archive can be read,
# optionally encrypts it with GPG, and deletes backups older than the retention period.
set -euo pipefail
URL="${DATABASE_URL:?DATABASE_URL is required}"
DIR="${BACKUP_DIR:-backups}"
KEEP="${BACKUP_KEEP_DAYS:-14}"
mkdir -p "$DIR"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$DIR/zenithcore-$TS.dump"

pg_dump --format=custom --no-owner --no-privileges --file="$FILE.part" "$URL"
pg_restore --list "$FILE.part" > /dev/null          # the archive is complete and readable
mv "$FILE.part" "$FILE"
if [ -n "${BACKUP_GPG_RECIPIENT:-}" ]; then
  gpg --batch --yes --recipient "$BACKUP_GPG_RECIPIENT" --output "$FILE.gpg" --encrypt "$FILE"
  rm -f "$FILE"
  FILE="$FILE.gpg"
fi
( cd "$DIR" && sha256sum "$(basename "$FILE")" > "$(basename "$FILE").sha256" )
find "$DIR" -name 'zenithcore-*.dump*' -mtime +"$KEEP" -delete
echo "$FILE"
