#!/usr/bin/env bash
# ZenithCore FMIS – restore and verify.
# Usage: scripts/restore.sh <backup file> <target DATABASE_URL> [--force]
# Checks the SHA-256 checksum, restores into the target database, then verifies the
# schema version, record counts and the integrity of the hash-chained audit trail.
# Refuses to overwrite a database that already holds data unless --force is given.
set -euo pipefail
FILE="${1:?backup file required}"
TARGET="${2:?target database URL required}"
FORCE="${3:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"

( cd "$(dirname "$FILE")" && sha256sum --check --status "$(basename "$FILE").sha256" ) || { echo "Checksum mismatch: $FILE" >&2; exit 2; }
if [[ "$FILE" == *.gpg ]]; then
  PLAIN="${FILE%.gpg}.restore"
  gpg --batch --yes --output "$PLAIN" --decrypt "$FILE"
  trap 'rm -f "$PLAIN"' EXIT
  FILE="$PLAIN"
fi
TABLES="$(psql "$TARGET" -Atc "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public'")"
if [ "$TABLES" != "0" ] && [ "$FORCE" != "--force" ]; then
  echo "Target database is not empty ($TABLES tables). Use --force to replace it." >&2; exit 3
fi
pg_restore --clean --if-exists --no-owner --no-privileges --exit-on-error --dbname="$TARGET" "$FILE"
DATABASE_URL="$TARGET" node --import tsx "$HERE/verify-db.ts"
