# Plains — Audit iniziale del codebase

> Branch analizzato: `matteo/development`
> Metodo: sola ispezione statica (lettura di sorgente, configurazione e documentazione).
> Nessun test eseguito, nessun servizio avviato, nessuna modifica al codice applicativo.
> Le conclusioni che dipendono da comportamento a runtime sono indicate esplicitamente.

---

## 1. Executive summary

**Plains** è un'applicazione full-stack per la gestione di laboratorio dedicata alla
ricerca su celle solari a perovskite. Copre il flusso
*Materiali → Soluzioni → Processi/Esperimenti → Risultati* e si integra con il
repository scientifico **NOMAD** per l'upload dei dati di ricerca.

Lo stack è **FastAPI (Python) + React 19 (TypeScript) + PostgreSQL**, orchestrato con
Docker Compose. Il backend è normalizzato (una tabella per entità, FK con cascate,
UUID generati anche lato client), il frontend mantiene uno *snapshot* denormalizzato in
memoria e lo riconcilia verso il backend tramite REST.

Il codebase è **maturo e curato**: è evidente un lavoro continuo di hardening
(sicurezza, soft-delete, robustezza dell'upload NOMAD, guardie anti-loop React). Le
aree di attenzione non riguardano l'impianto generale ma alcuni punti specifici:
componenti frontend molto grandi, un meccanismo di migrazione schema *de facto* basato
su `create_all` + DDL ad hoc (con una history Alembic non applicata automaticamente),
una persistenza full-snapshot che non è sicura per sessioni concorrenti sullo stesso
account, e residui di un dominio "Materiali/Soluzioni" ormai non più gestito dalla GUI.

**Giudizio complessivo**: architettura solida e difendibile; i rischi principali sono
legati a *manutenibilità* e *migrazioni schema*, non a difetti dimostrati di
correttezza dei dati.

---

## 2. Architettura

### 2.1 Backend — `backend/`

- **Framework**: FastAPI (`backend/app/main.py`), SQLModel/SQLAlchemy + psycopg su
  PostgreSQL.
- **Entry point**: `app/main.py` — CORS, Sentry, middleware header di sicurezza,
  handler `IntegrityError → 409`, rate limiting (slowapi), registrazione dei router.
- **Router**: `app/api/main.py` registra `login, users, utils, materials, solutions,
  processes, experiments, results, analyses, planes, plane_folders, state, trash,
  nomad` (+ `private` solo in ambiente `local`).
- **Modelli**: `app/models.py` (≈1590 righe) — definisce per ogni entità le varianti
  `Base / Create / Update / Public / table=True`. Le PK sono UUID; molti *Create*
  ereditano da `ClientIdCreate` per accettare UUID generati dal client.
- **Persistence helpers**: `app/crud.py` — CRUD per entità; `app/api/query.py`
  centralizza *owner-scoping* e *esclusione dal cestino* (`visible()`, `trashed_ids()`).
- **Autenticazione**: `app/api/deps.py` — JWT locale (HS256) oppure verifica token
  NOMAD (RS256 via JWKS) quando `NOMAD_OAUTH_ENABLED`; whitelist email
  (`ALLOWED_EMAILS`) come choke-point unico.
- **Configurazione**: `app/core/config.py` (pydantic-settings, `.env` un livello sopra
  `backend/`). Include guardie per segreti placeholder/brevi e forzatura dell'OAuth in
  staging/production.

### 2.2 Frontend — `frontend/`

- **Framework**: React 19 + TypeScript + Vite; TanStack Router (file-based), React
  Query, React Table; Mantine (modals/notifications/dropzone) + shadcn/ui (Radix) +
  Tailwind CSS v4; ECharts per i grafici; pdf-lib per export/import PDF.
- **Entry point**: `frontend/src/main.tsx` — client React Query, router, guardia
  `vite:preloadError` (reload una tantum su chunk stantii), Toaster.
- **Stato**: `frontend/src/store/AppContext.tsx` (≈2765 righe) è il context centrale;
  tutte le mutazioni passano per un `BackendAdapter` (`frontend/src/store/backend.ts`).
- **Routing**: `routes/_gui/*.tsx` sono wrapper sottili che importano i componenti da
  `routes/*.page.tsx`. Navigazione: Organization, Processes, Experiments, Results,
  Analysis, Export (`components/AppLayout.tsx`).
- **Client API**: `src/client/` è generato da OpenAPI (non va modificato a mano).
  Viene usato per auth/admin/planes/nomad; lo snapshot dati usa invece `fetch` diretto
  dentro `HttpBackend`.

### 2.3 Dipendenze rilevanti

- Backend: `fastapi`, `sqlmodel`, `alembic` (presente ma non eseguito in `prestart`,
  vedi §4.4), `sentry-sdk`, `slowapi`, `pwdlib[argon2,bcrypt]`, `pyjwt`, `pyyaml`.
- Frontend: `keycloak-js` (SSO), `@tanstack/*`, `@mantine/*`, `echarts`, `pdf-lib`,
  `zod`, `react-hook-form`.
- NOMAD: integrazione via API REST + OAuth/Keycloak (`app/services/nomad.py`, ≈4800
  righe) e schemi YAML in `app/nomad/data_schemas/`.

**Coerenza d'uso**: i framework sono usati in modo coerente. Nota: convivono **due
livelli HTTP** (client OpenAPI generato basato su axios per auth/admin/planes/nomad e
`fetch` diretto in `HttpBackend` per lo snapshot). Non è un difetto ma un'asimmetria
da tenere presente (IMPROVEMENT, §9).

---

## 3. Flussi applicativi principali

1. **Login/bootstrap** — autenticazione (Keycloak o login locale), poi
   `GET /state/bulk` carica l'intero snapshot normalizzato; `backendMapping.ts`
   ricostruisce le forme ricche del frontend (inclusa l'appartenenza alle collection).
2. **Organizzazione (canvas)** — `Plane` + elementi canvas (collection, sticky note,
   text field); le collection aggregano processi/esperimenti/risultati/analisi.
3. **Processo** — definizione a *stadi* con *alternative* di step; ricette di soluzione
   (solventi/soluti/soluzioni aggiunte); generazione degli *stack* (combinazioni di
   strati) con formule perovskite A/B/X e HOMO/LUMO.
4. **Esperimento** — derivato da un processo; substrati, layer, tempi di processazione
   per stack, `chemicals_prep`.
5. **Risultati** — file di misura (JV/EQE/stabilità), raggruppamento in *device group*
   e assegnazione ai substrati.
6. **NOMAD upload** — materializzazione dei chemicals, creazione zip + YAML metadata,
   upload, log di audit (`nomad_upload_log`) e *stash* degli archivi falliti.
7. **Salvataggio** — salvataggio debounced dell'intero snapshot + riconciliazione
   create/update/delete verso il backend (vedi §4.3).

---

## 4. Modello dati e persistenza

### 4.1 Strutture dati principali

Definite in `backend/app/models.py`:

- `User`, `UserState` (solo preferenze UI in JSONB).
- `LabMaterial`, `LabSolution` (+ `SolutionComponent`) — inventario.
- `Process` + figli: `ProcessInlineSubstrate`, `ProcessSubstrateDimension`,
  `ProcessSolutionRecipe` (+ `RecipeSolvent`/`RecipeSolute`/`RecipeAddedSolution`),
  `ProcessStep`, `ProcessGeneratedStack`/`ProcessGeneratedStackLayer`.
- `Experiment` + `LabSubstrate`, `ExperimentMaterial`, `ExperimentSolution`.
- `ExperimentResults` + `MeasurementFile`, `DeviceGroup`.
- `Analysis` + `AnalysisRef`.
- `Plane` (+ `PlaneShare`), `PlaneFolder`, `DataCollection`, `StickyNote`, `TextField`.
- `NomadUploadLog` (log di audit denormalizzato, non legato via cascata).
- `TrashEntry` (soft-delete: marca l'id senza toccare l'entità).

Ogni entità ha una colonna `frontend_data` JSONB per stato UI flessibile. Le FK usano
`ondelete` a cascata o `SET NULL` in modo coerente.

### 4.2 Proprietà e ciclo di vita

- **Proprietà**: ogni entità è legata a `owner_id`; `visible()` garantisce che i non
  superuser vedano solo le proprie righe e che le righe cestinate non riemergano.
- **Soft-delete**: `services/trash.py` calcola la *chiusura verso il basso*
  (process → experiment → result) per il delete e *verso l'alto* per il restore; il
  restore ri-attacca il posizionamento (plane/collection) lato server.
- **Upload completati** (`nomad_upload_status == "SUCCESS"`) non vengono mai cestinati.

### 4.3 Caricamento, modifica, salvataggio e sincronizzazione

Questo è il punto più delicato del frontend.

- `HttpBackend.load()` fa `GET /state/bulk` e ricostruisce lo snapshot.
- Ogni mutazione aggiorna lo stato React; un effect debounced marca `dirty` e
  `persistDirtyState()` chiama `backend.save(stateRef.current)`.
- `HttpBackend.save()` esegue `syncToBackend()`: per ogni entità *upsert* (POST se
  nuova, PUT se nota, con recupero su 404/409/400), poi **delete-reconciliation**
  (le top-entity presenti nel set server ma assenti dallo snapshot vengono
  soft-delete via `POST /trash/`).
- **Watchdog**: `visibilitychange` forza un flush; `beforeunload` scrive un backup di
  emergenza sincrono in `localStorage` (`UNLOAD_BACKUP_KEY`), ripristinato al successivo
  `load()` e ri-pushato. I risultati *incompleti* (file senza `nomad.upload_id`) sono
  esclusi da ogni snapshot salvato.

### 4.4 Persistenza backend e gestione errori

- `init_db()` in `app/core/db.py` usa `SQLModel.metadata.create_all(engine)` e poi una
  serie di `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` per colonne aggiunte dopo il primo
  rilascio; esiste anche la rimozione esplicita di una FK legacy su
  `lab_substrate.substrate_material_id`.
- `prestart.sh` NON esegue più `alembic upgrade head` (chiama solo
  `backend_pre_start.py` + `initial_data.py`).
- Gli `IntegrityError` sono convertiti in **409** strutturati (`main.py`), evitando il
  problema dei 500 mascherati da errore CORS (documentato in `CLAUDE.md`).

### 4.5 Integrazione NOMAD

- `services/nomad.py`: token, zip sicuro, generazione YAML metadata
  (`create_nomad_metadata_yaml`), upload, status, cleanup archivi temporanei e *stash*
  persistente (volume Docker `nomad-stash`) con retention a una settimana.
- `services/chemicals_materialization.py`: materializza i chemicals dell'esperimento
  (`experiment.chemicals_prep`) nelle tabelle `lab_material`/`lab_solution` al momento
  dell'export.
- `services/pubchem_enrichment.py` / `pubchem.py`: arricchimento PubChem (formula
  molecolare, SMILES, InChI, massa) con cache e marcatura `pubchem_synced_cid`.

### 4.6 Concorrenza e interruzioni

- Il modello di salvataggio è **snapshot-intero**: due sessioni browser parallele sullo
  stesso account si sovrascrivono a vicenda tramite la delete-reconciliation. Questo è
  un **limite noto** (documentato in `CLAUDE.md` e nei test di integrazione, che per
  questo girano serialmente). È un RISK per l'uso multi-scheda, non un bug nuovo.

### 4.7 Salvaguardie contro perdita silenziosa di dati

- Watchdog `beforeunload` + `visibilitychange` + backup localStorage (30 min).
- Soft-delete (cestino) invece di delete distruttive per le top-entity.
- Risultati incompleti mai persistiti.
- `hardDeleteResults` solo per staging incompleti (best-effort).
- Guardie anti-loop e stabilizzazione dei ref Mantine (patch `@mantine/core`) per
  evitare crash React #185 (vedi `CLAUDE.md`).

**Nota critica**: le salvaguardie sopra mitigano bene la *perdita per chiusura tab*,
ma non risolvono il *conflitto* tra sessioni concorrenti (perdita per ultima scrittura).

---

## 5. Valutazione UI/frontend

### 5.1 Organizzazione e consistenza

- Navigazione laterale coerente (`AppLayout` + `Sidebar`); le pagine sono componenti
  separati ma **molto grandi**:
  - `Processes.page.tsx` ≈ 8060 righe
  - `Organization.page.tsx` ≈ 6664 righe
  - `Results.page.tsx` ≈ 4802 righe
  - `Experiments.page.tsx` ≈ 3773 righe
- La logica scientifica pura è stata correttamente estratta in `lib/` con test
  (`processingTimes`, `solutionConcentration`, `stockSolutions`, `stackDivergence`,
  `uploadFlow`, `pdfSchema`): segnale positivo.

### 5.2 Layout responsivo e usabilità

- Esistono hook per mobile (`useMobile`) e gestione sidebar mobile. Non ho potuto
  verificare il comportamento reale senza eseguire l'app.

### 5.3 Duplicazione logica UI

- La generazione dei layer/stack e l'inferenza del tipo di materiale sono concentrate
  in funzioni helper dentro `Processes.page.tsx` (≈2600 righe di helper), mantenute
  lontane dal rendering ma comunque nello stesso file.

### 5.4 Gestione errori e feedback

- Toaster Mantine per notifiche; `ErrorComponent`/`NotFound`; `UploadFlowStatus` per lo
  stato dell'upload; log strutturato nel backend (`logging`). Buona copertura.

---

## 6. Mappa della funzionalità scientifica

| Area | Dove | Note |
|------|------|------|
| Gestione dati sperimentali | `Process`/`Experiment`/`ExperimentResults` + models | Flusso completo processi→esperimenti→risultati. |
| Ricette e composizione soluzioni | `-Processes.chemistry.tsx`, `lib/solutionConcentration.ts`, `lib/stockSolutions.ts` | Calcolo molarità precursori PbX₂ (PbI₂/PbBr₂/PbCl₂), *folding* delle stock solution. |
| Stack e architettura device | `lib/stackDivergence.ts`, `ProcessGeneratedStack*` | Combinazioni di strati da stadi/alternative. |
| Tempi di processazione | `lib/processingTimes.ts` | Per-stack ownership, divergenza, pseudo-stage "fine esperimento". |
| Risultati e visualizzazione | `Results.page.tsx`, `Analysis.page.tsx` (ECharts) | File JV/EQE/stabilità, device group, strategie di grouping/matching. |
| Import/export | `lib/pdfSchema.ts` (v5, ladder migrazioni), `lib/processExport.ts`, `lib/pdfImport.ts` | PDF AcroForm round-trip versionato. |
| Export generico | `Export.page.tsx` | `ComingSoonGate` (stub, non implementato). |
| Calcoli e assunzioni | `lib/solutionConcentration.ts` (unità, densità, masse molari), `illumination_intensity` default 1 sun AM1.5G | Le assunzioni sono documentate nei commenti; **correttezza scientifica non verificata** (fuori scope di questo audit statico). |
| NOMAD | `services/nomad.py`, `nomad/data_schemas/`, `docs/plans/nomad-measurement-parsing.md` | Parsing file CHOSE e popolamento schema NOMAD; il piano documenta difetti storici nel popolamento degli archivi. |

**Aree che richiedono verifica più approfondita** (da non considerare conclusioni):
- correttezza dei calcoli di concentrazione/unità (`solutionConcentration.ts`);
- fedeltà del popolamento dello schema NOMAD per JV/EQE/stabilità (il piano
  `nomad-measurement-parsing.md` elenca difetti; non è stato verificato se siano stati
  tutti risolti nel branch corrente);
- correttezza della migrazione PDF (ladder in `pdfSchema.ts`).

---

## 7. Testing e manutenibilità

### 7.1 Test presenti

- Backend: **622** funzioni `test_*` in `backend/tests/` (route, servizi NOMAD,
  integrazione, sicurezza). Coverage configurata con `fail_under = 80`.
- Frontend: **18** spec Playwright (`frontend/tests/`), incluse integrazione su stack
  reale (`integration/`) e regressioni anti-loop (`create-objects-loops`,
  `plains-infinite-loops`).
- Test puramente funzionali con file `.test.ts` per le librerie di calcolo.

### 7.2 Limitazioni note

- **I test non sono stati eseguiti in questa sessione**: la suite backend richiede
  Docker/Postgres e gli script di test girano contro il progetto Compose con `down -v`
  (pericoloso per il database di sviluppo). Non ho avviato servizi né eseguito test.
- `tasks/status.md` riporta (sessione precedente, non riverificato qui) errori `mypy`
  a doppia cifra e la non-eseguibilità della suite backend in quell'ambiente.

### 7.3 Manutenibilità

- **CONFIRMED (IMPROVEMENT)** — Componenti pagina molto grandi (fino a ~8000 righe):
  aumentano il costo di modifica e il rischio di regressioni (la classe di bug
  "infinite loop / max update depth" è ampiamente documentata in `CLAUDE.md` proprio
  in questi file). Non è richiesto un rewrite, ma un'estrazione incrementale.
- **CONFIRMED (IMPROVEMENT)** — Coesistenza di due client HTTP (generato + `fetch`).
- Nessun marcatore `TODO`/`FIXME`/`HACK` nel sorgente: segnale di cura.

---

## 8. Difetti confermati

### 8.1 [CONFIRMED] Pagine Materiali/Soluzioni morte nella GUI

- **Evidenza**: `frontend/src/routes/Materials.page.tsx` e `Solutions.page.tsx`
  restituiscono `null`; non esistono wrapper in `routes/_gui/` per `materials`/
  `solutions`; la navigazione (`AppLayout.pages`) non li include. `newMaterial`/
  `newSolution` sono definiti in `AppContext.tsx` ma **mai chiamati**; `Material`/
  `Solution` sono importati in `Processes.page.tsx` solo per tipizzare
  `EMPTY_MATERIALS`/`EMPTY_SOLUTIONS` (sempre vuoti).
- **Conseguenza**: codice morto/obsoleto; il dominio Materiali/Soluzioni non è più
  gestito come entità di prima classe dalla GUI, ma esiste ancora lato backend e viene
  alimentato solo dalla materializzazione NOMAD (`chemicals_materialization.py`).
- **Priorità**: bassa (pulizia). Non è un bug funzionale.

### 8.2 [CONFIRMED] Lo snapshot frontend non include Materiali/Soluzioni

- **Evidenza**: `AppSnapshot` (`store/backend.ts`) contiene solo `experiments,
  processes, results, planes, folders`; `bulkToSnapshot()` ignora `bulk.materials` e
  `bulk.solutions` pur essendo presenti in `GET /state/bulk`.
- **Conseguenza**: l'inventario `lab_material`/`lab_solution` è scritto dal backend
  (materializzazione) ma non viene mai letto/sincronizzato dalla GUI. Coerente con
  §8.1, ma va tenuto presente se si reintroduce una vista Materiali/Soluzioni.
- **Priorità**: informativa/bassa.

### 8.3 [CONFIRMED] `frontend/.env` è tracciato in Git

- **Evidenza**: `git ls-files` contiene `frontend/.env` (103 byte); non è ignorato
  (il file è già nell'indice, quindi le regole di `.gitignore` non si applicano).
- **Conseguenza**: potenziale esposizione di configurazione. **Non ho letto il
  contenuto** (regola: non leggere file d'ambiente privati). Probabilmente contiene
  solo `VITE_API_URL`/`VITE_BASE_PATH` (non segreti), ma va verificato.
- **Priorità**: da verificare (QUESTION); se contiene solo variabili Vite pubbliche,
  può restare, altrimenti va rimosso dall'indice e aggiunto a `.gitignore` (intervento
  fuori da `workbench/`, da autorizzare).

### 8.4 [CONFIRMED] Migrazioni schema: `create_all` + DDL ad hoc, Alembic non eseguito

- **Evidenza**: `prestart.sh` non esegue `alembic upgrade head`; `initial_data.py`
  chiama `init_db()` che usa `create_all` + `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
  Esistono 24 revisioni Alembic in `backend/app/alembic/versions/` non applicate
  automaticamente.
- **Conseguenza**: `create_all` non altera tabelle esistenti; i database già esistenti
  ricevono nuove colonne solo se coperte dai DDL ad hoc in `init_db`. Rischio di drift
  tra la history Alembic e lo schema reale; le nuove colonne future non arriveranno ai
  deployment esistenti se non aggiunte manualmente a `init_db` o con un `alembic
  upgrade` manuale.
- **Priorità**: media (RISK operativo per deployment esistenti).

---

## 9. Rischi e questioni aperte

### RISK

1. **Perdita per ultima scrittura tra sessioni concorrenti** — il salvataggio
   full-snapshot con delete-reconciliation non gestisce due schede/utenti simultanei
   sullo stesso account (documentato; test di integrazione girano seriali per questo).
2. **Drift dello schema** — `create_all` vs history Alembic (vedi §8.4); rischio per
   deployment esistenti al prossimo cambio di modello.
3. **Componenti pagina monolitici** — `Processes/Organization/Results/Experiments`
   sono molto grandi; concentrano logica di rendering e di dominio, aumentando il
   rischio di regressioni (inclusa la classe di bug di loop React già storicamente
   ricorrente).

### QUESTION

1. `frontend/.env` contiene segreti? (non letto; va verificato da chi ha accesso).
2. Stato attuale dei difetti di popolamento NOMAD elencati in
   `docs/plans/nomad-measurement-parsing.md` — risolti o ancora presenti?
3. Correttezza scientifica dei calcoli di concentrazione/unità e delle assunzioni
   (illuminazione 1 sun, densità/molari) — richiede validazione di dominio, non
   verificabile staticamente.
4. Conteggio errori `mypy` riportato in `tasks/status.md` — non riverificato.

### IMPROVEMENT

1. Consolidare i due client HTTP (generato + `fetch`) su un unico percorso.
2. Estrarre progressivamente helper/pagine in moduli più piccoli.
3. Rimuovere il codice morto Materiali/Soluzioni (pagine, `newMaterial`/`newSolution`,
   tipi non più usati per dati reali) una volta confermato che non servono.

---

## 10. Priorità di sviluppo raccomandate

Ordinate per *protezione dei dati e del comportamento esistente*, non per estetica.

1. **Verificare `frontend/.env`** (senza leggerlo qui): se contiene segreti, rimuoverlo
   dall'indice. Azione piccola, indipendente, a basso rischio.
2. **Decidere la strategia di migrazione schema**: ripristinare Alembic in `prestart`
   oppure formalizzare i DDL ad hoc di `init_db` come unico meccanismo, e documentare
   la scelta. Protegge i deployment esistenti dal drift.
3. **Documentare/gestire la concorrenza multi-sessione**: quantomeno un avviso o una
   strategia (es. lock per utente, merge, o blocco di sessioni multiple) prima che un
   uso multi-scheda reale causi perdita di dati.
4. (Opzionale) **Pulizia del codice morto** Materiali/Soluzioni e riduzione graduale
   dei componenti monolitici — solo dopo i punti 1–3.

Nessuna di queste azioni va iniziata senza autorizzazione esplicita; questo documento è
solo l'esito dell'analisi.
