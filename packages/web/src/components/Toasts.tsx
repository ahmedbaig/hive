import { useHive } from '../store.js';
import { Icon } from './Icon.js';

/**
 * Transient confirmations, anchored bottom-centre above the composer.
 *
 * Every destructive action in the app routes through here with an undo, which
 * is what lets archive and delete be one tap instead of a confirm dialog. A
 * dialog asks you to be sure before you have seen the result; an undo lets you
 * see the result and change your mind, and it is faster in the common case.
 */
export function Toasts(): JSX.Element {
  const toasts = useHive((s) => s.toasts);
  const dismiss = useHive((s) => s.dismissToast);

  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.kind}`}>
          <span className="toast-text">{toast.text}</span>
          {toast.action && (
            <button
              className="tiny ghost"
              onClick={() => {
                toast.action?.run();
                dismiss(toast.id);
              }}
            >
              <Icon name="undo" size={13} />
              {toast.action.label}
            </button>
          )}
          <button className="bare" aria-label="Dismiss" onClick={() => dismiss(toast.id)}>
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
