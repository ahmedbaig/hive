import type { FileTransfer } from '@hive/shared';
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { bytes, relative, truncate } from '../format.js';
import { useHive } from '../store.js';
import { Icon } from './Icon.js';

/**
 * The fleet's shared drop box.
 *
 * Agents put artifacts here and read them back through the MCP tools — either
 * whole, or a byte range at a time when the file is large enough that reading
 * it whole would cost more context than the answer is worth.
 */
export function Files(): JSX.Element {
  const [files, setFiles] = useState<FileTransfer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ file: FileTransfer; text: string } | null>(null);
  const toast = useHive((s) => s.toast);

  const refresh = (): void => {
    void api
      .files()
      .then(({ files: list }) => setFiles(list))
      .catch((err: unknown) => setError(String(err)));
  };

  useEffect(refresh, []);

  const upload = (file: File): void => {
    setBusy(true);
    setError(null);
    void api
      .upload(file, null)
      .then((stored) => {
        refresh();
        toast({
          kind: 'success',
          text: stored.deduped
            ? `${stored.filename} — identical bytes were already stored, reused`
            : `${stored.filename} shared`,
        });
      })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setBusy(false));
  };

  const remove = (file: FileTransfer): void => {
    void api
      .deleteFile(file.id)
      .then(() => {
        setFiles((prev) => prev.filter((f) => f.id !== file.id));
        toast({ kind: 'info', text: `${file.filename} removed` });
      })
      .catch((err: unknown) => toast({ kind: 'danger', text: String(err) }));
  };

  /** First 32 KB, the same window the agents' range read hands a model. */
  const openPreview = (file: FileTransfer): void => {
    void api
      .fileRange(file.id, 0, 32_768)
      .then(({ chunk }) => {
        if (chunk.text === null) {
          toast({ kind: 'info', text: `${file.filename} is binary — download it instead` });
          return;
        }
        setPreview({ file, text: chunk.text });
      })
      .catch((err: unknown) => toast({ kind: 'danger', text: String(err) }));
  };

  return (
    <div className="pane">
      <div className="toolbar">
        <strong>Shared files</strong>
        <span className="spacer" />
        <label className="upload-btn">
          <Icon name="upload" size={15} />
          {busy ? 'Uploading…' : 'Upload'}
          <input type="file" disabled={busy} onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload(file);
            e.target.value = '';
          }} />
        </label>
        <button className="ghost tiny" onClick={refresh} aria-label="Refresh">
          <Icon name="refresh" size={15} />
        </button>
      </div>

      {error && <div className="form-error">{error}</div>}
      {files.length === 0 && <div className="empty">Nothing shared yet.</div>}

      {files.map((file) => (
        <div key={file.id} className="file-row">
          <div className="file-icon">
            <Icon name="folder" size={18} />
          </div>
          <div className="file-meta">
            <div className="file-name">{file.filename}</div>
            <div className="file-sub">
              {file.uploadedByName} · {relative(file.uploadedAt)} · {bytes(file.size)} · {file.mime}
              {file.deduped && ' · deduped'}
            </div>
            {/* Agents verify integrity against this before acting on the bytes. */}
            <div className="mono muted file-hash" title={file.sha256}>
              sha256:{truncate(file.sha256, 24)} · id {file.id}
            </div>
          </div>
          <div className="file-actions">
            <button className="icon-btn" title="Preview as text" onClick={() => openPreview(file)}>
              <Icon name="thread" size={17} />
            </button>
            <a className="icon-btn" href={`/api/files/${file.id}`} download title="Download">
              <Icon name="download" size={17} />
            </a>
            <button className="icon-btn danger-text" title="Remove" onClick={() => remove(file)}>
              <Icon name="trash" size={17} />
            </button>
          </div>
        </div>
      ))}

      {preview && (
        <div className="modal-backdrop" onClick={() => setPreview(null)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <div className="row">
              <h3>{preview.file.filename}</h3>
              <span className="spacer" />
              <button className="bare" aria-label="Close" onClick={() => setPreview(null)}>
                <Icon name="close" size={18} />
              </button>
            </div>
            <pre className="file-preview">{preview.text}</pre>
            <div className="hint">
              First 32 KB — the same window an agent gets from one range read.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
