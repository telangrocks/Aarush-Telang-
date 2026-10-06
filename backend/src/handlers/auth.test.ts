import { describe, it, expect, vi, beforeEach } from "vitest";
import { isTokenRevoked, markTokenRevokedInCache } from "./auth";

describe("Dual-Path Authentication & JTI In-Memory Cache", () => {
  let mockContext: any;
  let mockDb: any;

  beforeEach(() => {
    mockDb = {
      prepare: vi.fn(),
    };
    mockContext = {
      env: {
        DB: mockDb,
      },
    };
  });

  it("authoritatively verifies valid token from D1 and caches for read-only polling", async () => {
    const jti = "test-valid-jti-1";
    const mockFirst = vi.fn().mockResolvedValue(null);
    mockDb.prepare.mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first: mockFirst,
      }),
    });

    // First call: queries D1
    const revoked1 = await isTokenRevoked(mockContext, jti);
    expect(revoked1).toBe(false);
    expect(mockDb.prepare).toHaveBeenCalledTimes(1);

    // Second call on read-only endpoint: hits in-memory cache, 0 D1 queries!
    const revoked2 = await isTokenRevoked(mockContext, jti);
    expect(revoked2).toBe(false);
    expect(mockDb.prepare).toHaveBeenCalledTimes(1); // Still 1!
  });

  it("authoritatively verifies revoked token from D1 and caches revoked status", async () => {
    const jti = "test-revoked-jti-1";
    const mockFirst = vi.fn().mockResolvedValue({ jti });
    mockDb.prepare.mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first: mockFirst,
      }),
    });

    const revoked1 = await isTokenRevoked(mockContext, jti);
    expect(revoked1).toBe(true);

    // Subsequent check returns true immediately from revoked cache
    const revoked2 = await isTokenRevoked(mockContext, jti);
    expect(revoked2).toBe(true);
  });

  it("markTokenRevokedInCache immediately revokes token in memory", async () => {
    const jti = "test-logout-jti";
    markTokenRevokedInCache(jti);

    // Should return true without querying D1
    const revoked = await isTokenRevoked(mockContext, jti);
    expect(revoked).toBe(true);
    expect(mockDb.prepare).not.toHaveBeenCalled();
  });

  it("degrades gracefully on read-only endpoints when D1 throws error", async () => {
    const jti = "test-degraded-jti";
    mockDb.prepare.mockImplementation(() => {
      throw new Error("D1 row read limit exceeded");
    });

    const revoked = await isTokenRevoked(mockContext, jti, { failClosed: false });
    expect(revoked).toBe(false); // Graceful degradation
  });

  it("strictly fails closed on high-stakes endpoints when D1 throws error", async () => {
    const jti = "test-high-stakes-jti";
    mockDb.prepare.mockImplementation(() => {
      throw new Error("D1 row read limit exceeded");
    });

    await expect(
      isTokenRevoked(mockContext, jti, { failClosed: true })
    ).rejects.toThrow("D1 row read limit exceeded");
  });
});
