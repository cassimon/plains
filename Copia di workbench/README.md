# Workbench personale — `matteo/development`

Questo directory è lo spazio di lavoro **personale** per l'analisi indipendente del
progetto **Plains** (branch `matteo/development`). Non contiene codice applicativo,
non modifica file tracciati e non fa parte del repository Git: è escluso tramite
`.git/info/exclude` (riga `/workbench/`).

## Scopo

- Tenere traccia delle attività di **analisi**, **audit** e **investigazione**
  senza toccare il codice dell'applicazione.
- Fornire un punto di riferimento stabile tra una sessione e l'altra.
- Mantenere una separazione netta fra *osservazioni*, *proposte* e *decisioni
  approvate*: nulla di ciò che è scritto qui è vincolante per il progetto finché
  non viene esplicitamente approvato e trasformato in una modifica al codice.

## Convenzioni per le sessioni future

1. **Politica operativa: in modalità analisi la lettura è di default e non si modifica
   nulla.** Le sessioni di analisi/audit sono *read-only*: non si tocca codice
   applicativo, test, dipendenze o configurazione. Le modifiche al codice sono
   consentite **solo** se il compito è stato esplicitamente autorizzato, e **solo entro
   lo scope approvato** di quel compito (mai di più, mai altrove).
2. **Non leggere né esporre** credenziali, token, `.env` privati o dati di ricerca
   sensibili (in particolare `frontend/.env`, `.nomad_auth`, dump in `db_backups/`).
3. **Non eseguire** comandi distruttivi, migrazioni, import o chiamate API esterne.
   Non avviare Docker e non eseguire `pytest` direttamente contro lo stack di
   sviluppo (vedi `CLAUDE.md` per i rischi sul database).
4. Ogni nuova indagine produce al massimo **un** documento in `reports/`: evitare
   documenti duplicati o sovrapposti.
5. Le etichette usate nei report sono: **CONFIRMED**, **RISK**, **QUESTION**,
   **IMPROVEMENT**. Non gonfiare la severità dei rilievi.
6. Tutta la documentazione è in **italiano**, preservando i termini tecnici
   originali (nomi di file, classi, funzioni, framework).

## Relazione fra i file

| File | Contenuto |
|------|-----------|
| `README.md` | Questo file: scopo e convenzioni. |
| `STATUS.md` | Stato corrente, analisi completate, prossimi passi immediati. Da aggiornare a ogni sessione. |
| `TODO.md` | Elenco prioritizzato di lavoro concreto, con distinzione *proposto* / *approvato*. |
| `DECISIONS.md` | Decisioni tecniche effettivamente prese e relative motivazioni. **Mai** presentare una proposta come decisione approvata. |
| `NOTES.md` | Osservazioni brevi, domande aperte, informazioni di contesto utili. |
| `reports/` | Audit e indagini sostanziali. Il report iniziale è `reports/INITIAL_AUDIT.md`. |

## Regole di coerenza

- **TODO** elenca solo lavoro *azionabile*: non trasformare ogni osservazione in un
  task di implementazione.
- **DECISIONS** resta vuoto finché non c'è una decisione reale (con chi decide e
  perché).
- **STATUS** è il riassunto più aggiornato; i report sono l'evidenza di dettaglio.
- Prima di chiudere una sessione: verificare `git status`, confermare che nessun file
  tracciato sia stato modificato, che il branch sia ancora `matteo/development` e che
  `workbench/` resti ignorato.
