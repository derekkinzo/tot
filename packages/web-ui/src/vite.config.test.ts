import { describe, it, expect, afterEach } from 'vitest';

// The config is a function of { command }; import the default export and invoke
// it directly to assert the dev-proxy fail-loud contract without booting Vite.
import configFactory from '../vite.config';

const factory = configFactory as unknown as (env: { command: 'serve' | 'build'; mode: string }) => any;
const saved = process.env.TOT_DEV_PORT;

afterEach(() => {
  if (saved === undefined) delete process.env.TOT_DEV_PORT;
  else process.env.TOT_DEV_PORT = saved;
});

describe('vite.config dev-proxy', () => {
  it('throws on `vite dev` when TOT_DEV_PORT is unset (no silent dead-target default)', () => {
    delete process.env.TOT_DEV_PORT;
    expect(() => factory({ command: 'serve', mode: 'development' })).toThrow(/TOT_DEV_PORT/);
  });

  it('proxies /sse and /api to the configured port on `vite dev`', () => {
    process.env.TOT_DEV_PORT = '54321';
    const cfg = factory({ command: 'serve', mode: 'development' });
    expect(cfg.server.proxy['/sse']).toBe('http://localhost:54321');
    expect(cfg.server.proxy['/api']).toBe('http://localhost:54321');
  });

  it('does not throw or configure a proxy for the production build', () => {
    delete process.env.TOT_DEV_PORT;
    let cfg: any;
    expect(() => { cfg = factory({ command: 'build', mode: 'production' }); }).not.toThrow();
    expect(cfg.server).toBeUndefined();
  });
});
