import { newId } from './id';

const DEVICE_ID_KEY = 'gbtunnelface:device-id';
const DEVICE_NAME_KEY = 'gbtunnelface:device-name';

/** 默认设备名（可在同步中心修改），区分两台平板 */
function defaultName(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const isPad = /iPad|Android(?!.*Mobile)|Tablet/i.test(ua);
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${isPad ? '平板' : '终端'}-${rand}`;
}

/** 兼容浏览器与测试环境的 localStorage 访问 */
function storage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
    const g = globalThis as unknown as { localStorage?: Storage };
    return g.localStorage ?? null;
  } catch {
    return null;
  }
}

/** 本机设备 id，首次访问时生成并持久化 */
export function getDeviceId(): string {
  const ls = storage();
  if (ls) {
    let id = ls.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = newId('device');
      ls.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  }
  return 'device-unknown';
}

export function getDeviceName(): string {
  const ls = storage();
  return ls?.getItem(DEVICE_NAME_KEY) || defaultName();
}

export function setDeviceName(name: string): void {
  try {
    storage()?.setItem(DEVICE_NAME_KEY, name.trim() || defaultName());
  } catch {
    /* localStorage 不可用时忽略 */
  }
}
