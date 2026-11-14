const PORTAL_PATIENT_WINDOW = 'ois-pms-patient';
const REOPEN_DELAY_MS = 2000;

interface PortalWindow {
  location: { href: string };
}
interface PortalBrowser {
  open: (url: string, target: string) => PortalWindow | null;
  schedule: (action: () => void, delayMs: number) => void;
}
export interface PortalPatientClick {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  currentTarget: { href: string };
  preventDefault: () => void;
}

let reopenGeneration = 0;

const browser: PortalBrowser = {
  open: (url, target) => window.open(url, target),
  schedule: (action, delayMs) => { window.setTimeout(action, delayMs); },
};

export function portalPatientReopenUrl(url: string, token: number): string {
  const next = new URL(url);
  next.searchParams.set('_', String(token));
  return next.toString();
}

function refreshOriginalWindow(opened: PortalWindow, url: string) {
  const next = portalPatientReopenUrl(url, Date.now());
  const location = opened.location as PortalWindow['location'] & { replace?: (nextUrl: string) => void };
  try {
    if (location.replace) location.replace(next);
    else location.href = next;
  } catch {
    location.href = next;
  }
}

export function openPortalPatient(url: string, host: PortalBrowser = browser): boolean {
  const generation = ++reopenGeneration;
  const held = host.open('about:blank', PORTAL_PATIENT_WINDOW);
  const opened = held ?? host.open(url, PORTAL_PATIENT_WINDOW);
  if (!opened) return false;
  if (held) held.location.href = url;
  host.schedule(() => {
    if (generation !== reopenGeneration) return;
    refreshOriginalWindow(opened, url);
  }, REOPEN_DELAY_MS);
  return true;
}

export function handlePortalPatientClick(event: PortalPatientClick): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const url = event.currentTarget.href;
  if (!url) return;
  event.preventDefault();
  openPortalPatient(url);
}
