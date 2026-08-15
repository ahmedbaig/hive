import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { installBadge, registerServiceWorker } from './notify.js';
import { installAudioUnlock } from './sound.js';
import { useHive } from './store.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

// Audio has to be armed by a real user gesture, and the browser only offers one
// chance to notice it — so the listener goes on before React mounts rather than
// inside an effect that may not have run when the operator first taps.
installAudioUnlock();
installBadge();
void registerServiceWorker();

// Tapping a notification asks the page to jump to the conversation it came from.
navigator.serviceWorker?.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string; channelId?: string } | undefined;
  if (data?.type === 'hive:open-channel' && data.channelId) {
    useHive.getState().openChannel(data.channelId);
  }
});

// Cold-start equivalent: the worker opened a new window with the channel in the
// query string because no tab was already running.
const requested = new URLSearchParams(location.search).get('channel');
if (requested) {
  useHive.getState().openChannel(requested);
  history.replaceState(null, '', location.pathname);
}

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
