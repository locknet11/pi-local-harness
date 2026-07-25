#!/usr/bin/env bash
# ==============================================================================
#  lib/gitops.sh — checkpoints, commits y rollback
# ------------------------------------------------------------------------------
#  A diferencia de aider, pi NO auto-commitea. Eso en realidad nos conviene:
#  el harness controla el punto exacto de corte y puede DESHACER una feature
#  que quedó rota.
#
#  Es la diferencia entre un proyecto que crece y uno que se pudre: con un
#  modelo local chico, un intento fallido suele dejar imports rotos y archivos
#  a medio escribir. Si eso queda en el árbol, la feature siguiente arranca
#  sobre escombros y falla también. Rollback = cada feature parte de verde.
# ==============================================================================

git_available()  { have git && git rev-parse --is-inside-work-tree >/dev/null 2>&1; }
git_is_dirty()   { ! git diff --quiet HEAD 2>/dev/null || [ -n "$(git status --porcelain 2>/dev/null)" ]; }
git_head()       { git rev-parse --short HEAD 2>/dev/null; }

git_ensure_identity() {
    git config user.email >/dev/null 2>&1 || git config user.email "harness@localhost"
    git config user.name  >/dev/null 2>&1 || git config user.name  "pi-local-harness"
}

git_init_repo() {
    if git_available; then
        log_dim "Ya es un repo git ($(git_head))"
        git_ensure_identity
        return 0
    fi
    log_step "git init"
    git init -q 2>/dev/null || { log_err "Falló git init"; return 1; }
    git_ensure_identity
    [ -f .gitignore ] || cat > .gitignore <<'EOF'
node_modules/
__pycache__/
*.pyc
.venv/
venv/
dist/
build/
target/
.DS_Store
.harness/tmp/
.harness/*.log
.harness/run/
EOF
    git add -A 2>/dev/null || true
    git commit -q -m "chore: init repo (pi-local-llm-harness)" 2>/dev/null || true
    log_ok "Repo inicializado en $(git_head)"
}

# Punto al que volver si la feature sale mal.
git_checkpoint() {
    git_available || { printf ''; return 1; }
    if git_is_dirty; then
        git add -A >/dev/null 2>&1 || true
        git commit -q -m "chore(harness): checkpoint antes de '$1'" >/dev/null 2>&1 || true
    fi
    git rev-parse HEAD 2>/dev/null
}

# Commitea TODO lo que dejó el agente, con un mensaje descriptivo.
git_commit_feature() {
    local id="$1" name="$2" status="$3"
    git_available || return 0
    git add -A >/dev/null 2>&1 || true
    if git diff --cached --quiet 2>/dev/null; then
        log_dim "Nada para commitear."
        return 0
    fi
    local prefix
    case "$status" in
        COMPLETED)  prefix="feat" ;;
        UNVERIFIED) prefix="feat" ;;
        *)          prefix="wip"  ;;
    esac
    local msg="$prefix($id): $name"
    [ "$status" = "UNVERIFIED" ] && msg="$msg [sin verificar]"
    if git commit -q -m "$msg" >/dev/null 2>&1; then
        log_ok "commit $(git_head) — $msg"
    else
        log_warn "No pude commitear (¿git user.name/user.email?)."
    fi
    return 0
}

# Vuelve el árbol al checkpoint. Se lleva puesto lo que el agente rompió.
git_rollback_to() {
    local ref="$1"
    [ -n "$ref" ] || return 1
    git_available || return 1
    log_warn "Rollback del árbol de trabajo a ${ref}"
    git reset -q --hard "$ref" >/dev/null 2>&1 || { log_err "Falló el rollback."; return 1; }
    git clean -qfd >/dev/null 2>&1 || true
    return 0
}

# Rama de trabajo, para no ensuciar main mientras el modelo experimenta.
git_ensure_branch() {
    local branch="$1"
    git_available || return 0
    [ -n "$branch" ] || return 0
    local cur
    cur=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
    [ "$cur" = "$branch" ] && return 0
    if git show-ref --verify --quiet "refs/heads/$branch"; then
        git checkout -q "$branch" 2>/dev/null || return 1
    else
        git checkout -q -b "$branch" 2>/dev/null || return 1
    fi
    log_info "Rama de trabajo: $branch"
}

# Cuántos archivos y líneas tocó el agente desde el checkpoint (para el log).
git_diffstat_since() {
    local ref="$1"
    [ -n "$ref" ] || return 1
    git_available || return 1
    git diff --shortstat "$ref" 2>/dev/null | sed 's/^[[:space:]]*//'
}

# Archivos que parecen tests, en varios lenguajes.
GIT_TEST_FILE_RE='(^|/)(tests?|spec|__tests__)/|(^|/)test_[^/]*$|_test\.[a-z]+$|\.(test|spec)\.[jt]sx?$|Test[s]?\.(java|kt|cs)$|_spec\.rb$'

# ¿El agente tocó algún archivo de tests desde el checkpoint?
#
# Existe por un caso real: el modelo marcó dos features como COMPLETED sin
# escribir un solo test. Los 4 tests que ya había (de la feature anterior)
# seguían pasando, así que la verificación daba verde — sobre código que era
# literalmente `return 0.0  # Dummy return`. Una suite que pasa sólo prueba que
# no rompiste lo viejo; no prueba que hiciste lo nuevo.
git_test_files_changed_since() {
    local ref="$1"
    [ -n "$ref" ] || return 1
    git_available || return 1
    # `grep -c` sin matches imprime "0" y ADEMÁS sale con 1: un `|| printf 0`
    # detrás devuelve "0\n0" y rompe la comparación numérica del que llama.
    { git diff --name-only "$ref" 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null; } \
        | grep -E "$GIT_TEST_FILE_RE" | wc -l | tr -d ' '
}
