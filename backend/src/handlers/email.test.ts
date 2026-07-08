import { afterEach, describe, expect, it, vi } from "vitest";
import { sendOtpEmail } from "./email";

describe("sendOtpEmail", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws when the Resend API key is missing", async () => {
    await expect(
      sendOtpEmail(undefined, "CryptoPulse <auth@example.com>", "user@example.com", "123456"),
    ).rejects.toThrow("RESEND_API_KEY is missing or invalid");
  });

  it("throws when the sender address is missing or still a placeholder", async () => {
    await expect(
      sendOtpEmail("test-key", undefined, "user@example.com", "123456"),
    ).rejects.toThrow("RESEND_FROM_EMAIL is missing or invalid");

    await expect(
      sendOtpEmail(
        "test-key",
        "CryptoPulse <onboarding@yourdomain.com>",
        "user@example.com",
        "123456",
      ),
    ).rejects.toThrow("RESEND_FROM_EMAIL is missing or invalid");
  });

  it("calls the Resend API with the configured sender", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    const response = await sendOtpEmail(
      "test-key",
      "CryptoPulse <auth@example.com>",
      "user@example.com",
      "123456",
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
        }),
      }),
    );
  });
});
