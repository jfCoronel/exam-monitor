// Configuración web de Firebase. Es pública por diseño: la seguridad está en database.rules.json.
export const firebaseConfig = {
  apiKey: 'AIzaSyCx_I9QQHKXb7_W3RmgE_uXBCJT4-OLBpk',
  authDomain: 'exam-monitor-jfc.firebaseapp.com',
  databaseURL: 'https://exam-monitor-jfc-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: 'exam-monitor-jfc',
  appId: '1:57936623243:web:03fc3a4771b131e18d468e',
};

// Emuladores locales (`npm run dev`, `npm run smoke`). El proyecto demo-* nunca toca la nube.
export const emulatorConfig = {
  apiKey: 'demo-key',
  authDomain: 'demo-foco.firebaseapp.com',
  databaseURL: 'http://127.0.0.1:9000/?ns=demo-foco-default-rtdb',
  projectId: 'demo-foco',
  appId: 'demo-app',
};
export const EMULATOR_HOSTS = { auth: 'http://127.0.0.1:9099', db: ['127.0.0.1', 9000] };

/** En localhost se usan los emuladores, salvo que la URL lleve ?prod. */
export function shouldUseEmulator(loc = globalThis.location) {
  if (!loc) return false;
  return ['localhost', '127.0.0.1'].includes(loc.hostname) && !new URLSearchParams(loc.search).has('prod');
}
