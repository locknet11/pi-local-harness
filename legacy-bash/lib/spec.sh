#!/usr/bin/env bash
# ==============================================================================
#  lib/spec.sh — parseo y mutación de PROJECT_SPEC.md
# ------------------------------------------------------------------------------
#  El backlog se direcciona por ÍNDICE DE BLOQUE, nunca por el nombre de la
#  feature. Si dos features se llaman parecido (o el modelo escribe un nombre
#  con caracteres raros), un parser por regex de nombre se confunde y te pisa
#  el status del bloque equivocado.
#
#  Formato canónico:
#
#    ## feature: Nombre corto
#    id: F001
#    status: PENDING
#    depends: F000                  (opcional)
#    test: npm test -- tests/foo     (opcional; pisa el comando global)
#    acceptance:
#      - criterio verificable 1
#      - criterio verificable 2
#    notes: |
#      texto libre
#
#  Estados: PENDING -> IN_PROGRESS -> COMPLETED | UNVERIFIED | FAILED | BLOCKED
# ==============================================================================

SPEC_FEATURE_RE='^#*[[:space:]]*feature:'

# --- Lectura ------------------------------------------------------------------
spec_count() {
    awk '/^#*[[:space:]]*feature:/ {n++} END{print n+0}' "$SPEC_FILE" 2>/dev/null
}

# "IDX<TAB>NOMBRE" de la primera feature PENDING cuyas dependencias estén OK.
spec_next_pending() {
    awk '
        function trim(s) { sub(/^[[:space:]]+/, "", s); sub(/[[:space:]]+$/, "", s); return s }
        /^#*[[:space:]]*feature:/ {
            idx++
            nm = $0; sub(/^#*[[:space:]]*feature:/, "", nm)
            names[idx] = trim(nm)
            next
        }
        idx > 0 && /^[[:space:]]*status:/ {
            st = $0; sub(/^[[:space:]]*status:/, "", st)
            if (status[idx] == "") status[idx] = trim(st)
            next
        }
        idx > 0 && /^[[:space:]]*id:/ {
            v = $0; sub(/^[[:space:]]*id:/, "", v)
            if (fid[idx] == "") { fid[idx] = trim(v); byid[trim(v)] = idx }
            next
        }
        idx > 0 && /^[[:space:]]*depends:/ {
            v = $0; sub(/^[[:space:]]*depends:/, "", v)
            if (dep[idx] == "") dep[idx] = trim(v)
            next
        }
        END {
            for (i = 1; i <= idx; i++) {
                if (status[i] != "PENDING") continue
                ok = 1
                if (dep[i] != "" && dep[i] != "none" && dep[i] != "-") {
                    n = split(dep[i], parts, /[, ]+/)
                    for (j = 1; j <= n; j++) {
                        d = parts[j]
                        if (d == "") continue
                        if (!(d in byid)) continue          # dep desconocida: la ignoramos
                        s = status[byid[d]]
                        if (s != "COMPLETED" && s != "UNVERIFIED") { ok = 0; break }
                    }
                }
                if (ok) { print i "\t" names[i]; exit }
            }
        }
    ' "$SPEC_FILE" 2>/dev/null
}

# ¿Quedan PENDING pero todas bloqueadas por dependencias sin cumplir?
spec_has_blocked_pending() {
    local total pending
    pending=$(awk '/^[[:space:]]*status:[[:space:]]*PENDING[[:space:]]*$/ {n++} END{print n+0}' "$SPEC_FILE")
    [ "$pending" -gt 0 ] || return 1
    [ -z "$(spec_next_pending)" ] || return 1
    return 0
}

spec_status_of() {
    awk -v want="$1" '
        /^#*[[:space:]]*feature:/ { idx++; inb = (idx == want); next }
        inb && /^[[:space:]]*status:/ {
            st = $0; sub(/^[[:space:]]*status:/, "", st)
            sub(/^[[:space:]]+/, "", st); sub(/[[:space:]]+$/, "", st)
            print st; exit
        }
    ' "$SPEC_FILE" 2>/dev/null
}

spec_field_of() {
    awk -v want="$1" -v key="$2" '
        /^#*[[:space:]]*feature:/ { idx++; inb = (idx == want); next }
        inb {
            line = $0
            sub(/^[[:space:]]+/, "", line)
            if (index(line, key ":") == 1) {
                v = substr(line, length(key) + 2)
                sub(/^[[:space:]]+/, "", v); sub(/[[:space:]]+$/, "", v)
                print v; exit
            }
        }
    ' "$SPEC_FILE" 2>/dev/null
}

spec_name_of() {
    awk -v want="$1" '
        /^#*[[:space:]]*feature:/ {
            idx++
            if (idx == want) {
                nm = $0; sub(/^#*[[:space:]]*feature:/, "", nm)
                sub(/^[[:space:]]+/, "", nm); sub(/[[:space:]]+$/, "", nm)
                print nm; exit
            }
        }
    ' "$SPEC_FILE" 2>/dev/null
}

spec_extract_block() {
    awk -v want="$1" '
        /^#*[[:space:]]*feature:/ {
            idx++
            if (idx == want) { inb = 1 } else if (inb) { exit }
        }
        inb { print }
    ' "$SPEC_FILE" 2>/dev/null
}

# --- Escritura ----------------------------------------------------------------
# Cambia el status del bloque N y VERIFICA que haya quedado escrito. Si esto
# falla en silencio, el loop principal reprocesa la misma feature para siempre.
spec_set_status() {
    local idx="$1" new="$2" tmp="${SPEC_FILE}.tmp.$$"

    awk -v want="$idx" -v st="$new" '
        /^#*[[:space:]]*feature:/ { idx++; inb = (idx == want); done = 0 }
        inb && !done && /^[[:space:]]*status:/ {
            match($0, /^[[:space:]]*/)
            print substr($0, 1, RLENGTH) "status: " st
            done = 1
            next
        }
        { print }
    ' "$SPEC_FILE" > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }

    [ -s "$tmp" ] || { rm -f "$tmp"; return 1; }
    # Nunca aceptamos una reescritura que perdió features.
    if [ "$(awk '/^#*[[:space:]]*feature:/ {n++} END{print n+0}' "$tmp")" != "$(spec_count)" ]; then
        rm -f "$tmp"; return 1
    fi
    mv "$tmp" "$SPEC_FILE" || return 1
    [ "$(spec_status_of "$idx")" = "$new" ] || return 1
    return 0
}

# Una corrida anterior murió a la mitad y dejó features colgadas.
spec_reset_stale() {
    local n
    while :; do
        n=$(awk '
            /^#*[[:space:]]*feature:/ { idx++; next }
            /^[[:space:]]*status:[[:space:]]*IN_PROGRESS[[:space:]]*$/ { print idx; exit }
        ' "$SPEC_FILE" 2>/dev/null)
        [ -n "$n" ] || break
        log_warn "Feature #$n quedó IN_PROGRESS de una corrida anterior → PENDING"
        spec_set_status "$n" "PENDING" || break
    done
}

spec_reset_from() {
    local from="$1" n count=0
    while :; do
        n=$(awk -v st="$from" '
            /^#*[[:space:]]*feature:/ { idx++; next }
            $0 ~ "^[[:space:]]*status:[[:space:]]*" st "[[:space:]]*$" { print idx; exit }
        ' "$SPEC_FILE" 2>/dev/null)
        [ -n "$n" ] || break
        spec_set_status "$n" "PENDING" || break
        count=$((count + 1))
    done
    printf '%s' "$count"
}

# --- Reporte ------------------------------------------------------------------
spec_summary() {
    awk '
        function trim(s) { sub(/^[[:space:]]+/, "", s); sub(/[[:space:]]+$/, "", s); return s }
        /^#*[[:space:]]*feature:/ {
            idx++
            nm = $0; sub(/^#*[[:space:]]*feature:/, "", nm)
            names[idx] = trim(nm); next
        }
        idx > 0 && /^[[:space:]]*status:/ && status[idx] == "" {
            st = $0; sub(/^[[:space:]]*status:/, "", st)
            status[idx] = trim(st); count[trim(st)]++
        }
        END {
            for (i = 1; i <= idx; i++) {
                s = status[i]
                mark = (s == "COMPLETED") ? "✔" : \
                       (s == "FAILED")    ? "✖" : \
                       (s == "UNVERIFIED")? "~" : \
                       (s == "IN_PROGRESS")? "»" : "·"
                printf "  %s  #%-3d %-11s %s\n", mark, i, s, names[i]
            }
            printf "\n  total=%d  completed=%d  unverified=%d  failed=%d  pending=%d\n", \
                idx, count["COMPLETED"]+0, count["UNVERIFIED"]+0, \
                count["FAILED"]+0, count["PENDING"]+0
        }
    ' "$SPEC_FILE" 2>/dev/null
}

# --- Validación ---------------------------------------------------------------
# Se usa después de que el MODELO genera el spec. Los modelos locales chicos se
# olvidan campos todo el tiempo; los errores que salgan de acá se le devuelven
# al modelo textualmente para que corrija.
spec_validate() {
    local file="${1:-$SPEC_FILE}"
    [ -f "$file" ] || { printf 'El archivo %s no existe.\n' "$file"; return 1; }

    awk '
        function trim(s) { sub(/^[[:space:]]+/, "", s); sub(/[[:space:]]+$/, "", s); return s }
        BEGIN { valid["PENDING"]=1; valid["IN_PROGRESS"]=1; valid["COMPLETED"]=1
                valid["FAILED"]=1; valid["UNVERIFIED"]=1; valid["BLOCKED"]=1 }
        /^#*[[:space:]]*feature:/ {
            idx++
            nm = $0; sub(/^#*[[:space:]]*feature:/, "", nm)
            names[idx] = trim(nm)
            if (names[idx] == "") printf "Feature #%d no tiene nombre.\n", idx
            next
        }
        idx > 0 && /^[[:space:]]*status:/ && status[idx] == "" {
            v = $0; sub(/^[[:space:]]*status:/, "", v); status[idx] = trim(v)
        }
        idx > 0 && /^[[:space:]]*id:/ && fid[idx] == "" {
            v = $0; sub(/^[[:space:]]*id:/, "", v); fid[idx] = trim(v)
        }
        idx > 0 && /^[[:space:]]*acceptance:/ { acc[idx] = 1 }
        END {
            if (idx == 0) { print "No encontré ninguna feature (falta \"## feature: <nombre>\")."; exit }
            for (i = 1; i <= idx; i++) {
                if (status[i] == "")            printf "Feature #%d (%s): falta \"status:\".\n", i, names[i]
                else if (!(status[i] in valid)) printf "Feature #%d (%s): status \"%s\" inválido.\n", i, names[i], status[i]
                if (fid[i] == "")               printf "Feature #%d (%s): falta \"id:\".\n", i, names[i]
                else if (seen[fid[i]]++)        printf "Feature #%d (%s): id \"%s\" duplicado.\n", i, names[i], fid[i]
                if (!acc[i])                    printf "Feature #%d (%s): falta la lista \"acceptance:\".\n", i, names[i]
            }
        }
    ' "$file"
}

spec_is_valid() {
    [ -z "$(spec_validate "${1:-$SPEC_FILE}")" ]
}
