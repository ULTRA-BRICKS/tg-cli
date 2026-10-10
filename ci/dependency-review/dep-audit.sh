#!/usr/bin/env bash
# Dependency vulnerability audit — the dependency-review gate. Auto-detects the package
# manager(s) of a tree and runs each one's native audit, failing on high/critical advisories.
#
# .github/workflows/dependency-review.yml runs the trusted BASE copy of this script under
# pull_request_target and hands it the PR head as AUDIT_DIR (tg-cli#326). The PR's files are
# DATA here, never code or configuration:
#   - Only an allowlist of manifests/lockfiles is copied into a fresh staging dir, and the node /
#     python / rust auditors run THERE. The PR's bunfig.toml, .npmrc, pip.conf or
#     .cargo/audit.toml never reach them — any of those could repoint the advisory source or
#     ignore a finding. A symlinked manifest is refused (it could point at a runner secret that
#     an auditor would echo into the log).
#   - pip-audit only ever gets a fully pinned requirements file, with pip disabled and no
#     dependency resolution (see req_file_classify). Anything it would have to BUILD to read
#     (an sdist, a VCS/URL/path requirement, an `-r` include, a foreign index) fails closed.
#   - A package.json with no lockfile is resolved as data (`bun install --lockfile-only
#     --ignore-scripts` in the staging dir: no package is installed, no lifecycle script runs)
#     and the resulting lockfile is audited — tg-cli itself tracks no lockfile.
#   - Go is refused: govulncheck loads the packages with the go toolchain, which honours the
#     tree's `#cgo` flags and `replace` directives — PR code under the privileged trigger.
#
# Fails CLOSED: a detected ecosystem without its auditor, a manifest that can't be audited as
# data, and an auditor that exits non-zero (an advisory OR the audit itself failing — e.g. no
# network to the advisory database) all fail the gate. Only "no manifest at all" passes empty.
#
# Detects: bun, pnpm/yarn/npm (node), pip-audit (python), cargo-audit (rust); go fails closed.
#
# Knobs (env):
#   DEP_AUDIT_LEVEL          minimum severity to FAIL on: low|moderate|high|critical (default high).
#   DEP_AUDIT_ALLOW_MISSING  "1" = DON'T fail when a manifest is found but can't be audited
#                            (fail-OPEN). Default 0 = fail CLOSED: "no audit ran" must not
#                            masquerade as "no vulns".
#
# Usage: sh ci/dependency-review/dep-audit.sh [AUDIT_DIR]   (AUDIT_DIR defaults to '.')
set -eu

LEVEL="${DEP_AUDIT_LEVEL:-high}"
ALLOW_MISSING="${DEP_AUDIT_ALLOW_MISSING:-0}"
AUDIT_DIR="${1:-.}"
rc=0
ran=0
missing=0
skipped=0

note() { echo "[dep-audit] $*" >&2; }
# A detected manifest that can't be audited: fail closed unless explicitly allowed.
miss() {
  if [ "$ALLOW_MISSING" = "1" ]; then
    note "$* — skipping (DEP_AUDIT_ALLOW_MISSING=1)."
    skipped=$((skipped+1))
  else
    note "$* — FAILING (no audit performed; set DEP_AUDIT_ALLOW_MISSING=1 to allow)."
    missing=$((missing+1))
  fi
}

if [ ! -d "$AUDIT_DIR" ]; then
  note "audit dir '$AUDIT_DIR' does not exist — FAILING (cannot audit)."
  exit 1
fi
AUDIT_DIR="$(cd "$AUDIT_DIR" && pwd)"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# Copy the manifests/lockfiles the auditors read — nothing else — into the staging dir.
cd "$AUDIT_DIR"
# Checked before the loop: its word list globs requirements/*.txt (following a symlinked
# directory) before any iteration runs.
if [ -L requirements ]; then
  note "requirements/ is a symlink — FAILING (manifests must be regular files in the audited tree)."
  exit 1
fi
for f in package.json bun.lock bun.lockb package-lock.json npm-shrinkwrap.json pnpm-lock.yaml \
         yarn.lock pyproject.toml poetry.lock Cargo.lock requirements*.txt requirements/*.txt; do
  if [ -L "$f" ]; then
    note "$f is a symlink — FAILING (a manifest must be a regular file in the audited tree)."
    exit 1
  fi
  [ -f "$f" ] || continue
  mkdir -p "$STAGE/$(dirname "$f")"
  cp "$f" "$STAGE/$f"
done
cd "$STAGE"

# Classify a requirements file $1 for data-safe auditing. Prints exactly one word:
#   pinned — every line is a pinned PyPI spec (`name[extras]==version`, optional `; marker`,
#            optional `--hash=algo:hex` tokens) or a benign line (blank / comment / a line of
#            only `--hash=` tokens / `--require-hashes`), AND at least one pinned spec exists.
#   empty  — only benign lines, no pinned spec. Covers nothing, so it must not mask an
#            un-auditable pyproject.toml.
#   unsafe — anything else: editable (`-e`), URL/VCS, `name @ url`, a local path, an `-r`/`-c`
#            include, an index/find-links option, an unpinned or wildcard spec, an env-var
#            expansion, or any extra option after a spec. pip-audit would have to fetch/BUILD
#            such input (setup.py / a PEP 517 backend = PR code under pull_request_target) or
#            read a file this scan never saw. Every token is checked, so an option can't hide
#            behind a hash.
req_file_classify() {  # $1 = requirements file -> prints: pinned | empty | unsafe
  awk '
    function hash_tok(t) { return t ~ /^--hash=[A-Za-z0-9]+:[A-Za-z0-9+\/=]+$/ }
    { line=$0; gsub(/\r/, "", line)
      sub(/(^|[ \t])#.*/, "", line)                    # comment (pip: line start or after space)
      sub(/[ \t]*\\$/, "", line)                       # trailing line-continuation
      sub(/[ \t]*;.*/, "", line)                       # environment marker
      gsub(/^[ \t]+|[ \t]+$/, "", line)
      if (line == "" || line == "--require-hashes") next
      n = split(line, tok, /[ \t]+/)
      start = 1
      if (tok[1] ~ /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9,._-]*\])?==[A-Za-z0-9][A-Za-z0-9.+!_-]*$/) { pinned=1; start=2 }
      else if (!hash_tok(tok[1])) { bad=1; next }
      for (i = start; i <= n; i++) if (!hash_tok(tok[i])) { bad=1; next }
    }
    END { if (bad) print "unsafe"; else if (pinned) print "pinned"; else print "empty" }
  ' "$1"
}

# Exits non-zero, listing the offenders, unless every dependency of ./package.json is a plain
# registry range/tag (`^1.2.0`, `>=1 <2`, `1.x`, `latest`): no `:` / `/` / `@` / `#`, so no git,
# URL, file, link, workspace or npm-alias spec, and no workspaces / overrides / resolutions /
# catalogs that could pull one in. One line on purpose: it is passed to `bun -e`.
REGISTRY_ONLY_JS='const p=JSON.parse(require("fs").readFileSync("package.json","utf8"));const bad=["workspaces","overrides","resolutions","patchedDependencies","catalog","catalogs"].filter(k=>p[k]!==undefined);for(const f of ["dependencies","devDependencies","optionalDependencies","peerDependencies"]){const d=p[f]??{};if(typeof d!=="object"||Array.isArray(d)){bad.push(f);continue}for(const[n,v]of Object.entries(d))if(typeof v!=="string"||!/^[A-Za-z0-9.^~<>=*|\- ]*$/.test(v))bad.push(f+"."+n+": "+JSON.stringify(v))}if(bad.length){console.error("[dep-audit] not a plain registry dependency: "+bad.join(", "));process.exit(1)}'

# --- node ---------------------------------------------------------------------------------
if [ -f bun.lock ] || [ -f bun.lockb ]; then
  if command -v bun >/dev/null 2>&1; then
    ran=1; note "bun audit --audit-level=$LEVEL"
    bun audit --audit-level="$LEVEL" || rc=1
  else
    miss "bun lockfile present but bun not installed"
  fi
elif [ -f package.json ]; then
  if [ -f pnpm-lock.yaml ]; then
    if command -v pnpm >/dev/null 2>&1; then
      ran=1; note "pnpm audit --audit-level $LEVEL"; pnpm audit --audit-level "$LEVEL" || rc=1
    else
      miss "pnpm-lock.yaml present but pnpm not installed"
    fi
  elif [ -f yarn.lock ]; then
    if command -v yarn >/dev/null 2>&1; then
      ran=1; note "yarn npm audit (yarn berry) — failing on $LEVEL+"; yarn npm audit --severity "$LEVEL" || rc=1
    else
      miss "yarn.lock present but yarn not installed"
    fi
  elif [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then
    if command -v npm >/dev/null 2>&1; then
      ran=1; note "npm audit --audit-level=$LEVEL"; npm audit --audit-level="$LEVEL" || rc=1
    else
      miss "npm lockfile present but npm not installed"
    fi
  elif command -v bun >/dev/null 2>&1; then
    # No lockfile: resolve package.json the way a fresh install would, as data only — but only
    # when every dependency is a plain registry range. A git / URL / file / alias spec (or
    # workspaces / overrides) would make the resolve fetch a PR-chosen location from the
    # privileged job, so it fails closed instead.
    if ! bun -e "$REGISTRY_ONLY_JS"; then
      miss "package.json has no lockfile and a dependency that is not a plain registry range (listed above)"
    else
      note "package.json has no lockfile — resolving it (bun install --lockfile-only --ignore-scripts)"
      if bun install --lockfile-only --ignore-scripts; then
        ran=1; note "bun audit --audit-level=$LEVEL"
        bun audit --audit-level="$LEVEL" || rc=1
      else
        miss "package.json could not be resolved to a lockfile"
      fi
    fi
  else
    miss "package.json has no lockfile and bun is not installed to resolve one"
  fi
fi

# --- python -------------------------------------------------------------------------------
# Never the bare `pip-audit` (that audits the RUNNER's environment, not this tree) and never a
# resolving `-r`/`-e`/project audit (that builds PR code). Pinned requirements files only, with
# --disable-pip (pip never runs) and --no-deps (no resolution).
py_manifest=0
for f in requirements*.txt requirements/*.txt; do
  [ -f "$f" ] && { py_manifest=1; break; }
done
if [ "$py_manifest" = "1" ] || [ -f pyproject.toml ] || [ -f poetry.lock ]; then
  audited_py=0   # a pinned requirements file was audited
  refused_py=0   # a requirements file was refused (already counted as a failure)
  for f in requirements*.txt requirements/*.txt; do
    [ -f "$f" ] || continue
    case "$(req_file_classify "$f")" in
      pinned)
        if command -v pip-audit >/dev/null 2>&1; then
          ran=1; audited_py=1
          note "pip-audit --disable-pip --no-deps -r $f"
          pip-audit --disable-pip --no-deps -r "$f" || rc=1
        else
          refused_py=1
          miss "python requirements file $f present but pip-audit not installed (pipx install pip-audit)"
        fi ;;
      empty)
        note "skipping $f — no pinned spec to audit (empty / comments / options only)" ;;
      *)
        refused_py=1
        miss "python requirements file $f has a line that is not a pinned name==version spec (editable / URL / VCS / local path / -r or -c include / index option / unpinned) — auditing it would fetch or BUILD PR-controlled code; pin every line to name==version" ;;
    esac
  done
  if [ "$audited_py" = "0" ] && [ "$refused_py" = "0" ] && { [ -f pyproject.toml ] || [ -f poetry.lock ]; }; then
    miss "python project (pyproject.toml/poetry.lock) present but no pinned requirements*.txt to audit as data (auditing the project would build it)"
  fi
fi

# --- rust ---------------------------------------------------------------------------------
if [ -f Cargo.lock ]; then
  if command -v cargo-audit >/dev/null 2>&1 || cargo audit --version >/dev/null 2>&1; then
    ran=1; note "cargo audit -f Cargo.lock"; cargo audit -f Cargo.lock || rc=1
  else
    miss "Cargo.lock present but cargo-audit not installed (cargo install cargo-audit)"
  fi
fi

# --- go -----------------------------------------------------------------------------------
# No data-only auditor: govulncheck builds the package graph from the source (see the header).
if [ -f "$AUDIT_DIR/go.mod" ]; then
  miss "go.mod present but a go module can't be audited as data (govulncheck builds the source)"
fi

if [ "$ran" = "0" ] && [ "$missing" = "0" ]; then
  if [ "$skipped" -gt 0 ]; then
    note "nothing audited — $skipped detected manifest(s) skipped by DEP_AUDIT_ALLOW_MISSING=1."
  else
    note "no supported manifest/lockfile found — nothing to audit."
  fi
  exit 0
fi
if [ "$missing" -gt 0 ]; then
  note "FAIL — $missing detected manifest(s) could not be audited (fail-closed). See above, or set DEP_AUDIT_ALLOW_MISSING=1."
  exit 1
fi
if [ "$rc" = "0" ]; then
  note "PASS — no advisories at $LEVEL+."
else
  note "FAIL — an auditor exited non-zero: advisories at $LEVEL+, or the audit itself failed (e.g. its advisory database was unreachable). See above."
fi
exit "$rc"
