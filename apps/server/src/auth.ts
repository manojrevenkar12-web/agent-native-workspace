import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** Signed, expiring session tokens: `<payload>.<hmac>`. No default secret exists. */
export class Tokens {
  constructor(private readonly secret: string) {
    if (secret.length < 32) throw new Error("ANW_SECRET must be at least 32 characters");
  }

  static devSecret(): string {
    return randomBytes(32).toString("hex");
  }

  issue(sub: string, ttlSeconds: number, now = Date.now()): string {
    const payload = b64url(JSON.stringify({ sub, exp: Math.floor(now / 1000) + ttlSeconds }));
    return `${payload}.${this.sign(payload)}`;
  }

  verify(token: string, now = Date.now()): string | null {
    const [payload, sig] = token.split(".");
    if (!payload || !sig) return null;
    const want = Buffer.from(this.sign(payload));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    try {
      const { sub, exp } = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
        sub: string;
        exp: number;
      };
      return exp * 1000 > now && typeof sub === "string" ? sub : null;
    } catch {
      return null;
    }
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.secret).update(payload).digest("base64url");
  }
}
