/** Captures one UTF-8 prefix. Once output exceeds the budget, later chunks stay excluded. */
export class BoundedOutput {
  private text = "";
  private bytes = 0;
  private overflow = false;

  constructor(private readonly limit: number) {}

  get value(): string {
    return this.text;
  }

  get exceeded(): boolean {
    return this.overflow;
  }

  append(chunk: string): string {
    if (this.overflow) return "";
    const remaining = Math.max(0, this.limit - this.bytes);
    const bytes = Buffer.from(chunk, "utf8");
    this.overflow = bytes.byteLength > remaining;
    const accepted = this.overflow
      ? new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(0, remaining), {
          stream: true,
        })
      : chunk;
    this.text += accepted;
    this.bytes += Buffer.byteLength(accepted);
    return accepted;
  }
}
