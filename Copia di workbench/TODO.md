# TODO

Legenda: **[PROPOSTO]** = suggerito, non ancora approvato · **[APPROVATO]** = autorizzato.

## Priorità alta

1. [PROPOSTO] **Verificare le unità di FF/PCE contro lo schema NOMAD**
   (`perovskite_solar_cell_database`). `_fill_factor_fraction` converte la FF in
   frazione ma `default_PCE` resta in percentuale (`services/nomad.py`). Se
   `default_PCE` è una frazione, l'efficienza negli export NOMAD è 100× errata.
2. [PROPOSTO] **Correggere `soluteVolumeMl` per unità `mol`**
   (`frontend/src/lib/solutionConcentration.ts`): rimuovere il `/1000` spurio
   (`(amt * molarMass) / density`) e aggiungere un test con `mol` + `density`.
3. [PROPOSTO] **Decidere la strategia migrazioni**: ripristino Alembic previa
   riconciliazione della history divergente, oppure formalizzazione dei DDL di
   `init_db` come unico meccanismo + documentazione. Non riabilitare Alembic alla cieca.

## Priorità media

4. [PROPOSTO] **Ripristino del dirty-state su salvataggio fallito** (e/o retry) in
   `persistDirtyState`/`HttpBackend.save`, per chiudere la perdita del singolo edit
   (errore di rete + chiusura tab).
5. [PROPOSTO] **Verificare `frontend/.env`** (con chi ha accesso): se contiene segreti,
   rimuoverlo dall'indice Git. *Non leggere il file.*

## Priorità bassa (opzionale)

6. [PROPOSTO] Rimuovere il **solo** codice UI morto Materiali/Soluzioni (pagine,
   `newMaterial`/`newSolution`, import type-only); **non** toccare tabelle backend né
   `chemicals_materialization`.
7. [PROPOSTO] Consolidare i due client HTTP (client OpenAPI generato + `fetch` in
   `HttpBackend`).
8. [PROPOSTO] Estrarre gradualmente i componenti pagina monolitici, un modulo alla
   volta, senza cambiare comportamento.

## Non trasformare in task

- Osservazioni minori e preferenze stilistiche; nessun refactoring ampio senza evidenza.
