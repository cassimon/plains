# Note

Osservazioni brevi, domande aperte e contesto utile raccolti durante le analisi.

## Contesto

- Baseline verificata: commit `5e312860fa00bb84180cbe34ecb1df80f5291012`
  (branch `matteo/development`), al 2026-07-22.
- Il repository porta molta storia documentata: `CLAUDE.md`, `tasks/status.md`
  (appartenente a un altro branch: contesto storico, non stato corrente),
  `docs/plans/*`.

## Osservazioni sulla persistenza

- `HttpBackend.save()` inghiotte gli errori (solo `console.error`); `persistDirtyState`
  azzera `dirtyRef` *prima* del salvataggio e non lo ripristina in caso di errore.
- `captureServerIds()` è chiamata solo a fine `syncToBackend()` (sync riuscito).
- Non esistono `saveChain`, retry o serializzazione esplicita dei salvataggi.
- La delete-reconciliation è per-sessione (itera i propri `serverIds`): una sessione non
  cancella le entità create da un'altra; le delete sono protette dal Trash.

## Osservazioni scientifiche

- `soluteVolumeMl` (unità `mol`) ha un `/1000` spurio: volume 1000× troppo piccolo.
- Export NOMAD: `default_FF` convertito in frazione, `default_PCE` lasciato in
  percentuale → asimmetria da chiarire con lo schema NOMAD.
- Parser file di misura (`Results.page.tsx::parseTxtContent`) basato su regex: Jsc
  assunto in mA/cm², FF normalizzato `≤1 → ×100`, tipo rilevato per substring.

## Domande aperte

- `default_PCE` nel schema NOMAD è frazione o percentuale?
- `frontend/.env` (tracciato, 103 byte) contiene segreti o solo variabili Vite?
- Quanto pesa realmente il caso multi-scheda sullo stesso account (last-writer-wins)?
- I difetti di popolamento NOMAD in `docs/plans/nomad-measurement-parsing.md` sono tutti
  risolti nel branch corrente? (il parser `parse_measurement_metadata` citato lì non
  esiste più nel codice attuale: il parsing è nel frontend `parseTxtContent`.)

## Regole rispettate

- Non letti `.env`, `.nomad_auth` o dump `db_backups/`.
- Nessun test eseguito, nessun Docker avviato, nessuna migrazione.
- Nessun file tracciato modificato.
