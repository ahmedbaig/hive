import type { FileTransfer } from '@hive/shared';
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { bytes, relative } from '../format.js';

/** Shared drop box. Agents fetch by id through the MCP tools. */
export function Files(): JSX.Element {
  const [files, setFiles] = useState<FileTransfer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = (): void => {
    void api
      .files()
      .then(({ files: list }) => setFiles(list))
      .catch((err) => setError(String(err)));
  };

  useEffect(refresh, []);

  const upload = (file: File): void => {
    setBusy(true);
    setError(null);
    void api
      .upload(file, null)
      .then(refresh)
      .catch((err) => setError(String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="pane">
      <div className="row" style={{ marginBottom: 12 }}>
        <strong>Shared files</strong>
        <span className="spacer" />
        <label className="ghost" style={{ cursor: 'pointer', padding: '6px 10px' }}>
          {busy ? 'Uploading…' : 'Upload'}
          <input
            type="file"
            style={{ display: 'none' }}
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) upload(file);
              e.target.value = '';
            }}
          />
        </label>
        <button onClick={refresh}>Refresh</button>
      </div>

      {error && <div style={{ color: 'var(--danger)', marginBottom: 8 }}>{error}</div>}
      {files.length === 0 && <div className="empty">Nothing shared yet.</div>}

      {files.map((file) => (
        <div key={file.id} className="file-row">
          <div className="row">
            <a className="attach" href={`/api/files/${file.id}`} download style={{ margin: 0 }}>
              📎 {file.filename}
            </a>
            <span className="spacer" />
            <span className="muted">{bytes(file.size)}</span>
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
            {file.uploadedByName} · {relative(file.uploadedAt)} · {file.mime}
          </div>
          {/* Agents verify integrity against this before acting on the bytes. */}
          <div className="mono muted" style={{ fontSize: 10, wordBreak: 'break-all' }}>
            sha256:{file.sha256}
          </div>
          <div className="mono muted" style={{ fontSize: 10 }}>
            id: {file.id}
          </div>
        </div>
      ))}
    </div>
  );
}
