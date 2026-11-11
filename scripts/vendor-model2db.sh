#!/usr/bin/env bash
# Copies the part of Model2DB that turns a saved project into its tables: the model, the parsers, the design
# decisions, the relational build and the SQL type of each column, for the web and the desktop versions. DB2CRUD reads model2db-project files
# with it until Model2DB exports db-schema itself (docs/decisions.md, decision 15). The copies are never edited
# by hand: run this again to update them.
#
# Usage: scripts/vendor-model2db.sh [path to the Model2DB repository]   (default: ../Model2DB)
set -euo pipefail
cd "$(dirname "$0")/.."
root="$(pwd)"
source="$(cd "${1:-../Model2DB}" && pwd)"
commit="$(git -C "$source" rev-parse --short HEAD)"

copy() { # copy <from> <to, relative to this repository> <file pattern>, without tests or caches
  local target="$root/$2"
  rm -rf "$target"
  mkdir -p "$target"
  (cd "$1" && find model parsers design physical -type f -name "$3" ! -name '*.test.ts' ! -path '*/test/*' ! -path '*/__pycache__/*' -print0 |
    xargs -0 -I{} rsync -R {} "$target/")
}

web="web/src/core/interop/model2db/vendor"
copy "$source/web/src/core" "$web" '*.ts'
mkdir -p "$web/interop" "$web/generate"
cp "$source/web/src/core/interop/project.ts" "$web/interop/"
cp "$source/web/src/core/generate/types.ts" "$source/web/src/core/generate/todos.ts" "$web/generate/"
mkdir -p "$web/generate/sql"
cp "$source/web/src/core/generate/sql/sql.ts" "$web/generate/sql/"

desktop="desktop/db2crud/core/interop/model2db/vendor"
copy "$source/desktop/model2db/core" "$desktop" '*.py'
mkdir -p "$desktop/interop" "$desktop/generate"
cp "$source/desktop/model2db/core/interop/project.py" "$desktop/interop/"
cp "$source/desktop/model2db/core/generate/types.py" "$source/desktop/model2db/core/generate/todos.py" "$desktop/generate/"
mkdir -p "$desktop/generate/sql"
cp "$source/desktop/model2db/core/generate/sql/sql.py" "$desktop/generate/sql/"
cp "$source/desktop/model2db/core/js.py" "$desktop/"
for folder in $(cd "$desktop" && find . -type d); do touch "$desktop/$folder/__init__.py"; done

for target in "$web" "$desktop"; do
  printf 'Copied from Model2DB %s by scripts/vendor-model2db.sh. Do not edit: run the script again.\n' "$commit" > "$target/VENDORED.txt"
done
echo "Model2DB $commit copied to $web and $desktop"
