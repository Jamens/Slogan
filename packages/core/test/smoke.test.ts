import { describe, expect, it } from 'vitest';
import { CORE_SCHEMA_VERSION } from '@dajia/core';

describe('workspace 骨架', () => {
  it('可以通过包名 import @dajia/core', () => {
    expect(CORE_SCHEMA_VERSION).toBe(1);
  });
});
