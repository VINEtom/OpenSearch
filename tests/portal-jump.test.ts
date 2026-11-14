import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePortalPatientClick, openPortalPatient, portalPatientReopenUrl } from '../web/src/lib/portal-jump.js';

const patientUrl = 'http://10.8.31.28:10010/pms/patient-information?source=microApp&vPGuid=3a1365dd-fc22-b9ca-af12-dc5e3c3f548d';

test('reopen address keeps the patient id and adds a new load token', () => {
  const reopened = new URL(portalPatientReopenUrl(patientUrl, 42));
  assert.equal(reopened.searchParams.get('source'), 'microApp');
  assert.equal(reopened.searchParams.get('vPGuid'), '3a1365dd-fc22-b9ca-af12-dc5e3c3f548d');
  assert.equal(reopened.searchParams.get('_'), '42');
});

test('patient link opens one window and reloads it after two seconds', () => {
  const timers: Array<{ action: () => void; delayMs: number }> = [];
  const opened = { location: { href: '' } };
  const openedUrls: string[] = [];
  const started = openPortalPatient(patientUrl, {
    open: (url, target) => {
      openedUrls.push(`${target} ${url}`);
      return opened;
    },
    schedule: (action, delayMs) => { timers.push({ action, delayMs }); },
  });
  assert.equal(started, true);
  assert.deepEqual(openedUrls, ['ois-pms-patient about:blank']);
  assert.equal(opened.location.href, patientUrl);
  assert.deepEqual(timers.map((timer) => timer.delayMs), [2000]);
  timers[0].action();
  const reopened = new URL(opened.location.href);
  assert.equal(reopened.searchParams.get('vPGuid'), '3a1365dd-fc22-b9ca-af12-dc5e3c3f548d');
  assert.ok(reopened.searchParams.get('_'));
  assert.equal(openedUrls.length, 1);
});

test('a newer patient click cancels the previous refresh', () => {
  const timers: Array<() => void> = [];
  const first = { location: { href: '' } };
  const second = { location: { href: '' } };
  const windows = [first, second];
  const otherPatient = patientUrl.replace('548d', 'eeee');
  openPortalPatient(patientUrl, {
    open: () => windows.shift() ?? null,
    schedule: (action) => { timers.push(action); },
  });
  openPortalPatient(otherPatient, {
    open: () => windows.shift() ?? null,
    schedule: (action) => { timers.push(action); },
  });
  timers[0]();
  assert.equal(first.location.href, patientUrl);
  timers[1]();
  assert.equal(new URL(second.location.href).searchParams.get('vPGuid'), '3a1365dd-fc22-b9ca-af12-dc5e3c3feeee');
});

test('a missing window handle does not open another page', () => {
  const timers: Array<() => void> = [];
  const openedUrls: string[] = [];
  const started = openPortalPatient(patientUrl, {
    open: (url, target) => {
      openedUrls.push(`${target} ${url}`);
      return null;
    },
    schedule: (action) => { timers.push(action); },
  });
  assert.equal(started, false);
  assert.deepEqual(openedUrls, ['ois-pms-patient about:blank', `ois-pms-patient ${patientUrl}`]);
  assert.equal(timers.length, 0);
});

test('a rejected reload still reloads the same window and does not open another page', () => {
  const timers: Array<() => void> = [];
  const openedUrls: string[] = [];
  const opened = {
    location: {
      href: '',
      reload() { throw new Error('cross-origin'); },
      replace(nextUrl: string) { this.href = nextUrl; },
    },
  };
  openPortalPatient(patientUrl, {
    open: (url, target) => {
      openedUrls.push(`${target} ${url}`);
      return opened;
    },
    schedule: (action) => { timers.push(action); },
  });
  timers[0]();
  assert.equal(openedUrls.length, 1);
  assert.equal(new URL(opened.location.href).searchParams.get('vPGuid'), '3a1365dd-fc22-b9ca-af12-dc5e3c3f548d');
});

test('modified clicks keep the browser default and a blocked window is not opened again', () => {
  handlePortalPatientClick({
    button: 0,
    metaKey: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    currentTarget: { href: patientUrl },
    preventDefault: () => { throw new Error('modified click should follow the link'); },
  });
  const openedUrls: string[] = [];
  let prevented = 0;
  const previous = globalThis.window;
  globalThis.window = {
    open: (url: string, target: string) => {
      openedUrls.push(`${target} ${url}`);
      return null;
    },
    setTimeout: () => 0,
  } as unknown as Window & typeof globalThis;
  handlePortalPatientClick({
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    currentTarget: { href: patientUrl },
    preventDefault() { prevented += 1; },
  });
  globalThis.window = previous;
  assert.equal(prevented, 1);
  assert.deepEqual(openedUrls, ['ois-pms-patient about:blank', `ois-pms-patient ${patientUrl}`]);
});
