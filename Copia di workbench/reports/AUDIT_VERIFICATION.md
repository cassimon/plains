# Plains — Verifica e prioritizzazione dell'audit iniziale

> Riferimento: `reports/INITIAL_AUDIT.md`. Questo documento **corregge e verifica** i
> rilievi precedenti senza ripeterli; rileggere l'altro report per il contesto
> architetturale completo.
>
> Metodo: sola ispezione statica. Nessun test eseguito, nessun servizio avviato,
> nessuna modifica a codice/dati persistenti.

---

## 1. Baseline esatta

- Repository: **Plains** (`cassimon/plains`).
- Branch: **`matteo/development`**, working tree **pulito**.
- Commit: **`5e312860fa00bb84180cbe34ecb1df80f5291012`**
  (`fix NOMAD URL and USER_REGISTRATION in .env.example`, 2026-07-22).
- `workbench/` escluso via `.git/info/exclude`, nessun file tracciato al suo interno.

Ogni analisi futura può essere confrontata con questo SHA.

---

## 2. Verifica della persistenza

Sono stati riesaminati `HttpBackend.save()`, `syncToBackend()`, `persistDirtyState()`,
`captureServerIds()`, i watchdog di salvataggio e la riconciliazione delete.

### 2.1 Meccanismi richiesti: presenti o assenti?

| Meccanismo | Stato | Evidenza |
|-----------|-------|----------|
| Serializzazione tipo `saveChain` | **ASSENTE** | Nessun queue/chain di salvataggi. L'unica "guardia" è il flag `dirtyRef` letto/scritto in modo sincrono in `persistDirtyState()` (`AppContext.tsx:1556-1568`). Due `syncToBackend` sovrapposti (es. debounce + `visibilitychange` + `restoreUnloadBackup`) non sono esplicitamente serializzati. |
| Ripristino del dirty-state in caso di errore | **ASSENTE** | `persistDirtyState` imposta `dirtyRef.current = false` **prima** di `await backend.save(...)` e non lo ripristina se il salvataggio fallisce. |
| Capture degli ID server dallo snapshot sincronizzato con successo | **PRESENTE** | `captureServerIds()` è chiamata solo in fondo a `syncToBackend()` (`backend.ts:956`), cioè solo se tutte le richieste sono andate a buon fine. |
| Retry automatico | **ASSENTE** | Nessun retry/backoff. L'intervallo periodico (30 s) chiama `persistDirtyState`, che è un no-op se `dirtyRef` è false. |

### 2.2 Propagazione e ripristino degli errori

- `HttpBackend.save()` avvolge `syncToBackend()` in `try/catch` e **inghiotte** l'errore
  (solo `console.error`), quindi `persistDirtyState` non vede mai una rejection.
- `syncToBackend()` **non è atomica**: procede per entità con `await` sequenziali e
  lancia alla prima richiesta non recuperabile. `upsert()` recupera solo 404 (su
  update) e 400/409/500 (su create), `deleteRemoved()` solo 404.
- Conseguenza concreta: se il salvataggio fallisce a metà, `this.data` contiene già il
  nuovo snapshot (assegnato a inizio `save()`), mentre `serverIds` resta quello
  dell'ultimo sync riuscito. Il `upsert` successivo recupera via fallback 409→PUT,
  quindi il sistema tende ad auto-correggersi, ma lo stato interno diverge fino al
  prossimo successo.

### 2.3 Classificazione dei rilievi

**A. Perdita dati dimostrabile dall'implementazione (finestra ristretta)**

Sequenza: (1) un singolo edit → `scheduleSave` marca `dirty=true`; (2) dopo 2,5 s il
salvataggio parte e fallisce (es. rete assente); (3) `dirty` è già `false`; (4) l'utente
chiude la scheda → il watchdog `beforeunload` scrive il backup **solo se `dirty` è true**
(`AppContext.tsx:2074`) → nessun backup; l'edit è perso (resta solo un `console.error`).

Questo **non era** nel report iniziale. È una perdita *dimostrabile* dal codice, ma con
finestra stretta e mitigazioni parziali: `visibilitychange` forza un flush (e re-marca
dirty), l'intervallo 30 s salva se c'è dirty pendente, e un ulteriore edit ri-triggera il
salvataggio. Non c'è perdita se l'utente continua a lavorare o se il salvataggio riesce.

**B. Rischi di concorrenza (richiedono riproduzione runtime)**

Il report iniziale parlava di "sessioni che si sovrascrivono a vicenda". Verifica più
precisa:

- La **delete-reconciliation è per-sessione**: `deleteRemoved()` itera solo
  `this.serverIds[type]`, che riflette lo snapshot *della sessione*. Una sessione A non
  cancella le entità create da una sessione B (non presenti nei suoi `serverIds`).
- Le **entità eliminate** da A sono protette: una B stantia che le ri-upserta non le fa
  riapparire, perché il Trash le nasconde da `/state/bulk`.
- Il rischio residuo reale è **last-writer-wins sulle entità condivise**: ogni salvataggio
  ri-upserta *tutte* le entità dello snapshot, quindi un edit concorrente di B su
  un'entità che A possiede nello snapshot viene sovrascritto dal successivo salvataggio
  di A. Non è una cancellazione di massa, è una sovrascrittura di modifiche concorrenti.
  Richiede riproduzione runtime per quantificarne la gravità d'uso.

**C. Comportamenti già protetti** (non erano difetti): `captureServerIds` dal sync
riuscito, fallback `upsert`, delete solo soft-delete, skip dei risultati orfani,
tolleranza FK delle substrate-dimensions, backup `beforeunload` + `restoreUnloadBackup`
(finestra 30 min), esclusione dei risultati incompleti da ogni snapshot.

**D. Miglioramenti opzionali** (non necessari): aggiunta di un retry/ripristino del
dirty-state su errore e di una vera serializzazione dei salvataggi.

---

## 3. Rischio migrazioni database

Riesaminati `init_db()`, `prestart.sh`, `backend/app/alembic/` e i modelli.

- **Confermato**: `prestart.sh` esegue solo `backend_pre_start.py` + `initial_data.py`;
  `initial_data.py` chiama `init_db()` che usa `SQLModel.metadata.create_all` + DDL ad
  hoc (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`).
- **Nuova evidenza**: la history Alembic (24 revisioni) **non contiene** `step_ref`,
  le colonne trash `root_entity_type`/`root_entity_id`/`original_collection_id`, né la
  tabella `trash_entry`. Cioè la catena Alembic è **già divergente** dal modello attuale.
- `alembic/env.py` è funzionante (`target_metadata = SQLModel.metadata`, URL da settings).

**Conclusione corretta rispetto all'audit iniziale**: non c'è evidenza di una
**incompatibilità di schema attuale** — `create_all` + i DDL ad hoc di `init_db` (eseguiti
a ogni avvio) coprono sia i DB nuovi sia le colonne note dei DB esistenti. Il problema è
un **rischio di manutenzione futura**, non un difetto attivo oggi:

1. una nuova colonna su `models.py` **non** arriverà ai deployment esistenti se non viene
   aggiunta manualmente ai DDL di `init_db` (meccanismo fragile, senza test);
2. la history Alembic è orfana/divergente: riabilitarla richiede una **riconciliazione**
   (le revisioni mancano di colonne già presenti via DDL ad hoc), non un semplice
   `alembic upgrade head`.

**Non raccomando** di riabilitare automaticamente Alembic senza prima verificare la
compatibilità con i deployment esistenti e la divergenza della history.

---

## 4. Materiali e soluzioni

Distinzione che il report iniziale aveva appiattito:

- **Entità di dominio (`lab_material`, `lab_solution`) — VIVE e usate dal backend/NOMAD**:
  - `chemicals_materialization.materialize_experiment_chemicals()` è chiamata da
    `routes/nomad.py` a ogni upload;
  - `create_nomad_metadata_yaml()` legge `LabMaterial`/`LabSolution` per generare le
    entità NOMAD (`PlainsMaterial`/`PlainsSolution`);
  - il client generato espone `MaterialsService`/`SolutionsService` (endpoint nell'API).
- **Codice UI di gestione entità — MORTO/obsoleto (irraggiungibile)**:
  - `Materials.page.tsx`/`Solutions.page.tsx` ritornano `null`, senza route e fuori nav;
  - `newMaterial`/`newSolution` mai chiamati; i tipi `Material`/`Solution` sono importati
    solo come *type* in `Processes.page.tsx` per tipizzare array sempre vuoti;
  - lo snapshot frontend non include materiali/soluzioni e `bulkToSnapshot` li ignora.
- I "chemicals" della GUI vivono in `experiment.chemicals_prep` (JSONB) + materiali
  inline/ricette del processo, **non** nelle entità `Material`/`Solution`.

**Conclusione**: la pulizia è **sicura solo** per i file UI morti (pagine, factory, tipi e
import type-only). Le tabelle backend e il servizio di materializzazione **non vanno
toccati**: sono carichi di significato per l'export NOMAD.

---

## 5. Funzionalità scientifica

### 5.1 Mappa migliorata

| Area | Funzioni rilevanti | Assunzioni implementate |
|------|--------------------|-------------------------|
| Concentrazioni/unità | `lib/solutionConcentration.ts` (`soluteVolumeMl`, `soluteMoles`, `soluteMassG`, `resolveSolution`, `concentrationSummary`) | densità in g/mL, massa molare in g/mol; molarità su base solvente/totale; %w/w; `totalPbX2` = somma degli alogenuri di piombo (CID 24931/139549/24459 + regex `pb(i2|br2|cl2)`). |
| Stock solution | `lib/stockSolutions.ts` (`deriveStockVolumes`, `reconstructStockModel`) | `volumeMl` autoritativo; ratio derivati dal totale. |
| Trasformazioni processo/esperimento | `backendMapping.ts`, `-Experiments.chemicals.tsx` (`collectChemicals`), `chemicals_materialization.py` | chemicals raccolti da step inline + ricette, con override da `chemicals_prep`; materializzazione idempotente su `(owner_id, inventory_label)`. |
| Stack/architettura | `lib/stackDivergence.ts`, `ProcessGeneratedStack*` | combinazioni di strati da stadi/alternative. |
| Tempi di processazione | `lib/processingTimes.ts` | per-stack ownership, divergenza, pseudo-stage finale. |
| Parsing file di misura | `Results.page.tsx::parseTxtContent` | regex per PCE/Voc/Jsc/FF; tipo da substring (JV/IPCE/stabilità/UV-Vis); FF normalizzato `≤1 → ×100`; Jsc assunto in mA/cm²; data solo `YYYY-MM-DD`. |
| JV/EQE/stabilità → NOMAD | `services/nomad.py` (`_jv_section`, `_best_jv`, `_best_ipce`, `_fill_factor_fraction`, `_measurement_runs`, tabelle unità ~righe 448-486) | `light_spectra = AM 1.5G`; `light_intensity` default 100 mW/cm² (1 sun); FF da percentuale a frazione; Jsc da IPCE come fallback. |

**Test esistenti** (non eseguiti in questa sessione): `solutionConcentration.test.ts`,
`stockSolutions.test.ts`, `stackDivergence.test.ts`, `processingTimes.test.ts`, e backend
`test_nomad_measurement_conditions.py`, `test_nomad_metadata_generation.py`,
`test_nomad_perovskite_coefficients.py`, `test_nomad_quenching.py`,
`test_nomad_entities.py`, `test_nomad_deposition_timeline.py`, ecc.

### 5.2 Inconsistenze concrete tra modello e trasformazioni

**1. [CONFIRMED — statico] `soluteVolumeMl` per unità `mol` è 1000× troppo piccola.**

`frontend/src/lib/solutionConcentration.ts:8-14`:

```ts
if (s.unit === "mg" && s.density) return amt / (s.density * 1000)
if (s.unit === "mol" && s.molarMass && s.density)
  return (amt * s.molarMass) / (s.density * 1000)
```

Analisi dimensionale (densità in g/mL, molarMass in g/mol):
- `mg`: `amt/1000` converte mg→g, poi `/densità` → mL. **Corretto.**
- `mol`: `amt * molarMass` è già in **grammi**; dividere per `densità * 1000` dà
  **mL/1000**, cioè un volume 1000× troppo piccolo. Dovrebbe essere
  `(amt * molarMass) / density`.

Impatto: modesto — influenza solo la molarità su base *totale* (il contributo del solido
al volume totale) per soluti espressi in `mol` con densità valorizzata. Non coperto dai
test: tutti i fixture `mol` in `solutionConcentration.test.ts` omettono `density`, quindi
`return null` e il ramo non è mai esercitato. L'unità `mol` e il campo `density` sono
entrambi selezionabili nella UI (`SOLUTE_UNITS = ["mg","ml","mol"]`, campo densità
precompilato da PubChem), quindi il ramo è raggiungibile.

**2. [QUESTION] Asimmetria FF/PCE nell'export NOMAD.**

`services/nomad.py::_fill_factor_fraction` converte la FF da percentuale a frazione
(`25.38 → 0.2538`), ma `default_PCE` viene passato **così com'è** (es. `3.67`). Il test
`test_the_sample_states_the_fill_factor_as_a_fraction` asserisce esplicitamente
`default_FF == 0.3261` e `default_PCE == 3.67`. Se nel schema NOMAD
(`perovskite_solar_cell_database`) `default_PCE` ha la stessa semantica *frazione* di
`default_FF`, la PCE risulterebbe 100× troppo grande (367%). Non ho la definizione dello
schema NOMAD nel repo per concludere; `working_extend.archive.yaml` mostra esempi
contraddittori (`default_FF: 80`, `default_PCE: 13`). **Va verificato contro lo schema
NOMAD** prima di dichiararlo bug.

### 5.3 Assunzioni da validare col dominio (non conclusioni)

- Jsc assunto sempre in mA/cm² (nessuna conversione di unità nel parser frontend).
- Illuminazione di default 100 mW/cm² (1 sun, AM 1.5G) quando assente.
- Euristiche di riconoscimento tipo-file per substring e di normalizzazione FF (`≤1 →
  ×100`), che possono dare falsi positivi/negativi su file non standard.
- Correttezza dei CID degli alogenuri di piombo e della logica `totalPbX2`.

---

## 6. Priorità rivalutate

Ordinate per rischio-dati, conseguenza scientifica, impatto utente, confidenza e
costo/rischio di regressione.

1. **[VERIFICA — alta conseguenza scientifica, costo minimo]** Chiarire le unità di
   FF/PCE contro lo schema NOMAD (`default_PCE` frazione o percentuale?). Se PCE è
   frazione, è un bug che altera l'efficienza in **tutti** gli export NOMAD.
2. **[CORREZIONE — confidenza alta, costo minimo]** Correggere `soluteVolumeMl` per
   unità `mol` (rimuovere il `/1000` spurio) e aggiungere un test con `mol` + `density`.
3. **[DECISIONE — protegge i deployment esistenti]** Decidere e documentare la strategia
   migrazioni (ripristino Alembic previa riconciliazione, oppure formalizzazione dei DDL
   di `init_db`). Oggi è un rischio futuro, ma la decisione costa poco adesso.
4. **[DATI — finestra stretta]** Ripristino del dirty-state su salvataggio fallito
   (e/o retry) per chiudere la perdita di un singolo edit in caso di errore + chiusura.
5. **[CONFIG — limitato]** `frontend/.env` tracciato: verificare la presenza di segreti
   (non letto qui). Bassa priorità finché non si accerta la presenza di valori sensibili.
6. **[OPZIONALE]** Pulizia UI morta Materiali/Soluzioni (solo file UI), consolidamento
   dei due client HTTP, estrazione dei componenti monolitici.

---

## 7. Limitazioni della verifica

- Nessun test eseguito (suite che richiedono Docker/Postgres; alcuni script usano
  `down -v` sul DB di sviluppo).
- I rilievi di concorrenza (last-writer-wins) e la finestra di perdita singolo-edit non
  sono stati riprodotti a runtime; sono dedotti dal codice.
- L'eventuale bug PCE è un QUESTION: manca la definizione dello schema NOMAD.
- `frontend/.env` non letto per regola; il suo contenuto resta ignoto.
