import { describe, expect, it, vi } from 'vitest';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import registerPiToPi from '../../src/index.js';

describe('Pi-to-Pi extension bootstrap', () => {
  it('registers only session lifecycle hooks during extension load', () => {
    const on = vi.fn<ExtensionAPI['on']>();

    registerPiToPi({ on } as unknown as ExtensionAPI);

    expect(on).toHaveBeenCalledTimes(2);
    expect(on).toHaveBeenNthCalledWith(1, 'session_start', expect.any(Function));
    expect(on).toHaveBeenNthCalledWith(2, 'session_shutdown', expect.any(Function));
  });
});
