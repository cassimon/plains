// ─────────────────────────────────────────────────────────────────────────────
// dropFiles — extract every File from a drag-and-drop, recursing INTO folders.
//
// A dropped directory appears in `DataTransfer.files` as a single zero-byte
// entry named after the folder — its contents are only reachable through the
// non-standard-but-universally-supported `DataTransferItem.webkitGetAsEntry()`
// FileSystem API. That's why "Import from Upload" saw one substrate named after
// the folder instead of one per measurement file: the folder never got expanded.
//
// Browsers neuter `DataTransfer.items` the instant the drop handler returns (or
// yields to an `await`), so the entries MUST be snapshotted synchronously; only
// the recursive file reads are async. `filesFromDataTransfer` does exactly that:
// it reads the entries synchronously and hands back a Promise for the files.
// ─────────────────────────────────────────────────────────────────────────────

// Minimal structural types for the webkit FileSystem entry API — the DOM lib's
// FileSystemEntry types aren't reliably present/usable across TS configs.
type FsEntry = {
  isFile: boolean
  isDirectory: boolean
  file?: (
    onSuccess: (file: File) => void,
    onError?: (e: unknown) => void,
  ) => void
  createReader?: () => FsDirectoryReader
}
type FsDirectoryReader = {
  readEntries: (
    onSuccess: (entries: FsEntry[]) => void,
    onError?: (e: unknown) => void,
  ) => void
}

function readFile(entry: FsEntry): Promise<File | null> {
  return new Promise((resolve) => {
    if (!entry.file) {
      resolve(null)
      return
    }
    entry.file(
      (file) => resolve(file),
      () => resolve(null),
    )
  })
}

/** `readEntries` yields at most ~100 entries per call — pump it until empty. */
function readAllDirEntries(reader: FsDirectoryReader): Promise<FsEntry[]> {
  return new Promise((resolve) => {
    const all: FsEntry[] = []
    const pump = () => {
      reader.readEntries(
        (entries) => {
          if (entries.length === 0) {
            resolve(all)
            return
          }
          all.push(...entries)
          pump()
        },
        () => resolve(all),
      )
    }
    pump()
  })
}

async function collectFromEntry(entry: FsEntry, out: File[]): Promise<void> {
  if (entry.isFile) {
    const file = await readFile(entry)
    if (file) {
      out.push(file)
    }
    return
  }
  if (entry.isDirectory && entry.createReader) {
    const children = await readAllDirEntries(entry.createReader())
    for (const child of children) {
      await collectFromEntry(child, out)
    }
  }
}

/**
 * All files in a drop, with any dropped folders expanded recursively (each file
 * keeps its own base name, so file-name group recognition works). Falls back to
 * the flat `dataTransfer.files` when the FileSystem entry API isn't available, so
 * plain file drops keep working everywhere.
 *
 * MUST be called synchronously from the drop handler: it snapshots the entries
 * before the browser neuters the event's DataTransfer, then reads them async.
 */
export function filesFromDataTransfer(
  dataTransfer: DataTransfer,
): Promise<File[]> {
  const items = dataTransfer.items
  const entries: FsEntry[] = []
  if (items && items.length > 0) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.kind !== "file") {
        continue
      }
      const getAsEntry = (
        item as unknown as { webkitGetAsEntry?: () => FsEntry | null }
      ).webkitGetAsEntry
      if (typeof getAsEntry === "function") {
        const entry = getAsEntry.call(item)
        if (entry) {
          entries.push(entry)
        }
      }
    }
  }
  // No usable entries (API absent, or non-file items) — the flat FileList is all
  // we have. This also covers browsers without webkitGetAsEntry.
  if (entries.length === 0) {
    return Promise.resolve(Array.from(dataTransfer.files ?? []))
  }
  return (async () => {
    const out: File[] = []
    for (const entry of entries) {
      await collectFromEntry(entry, out)
    }
    return out
  })()
}
