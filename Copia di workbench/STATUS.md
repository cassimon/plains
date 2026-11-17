# Status

> Ultimo aggiornamento: verifica dell'audit completata (branch `matteo/development`).

## Baseline

- Repository: **Plains** (`cassimon/plains`).
- Branch: **`matteo/development`**, working tree **pulito**.
- Commit: **`5e312860fa00bb84180cbe34ecb1df80f5291012`** (2026-07-22).
- `workbench/` escluso via `.git/info/exclude`.

## Analisi completata

1. **Audit architetturale iniziale** → `reports/INITIAL_AUDIT.md`.
2. **Verifica e prioritizzazione** → `reports/AUDIT_VERIFICATION.md`.

## Esito della verifica (sintesi)

Rilievi iniziali **confermati**: pagine Materiali/Soluzioni morte nella GUI;
snapshot frontend senza materiali/soluzioni; `frontend/.env` tracciato; Alembic non
eseguito in `prestart` (schema via `create_all` + DDL ad hoc).

Rilievi **corretti/ridimensionati**:

- Migrazioni: nessuna **incompatibilità attuale** dimostrata; è un rischio di
  manutenzione **futura** (history Alembic già divergente: mancano `step_ref`, colonne
  trash, tabella `trash_entry`). Non riabilitare Alembic senza riconciliazione.
- Materiali/Soluzioni: le **entità backend** (`lab_material`/`lab_solution` +
  materializzazione NOMAD) sono **vive**; è morto solo il **codice UI** (pagine/factory).
- Concorrenza: non è cancellazione di massa, è **last-writer-wins** sulle entità
  condivise (delete-reconciliation per-sessione; il Trash protegge le delete).

Nuovi rilievi dimostrati:

- [CONFIRMED] `soluteVolumeMl` per unità `mol` è **1000× troppo piccola**
  (`solutionConcentration.ts`); non coperta dai test.
- [CONFIRMED] Finestra di perdita di un singolo edit: salvataggio fallito ⇒ `dirty=false`
  ⇒ `beforeunload` non scrive il backup ⇒ edit perso (mitigata da `visibilitychange`/
  intervallo/next-edit).
- [QUESTION] Asimmetria FF/PCE nell'export NOMAD (`default_FF` in frazione,
  `default_PCE` in percentuale): da verificare contro lo schema NOMAD.

## Prossimi passi immediati

1. Verificare le unità di FF/PCE contro lo schema NOMAD.
2. Correggere `soluteVolumeMl` (unità `mol`) + test di regressione.
3. Decidere la strategia migrazioni (Alembic riconciliato oppure DDL `init_db`
   formalizzati).

**Nessun test eseguito** (suite con Docker/Postgres o `down -v` sul DB di sviluppo).
