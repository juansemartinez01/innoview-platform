export function signedFixture(): Promise<{
  issuer: string;
  token(subject: string): Promise<string>;
  close(): Promise<void>;
}>;
